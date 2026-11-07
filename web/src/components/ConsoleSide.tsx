import type { Claim } from "../lib/api";
import type { Log } from "../lib/console";
import { fmtUnits } from "../lib/format";

const PHASES = ["Prepare the trade", "Simulate on live state", "Sign in your wallet", "Wait for confirmation"];

/** The four steps of a trade. `phase` is -1 when idle, 0..3 while running and 4 when done. */
export function Progress({ phase, failed }: { phase: number; failed: boolean }) {
  const state = (i: number) => (phase === 4 || phase > i ? "Done" : phase === i ? (failed ? "Failed" : "Running") : "Waiting");
  return (
    <section>
      <h2>Progress</h2>
      <ol className="track" aria-live="polite">
        {PHASES.map((p, i) => (
          <li key={p} data-state={state(i).toLowerCase()}><span className="stn">{state(i) === "Done" ? "✓" : i + 1}</span><b>{p}</b><em>{state(i)}</em></li>
        ))}
      </ol>
    </section>
  );
}

export function LogList({ logs }: { logs: Log[] }) {
  return (
    <section>
      <h2>Log</h2>
      {logs.length === 0 ? <p className="note">Nothing yet. Simulate a trade to see the result here.</p> : (
        <ul className="log">
          {logs.map((l, i) => (
            <li key={i} className={l.level}><time>{l.t}</time><span>{l.msg}{l.href && <> <a href={l.href} target="_blank" rel="noreferrer">View transaction</a></>}</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The executor's ERC-6909 claims, read by the bot. Withdraw hands one to the Maintenance form. */
export function Claims({ claims, error, connected, onWithdraw }: {
  claims?: Claim[]; error?: string; connected: boolean; onWithdraw: (c: Claim) => void;
}) {
  return (
    <section>
      <h2>Claims</h2>
      {claims ? (
        <ul className="claims">
          {claims.map((c) => (
            <li key={c.address}>
              <span><b>{c.symbol}</b> {fmtUnits(c.claim, c.decimals, 6)}</span>
              <button type="button" className="btn small" disabled={BigInt(c.claim) === 0n || !connected} onClick={() => onWithdraw(c)}>Withdraw</button>
            </li>
          ))}
        </ul>
      ) : <p className="note">{error ? "Claims appear here when the bot is running." : "Loading claims."}</p>}
      <p className="note">These are ERC-6909 claims held by the executor inside the PoolManager. They are not ERC-20 tokens in your wallet and MetaMask does not show them. Withdraw turns a claim into tokens sent to the recipient; it fills the form below, check it, then send.</p>
    </section>
  );
}
