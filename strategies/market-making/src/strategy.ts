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

  /**
   * On every real startup, remove any open orders left by a previous process.
   * This prevents a Railway restart from stacking new quotes on top of ghosts.
   */
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

  /**
   * Reconcile our in-memory bid/ask against the contract. If a tracked order is
   * no longer open it was either filled, cancelled or expired. We attempt an
   * expired reclaim first (simulation prevents gas spend when it was a fill),
   * then clear that leg so requote() can replenish it immediately.
   */
  private async reconcileTrackedLegs(): Promise<void> {
    if (this.cfg.dryRun) return;
    const tracked = [
      ["bid", this.bid] as const,
      ["ask", this.ask] as const,
    ].filter(([, order]) => order && order.orderId !== 0n);
    if (tracked.length === 0) return;

    const openIds = await this.pool.openOrderIds();
    const open = new Set(openIds.map((id) => id.toString()));

    for (const [side, order] of tracked) {
      if (!order || open.has(order.orderId.toString())) continue;

      try {
        await this.pool.cancelExpired([order.orderId]);
        this.log(`replenish: reclaimed expired ${side} id=${order.orderId}`);
      } catch {
        this.log(`replenish: ${side} id=${order.orderId} filled/closed — replacing`);
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

    // Detect fills/expiry before applying the price-movement threshold. A missing
    // leg must be replenished even when mid barely moved.
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

    // Healthy two-sided quote + small price move = leave both orders resting.
    if (!bidMissing && !askMissing && !priceMoveRequiresRequote) return;

    this.lastMid = mid;
    this.lastRequoteAt = Date.now();

    const invUsdso = (await this.pool.walletBase()) * mid;
    const imbalance = (invUsdso - this.cfg.targetInventoryUsdso) / this.cfg.notionalUsdso;
    const skewBps = imbalance * this.cfg.inventorySkewBps;

    const bidPrice = shiftBps(mid, -this.cfg.halfSpreadBps - skewBps);
    const askPrice = shiftBps(mid, +this.cfg.halfSpreadBps - skewBps);
    const qty = this.cfg.notionalUsdso / mid;

    if (qty < this.pool.minQty) {
      this.log(`qty ${qty} below market min ${this.pool.minQty} — raise MM_NOTIONAL_USDSO`);
      return;
    }

    this.log(`requote mid=${mid.toFixed(6)} bid=${bidPrice.toFixed(6)} ask=${askPrice.toFixed(6)} qty=${qty.toFixed(6)} skewBps=${skewBps.toFixed(2)}`);

    // When a leg disappeared but price barely moved, replenish only that side.
    // On a real price move, refresh both sides so the pair stays competitive.
    if (priceMoveRequiresRequote || bidMissing) await this.replaceLeg("bid", bidPrice, qty);
    if (priceMoveRequiresRequote || askMissing) await this.replaceLeg("ask", askPrice, qty);
  }

  private async replaceLeg(side: "bid" | "ask", price: number, qty: number): Promise<void> {
    const existing = side === "bid" ? this.bid : this.ask;
    if (existing && approxEq(existing.price, price) && approxEq(existing.qty, qty)) return;

    if (this.cfg.dryRun) {
      this.log(`[dry-run] ${side} ${qty.toFixed(6)} @ ${price.toFixed(6)}`);
      if (side === "bid") this.bid = { orderId: 0n, price, qty };
      else this.ask = { orderId: 0n, price, qty };
      return;
    }

    if (existing && existing.orderId !== 0n) {
      let cleared = false;
      try {
        await this.pool.cancel(existing.orderId);
        cleared = true;
      } catch (err) {
        this.log(`cancel ${side} failed id=${existing.orderId}`, (err as Error).message);
        try {
          await this.pool.cancelExpired([existing.orderId]);
          cleared = true;
          this.log(`reclaimed expired ${side} id=${existing.orderId}`);
        } catch {
          const openIds = await this.pool.openOrderIds();
          cleared = !openIds.some((id) => id === existing.orderId);
          if (!cleared) {
            this.log(`SKIP ${side}: previous order id=${existing.orderId} is still open`);
            return;
          }
        }
      }
      if (cleared) {
        if (side === "bid") this.bid = undefined;
        else this.ask = undefined;
      }
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
      const rec = { orderId: res.orderId ?? 0n, price, qty };
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
          try { await this.pool.cancelExpired([o.orderId]); } catch { /* best-effort */ }
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
