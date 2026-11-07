import { type PublicClient } from "viem";
import { aquaAbi, executorAbi } from "./abi";
import type { Config } from "./config";
import { tokenInfo } from "./deployments";
import type { Logger } from "./log";
import { applySlippage, gasCostWei, nativeToToken, parseUnitsString, readSqrtPrice } from "./price";
import { MAX_U128, quoteArb, type ArbParams } from "./quote";
import { searchBestSize } from "./size";
import type { StrategyTracker } from "./tracker";
import type { Address, Deployment, Direction, Opportunity, OpportunityStatus, PoolInfo, Strategy } from "./types";

export type ScanCtx = {
  client: PublicClient;
  dep: Deployment;
  cfg: Config;
  tracker: StrategyTracker;
  wrappedNative?: Address;
  backoff: Map<string, number>;
  skippedHooked: Set<string>;
  log: Logger;
};

const FALLBACK_GAS = 260_000n;
const DEFAULT_MAX_UNITS = "1000";

export function opportunityId(pool: PoolInfo, s: Strategy, dir: Direction): string {
  return `${pool.symbol}:${s.strategyHash.slice(0, 10)}:${dir}`;
}

async function liveBalances(ctx: ScanCtx, pool: PoolInfo, s: Strategy): Promise<[bigint, bigint] | null> {
  try {
    const [b0, b1] = await ctx.client.readContract({
      address: ctx.dep.aqua,
      abi: aquaAbi,
      functionName: "safeBalances",
      args: [s.maker, ctx.dep.router, s.strategyHash, pool.key.currency0, pool.key.currency1],
    });
    return b0 > 0n && b1 > 0n ? [b0, b1] : null;
  } catch {
    return null; // docked, or it does not hold this pair
  }
}

/** Quotes both directions of every (pool, strategy) pair, sizes the profitable ones and prices their gas. */
export async function scanOnce(ctx: ScanCtx, now = Date.now()): Promise<Opportunity[]> {
  const { client, dep, cfg } = ctx;
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const gasPrice = await client.getGasPrice();
  const out: Opportunity[] = [];

  for (const pool of dep.pools) {
    const sqrt = await readSqrtPrice(client, dep, pool.key);
    for (const s of ctx.tracker.strategies.values()) {
      if (s.hooked && !cfg.allowHookedOrders) {
        if (!ctx.skippedHooked.has(s.strategyHash)) {
          ctx.skippedHooked.add(s.strategyHash);
          ctx.log.warn(`skipping strategy ${s.strategyHash.slice(0, 10)}: its order has maker hooks (set ALLOW_HOOKED_ORDERS=true to trade it)`);
        }
        continue;
      }
      const bal = await liveBalances(ctx, pool, s);
      if (!bal) continue;
      for (const dir of ["sell-currency0", "sell-currency1"] as Direction[]) {
        const sell0 = dir === "sell-currency0";
        const sellToken = sell0 ? pool.key.currency0 : pool.key.currency1;
        const info = tokenInfo(dep, sellToken);
        const balanceIn = sell0 ? bal[0] : bal[1];
        const cap = parseUnitsString(cfg.maxAmountIn[info.symbol] ?? DEFAULT_MAX_UNITS, info.decimals);
        let hi = balanceIn < cap ? balanceIn : cap;
        if (hi > MAX_U128) hi = MAX_U128;
        const id = opportunityId(pool, s, dir);
        const base = {
          id,
          pool: pool.symbol,
          poolKey: pool.key,
          strategyHash: s.strategyHash,
          order: { maker: s.order.maker, traits: s.order.traits.toString(), data: s.order.data },
          direction: dir,
          sellToken,
          profitSymbol: info.symbol,
          decimals: info.decimals,
          block: head.toString(),
          scannedAt: now,
        };
        if (hi < 2n) continue;
        const lo = hi / 1_000_000n > 0n ? hi / 1_000_000n : 1n;
        const arb = (amountIn: bigint, minProfit = 0n): ArbParams => ({
          key: pool.key,
          zeroForOne: sell0,
          amountIn,
          minProfit,
          lastBlock: Number(head) + cfg.expiryBlocks,
          profitAsClaim: cfg.profitAsClaim,
          order: s.order,
        });
        const quote = async (x: bigint) => {
          const q = await quoteArb(client, dep, arb(x));
          return q.viable ? q.profit : null;
        };

        // Marginal profit at (almost) zero size is the price gap minus fees. Profit is single-peaked in size, so if
        // a tiny trade loses, every size loses and there is nothing to search.
        const tiny = await quote(lo);
        if (tiny === null || tiny <= 0n) {
          out.push({
            ...base,
            amountIn: lo.toString(),
            quotedProfit: (tiny ?? 0n).toString(),
            gas: "0",
            gasCost: "0",
            netProfit: (tiny ?? 0n).toString(),
            status: "unprofitable",
          });
          continue;
        }
        const best = await searchBestSize(quote, lo, hi, { maxEvals: cfg.maxQuotesPerSearch });
        if (!best || best.profit <= 0n) {
          out.push({ ...base, amountIn: lo.toString(), quotedProfit: tiny.toString(), gas: "0", gasCost: "0", netProfit: tiny.toString(), status: "unprofitable" });
          continue;
        }

        let gas = FALLBACK_GAS;
        try {
          gas = await client.estimateContractGas({
            account: dep.owner,
            address: dep.executor,
            abi: executorAbi,
            functionName: "arb",
            args: [arb(best.amount, applySlippage(best.profit, cfg.slippageBps) || 1n)],
          });
        } catch {
          /* keep the fallback; execution re-simulates anyway */
        }
        const costWei = gasCostWei(gas, gasPrice);
        const costInToken = ctx.wrappedNative ? nativeToToken(costWei, sellToken, ctx.wrappedNative, pool.key, sqrt) : null;
        let status: OpportunityStatus;
        let note: string | undefined;
        let net = best.profit;
        if (costInToken === null) {
          status = "unpriced";
          note = "Cannot convert gas cost into the profit token with this pool, so the bot will not trade it.";
        } else {
          net = best.profit - costInToken;
          const threshold = parseUnitsString(cfg.minNetProfit[info.symbol] ?? "0", info.decimals);
          status = net > 0n && net >= threshold ? "ready" : "below-threshold";
        }
        if (ctx.backoff.get(id) !== undefined && ctx.backoff.get(id)! > now) {
          status = "backoff";
          note = "A recent attempt failed; waiting before trying again.";
        }
        out.push({
          ...base,
          amountIn: best.amount.toString(),
          quotedProfit: best.profit.toString(),
          gas: gas.toString(),
          gasCost: (costInToken ?? 0n).toString(),
          netProfit: net.toString(),
          status,
          note,
        });
      }
    }
  }
  return out.sort((a, b) => (BigInt(b.netProfit) > BigInt(a.netProfit) ? 1 : -1));
}
