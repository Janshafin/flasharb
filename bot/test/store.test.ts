import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TradeStore } from "../src/store";
import type { Trade } from "../src/types";

const HOUR = 3_600_000;
const trade = (ts: number, profit: string, status: Trade["status"] = "success"): Trade => ({
  id: String(ts), ts, block: "1", txHash: null, pool: "WETH/USDC", direction: "sell-currency0", profitSymbol: "WETH",
  profitToken: "0x00000000000000000000000000000000000000a1", decimals: 18, amountIn: "1", quotedProfit: profit,
  minProfit: "1", realizedProfit: profit, gasUsed: "1", effectiveGasPrice: "1", status,
});

describe("TradeStore", () => {
  it("persists trades across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "flasharb-store-"));
    const a = new TradeStore(dir);
    a.add(trade(1000, "5"));
    a.add(trade(2000, "7"));
    const b = new TradeStore(dir);
    expect(b.all().length).toBe(2);
    expect(b.recent(1)[0].realizedProfit).toBe("7");
  });

  it("buckets realised profit into cumulative hourly points and ignores failures", () => {
    const store = new TradeStore(mkdtempSync(join(tmpdir(), "flasharb-pnl-")));
    const now = 100 * HOUR + 1234;
    store.add(trade(98 * HOUR + 5, "10"));
    store.add(trade(98 * HOUR + 9, "5"));
    store.add(trade(100 * HOUR, "20"));
    store.add(trade(99 * HOUR, "999", "failed"));
    const [series] = store.pnl(now, 4);
    expect(series.symbol).toBe("WETH");
    expect(series.points.map((p) => p.cumulative)).toEqual(["0", "15", "15", "35"]);
    expect(series.points.length).toBe(4);
  });

  it("counts profit older than the window in the starting total", () => {
    const store = new TradeStore(mkdtempSync(join(tmpdir(), "flasharb-pnl2-")));
    store.add(trade(10 * HOUR, "100"));
    const [series] = store.pnl(100 * HOUR, 3);
    expect(series.points[0].cumulative).toBe("100");
  });

  it("skips a corrupt line instead of refusing to start", () => {
    const dir = mkdtempSync(join(tmpdir(), "flasharb-bad-"));
    const s = new TradeStore(dir);
    s.add(trade(1, "1"));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").appendFileSync(join(dir, "trades.jsonl"), "{not json\n");
    expect(new TradeStore(dir).all().length).toBe(1);
  });
});
