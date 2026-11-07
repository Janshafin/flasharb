import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { ago, axisLabel, fmtUnits, niceStep, shortHash } from "../lib/format";
import { getMyTrades } from "../lib/mytrades";
import {
  usePoll, type Opportunity, type OppStatus, type PnlSeries, type Status, type Trade,
} from "../lib/api";

// Call-frame gas from snapshots/FlashArbExecutor.json (forge test), Solidity reference build.
const TEST_GAS = [
  { label: "First trade, profit kept as a claim", gas: 219380 },
  { label: "First trade, profit sent to your wallet", gas: 203122 },
  { label: "Later trade, claim", gas: 185148 },
  { label: "Later trade, sent to your wallet", gas: 185990 },
];

const STATUS_TEXT: Record<OppStatus, string> = {
  ready: "Ready",
  "below-threshold": "Below your minimum",
  backoff: "Waiting after a failed try",
  unpriced: "Gas cannot be priced",
  unprofitable: "No gap",
};

/** Everything the console needs to run an opportunity, handed over through localStorage. */
function loadIntoForm(op: Opportunity, status: Status) {
  const amountIn = formatUnits(BigInt(op.amountIn), op.decimals);
  const minProfit = formatUnits((BigInt(op.quotedProfit) * 9000n) / 10000n || 1n, op.decimals);
  const prefill = {
    executor: status.executor,
    c0: op.poolKey.currency0, c1: op.poolKey.currency1,
    fee: String(op.poolKey.fee), tickSpacing: String(op.poolKey.tickSpacing), hooks: op.poolKey.hooks,
    zeroForOne: op.direction === "sell-currency0",
    amountIn, minProfit, decimals: String(op.decimals),
    profitAsClaim: status.profitAsClaim,
    order: JSON.stringify({ maker: op.order.maker, traits: op.order.traits, data: op.order.data }, null, 2),
    note: `Loaded ${op.pool}, selling ${op.profitSymbol}, from the bot's scan at block ${op.block}.`,
    quote: { quotedProfit: op.quotedProfit, gas: op.gas, gasCost: op.gasCost, netProfit: op.netProfit, symbol: op.profitSymbol, pool: op.pool, block: op.block },
  };
  try { localStorage.setItem("flasharb.prefill", JSON.stringify(prefill)); } catch { /* the console starts empty */ }
  location.hash = "#/app/execute";
}

