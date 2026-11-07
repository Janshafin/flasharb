import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Trade } from "./types";

export class TradeStore {
  private trades: Trade[] = [];
  private file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "trades.jsonl");
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.trades.push(JSON.parse(line) as Trade);
        } catch {
          /* skip a corrupt line instead of refusing to start */
        }
      }
    }
  }

  add(t: Trade): void {
    this.trades.push(t);
    appendFileSync(this.file, JSON.stringify(t) + "\n");
  }

  recent(limit = 50): Trade[] {
    return this.trades.slice(-limit).reverse();
  }

  all(): Trade[] {
    return this.trades;
  }

  /** Cumulative realised profit per hour, per token. Only successful trades count. */
  pnl(now: number, hours = 12): { symbol: string; decimals: number; points: { hour: number; cumulative: string }[] }[] {
    const bySymbol = new Map<string, { decimals: number; byHour: Map<number, bigint> }>();
    for (const t of this.trades) {
      if (t.status !== "success") continue;
      const entry = bySymbol.get(t.profitSymbol) ?? { decimals: t.decimals, byHour: new Map() };
      const h = Math.floor(t.ts / 3_600_000);
      entry.byHour.set(h, (entry.byHour.get(h) ?? 0n) + BigInt(t.realizedProfit));
      bySymbol.set(t.profitSymbol, entry);
    }
    const nowHour = Math.floor(now / 3_600_000);
    return [...bySymbol.entries()].map(([symbol, { decimals, byHour }]) => {
      let cumulative = 0n;
      for (const [h, v] of byHour) if (h < nowHour - hours + 1) cumulative += v;
      const points = [];
      for (let h = nowHour - hours + 1; h <= nowHour; h++) {
        cumulative += byHour.get(h) ?? 0n;
        points.push({ hour: h * 3_600_000, cumulative: cumulative.toString() });
      }
      return { symbol, decimals, points };
    });
  }
}
