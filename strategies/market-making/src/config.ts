/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { loadEnv } from "@dreamdex-bot-kit/core";
loadEnv();

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key}="${v}" is not a number`);
  return n;
}

function str(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export const config = {
  /** Which market to quote. */
  symbol: str("MM_SYMBOL", "SOMI:USDso"),
  /** Half-spread each side of mid, in bps. Total quoted spread = 2× this. */
  halfSpreadBps: num("MM_HALF_SPREAD_BPS", 5),
  /** Order size, in quote (USDso) notional per side. */
  notionalUsdso: num("MM_NOTIONAL_USDSO", 20),
  /** Target base inventory in quote terms; quotes skew to pull inventory back here. */
  targetInventoryUsdso: num("MM_TARGET_INVENTORY_USDSO", 0),
  /** Half-width of the inventory guard band, in USDso. Defaults to one order notional. */
  inventoryGuardBandUsdso: num(
    "MM_INVENTORY_GUARD_BAND_USDSO",
    num("MM_NOTIONAL_USDSO", 20),
  ),
  /** How hard to skew per unit of inventory imbalance, in bps per 1× notional. */
  inventorySkewBps: num("MM_INVENTORY_SKEW_BPS", 4),
  /** Enable a confirmed trend filter that tilts inventory target without changing quote notional. */
  trendFilterEnabled: bool("MM_TREND_FILTER_ENABLED", false),
  /** Fast EMA time constant used by the trend filter. */
  trendFastEmaMs: num("MM_TREND_FAST_EMA_MS", 5 * 60_000),
  /** Slow EMA time constant used by the trend filter. */
  trendSlowEmaMs: num("MM_TREND_SLOW_EMA_MS", 20 * 60_000),
  /** Minimum fast-vs-slow EMA separation required to call a trend, in bps. */
  trendEmaThresholdBps: num("MM_TREND_EMA_THRESHOLD_BPS", 6),
  /** Recent price-move window used as a second confirmation signal. */
  trendMoveWindowMs: num("MM_TREND_MOVE_WINDOW_MS", 15 * 60_000),
  /** Minimum absolute recent move required to confirm the EMA signal, in bps. */
  trendMoveThresholdBps: num("MM_TREND_MOVE_THRESHOLD_BPS", 12),
  /** Consecutive confirmed observations required before switching trend state. */
  trendConfirmations: num("MM_TREND_CONFIRMATIONS", 3),
  /** USDso amount added/subtracted from the normal inventory target in up/down trends. */
  trendTargetTiltUsdso: num("MM_TREND_TARGET_TILT_USDSO", 8),
  /** Only requote once mid has moved this many bps. */
  requoteTriggerBps: num("MM_REQUOTE_TRIGGER_BPS", 3),
  /** Don't quote if the book's own spread is wider than this. */
  maxBookSpreadBps: num("MM_MAX_BOOK_SPREAD_BPS", 50),
  /** Minimum wall-time between requotes, ms. */
  requoteCooldownMs: num("MM_REQUOTE_COOLDOWN_MS", 2_000),
  /** Fallback poll interval if the WS feed is quiet, ms. */
  refreshIntervalMs: num("MM_REFRESH_INTERVAL_MS", 5_000),
  /** Resting order lifetime, ms. */
  expireMs: num("MM_EXPIRE_MS", 60 * 60_000),
  /** Extra balance headroom required before placing either leg. */
  balanceBufferBps: num("MM_BALANCE_BUFFER_BPS", 20),
  /** Stop sending transactions when signer gas balance falls below this amount of SOMI. */
  minGasSomi: num("MM_MIN_GAS_SOMI", 1),
  /** Log intended actions without sending any transaction. */
  dryRun: bool("DRY_RUN", true),
};

export type Config = typeof config;
