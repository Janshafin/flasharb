import type { Trade } from "./api";

const KEY = "flasharb.mytrades.v1";

/** Trades sent from this browser's console. The bot cannot see them (the executor emits no event), so they live here. */
export function getMyTrades(): Trade[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]") as Trade[]; } catch { return []; }
}

export function addMyTrade(t: Trade): void {
  try { localStorage.setItem(KEY, JSON.stringify([t, ...getMyTrades()].slice(0, 50))); } catch { /* history is a convenience */ }
}
