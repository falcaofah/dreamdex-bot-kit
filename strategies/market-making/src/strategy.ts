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

type TrendState = "NEUTRAL" | "UPTREND" | "DOWNTREND";

export class MarketMaker {
  private bid?: RestingOrder;
  private ask?: RestingOrder;
  private lastMid?: number;
  private lastRequoteAt = 0;
  private requoting = false;
  private gasPaused = false;

  private trendState: TrendState = "NEUTRAL";
  private trendCandidate: TrendState = "NEUTRAL";
  private trendCandidateCount = 0;
  private fastEma?: number;
  private slowEma?: number;
  private lastTrendUpdateMs?: number;
  private trendHistory: Array<{ ts: number; mid: number }> = [];

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

  private updateTrend(mid: number, now: number): number {
    if (!this.cfg.trendFilterEnabled) return this.cfg.targetInventoryUsdso;

    if (this.fastEma === undefined || this.slowEma === undefined || this.lastTrendUpdateMs === undefined) {
      this.fastEma = mid;
      this.slowEma = mid;
      this.lastTrendUpdateMs = now;
      this.trendHistory = [{ ts: now, mid }];
      return this.cfg.targetInventoryUsdso;
    }

    const dt = Math.max(1, now - this.lastTrendUpdateMs);
    this.lastTrendUpdateMs = now;
    const fastAlpha = 1 - Math.exp(-dt / Math.max(1, this.cfg.trendFastEmaMs));
    const slowAlpha = 1 - Math.exp(-dt / Math.max(1, this.cfg.trendSlowEmaMs));
    this.fastEma += fastAlpha * (mid - this.fastEma);
    this.slowEma += slowAlpha * (mid - this.slowEma);

    this.trendHistory.push({ ts: now, mid });
    const cutoff = now - this.cfg.trendMoveWindowMs;
    while (this.trendHistory.length > 2 && this.trendHistory[1]!.ts < cutoff) {
      this.trendHistory.shift();
    }

    const anchor = this.trendHistory.find((p) => p.ts >= cutoff) ?? this.trendHistory[0];
    const emaBps = ((this.fastEma - this.slowEma) / this.slowEma) * 10_000;
    const moveBps = anchor ? ((mid - anchor.mid) / anchor.mid) * 10_000 : 0;

    let candidate: TrendState = "NEUTRAL";
    if (emaBps >= this.cfg.trendEmaThresholdBps && moveBps >= this.cfg.trendMoveThresholdBps) {
      candidate = "UPTREND";
    } else if (emaBps <= -this.cfg.trendEmaThresholdBps && moveBps <= -this.cfg.trendMoveThresholdBps) {
      candidate = "DOWNTREND";
    }

    if (candidate === this.trendCandidate) {
      this.trendCandidateCount += 1;
    } else {
      this.trendCandidate = candidate;
      this.trendCandidateCount = 1;
    }

    if (this.trendCandidateCount >= Math.max(1, Math.floor(this.cfg.trendConfirmations)) && candidate !== this.trendState) {
      this.trendState = candidate;
      this.log(`TREND ${this.trendState}: ema=${emaBps.toFixed(2)}bps move=${moveBps.toFixed(2)}bps`);
    }

    const tilt = this.trendState === "UPTREND"
      ? this.cfg.trendTargetTiltUsdso
      : this.trendState === "DOWNTREND"
        ? -this.cfg.trendTargetTiltUsdso
        : 0;

    return Math.max(0, this.cfg.targetInventoryUsdso + tilt);
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

    const effectiveTargetInventoryUsdso = this.updateTrend(mid, this.lastRequoteAt);

    // walletBase() only sees free WBTC. A resting ask locks WBTC in the pool,
    // so include that tracked quantity when computing total inventory. Without
    // this, the strategy can think inventory is low and keep buying while a sell
    // order is already holding part of the WBTC balance.
    const freeBase = await this.pool.walletBase();
    const lockedAskBase = this.ask?.qty ?? 0;
    const totalBase = freeBase + lockedAskBase;
    const invUsdso = totalBase * mid;
    const imbalance = (invUsdso - effectiveTargetInventoryUsdso) / this.cfg.notionalUsdso;
    const skewBps = imbalance * this.cfg.inventorySkewBps;

    // Hard guard: outside this band, stop quoting the side that would worsen inventory.
    const lowerInventoryUsdso = Math.max(0, effectiveTargetInventoryUsdso - this.cfg.inventoryGuardBandUsdso);
    const upperInventoryUsdso = effectiveTargetInventoryUsdso + this.cfg.inventoryGuardBandUsdso;
    const inventoryTooLong = invUsdso > upperInventoryUsdso;
    const inventoryTooShort = invUsdso < lowerInventoryUsdso;

    // Soft guard: before reaching the hard limit, keep both sides live but reduce
    // only the side that would push inventory farther away from target.
    const softWidthUsdso = Math.min(
      Math.max(0, this.cfg.softInventoryGuardWidthUsdso),
      Math.max(0, this.cfg.inventoryGuardBandUsdso),
    );
    const lowerSoftInventoryUsdso = lowerInventoryUsdso + softWidthUsdso;
    const upperSoftInventoryUsdso = upperInventoryUsdso - softWidthUsdso;
    const inventorySoftShort = this.cfg.softInventoryGuardEnabled
      && !inventoryTooShort
      && invUsdso < lowerSoftInventoryUsdso;
    const inventorySoftLong = this.cfg.softInventoryGuardEnabled
      && !inventoryTooLong
      && invUsdso > upperSoftInventoryUsdso;

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

    const normalQty = this.cfg.notionalUsdso / mid;
    if (normalQty < this.pool.minQty) {
      this.log(`qty ${normalQty} below market min ${this.pool.minQty} — raise MM_NOTIONAL_USDSO`);
      return;
    }

    const reducedNotionalUsdso = Math.min(
      this.cfg.notionalUsdso,
      Math.max(0, this.cfg.softInventoryGuardNotionalUsdso),
    );
    const requestedReducedQty = reducedNotionalUsdso / mid;
    const reducedQty = requestedReducedQty >= this.pool.minQty ? requestedReducedQty : normalQty;
    if (this.cfg.softInventoryGuardEnabled && reducedQty === normalQty && reducedNotionalUsdso < this.cfg.notionalUsdso) {
      this.log(`SOFT INVENTORY GUARD: reduced qty ${requestedReducedQty.toFixed(6)} below market min ${this.pool.minQty}; using normal qty`);
    }

    const bidQty = inventorySoftLong ? reducedQty : normalQty;
    const askQty = inventorySoftShort ? reducedQty : normalQty;
    const bidSizeChanged = !!this.bid && !approxEq(this.bid.qty, bidQty);
    const askSizeChanged = !!this.ask && !approxEq(this.ask.qty, askQty);
    const softState = inventorySoftShort ? "LOW" : inventorySoftLong ? "HIGH" : "OFF";

    this.log(`requote mid=${mid.toFixed(6)} bid=${bidPrice.toFixed(6)} ask=${askPrice.toFixed(6)} bidQty=${bidQty.toFixed(6)} askQty=${askQty.toFixed(6)} skewBps=${skewBps.toFixed(2)} invUsdso=${invUsdso.toFixed(2)} trend=${this.trendState} target=${effectiveTargetInventoryUsdso.toFixed(2)} soft=${softState}`);

    if (inventoryTooLong) {
      if (this.bid) await this.replaceLeg("bid", bidPrice, bidQty, false);
      else this.log(`INVENTORY GUARD: ${invUsdso.toFixed(2)} USDso > ${upperInventoryUsdso.toFixed(2)} — bid paused`);
    } else if (priceMoveRequiresRequote || bidMissing || bidSizeChanged) {
      await this.replaceLeg("bid", bidPrice, bidQty);
    }

    if (inventoryTooShort) {
      if (this.ask) await this.replaceLeg("ask", askPrice, askQty, false);
      else this.log(`INVENTORY GUARD: ${invUsdso.toFixed(2)} USDso < ${lowerInventoryUsdso.toFixed(2)} — ask paused`);
    } else if (priceMoveRequiresRequote || askMissing || askSizeChanged) {
      await this.replaceLeg("ask", askPrice, askQty);
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
