/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { ChainContext } from "./client.js";
import { MARKETS, NATIVE_SENTINEL } from "./config/tokens.js";
import {
  SPOT_POOL_ABI,
  ERC20_ABI,
  readPoolParams,
  readBookLevels,
  readWithdrawableBalance,
  type PoolParams,
} from "./contract.js";
import { placeOrder, cancelOrder, placeOrderFor, cancelOrderFor, type ExecCtx, type PlaceOrderResult } from "./execute.js";
import { ORDER_TYPE, buildExpireNs } from "./gotchas.js";
import { toRaw, fromRaw, alignToTick, alignToLot } from "./quant.js";

const EXPIRED_ABI = [{
  type: "function",
  name: "cancelExpiredOrders",
  stateMutability: "nonpayable",
  inputs: [{ name: "orderIds", type: "uint128[]" }],
  outputs: [],
}] as const;

export interface TopOfBook {
  bestBid?: number;
  bestAsk?: number;
  mid?: number;
}

export interface PlaceArgs {
  isBid: boolean;
  price: number;
  qty: number;
  orderType?: number;
  expireMs?: number;
}

export class Pool {
  private constructor(
    private readonly ctx: ChainContext,
    readonly symbol: string,
    readonly address: `0x${string}`,
    readonly baseIsNative: boolean,
    readonly params: PoolParams,
    readonly baseDecimals: number,
    readonly quoteDecimals: number,
  ) {}

  static async load(ctx: ChainContext, symbol: string): Promise<Pool> {
    const meta = MARKETS[ctx.net.name][symbol];
    if (!meta) throw new Error(`Unknown market "${symbol}" on ${ctx.net.name}. See packages/core/src/config/tokens.ts.`);
    const params = await readPoolParams(ctx.publicClient, meta.pool);
    return new Pool(ctx, symbol, meta.pool, meta.baseIsNative, params, meta.baseDecimals, meta.quoteDecimals);
  }

  private get exec(): ExecCtx {
    return { publicClient: this.ctx.publicClient, walletClient: this.ctx.walletClient, account: this.ctx.account };
  }

  private get subject(): `0x${string}` {
    return this.ctx.owner ?? this.ctx.account.address;
  }

  get tick(): number { return fromRaw(this.params.tickSize, this.quoteDecimals); }
  get lot(): number { return fromRaw(this.params.lotSize, this.baseDecimals); }
  get minQty(): number { return fromRaw(this.params.minQuantity, this.baseDecimals); }

  async topOfBook(depth = 1): Promise<TopOfBook> {
    const [bids, asks] = await Promise.all([
      readBookLevels(this.ctx.publicClient, this.address, true, depth),
      readBookLevels(this.ctx.publicClient, this.address, false, depth),
    ]);
    const bestBid = bids[0] ? fromRaw(bids[0].priceRaw, this.quoteDecimals) : undefined;
    const bestAsk = asks[0] ? fromRaw(asks[0].priceRaw, this.quoteDecimals) : undefined;
    const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk);
    return { bestBid, bestAsk, mid };
  }

  async place(args: PlaceArgs): Promise<PlaceOrderResult> {
    const side = args.isBid ? "bid" : "ask";
    const priceRaw = alignToTick(toRaw(args.price, this.quoteDecimals), this.params.tickSize, side);
    const quantityRaw = alignToLot(toRaw(args.qty, this.baseDecimals), this.params.lotSize);
    const params = {
      pool: this.address,
      baseIsNative: this.baseIsNative,
      isBid: args.isBid,
      priceRaw,
      quantityRaw,
      tickRaw: this.params.tickSize,
      lotRaw: this.params.lotSize,
      minQtyRaw: this.params.minQuantity,
      orderType: args.orderType ?? ORDER_TYPE.ImmediateOrCancel,
      expireTimestampNs: buildExpireNs(args.expireMs ?? 60 * 60_000),
    };
    return this.ctx.owner ? placeOrderFor(this.exec, params, this.ctx.owner) : placeOrder(this.exec, params);
  }

  async cancel(orderId: bigint): Promise<`0x${string}`> {
    return this.ctx.owner
      ? cancelOrderFor(this.exec, this.address, this.ctx.owner, orderId)
      : cancelOrder(this.exec, this.address, orderId);
  }

  /** Reclaim funds from known expired order ids. Default wallet mode only. */
  async cancelExpired(orderIds: bigint[]): Promise<`0x${string}` | undefined> {
    if (orderIds.length === 0 || this.ctx.owner) return undefined;
    const sim = await this.ctx.publicClient.simulateContract({
      address: this.address,
      abi: EXPIRED_ABI,
      functionName: "cancelExpiredOrders",
      args: [orderIds],
      account: this.ctx.account,
    });
    const hash = await this.ctx.walletClient.writeContract({ ...sim.request, chain: this.ctx.walletClient.chain, account: this.ctx.account });
    await this.ctx.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async openOrderIds(): Promise<bigint[]> {
    const ids = await this.ctx.publicClient.readContract({
      address: this.address,
      abi: SPOT_POOL_ABI,
      functionName: "getOwnOpenOrders",
      account: this.subject,
    });
    return [...ids];
  }

  async vaultBase(): Promise<number> {
    const token = this.baseIsNative ? (NATIVE_SENTINEL as `0x${string}`) : this.params.baseToken;
    const raw = await readWithdrawableBalance(this.ctx.publicClient, this.address, this.subject, token);
    return fromRaw(raw, this.baseDecimals);
  }

  async walletBase(): Promise<number> {
    if (this.baseIsNative) {
      const raw = await this.ctx.publicClient.getBalance({ address: this.subject });
      return fromRaw(raw, this.baseDecimals);
    }
    const raw = await this.ctx.publicClient.readContract({
      address: this.params.baseToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.subject],
    });
    return fromRaw(raw, this.baseDecimals);
  }

  /** Quote-token balance available in the owner's wallet. */
  async walletQuote(): Promise<number> {
    const raw = await this.ctx.publicClient.readContract({
      address: this.params.quoteToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.subject],
    });
    return fromRaw(raw, this.quoteDecimals);
  }

  /** Native SOMI held by the signer, used only for transaction gas. */
  async signerGasBalance(): Promise<number> {
    const raw = await this.ctx.publicClient.getBalance({ address: this.ctx.account.address });
    return Number(raw) / 1e18;
  }
}
