import { useEffect, useRef, useState } from "react";

/** Where the searcher bot's HTTP API lives. */
export const BOT_API: string = (import.meta.env.VITE_BOT_API_URL as string | undefined) ?? "http://127.0.0.1:8787";

// Mirrors bot/src/types.ts and bot/src/server.ts. Every bigint arrives as a decimal string.
export type PoolKey = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
export type Token = { address: string; symbol: string; decimals: number };
export type Status = {
  chainId: number; block: string; executor: string; owner: string | null; poolManager: string; aqua: string; router: string;
  tokens: Token[]; pools: { symbol: string; key: PoolKey }[]; botAddress: string | null; dryRun: boolean; stopped: boolean;
  profitAsClaim: boolean; lastError: string | null; lastScanAt: number | null; scanCount: number; uptimeMs: number;
};
export type OppStatus = "ready" | "below-threshold" | "unprofitable" | "unpriced" | "backoff";
export type Opportunity = {
  id: string; pool: string; poolKey: PoolKey; strategyHash: string; order: { maker: string; traits: string; data: string };
  direction: "sell-currency0" | "sell-currency1"; sellToken: string; profitSymbol: string; decimals: number;
  amountIn: string; quotedProfit: string; gas: string; gasCost: string; netProfit: string; status: OppStatus; note?: string;
  block: string; scannedAt: number;
};
export type Trade = {
  id: string; ts: number; block: string; txHash: string | null; pool: string; direction: string; profitSymbol: string;
  profitToken: string; decimals: number; amountIn: string; quotedProfit: string; minProfit: string; realizedProfit: string;
  gasUsed: string; effectiveGasPrice: string; status: "success" | "reverted" | "failed"; error?: string;
};
export type PnlSeries = { symbol: string; decimals: number; points: { hour: number; cumulative: string }[] };
export type Claim = { symbol: string; address: string; decimals: number; claim: string; held: string };

export type Polled<T> = { data?: T; error?: string; loading: boolean; updatedAt?: number };

/**
 * Polls a bot endpoint. Polling pauses while the tab is hidden, and the last good data stays on screen if a later
 * request fails, so a short outage does not blank the dashboard.
 */
export function usePoll<T>(path: string, ms = 3000): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ loading: true });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.hidden) { timer = setTimeout(tick, ms); return; }
      try {
        const r = await fetch(`${BOT_API}${path}`, { cache: "no-store" });
        if (!r.ok) throw new Error(`The bot answered ${r.status}.`);
        const data = (await r.json()) as T;
        if (alive.current) setState({ data, loading: false, updatedAt: Date.now() });
      } catch (e) {
        const msg = e instanceof TypeError ? "Cannot reach the bot." : e instanceof Error ? e.message : "Request failed.";
        if (alive.current) setState((s) => ({ ...s, error: msg, loading: false }));
      }
      timer = setTimeout(tick, ms);
    };
    tick();
    const onVisible = () => { if (!document.hidden) { if (timer) clearTimeout(timer); tick(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive.current = false; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [path, ms]);
  return state;
}
