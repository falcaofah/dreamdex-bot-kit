/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { Pool, ORDER_TYPE, shiftBps, spreadBps } from "@dreamdex-bot-kit/core";
import type { Config } from "./config.js";

interface RestingOrder {
  orderId: bigint;
  price: number;
  qty: number;
  postedAtMs: number;
}

export class MarketMaker {
  private bid?: RestingOrder;
  private ask?: RestingOrder;
  private lastMid?: number;
  private lastRequoteAt = 0;
  private requoting = false;
  private gasPaused = false;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: Config,
    private readonly log: (msg: string, extra?: unknown) => void,
  ) {}

  async initialize(): Promise<void> {
    const ids = await this.pool.openOrderIds();
    if (ids.length === 0) {
      this.log("startup reconciliation: no open orders");
      return;
    }

    if (this.cfg.dryRun) {
      this.log(`[dry-run] startup reconciliation would cancel ${ids.length} open order(s)`);
      return;
    }

    this.log(`startup reconciliation: cancelling ${ids.length} open order(s)`);
    for (const id of ids) {
      try {
        await this.pool.cancel(id);
        this.log(`startup cancelled id=${id}`);
      } catch (err) {
        this.log(`startup cancel failed id=${id}`, (err as Error).message);
        try {
          await this.pool.cancelExpired([id]);
          this.log(`startup reclaimed expired id=${id}`);
        } catch (expiredErr) {
          this.log(`startup expired reclaim failed id=${id}`, (expiredErr as Error).message);
        }
      }
    }
  }

  async onBook(): Promise<void> {
    if (this.requoting) return;
    if (Date.now() - this.lastRequoteAt < this.cfg.requoteCooldownMs) return;
    this.requoting = true;
    try {
      await this.requote();
    } finally {
      this.requoting = false;
    }
  }

  private async reconcileTrackedLegs(): Promise<void> {
    if (this.cfg.dryRun) return;
    const tracked = [
      ["bid", this.bid] as const,
      ["ask", this.ask] as const,
    ].filter(([, order]) => order && order.orderId !== 0n);
    if (tracked.length === 0) return;

    const openIds = await this.pool.openOrderIds();
    const open = new Set(openIds.map((id) => id.toString()));
    const now = Date.now();

    for (const [side, order] of tracked) {
      if (!order || open.has(order.orderId.toString())) continue;

      const ageMs = Math.max(0, now - order.postedAtMs);
      if (ageMs >= this.cfg.expireMs) {
        try {
          await this.pool.cancelExpired([order.orderId]);
          this.log(`replenish: reclaimed expired ${side} id=${order.orderId}`);
        } catch {
          this.log(`replenish: ${side} id=${order.orderId} already closed — replacing`);
        }
      } else {
        this.log(`replenish: ${side} id=${order.orderId} filled/closed after ${(ageMs / 1000).toFixed(1)}s — replacing`);
      }

      if (side === "bid") this.bid = undefined;
      else this.ask = undefined;
    }
  }

  private async requote(): Promise<void> {
    if (!this.cfg.dryRun) {
      const gasSomi = await this.pool.signerGasBalance();
      if (gasSomi < this.cfg.minGasSomi) {
        if (!this.gasPaused) this.log(`PAUSED: gas balance ${gasSomi.toFixed(4)} SOMI < minimum ${this.cfg.minGasSomi}`);
        this.gasPaused = true;
        return;
      }
      if (this.gasPaused) this.log(`RESUMED: gas balance ${gasSomi.toFixed(4)} SOMI`);
      this.gasPaused = false;
    }

    await this.reconcileTrackedLegs();

    const { bestBid, bestAsk, mid } = await this.pool.topOfBook();
    if (mid === undefined) {
      this.log("no mid price (empty book) — skipping requote");
      return;
    }

    if (bestBid !== undefined && bestAsk !== undefined) {
      const bookBps = spreadBps(bestBid, bestAsk);
      if (bookBps > this.cfg.maxBookSpreadBps) {
        this.log(`book spread ${bookBps.toFixed(1)}bps > max ${this.cfg.maxBookSpreadBps}bps — skipping`);
        return;
      }
    }

    const driftBps = this.lastMid === undefined
      ? Number.POSITIVE_INFINITY
      : Math.abs((mid - this.lastMid) / this.lastMid) * 10_000;
    const priceMoveRequiresRequote = driftBps >= this.cfg.requoteTriggerBps;
    const bidMissing = !this.bid;
    const askMissing = !this.ask;

    if (!bidMissing && !askMissing && !priceMoveRequiresRequote) return;

    this.lastMid = mid;
    this.lastRequoteAt = Date.now();

    // walletBase() only sees free WBTC. A resting ask locks WBTC in the pool,
    // so include that tracked quantity when computing total inventory. Without
    // this, the strategy can think inventory is low and keep buying while a sell
    // order is already holding part of the WBTC balance.
    const freeBase = await this.pool.walletBase();
    const lockedAskBase = this.ask?.qty ?? 0;
    const totalBase = freeBase + lockedAskBase;
    const invUsdso = totalBase * mid;
    const imbalance = (invUsdso - this.cfg.targetInventoryUsdso) / this.cfg.notionalUsdso;
    const skewBps = imbalance * this.cfg.inventorySkewBps;

    // Configurable inventory band around the target. Outside this band we stop
    // adding inventory in the wrong direction and quote only the side that
    // brings the wallet back toward target. The default remains one notional.
    const lowerInventoryUsdso = Math.max(0, this.cfg.targetInventoryUsdso - this.cfg.inventoryGuardBandUsdso);
    const upperInventoryUsdso = this.cfg.targetInventoryUsdso + this.cfg.inventoryGuardBandUsdso;
    const inventoryTooLong = invUsdso > upperInventoryUsdso;
    const inventoryTooShort = invUsdso < lowerInventoryUsdso;

    const rawBidPrice = shiftBps(mid, -this.cfg.halfSpreadBps - skewBps);
    const rawAskPrice = shiftBps(mid, +this.cfg.halfSpreadBps - skewBps);

    let bidPrice = rawBidPrice;
    let askPrice = rawAskPrice;
    if (bestAsk !== undefined) bidPrice = Math.min(bidPrice, bestAsk - this.pool.tick);
    if (bestBid !== undefined) askPrice = Math.max(askPrice, bestBid + this.pool.tick);

    if (bidPrice !== rawBidPrice) {
      this.log(`maker clamp bid ${rawBidPrice.toFixed(6)} -> ${bidPrice.toFixed(6)}`);
    }
    if (askPrice !== rawAskPrice) {
      this.log(`maker clamp ask ${rawAskPrice.toFixed(6)} -> ${askPrice.toFixed(6)}`);
    }

    const qty = this.cfg.notionalUsdso / mid;

    if (qty < this.pool.minQty) {
      this.log(`qty ${qty} below market min ${this.pool.minQty} — raise MM_NOTIONAL_USDSO`);
      return;
    }

    this.log(`requote mid=${mid.toFixed(6)} bid=${bidPrice.toFixed(6)} ask=${askPrice.toFixed(6)} qty=${qty.toFixed(6)} skewBps=${skewBps.toFixed(2)} invUsdso=${invUsdso.toFixed(2)}`);

    if (inventoryTooLong) {
      if (this.bid) await this.replaceLeg("bid", bidPrice, qty, false);
      else this.log(`INVENTORY GUARD: ${invUsdso.toFixed(2)} USDso > ${upperInventoryUsdso.toFixed(2)} — bid paused`);
    } else if (priceMoveRequiresRequote || bidMissing) {
      await this.replaceLeg("bid", bidPrice, qty);
    }

    if (inventoryTooShort) {
      if (this.ask) await this.replaceLeg("ask", askPrice, qty, false);
      else this.log(`INVENTORY GUARD: ${invUsdso.toFixed(2)} USDso < ${lowerInventoryUsdso.toFixed(2)} — ask paused`);
    } else if (priceMoveRequiresRequote || askMissing) {
      await this.replaceLeg("ask", askPrice, qty);
    }
  }

  private async replaceLeg(side: "bid" | "ask", price: number, qty: number, placeAfterCancel = true): Promise<void> {
    const existing = side === "bid" ? this.bid : this.ask;
    if (placeAfterCancel && existing && approxEq(existing.price, price) && approxEq(existing.qty, qty)) return;

    if (this.cfg.dryRun) {
      if (!placeAfterCancel) {
        this.log(`[dry-run] inventory guard would cancel ${side}`);
        if (side === "bid") this.bid = undefined;
        else this.ask = undefined;
        return;
      }
      const rec = { orderId: 0n, price, qty, postedAtMs: Date.now() };
      this.log(`[dry-run] ${side} ${qty.toFixed(6)} @ ${price.toFixed(6)}`);
      if (side === "bid") this.bid = rec;
      else this.ask = rec;
      return;
    }

    if (existing && existing.orderId !== 0n) {
      let cleared = false;
      try {
        await this.pool.cancel(existing.orderId);
        cleared = true;
      } catch (err) {
        this.log(`cancel ${side} failed id=${existing.orderId}`, (err as Error).message);
        const openIds = await this.pool.openOrderIds();
        const stillOpen = openIds.some((id) => id === existing.orderId);
        if (!stillOpen) {
          const ageMs = Math.max(0, Date.now() - existing.postedAtMs);
          if (ageMs >= this.cfg.expireMs) {
            try {
              await this.pool.cancelExpired([existing.orderId]);
              this.log(`reclaimed expired ${side} id=${existing.orderId}`);
            } catch {
              this.log(`${side} id=${existing.orderId} already closed — replacing`);
            }
          } else {
            this.log(`${side} id=${existing.orderId} filled/closed — replacing without reclaim tx`);
          }
          cleared = true;
        } else {
          this.log(`SKIP ${side}: previous order id=${existing.orderId} is still open`);
          return;
        }
      }
      if (cleared) {
        if (side === "bid") this.bid = undefined;
        else this.ask = undefined;
      }
    }

    if (!placeAfterCancel) {
      this.log(`INVENTORY GUARD: cancelled ${side}; waiting for inventory to rebalance`);
      return;
    }

    const buffer = 1 + this.cfg.balanceBufferBps / 10_000;
    if (side === "bid") {
      const quote = await this.pool.walletQuote();
      const required = price * qty * buffer;
      if (quote < required) {
        this.log(`SKIP bid: free quote ${quote.toFixed(6)} < required ${required.toFixed(6)}`);
        return;
      }
    } else {
      const base = await this.pool.walletBase();
      const required = qty * buffer;
      if (base < required) {
        this.log(`SKIP ask: free base ${base.toFixed(8)} < required ${required.toFixed(8)}`);
        return;
      }
    }

    try {
      const res = await this.pool.place({
        isBid: side === "bid",
        price,
        qty,
        orderType: ORDER_TYPE.PostOnly,
        expireMs: this.cfg.expireMs,
      });
      const rec = { orderId: res.orderId ?? 0n, price, qty, postedAtMs: Date.now() };
      if (side === "bid") this.bid = rec;
      else this.ask = rec;
      this.log(`posted ${side} ${qty.toFixed(6)} @ ${price.toFixed(6)} id=${res.orderId} tx=${res.txHash}`);
    } catch (err) {
      this.log(`post ${side} failed`, (err as Error).message);
      if (side === "bid") this.bid = undefined;
      else this.ask = undefined;
    }
  }

  async cancelAll(): Promise<void> {
    for (const o of [this.bid, this.ask]) {
      if (o && o.orderId !== 0n) {
        try {
          await this.pool.cancel(o.orderId);
        } catch {
          const ageMs = Math.max(0, Date.now() - o.postedAtMs);
          if (ageMs >= this.cfg.expireMs) {
            try { await this.pool.cancelExpired([o.orderId]); } catch { /* best-effort */ }
          }
        }
      }
    }
    this.bid = undefined;
    this.ask = undefined;
  }
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) / (b || 1) < 1e-9;
}
