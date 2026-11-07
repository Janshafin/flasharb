import { decodeErrorResult, encodeFunctionData, type Hex, type PublicClient } from "viem";
import { executorAbi } from "./abi";
import type { Address, Deployment, Order, PoolKey } from "./types";

export const MAX_U128 = (1n << 128n) - 1n;

export type ArbParams = {
  key: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  minProfit: bigint;
  lastBlock: number;
  profitAsClaim: boolean;
  order: Order;
};

export type Quote =
  | { viable: true; amountBack: bigint; amountOwed: bigint; profit: bigint }
  | { viable: false; reason: string };

/** Finds the revert payload in a viem error chain. */
export function revertData(err: unknown): Hex | undefined {
  let e: any = err;
  for (let i = 0; i < 12 && e; i++) {
    if (typeof e.data === "string" && e.data.startsWith("0x")) return e.data as Hex;
    if (e.data && typeof e.data.data === "string" && e.data.data.startsWith("0x")) return e.data.data as Hex;
    e = e.cause;
  }
  return undefined;
}

/**
 * The executor reverts with InsufficientProfit(amountBack, amountOwed, minProfit) whenever the arb does not clear
 * minProfit. Asking for an unreachable minProfit therefore returns the exact on-chain numbers: profit is
 * amountBack - amountOwed, and it can be negative. Any other revert means this size or direction is not viable.
 */
export function decodeQuote(data: Hex | undefined): Quote {
  if (!data || data === "0x") return { viable: false, reason: "reverted without data" };
  try {
    const err = decodeErrorResult({ abi: executorAbi, data });
    if (err.errorName === "InsufficientProfit") {
      const [amountBack, amountOwed] = err.args as readonly [bigint, bigint, bigint];
      return { viable: true, amountBack, amountOwed, profit: amountBack - amountOwed };
    }
    return { viable: false, reason: err.errorName };
  } catch {
    return { viable: false, reason: `unrecognised revert ${data.slice(0, 10)}` };
  }
}

export async function quoteArb(client: PublicClient, dep: Deployment, arb: ArbParams): Promise<Quote> {
  const data = encodeFunctionData({ abi: executorAbi, functionName: "arb", args: [{ ...arb, minProfit: MAX_U128 }] });
  try {
    await client.call({ account: dep.owner as Address, to: dep.executor, data });
    return { viable: false, reason: "quote did not revert" };
  } catch (e) {
    return decodeQuote(revertData(e));
  }
}
