import { useEffect, useState } from "react";
import { usePoll, type Status } from "../lib/api";
import { fmtUnits, shortHash } from "../lib/format";
import { Events, Flow, Trace, type ProofData } from "./ProofParts";

type Listed = { txHash: string; block: string; kind: string };

/** Every value on this page comes from a receipt, a call trace, calldata or a balance read at a block. */
export default function Proof() {
  const status = usePoll<Status>("/api/status", 5000);
  const list = usePoll<{ transactions: Listed[] }>("/api/proofs", 5000);
  const [tx, setTx] = useState<string>();
  const txs = list.data?.transactions ?? [];
  useEffect(() => { if (!tx && txs.length) setTx(txs[0].txHash); }, [tx, txs]);
  const proof = usePoll<ProofData>(tx ? `/api/proof?tx=${tx}` : "/api/health", 15000);
  const p = tx && proof.data && "tx" in proof.data && proof.data.tx.hash.toLowerCase() === tx.toLowerCase() ? proof.data : undefined;
  const tokens = status.data?.tokens ?? [];
  const u = (v: string | null | undefined, d = p?.token.decimals ?? 18) => (v == null ? "not available" : `${fmtUnits(v, d, 8)} ${p?.token.symbol}`);

  return (
    <div className="stack">
      <header className="head">
        <h1>Execution proof</h1>
        <p>Pick a transaction the executor made. Everything below is read back from the chain: the receipt, the call trace, the calldata and balances at the blocks before and after.</p>
      </header>

      {list.error && <p className="callout bad">{list.error} Start the demo with <code>scripts/demo.sh</code>; proofs come from the bot's API.</p>}
      {list.data && txs.length === 0 && <p className="callout">No executor transactions on this chain yet. Run a trade, or wait for the bot to take the open gap.</p>}

      {txs.length > 0 && (
        <div className="seg proofpick" role="group" aria-label="Transaction">
          {txs.map((t) => (
            <button type="button" key={t.txHash} aria-pressed={t.txHash === tx} onClick={() => setTx(t.txHash)}>
              {t.kind === "arb" ? "Arbitrage" : "Withdrawal"}, block {t.block} <span className="code">{shortHash(t.txHash)}</span>
            </button>
          ))}
        </div>
      )}

      {tx && !p && <p className="note">{proof.error ?? "Reading the receipt and the trace."}</p>}
      {p && (
        <>
          <p className={`callout ${p.network.kind === "live" ? "" : "kind-local"}`}>
            {p.network.kind === "local-anvil"
              ? <>Local evidence: anvil chain {p.network.chainId} on this machine, running Uniswap v4, Aqua and SwapVM deployed from their pinned sources. Not a Unichain transaction.</>
              : p.network.chainId === 1301
                ? <>Public testnet evidence: Unichain Sepolia (chain 1301), <a href={`https://sepolia.uniscan.xyz/tx/${p.tx.hash}`} target="_blank" rel="noreferrer">view on Uniscan</a>. Uniswap's own deployed v4 PoolManager; 1inch has not deployed Aqua or the SwapVM router on this testnet, so flasharb deployed both from the same pinned sources. The tokens are test tokens with no value.</>
                : <>Live network evidence: chain {p.network.chainId}.</>}
          </p>
          {p.kind === "arb" && <Flow p={p} tokens={tokens} />}

          <section>
            <h2>Evidence</h2>
            <table className="plain proof">
              <caption className="sr">Proof fields and where each comes from</caption>
              <thead><tr><th scope="col">Field</th><th scope="col">Value</th><th scope="col">Source</th></tr></thead>
              <tbody>
                <tr><td>Transaction</td><td className="code wrap">{p.tx.hash}</td><td>Receipt</td></tr>
                <tr><td>Network</td><td>Chain {p.network.chainId}{p.network.kind === "local-anvil" ? " (local anvil)" : ""}</td><td>RPC</td></tr>
                <tr><td>Block and status</td><td>Block {p.tx.block}, {p.tx.status === "success" ? "succeeded" : "reverted"}</td><td>Receipt</td></tr>
                <tr><td>Sent by</td><td className="code wrap">{p.tx.from}</td><td>Transaction</td></tr>
                {(["executor", "poolManager", "aqua", "router"] as const).map((k) => (
                  <tr key={k}><td>{{ executor: "FlashArbExecutor", poolManager: "Uniswap v4 PoolManager", aqua: "1inch Aqua", router: "1inch SwapVM router" }[k]}</td>
                    <td className="code wrap">{p.contracts[k].address}</td><td>Code at that block: {p.contracts[k].codeBytes.toLocaleString()} bytes; called in the trace</td></tr>
                ))}
                {p.arb && <>
                  <tr><td>Pool</td><td>{p.arb.pair}, fee {p.arb.fee}, tick spacing {p.arb.tickSpacing}, {p.arb.hooks.endsWith("0000000000") ? "no hooks" : `hooks ${p.arb.hooks}`}</td><td>Calldata</td></tr>
                  <tr><td>Input</td><td>{u(p.arb.amountIn)} sold on v4</td><td>Calldata</td></tr>
                  <tr><td>Minimum profit and expiry</td><td>{u(p.arb.minProfit)}, until block {p.arb.lastBlock}</td><td>Calldata</td></tr>
                  <tr><td>Quoted profit</td><td>{p.profit?.quoted ? u(p.profit.quoted) : "none"}</td><td>{p.profit?.quotedBy}</td></tr>
                  <tr><td>Realised profit</td><td><b>{u(p.profit?.realized)}</b>{p.profit?.quoted && p.profit.quoted === p.profit.realized ? ", exactly the quote" : ""}</td><td>{p.arb.profitAsClaim ? "ERC-6909 claim, block before vs after" : "Owner's token balance, block before vs after"}</td></tr>
                </>}
                {p.withdraw && <tr><td>Withdrawn</td><td className="wrap">{u(p.withdraw.amount)} to <span className="code">{p.withdraw.to}</span></td><td>Calldata</td></tr>}
                <tr><td>Gas</td><td>{Number(p.tx.gasUsed).toLocaleString()} gas at {fmtUnits(p.tx.effectiveGasPrice, 9, 4)} gwei = {fmtUnits(p.tx.gasCostWei, 18, 10)} ETH</td><td>Receipt</td></tr>
                {p.profit && <tr><td>Profit after gas</td><td>{p.profit.gasAdjusted ? <>{u(p.profit.realized)} − {u(p.profit.gasCostInToken)} gas = <b>{u(p.profit.gasAdjusted)}</b></> : "not available: no price to convert gas into this token"}</td><td>Calculation; gas converted at the current pool price</td></tr>}
                <tr><td>Executor's {p.token.symbol} claim</td><td>{u(p.balances.claimBefore)} → {u(p.balances.claimAfter)}</td><td>PoolManager.balanceOf at blocks {Number(p.tx.block) - 1} and {p.tx.block}</td></tr>
                <tr><td>{p.withdraw ? "Recipient" : "Owner"}'s {p.token.symbol} tokens</td><td>{u(p.balances.heldBefore)} → {u(p.balances.heldAfter)}</td><td>ERC-20 balanceOf at blocks {Number(p.tx.block) - 1} and {p.tx.block}</td></tr>
              </tbody>
            </table>
          </section>

          <section>
            <h2>Call trace</h2>
            <p className="note">From the node's <code>debug_traceTransaction</code>. Function names come from the compiled artifacts of the pinned sources.</p>
            <Trace t={p.trace} />
          </section>

          <section>
            <h2>Events in the receipt</h2>
            <Events evs={p.events} />
          </section>
        </>
      )}

      <section>
        <h2>Other evidence</h2>
        <p className="note">Unichain fork simulation: <code>UNICHAIN_RPC_URL=https://mainnet.unichain.org forge test --match-path 'test/fork/*' -vv</code> runs the same arbitrage against the real deployed PoolManager, Aqua and router, with test tokens. It sends nothing to the network. No arbitrage has been sent to a live network yet.</p>
      </section>
    </div>
  );
}