function Chart({ series }: { series: PnlSeries }) {
  const data = series.points.map((p) => Number(formatUnits(BigInt(p.cumulative), series.decimals)));
  const W = 720, H = 220, L = 52, B = 28, T = 16, R = 70;
  const max = Math.max(...data, 0);
  const step = niceStep((max || 1) / 4);
  const top = step * 4;
  const x = (i: number) => L + (i / Math.max(1, data.length - 1)) * (W - L - R);
  const y = (v: number) => H - B - (v / top) * (H - B - T);
  const line = data.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const last = data.length - 1;
  const [hi, setHi] = useState<number | null>(null);
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHi(Math.max(0, Math.min(last, Math.round(((px - L) / (W - L - R)) * last))));
  };
  const label = (v: number) => `${axisLabel(v)} ${series.symbol}`;
  const endLabel = fmtUnits(series.points[last].cumulative, series.decimals, 4);
  return (
    <div className="chart-wrap">
      <svg
        tabIndex={0} viewBox={`0 0 ${W} ${H}`} className="chart" role="img"
        aria-label={`Cumulative realised profit in ${series.symbol} over 12 hours, now ${endLabel}`}
        onFocus={() => setHi((h) => h ?? last)} onBlur={() => setHi(null)} onPointerMove={move} onPointerLeave={() => setHi(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); setHi((h) => Math.max(0, (h ?? last) - 1)); }
          if (e.key === "ArrowRight") { e.preventDefault(); setHi((h) => Math.min(last, (h ?? last) + 1)); }
          if (e.key === "Escape") setHi(null);
        }}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(step * i)} y2={y(step * i)} stroke="#000" strokeOpacity=".15" />
            <text x={L - 8} y={y(step * i) + 4} textAnchor="end">{axisLabel(step * i)}</text>
          </g>
        ))}
        <text x={L} y={H - 6}>12 hours ago</text>
        <text x={W - R} y={H - 6} textAnchor="end">Now</text>
        <polygon points={`${L},${H - B} ${line} ${x(last)},${H - B}`} fill="var(--yellow)" />
        <polyline points={line} fill="none" stroke="#000" strokeWidth="3" strokeLinejoin="round" pathLength={1} className="draw" />
        <rect x={x(last) - 5} y={y(data[last]) - 5} width="10" height="10" fill="var(--red)" />
        {hi !== null && (
          <g>
            <line className="hoverline" x1={x(hi)} x2={x(hi)} y1={T} y2={H - B} />
            <circle cx={x(hi)} cy={y(data[hi])} r="5" fill="var(--white)" stroke="#000" strokeWidth="3" />
            <text className="readout" x={Math.min(x(hi) + 10, W - R - 120)} y={T + 10}>{`${last - hi === 0 ? "Now" : `${last - hi} h ago`}: ${label(data[hi])}`}</text>
          </g>
        )}
      </svg>
      <p className="note">
        {max === 0 ? "No profit has been realised in this window yet." : `Realised profit rose to ${endLabel} ${series.symbol}. `}
        Focus the chart and use the left and right arrow keys to read each hour. The chart shows the bot's trades; the profit tile also counts trades sent from this console.
      </p>
      <details className="datatable"><summary>Show the data as a table</summary>
        <table className="plain"><caption className="sr">Cumulative realised profit by hour</caption>
          <thead><tr><th scope="col">Hours ago</th><th scope="col" className="r">{series.symbol}</th></tr></thead>
          <tbody>{series.points.map((p, i) => <tr key={p.hour}><td>{last - i === 0 ? "Now" : last - i}</td><td className="r">{fmtUnits(p.cumulative, series.decimals, 6)}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

function Offline({ error }: { error?: string }) {
  return (
    <div className="stack">
      <header className="head"><h1>Overview</h1></header>
      <div className="empty">
        <h2>The bot is not running</h2>
        <p>{error ?? "Waiting for the bot."} The dashboard shows live data from the searcher bot, and has none to show without it. Start the local demo and the bot:</p>
        <pre>{"scripts/demo-chain.sh\ncd bot && npm start"}</pre>
        <p>The bot listens on 127.0.0.1:8787. Set VITE_BOT_API_URL if yours is elsewhere. This page checks again every few seconds.</p>
      </div>
    </div>
  );
}

export default function Monitor() {
  const status = usePoll<Status>("/api/status");
  const opps = usePoll<{ opportunities: Opportunity[]; scannedAt: number | null }>("/api/opportunities");
  const trades = usePoll<{ trades: Trade[] }>("/api/trades?limit=20");
  const pnl = usePoll<{ series: PnlSeries[] }>("/api/pnl", 10_000);
  const [pick, setPick] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const s = status.data;
  const list = opps.data?.opportunities ?? [];
  const live = list.filter((o) => o.status !== "unprofitable");
  const noGap = list.length - live.length;
  const mine = getMyTrades();
  const myIds = new Set(mine.map((t) => t.id));
  const tr = [...mine, ...(trades.data?.trades ?? [])].sort((a, b) => b.ts - a.ts);
  const settled = tr.filter((t) => t.status === "success");
  const series = pnl.data?.series ?? [];
  const cur = series[Math.min(pick, Math.max(0, series.length - 1))];
  const avgGas = useMemo(() => (settled.length ? Math.round(settled.reduce((a, t) => a + Number(t.gasUsed), 0) / settled.length) : 0), [settled]);

  if (!s) return <Offline error={status.error} />;

  const mode = s.stopped ? "Stopped by the STOP file. The bot finds trades but sends none." : s.dryRun ? "Dry run. The bot finds trades but sends none." : "Live. The bot sends a trade as soon as one pays.";
  const consoleProfit = (sym: string) => mine.filter((t) => t.status === "success" && t.profitSymbol === sym).reduce((a, t) => a + BigInt(t.realizedProfit), 0n);
  const totalProfit = cur ? fmtUnits(BigInt(cur.points[cur.points.length - 1].cumulative) + consoleProfit(cur.symbol), cur.decimals, 4) : (mine.length ? fmtUnits(consoleProfit(mine[0].profitSymbol), mine[0].decimals, 4) : "0");

  return (
    <div className="stack">
      <header className="head">
        <h1>Overview</h1>
        <p className="live"><span className={`dot ${status.error ? "down" : ""}`} aria-hidden="true" />
          {status.error ? `Lost contact with the bot (${status.error}) Showing the last data.` : `Connected to the bot on chain ${s.chainId}, block ${s.block}, scanned ${ago(s.lastScanAt)}.`} {mode}
        </p>
        {s.lastError && <p className="callout bad">The bot's last error: {s.lastError}</p>}
      </header>

      <dl className="tiles">
        <div className="tile t-profit"><dt>Realised profit{cur ? `, ${cur.symbol}` : mine.length ? `, ${mine[0].profitSymbol}` : ""}</dt><dd>{totalProfit}</dd></div>
        <div className="tile t-settled"><dt>Trades that settled</dt><dd>{settled.length} of {tr.length}</dd></div>
        <div className="tile t-gas"><dt>Average gas per settled trade</dt><dd>{avgGas ? avgGas.toLocaleString() : "none yet"}</dd></div>
      </dl>

      <section>
        <h2>Profit over 12 hours</h2>
        {series.length > 1 && (
          <div className="seg tabs" role="group" aria-label="Profit token">
            {series.map((x, i) => <button type="button" key={x.symbol} aria-pressed={i === pick} onClick={() => setPick(i)}>{x.symbol}</button>)}
          </div>
        )}
        {cur ? <Chart series={cur} /> : <p className="note">No trades have settled yet, so there is no profit to chart. The chart appears after the first one.</p>}
      </section>

      <section>
        <h2>Opportunities</h2>
        {live.length === 0 ? (
          <p className="note">No route has a price gap right now. The bot checks {s.pools.length} pool{s.pools.length === 1 ? "" : "s"} every few seconds{noGap ? `; ${noGap} route${noGap === 1 ? " has" : "s have"} no gap` : ""}.</p>
        ) : (
          <div className="tw"><table className="plain">
            <thead><tr><th scope="col">Pool</th><th scope="col">Route</th><th scope="col" className="r">Amount in</th><th scope="col" className="r">Expected profit</th><th scope="col" className="r">Gas cost</th><th scope="col" className="r">Net</th><th scope="col">Status</th><th scope="col"><span className="sr">Action</span></th></tr></thead>
            <tbody>{live.map((o, i) => (
              <tr key={o.id} style={{ ["--i" as string]: i }}>
                <td>{o.pool}</td>
                <td>Sell {o.profitSymbol} on v4, buy back from Aqua</td>
                <td className="r">{fmtUnits(o.amountIn, o.decimals)} {o.profitSymbol}</td>
                <td className="r">{fmtUnits(o.quotedProfit, o.decimals)}</td>
                <td className="r">{fmtUnits(o.gasCost, o.decimals)}</td>
                <td className={`r ${BigInt(o.netProfit) < 0n ? "neg" : ""}`}>{fmtUnits(o.netProfit, o.decimals)}</td>
                <td>{o.status === "ready" ? <mark className="ready">{STATUS_TEXT[o.status]}</mark> : STATUS_TEXT[o.status]}</td>
                <td><button type="button" className="btn small" onClick={() => loadIntoForm(o, s)}>Load into form</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {live.some((o) => o.note) && <p className="note">{live.find((o) => o.note)?.note}</p>}
      </section>

      <section>
        <h2>Recent trades</h2>
        {tr.length === 0 ? <p className="note">The bot has not sent a trade yet. {s.dryRun ? "It is in dry-run mode; set DRY_RUN=false to let it send." : "It sends the first one as soon as a route pays after gas."}</p> : (
          <div className="tw"><table className="plain">
            <thead><tr><th scope="col">Transaction</th><th scope="col">When</th><th scope="col">Pool</th><th scope="col" className="r">Amount in</th><th scope="col" className="r">Profit</th><th scope="col" className="r">Gas</th><th scope="col">Result</th></tr></thead>
            <tbody>{tr.map((t, i) => (
              <tr key={t.id} style={{ ["--i" as string]: i }}>
                <td className="code">{shortHash(t.txHash)}</td>
                <td>{ago(t.ts)}</td>
                <td>{t.pool}</td>
                <td className="r">{fmtUnits(t.amountIn, t.decimals)} {t.profitSymbol}</td>
                <td className="r">{t.status === "success" ? `${fmtUnits(t.realizedProfit, t.decimals)} ${t.profitSymbol}` : "none"}</td>
                <td className="r">{t.status === "success" || t.status === "reverted" ? Number(t.gasUsed).toLocaleString() : "none"}</td>
                <td className={t.status === "success" ? "" : "neg"}>{t.status === "success" ? "Settled" : t.status === "reverted" ? "Reverted on-chain" : `Not sent: ${t.error ?? "failed"}`}{myIds.has(t.id) ? " (sent from this console)" : ""}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section>
        <h2>Gas per trade</h2>
        <p className="note">The first four rows were measured in the Solidity reference build with forge test. {avgGas ? "The last row is the average of your settled trades on this chain." : "Your own average appears here after the first settled trade."}</p>
        <div className="bars">
          {[...TEST_GAS, ...(avgGas ? [{ label: "Your settled trades, average", gas: avgGas }] : [])].map((r) => (
            <div className="bar-row" key={r.label}>
              <span>{r.label}</span>
              <span className="bar-meter"><i style={{ width: `${Math.min(100, (r.gas / 230000) * 100)}%` }} /></span>
              <span className="r">{r.gas.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
