import { useState } from "react";
import { chains, useWallet } from "../lib/wallet";

type Props = { botChainId?: number; owner?: string; ownerOk?: boolean; executor: string; loaded: boolean };

/** What still stands between this wallet and a trade, one step at a time, each with the action that fixes it. */
export default function Steps({ botChainId, owner, ownerOk, executor, loaded }: Props) {
  const w = useWallet();
  const [copied, setCopied] = useState(false);
  const target = chains.find((c) => c.id === botChainId);
  const onChain = !!w.account && botChainId !== undefined && w.chainId === botChainId;
  const cmd = `WALLET=${w.account ?? "0xYourTestAccount"} scripts/demo.sh`;
  const copy = () => navigator.clipboard?.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});

  const steps: { done: boolean; title: string; body: React.ReactNode }[] = [
    {
      done: !!w.account,
      title: "Connect your wallet",
      body: !w.hasProvider ? <>No browser wallet found. Install MetaMask, then reload this page.</>
        : <><button type="button" className="btn small" disabled={w.pending} onClick={() => w.connect()}>{w.pending ? "Check your wallet" : "Connect wallet"}</button> Use a dedicated test account, never one that holds real funds.</>,
    },
    {
      done: onChain,
      title: `Switch to ${target?.name ?? `chain ${botChainId ?? "…"}`}${botChainId === 31337 ? " (chain 31337)" : ""}`,
      body: botChainId === undefined ? <>Waiting for the bot to report its chain. Is <code>scripts/demo.sh</code> running?</>
        : !target ? <>The bot is on chain {botChainId}, which this page does not know.</>
        : <><button type="button" className="btn small" disabled={!w.account || w.pending} onClick={() => w.switchTo(target)}>Switch network</button> Your wallet is on chain {w.chainId ?? "unknown"}. MetaMask asks to add {target.name} (RPC {target.rpcUrls.default.http[0]}) the first time; approve it.</>,
    },
    {
      done: ownerOk === true,
      title: "Use an executor your wallet owns",
      body: ownerOk === undefined ? <>Checking who owns {executor ? `executor ${executor.slice(0, 10)}…` : "the executor"}.</>
        : <>Only the executor's owner can trade, and this one belongs to {owner?.slice(0, 10)}…. Stop the demo (Ctrl-C) and start it with your address, which deploys an executor you own and keeps the bot from trading first:
          <code className="cmd">{cmd}</code><button type="button" className="btn small" onClick={copy}>{copied ? "Copied" : "Copy command"}</button> Then reload this page.</>,
    },
    {
      done: loaded,
      title: "Load an opportunity",
      body: <>On the <a href="#/app">Overview</a>, press <b>Load into form</b> on a ready opportunity. If none is ready, run <code>scripts/reseed.sh</code>.</>,
    },
  ];
  const next = steps.findIndex((s) => !s.done);
  if (next === -1) return null;
  return (
    <ol className="steps" aria-label="Before you can trade">
      {steps.map((s, i) => (
        <li key={s.title} data-state={s.done ? "done" : i === next ? "now" : "later"}>
          <span className="stn" aria-hidden="true">{s.done ? "✓" : i + 1}</span>
          <div><b>{s.title}</b>{i === next && <p>{s.body}</p>}</div>
        </li>
      ))}
    </ol>
  );
}
