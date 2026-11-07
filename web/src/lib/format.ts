import { formatUnits } from "viem";

/** 12514098403546826n with 18 decimals -> "0.0125". Keeps `maxFrac` significant places and groups thousands. */
export function fmtUnits(raw: string | bigint, decimals: number, maxFrac = 4): string {
  const v = BigInt(raw);
  const neg = v < 0n;
  const [whole, frac = ""] = formatUnits(neg ? -v : v, decimals).split(".");
  let f = frac.slice(0, maxFrac).replace(/0+$/, "");
  // A tiny non-zero amount should not read as zero.
  if (!f && !BigInt(whole) && (neg ? -v : v) > 0n) f = (frac.match(/^0*[1-9]\d{0,1}/)?.[0] ?? "").replace(/0+$/, "");
  const grouped = BigInt(whole).toLocaleString("en-US");
  return `${neg ? "−" : ""}${grouped}${f ? "." + f : ""}`;
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} seconds ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} days ago`;
}

export const shortHash = (h: string | null | undefined) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "none");

/** Rounds an axis step up to 1, 2 or 5 times a power of ten. */
export function niceStep(rough: number): number {
  if (!(rough > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(rough)));
  const n = rough / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Axis label for a plain number: enough precision to tell small values apart. */
export function axisLabel(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  return a >= 100 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : Number(v.toPrecision(2)).toString();
}
