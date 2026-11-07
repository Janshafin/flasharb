import { fmtUnits } from "../lib/format";
import type { Token } from "../lib/api";

export type Step = { depth: number; type: string; from: string; to: string; call: string; gasUsed: string; error?: string };
export type Ev = { contract: string; name: string; args: Record<string, string> };
export type ProofData = {
  network: { chainId: number; kind: "local-anvil" | "live" };
  tx: { hash: string; from: string; block: string; status: string; gasUsed: string; effectiveGasPrice: string; gasCostWei: string };
  kind: "arb" | "withdrawClaim" | string;
  arb?: { pair: string; fee: number; tickSpacing: number; hooks: string; sold: string; amountIn: string; minProfit: string; lastBlock: number; profitAsClaim: boolean; maker: string };
  withdraw?: { amount: string; to: string };
  contracts: Record<"executor" | "poolManager" | "aqua" | "router", { address: string; codeBytes: number }>;
  token: Token;
  balances: { claimBefore: string; claimAfter: string; holder: string; heldBefore: string; heldAfter: string };
  profit?: { realized: string; quoted: string | null; quotedBy: string; gasCostInToken: string | null; gasAdjusted: string | null };
  events: Ev[];
  trace: { available: boolean; reason?: string; steps: Step[] };
};

const abs = (v: string) => (v.startsWith("-") ? v.slice(1) : v);
/** Which protocol a contract label belongs to, for the colour of its rows. */
export const side = (name: string) => (name.startsWith("Uniswap") ? "uni" : name.startsWith("1inch") ? "inch" : name === "FlashArbExecutor" ? "exec" : "tok");

/** The two protocol legs and the settlement, with amounts taken from the receipt's own events. */
export function Flow({ p, tokens }: { p: ProofData; tokens: Token[] }) {
  const dec = (sym: string) => tokens.find((t) => t.symbol === sym)?.decimals ?? 18;
  const swap = p.events.find((e) => e.name === "Swap");
  const pulled = p.events.find((e) => e.name === "Pulled");
  const pushed = p.events.find((e) => e.name === "Pushed");
  const minted = p.events.find((e) => e.name === "Transfer (ERC-6909 claim)");
  const [c0, c1] = (p.arb?.pair ?? "/").split("/");
  const sold0 = swap && swap.args.amount0.startsWith("-");
  const got = swap && (sold0 ? { sym: c1, v: swap.args.amount1 } : { sym: c0, v: swap.args.amount0 });
  const paid = swap && (sold0 ? { sym: c0, v: swap.args.amount0 } : { sym: c1, v: swap.args.amount1 });
  const amt = (v: string, sym: string) => `${fmtUnits(abs(v), dec(sym), 6)} ${sym}`;
  return (
    <ol className="flow" aria-label="Trade flow">
      <li className="leg uni">
        <b>1. Uniswap v4</b>
        <span>{paid && got ? <>Sold {amt(paid.v, paid.sym)} for {amt(got.v, got.sym)} in <code>PoolManager.swap</code>. Nothing moved yet: flash accounting only recorded the debt.</> : "No Swap event in this receipt."}</span>
      </li>
      <li className="leg inch">
        <b>2. 1inch SwapVM and Aqua</b>
        <span>{pulled && pushed ? <>The SwapVM router priced the maker's Aqua strategy. Aqua pulled {amt(pulled.args.amount, pulled.args.token)} from the maker into the PoolManager and pushed {amt(pushed.args.amount, pushed.args.token)} to the maker.</> : "No Aqua Pulled/Pushed events in this receipt."}</span>
      </li>
      <li className="leg settle">
        <b>3. Settle in one unlock</b>
        <span>{minted ? <>Both debts closed with <code>sync</code> and <code>settle</code>. The spread, {amt(minted.args.amount, p.token.symbol)}, was minted to the executor as an ERC-6909 claim.</> : p.profit ? <>Both debts closed; the spread was paid out with <code>take</code>.</> : "Not an arbitrage."}</span>
      </li>
    </ol>
  );
}

export function Trace({ t }: { t: ProofData["trace"] }) {
  if (!t.available) return <p className="note">{t.reason} The receipt events above still show which contracts ran.</p>;
  return (
    <ol className="trace" aria-label="Call trace">
      {t.steps.map((s, i) => (
        <li key={i} className={side(s.to)} style={{ ["--d" as string]: s.depth }}>
          <span><b>{s.to}</b>.{s.call}</span><em>{Number(s.gasUsed).toLocaleString()} gas{s.error ? `, ${s.error}` : ""}</em>
        </li>
      ))}
    </ol>
  );
}

export function Events({ evs }: { evs: Ev[] }) {
  return (
    <table className="plain evs">
      <caption className="sr">Events in the receipt</caption>
      <thead><tr><th scope="col">Contract</th><th scope="col">Event</th><th scope="col">Arguments</th></tr></thead>
      <tbody>{evs.map((e, i) => (
        <tr key={i}><td>{e.contract}</td><td>{e.name}</td><td className="args">{Object.entries(e.args).map(([k, v]) => `${k} ${v.length > 24 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v}`).join(", ")}</td></tr>
      ))}</tbody>
    </table>
  );
}
