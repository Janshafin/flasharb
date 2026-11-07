import { encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { executorAbi } from "../src/abi";
import { decodeQuote, revertData } from "../src/quote";

describe("decodeQuote", () => {
  it("reads profit from InsufficientProfit", () => {
    const data = encodeErrorResult({ abi: executorAbi, errorName: "InsufficientProfit", args: [1_011_606_443_929_680_607n, 1_000_000_000_000_000_000n, (1n << 128n) - 1n] });
    const q = decodeQuote(data);
    expect(q).toEqual({ viable: true, amountBack: 1_011_606_443_929_680_607n, amountOwed: 1_000_000_000_000_000_000n, profit: 11_606_443_929_680_607n });
  });

  it("reports a loss as a negative profit", () => {
    const data = encodeErrorResult({ abi: executorAbi, errorName: "InsufficientProfit", args: [972_231_781_631_463_709n, 1_000_000_000_000_000_000n, 1n] });
    const q = decodeQuote(data);
    expect(q.viable && q.profit).toBe(-27_768_218_368_536_291n);
  });

  it("treats any other executor error as not viable", () => {
    const q = decodeQuote(encodeErrorResult({ abi: executorAbi, errorName: "NotOwner" }));
    expect(q).toEqual({ viable: false, reason: "NotOwner" });
  });

  it("is not viable for empty or unknown data", () => {
    expect(decodeQuote(undefined).viable).toBe(false);
    expect(decodeQuote("0x").viable).toBe(false);
    expect(decodeQuote("0xdeadbeef").viable).toBe(false);
  });
});

describe("revertData", () => {
  it("finds data nested in a cause chain", () => {
    const err = { cause: { cause: { data: "0xc39ba758" } } };
    expect(revertData(err)).toBe("0xc39ba758");
  });
  it("returns undefined when there is none", () => {
    expect(revertData(new Error("boom"))).toBeUndefined();
  });
});
