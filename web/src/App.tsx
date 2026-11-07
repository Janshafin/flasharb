import { useEffect, useState } from "react";
import Landing from "./components/Landing";
import Monitor from "./components/Monitor";
import Execute from "./components/Execute";
import Proof from "./components/Proof";
import { WalletProvider, chains, short, useWallet } from "./lib/wallet";
import { fmtUnits } from "./lib/format";
import { BOT_API } from "./lib/api";

type Route = "home" | "monitor" | "execute" | "proof";
const parse = (): Route =>
  location.hash.startsWith("#/app/execute") ? "execute" : location.hash.startsWith("#/app/proof") ? "proof" : location.hash.startsWith("#/app") ? "monitor" : "home";

function useRoute() {
  const [r, setR] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setR((prev) => {
      const next = parse();
      if (next !== prev) window.scrollTo(0, 0);
      return next;
    });
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

function Wallet() {
  const w = useWallet();
  const err = w.error && <span className="wallet-err" role="alert">{w.error}</span>;
  if (!w.hasProvider) return <span className="wallet-err">No browser wallet found</span>;
  if (!w.account) {
    return (
      <span className="wallet">
        <button className="btn small" disabled={w.pending} onClick={() => w.connect()}>{w.pending ? "Check your wallet" : "Connect wallet"}</button>
        {err}
      </span>
    );
  }
  return (
    <span className="wallet">
      <select aria-label="Network" value={w.chain?.id ?? ""} disabled={w.pending} onChange={(e) => { const c = chains.find((x) => x.id === Number(e.target.value)); if (c) w.switchTo(c); }}>
        {!w.chain && <option value="">Unsupported network ({w.chainId})</option>}
        {chains.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <span className="addr" title={w.account}>{short(w.account)}</span>
      {w.balance !== undefined && <span className="addr">{fmtUnits(w.balance.toString(), 18, 4)} ETH</span>}
      <button className="btn small" onClick={w.disconnect}>Disconnect</button>
      {err}
    </span>
  );
}

function Bar({ route }: { route: Route }) {
  return (
    <header className={`bar ${route === "home" ? "bar-home" : ""}`}>
      <a href="#/" className="word"><img src="/flasharb-icon.png" width="34" height="34" alt="" />flasharb</a>
      <nav aria-label="Main">
        {route === "home" ? (
          <>
            <a href="#settle">How it works</a>
            <a href="#/app">Dashboard</a>
            <a className="btn small yellow" href="#/app/execute">Run a trade</a>
          </>
        ) : (
          <>
            <a href="#/app" aria-current={route === "monitor" ? "page" : undefined}>Overview</a>
            <a href="#/app/execute" aria-current={route === "execute" ? "page" : undefined}>Run a trade</a>
            <a href="#/app/proof" aria-current={route === "proof" ? "page" : undefined}>Proof</a>
            <a href="#/">Home</a>
            <Wallet />
          </>
        )}
      </nav>
    </header>
  );
}

/** A hosted copy (for example on Vercel) cannot reach the bot, which runs on the developer's own computer. */
function HostedNotice() {
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
  if (local || !/127\.0\.0\.1|localhost/.test(BOT_API)) return null;
  return (
    <p className="callout bad hosted" role="alert">
      This is a hosted copy of the dashboard, so it cannot reach the searcher bot: the bot and the local chain run on the
      demo computer. To use the app, clone the repository and run <code>./flasharb.sh</code>, then open
      {" "}<a href="http://127.0.0.1:5173/#/app">http://127.0.0.1:5173/#/app</a> on that computer.
    </p>
  );
}

export default function App() {
  const route = useRoute();
  return (
    <WalletProvider>
      <Bar route={route} />
      <HostedNotice />
      {route === "home" ? <Landing /> : <main className="app">{route === "monitor" ? <Monitor /> : route === "proof" ? <Proof /> : <Execute />}</main>}
    </WalletProvider>
  );
}
