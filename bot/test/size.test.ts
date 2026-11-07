import { describe, expect, it } from "vitest";
import { searchBestSize } from "../src/size";

// A concave profit curve like the executor's: gap * x minus a quadratic price impact, peaking at x = 1_000_000.
const concave = async (x: bigint) => 2_000_000n * x - x * x;

describe("searchBestSize", () => {
  it("finds the peak of a concave curve within tolerance", async () => {
    const r = await searchBestSize(async (x) => concave(x), 1n, 10_000_000n, { maxEvals: 40, tolBps: 10 });
    expect(r).not.toBeNull();
    expect(Number(r!.amount)).toBeGreaterThan(950_000);
    expect(Number(r!.amount)).toBeLessThan(1_050_000);
  });

  it("uses far fewer quotes than a scan", async () => {
    let calls = 0;
    await searchBestSize(async (x) => { calls++; return concave(x); }, 1n, 10_000_000n, { maxEvals: 24 });
    expect(calls).toBeLessThanOrEqual(28);
  });

  it("returns the best point when the curve only rises", async () => {
    const r = await searchBestSize(async (x) => x * 3n, 10n, 1000n);
    expect(r!.amount).toBe(1000n);
  });

  it("returns the smallest size when the curve only falls", async () => {
    const r = await searchBestSize(async (x) => -x, 10n, 1000n);
    expect(r!.amount).toBe(10n);
  });

  it("treats unquotable sizes as the worst value and shrinks towards small sizes", async () => {
    // Only sizes up to 5_000 can be quoted; profit rises with size there.
    const f = async (x: bigint) => (x <= 5_000n ? x : null);
    const r = await searchBestSize(f, 1n, 1_000_000n, { maxEvals: 40, tolBps: 10 });
    expect(r).not.toBeNull();
    expect(r!.amount).toBeLessThanOrEqual(5_000n);
    expect(r!.amount).toBeGreaterThan(2_000n);
  });

  it("returns null when nothing can be quoted", async () => {
    expect(await searchBestSize(async () => null, 1n, 1000n)).toBeNull();
  });

  it("rejects an empty or inverted range", async () => {
    expect(await searchBestSize(async () => 1n, 0n, 10n)).toBeNull();
    expect(await searchBestSize(async () => 1n, 10n, 5n)).toBeNull();
  });
});
