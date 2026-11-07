import { concat, encodeAbiParameters, keccak256, toHex, type PublicClient } from "viem";
import { poolManagerAbi } from "./abi";
import type { Address, Deployment, PoolKey } from "./types";

const POOLS_SLOT = toHex(6n, { size: 32 }); // StateLibrary.POOLS_SLOT in v4-core v4.0.0

export function poolId(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** Reads slot0's sqrtPriceX96 straight from PoolManager storage (StateLibrary.getSlot0 without an extra contract). */
export async function readSqrtPrice(client: PublicClient, dep: Deployment, key: PoolKey): Promise<bigint> {
  const slot = keccak256(concat([poolId(key), POOLS_SLOT]));
  const data = await client.readContract({ address: dep.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot] });
  return BigInt(data) & ((1n << 160n) - 1n);
}

export function gasCostWei(gas: bigint, gasPrice: bigint): bigint {
  return gas * gasPrice;
}

/**
 * Converts an amount of the wrapped-native token (what gas is paid in) into `profitToken` raw units using the pool's
 * price. Returns null when the pool does not contain both tokens, so the caller can refuse to guess.
 */
export function nativeToToken(
  wei: bigint,
  profitToken: Address,
  wrappedNative: Address,
  key: PoolKey,
  sqrtPriceX96: bigint,
): bigint | null {
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
  if (same(profitToken, wrappedNative)) return wei;
  const inPool = (t: Address) => same(t, key.currency0) || same(t, key.currency1);
  if (!inPool(profitToken) || !inPool(wrappedNative) || sqrtPriceX96 === 0n) return null;
  const priceX192 = sqrtPriceX96 * sqrtPriceX96; // token1 per token0, Q192
  return same(wrappedNative, key.currency0) ? (wei * priceX192) >> 192n : (wei << 192n) / priceX192;
}

/** Parses "1.5" into raw units for a token with `decimals`. */
export function parseUnitsString(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function applySlippage(profit: bigint, slippageBps: number): bigint {
  return (profit * BigInt(10_000 - slippageBps)) / 10_000n;
}
