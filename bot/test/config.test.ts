import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadDotenv, parseConfig } from "../src/config";

const KEY = "0x" + "ab".repeat(32);

describe("parseConfig", () => {
  it("defaults to a safe dry run", () => {
    const c = parseConfig({});
    expect(c.dryRun).toBe(true);
    expect(c.chainId).toBe(31337);
    expect(c.pollMs).toBe(3000);
    expect(c.profitAsClaim).toBe(true);
    expect(c.allowHookedOrders).toBe(false);
  });

  it("requires a valid key to send transactions", () => {
    expect(() => parseConfig({ DRY_RUN: "false" })).toThrow(/OWNER_PRIVATE_KEY is required/);
    expect(() => parseConfig({ DRY_RUN: "false", OWNER_PRIVATE_KEY: "0x123" })).toThrow(/64 hex/);
    expect(parseConfig({ DRY_RUN: "false", OWNER_PRIVATE_KEY: KEY }).ownerKey).toBe(KEY);
  });

  it("lists every problem at once", () => {
    try {
      parseConfig({ RPC_URL: "ws://x", POLL_MS: "5", PORT: "70000", SLIPPAGE_BPS: "20000" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const p = (e as ConfigError).problems;
      expect(p.length).toBe(4);
    }
  });

  it("reads per-token limits by symbol", () => {
    const c = parseConfig({ MIN_NET_PROFIT_WETH: "0.0005", MAX_AMOUNT_IN_USDC: "20000" });
    expect(c.minNetProfit).toEqual({ WETH: "0.0005" });
    expect(c.maxAmountIn).toEqual({ USDC: "20000" });
    expect(() => parseConfig({ MIN_NET_PROFIT_WETH: "lots" })).toThrow(/decimal number/);
  });

  it("never exposes the key in the thrown message", () => {
    try {
      parseConfig({ DRY_RUN: "false", OWNER_PRIVATE_KEY: "0x" + "cd".repeat(31) });
    } catch (e) {
      expect(String(e)).not.toContain("cdcdcd");
    }
  });
});

describe("loadDotenv", () => {
  it("fills missing variables and keeps existing ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "flasharb-"));
    const file = join(dir, ".env");
    writeFileSync(file, "# comment\nRPC_URL=http://from-file\nPORT='9999'\nEMPTY\n");
    const env: NodeJS.ProcessEnv = { PORT: "1234" };
    loadDotenv(file, env);
    expect(env.RPC_URL).toBe("http://from-file");
    expect(env.PORT).toBe("1234");
  });
});
