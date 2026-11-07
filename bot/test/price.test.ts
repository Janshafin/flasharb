import { describe, expect, it } from "vitest";
import { applySlippage, nativeToToken, parseUnitsString, poolId } from "../src/price";

const WETH = "0x00000000000000000000000000000000000000a1" as const;
const USDC = "0x00000000000000000000000000000000000000b2" as const;
const key = { currency0: WETH, currency1: USDC, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" as const };
// sqrtPriceX96 for 3,000 USDC (6 dp) per WETH (18 dp): price raw = 3000e6 / 1e18 = 3e-9
const sqrt3000 = BigInt(Math.floor(Math.sqrt(3e-9) * 2 ** 96));

describe("nativeToToken", () => {
  it("returns the same amount when the profit token is the wrapped native", () => {
    expect(nativeToToken(10n ** 15n, WETH, WETH, key, sqrt3000)).toBe(10n ** 15n);
  });

  it("converts WETH wei to USDC raw units when WETH is currency0", () => {
    const usdc = nativeToToken(10n ** 18n, USDC, WETH, key, sqrt3000)!;
    expect(Number(usdc) / 1e6).toBeGreaterThan(2_990);
    expect(Number(usdc) / 1e6).toBeLessThan(3_010);
  });

  it("converts when WETH is currency1", () => {
    const flipped = { ...key, currency0: USDC, currency1: WETH };
    // price is now WETH per USDC raw = 1e18 / 3000e6
    const sqrt = BigInt(Math.floor(Math.sqrt(1e18 / 3000e6) * 2 ** 96));
    const usdc = nativeToToken(10n ** 18n, USDC, WETH, flipped, sqrt)!;
    expect(Number(usdc) / 1e6).toBeGreaterThan(2_990);
    expect(Number(usdc) / 1e6).toBeLessThan(3_010);
  });

  it("refuses to guess when the pool lacks a token", () => {
    const other = "0x00000000000000000000000000000000000000c3" as const;
    expect(nativeToToken(1n, other, WETH, key, sqrt3000)).toBeNull();
    expect(nativeToToken(1n, USDC, WETH, key, 0n)).toBeNull();
  });
});

describe("units and slippage", () => {
  it("parses decimal strings into raw units", () => {
    expect(parseUnitsString("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseUnitsString("20000", 6)).toBe(20_000_000_000n);
    expect(parseUnitsString("0.0001", 6)).toBe(100n);
    expect(parseUnitsString("0.1234567", 6)).toBe(123_456n);
  });
  it("applies slippage in basis points", () => {
    expect(applySlippage(1000n, 1000)).toBe(900n);
    expect(applySlippage(1000n, 0)).toBe(1000n);
    expect(applySlippage(1000n, 10_000)).toBe(0n);
  });
  it("derives a stable pool id", () => {
    expect(poolId(key)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(poolId(key)).toBe(poolId({ ...key }));
    expect(poolId(key)).not.toBe(poolId({ ...key, fee: 500 }));
  });
});
