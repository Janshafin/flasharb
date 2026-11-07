import { useEffect, useMemo, useRef, useState } from "react";
import { isAddress, parseUnits, type Address } from "viem";
import { buildArb, explain, validate, FORM_KEY, loadForm, readPrefill, type Form, type Log, type Prefill, type Quote } from "../lib/console";
import { erc20Abi, executorAbi, poolManagerAbi } from "../lib/abi";
import { addMyTrade } from "../lib/mytrades";
import { Claims, LogList, Progress } from "./ConsoleSide";
import Steps from "./Steps";
import Maintenance, { type MaintForm, type MaintKind } from "./Maintenance";
import { usePoll, type Claim, type Status } from "../lib/api";
import { fmtUnits } from "../lib/format";
import { chains, short, useWallet } from "../lib/wallet";

export default function Execute() {
  const w = useWallet();
  const [prefill] = useState<Prefill | null>(readPrefill);
  const [f, setF] = useState<Form>(() => {
    const { note: _note, quote: _quote, ...rest } = prefill ?? {};
    return { ...loadForm(), ...rest };
  });
  const [note, setNote] = useState<string | undefined>(prefill?.note);
  // The bot's quote for exactly the loaded inputs. Editing any field drops it, because it no longer applies.
  const [quote, setQuote] = useState<Quote | undefined>(prefill?.quote);
  const [lastBlock, setLastBlock] = useState<number>();
  useEffect(() => { try { localStorage.removeItem("flasharb.prefill"); } catch { /* ignore */ } }, []);
  const status = usePoll<Status>("/api/status", 5000);
  const claimsPoll = usePoll<{ claims: Claim[] }>("/api/claims", 5000);
  // Follow the bot's executor: after a restart (for example with WALLET=...) the remembered form would otherwise keep
  // the previous chain's executor, owned by someone else. A deliberately typed address is replaced only on a change.
  useEffect(() => {
    const ex = status.data?.executor;
    if (!ex) return;
    let last: string | null = null;
    try { last = localStorage.getItem("flasharb.botExecutor"); localStorage.setItem("flasharb.botExecutor", ex); } catch { /* ignore */ }
    setF((x) => (!x.executor || (last !== ex && x.executor !== ex) ? { ...x, executor: ex } : x));
  }, [status.data?.executor]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [phase, setPhase] = useState(-1); // -1 idle, 0..3 running, 4 done
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sim, setSim] = useState<{ key: string; request: any; gas: bigint; fee?: bigint } | null>(null);
  const [owner, setOwner] = useState<string>();
  const [maint, setMaint] = useState<MaintKind>("approve");
  const [m, setM] = useState<MaintForm>({ tokens: "", token: "", to: "", amount: "", decimals: "" });

  useEffect(() => { try { localStorage.setItem(FORM_KEY, JSON.stringify(f)); } catch { /* ignore */ } }, [f]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setNote(undefined); setQuote(undefined); setF((s) => ({ ...s, [k]: v })); };
  const formKey = useMemo(() => JSON.stringify(f), [f]);
  const fresh = sim?.key === formKey;

  const log = (level: Log["level"], msg: string, href?: string) =>
    setLogs((l) => [{ t: new Date().toLocaleTimeString(), level, msg, href }, ...l].slice(0, 60));

  // Owner check
  useEffect(() => {
    setOwner(undefined);
    const c = w.clients();
    if (!c || !isAddress(f.executor)) return;
    c.pub.readContract({ address: f.executor, abi: executorAbi, functionName: "OWNER" })
      .then((o) => setOwner(o as string)).catch(() => setOwner(undefined));
  }, [f.executor, w.account, w.chainId]); // eslint-disable-line react-hooks/exhaustive-deps

  const errs = useMemo(() => validate(f), [f]);
  
  const [touched, setTouched] = useState<Partial<Record<keyof Form, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const E = (k: keyof Form) => (touched[k] || submitted ? errs[k] : undefined);
  const LABELS: Record<string, string> = { executor: "Contract address", c0: "Currency 0", c1: "Currency 1", hooks: "Hooks contract", fee: "Fee", tickSpacing: "Tick spacing", amountIn: "Amount to sell", minProfit: "Minimum profit", decimals: "Token decimals", blocks: "Expires in", order: "Aqua strategy order" };
  const ownerOk = owner && w.account ? owner.toLowerCase() === w.account.toLowerCase() : undefined;

  const build = (latest: bigint) => buildArb(f, latest);

  async function simulate() {
    const c = w.clients();
    if (!c || !w.account) return;
    setBusy(true); setFailed(false); setPhase(0);
    try {
      const latest = await c.pub.getBlockNumber();
      const arg = build(latest);
      log("info", `Prepared a trade of ${f.amountIn} with a minimum profit of ${f.minProfit}, expiring at block ${arg.lastBlock}.`);
      setPhase(1);
      const { request } = await c.pub.simulateContract({
        account: w.account, address: f.executor as Address, abi: executorAbi, functionName: "arb", args: [arg],
      });
      const gas = await c.pub.estimateContractGas({
        account: w.account, address: f.executor as Address, abi: executorAbi, functionName: "arb", args: [arg],
      });
      setSim({ key: formKey, request, gas });
      setLastBlock(arg.lastBlock);
      setPhase(2);
      log("ok", `Simulation passed. Estimated gas ${gas.toLocaleString()}. You can send it now.`);
    } catch (e) {
      setFailed(true); setSim(null);
      log("err", explain(e));
    } finally { setBusy(false); }
  }

  async function execute() {
    const c = w.clients();
    if (!c || !sim || !fresh) return;
    setBusy(true); setFailed(false); setPhase(2);
    try {
      const sold = (f.zeroForOne ? f.c0 : f.c1) as Address;
      const readProfitBalance = async () => {
        if (f.profitAsClaim) {
          const pm = (await c.pub.readContract({ address: f.executor as Address, abi: executorAbi, functionName: "POOL_MANAGER" })) as Address;
          return (await c.pub.readContract({ address: pm, abi: poolManagerAbi, functionName: "balanceOf", args: [f.executor as Address, BigInt(sold)] })) as bigint;
        }
        return (await c.pub.readContract({ address: sold, abi: erc20Abi, functionName: "balanceOf", args: [w.account as Address] })) as bigint;
      };
      const before = await readProfitBalance();
      const hash = await c.wallet.writeContract(sim.request);
      const href = w.chain?.blockExplorers ? `${w.chain.blockExplorers.default.url}/tx/${hash}` : undefined;
      log("info", `Sent ${short(hash)}. Waiting for confirmation.`, href);
      setPhase(3);
      const rc = await c.pub.waitForTransactionReceipt({ hash });
      const realized = (await readProfitBalance()) - before;
      const token = status.data?.tokens.find((t) => t.address.toLowerCase() === sold.toLowerCase());
      addMyTrade({
        id: `console:${hash}`, ts: Date.now(), block: rc.blockNumber.toString(), txHash: hash, pool: token ? `${token.symbol} sold` : "console trade",
        direction: f.zeroForOne ? "sell-currency0" : "sell-currency1", profitSymbol: token?.symbol ?? "tokens", profitToken: sold,
        decimals: Number(f.decimals), amountIn: parseUnits(f.amountIn || "0", Number(f.decimals)).toString(), quotedProfit: quote?.quotedProfit ?? "0",
        minProfit: parseUnits(f.minProfit || "0", Number(f.decimals)).toString(), realizedProfit: rc.status === "success" ? realized.toString() : "0",
        gasUsed: rc.gasUsed.toString(), effectiveGasPrice: rc.effectiveGasPrice.toString(), status: rc.status === "success" ? "success" : "reverted",
      });
      if (rc.status === "success") {
        setPhase(4);
        const where = f.profitAsClaim ? "as an ERC-6909 claim held by the executor in the PoolManager (not in your wallet yet; withdraw it below)" : "to your wallet";
        const vs = quote ? ` The bot quoted ${fmtUnits(quote.quotedProfit, Number(f.decimals), 6)}.` : "";
        log("ok", `Confirmed in block ${rc.blockNumber}. Gas used ${rc.gasUsed.toLocaleString()}, costing ${fmtUnits(rc.gasUsed * rc.effectiveGasPrice, 18, 8)} ETH. Profit read from chain: ${fmtUnits(realized, Number(f.decimals), 6)}, paid ${where}.${vs}`, href);
      } else { throw new Error("Transaction reverted on-chain"); }
      setSim(null);
    } catch (e) {
      setFailed(true); log("err", explain(e));
    } finally { setBusy(false); }
  }

  const connected = !!w.account;
  const wrongChain = connected && !w.chain;
  // Never simulate or send on a chain other than the one the bot's deployment lives on, or from a non-owner.
  const chainMismatch = connected && !!status.data && w.chainId !== status.data.chainId;
  const blocked = wrongChain || chainMismatch || ownerOk === false;
  const dec = Number(f.decimals);
  const pairSym = (a: string) => status.data?.tokens.find((t) => t.address.toLowerCase() === a.toLowerCase())?.symbol ?? short(a);
  

  return (
    <div className="stack">
      <header className="head">
        <h1>Run a trade</h1>
        <p>Simulate against live state first. Send unlocks only for the exact inputs that passed.</p>
      </header>

      <Steps botChainId={status.data?.chainId} owner={owner} ownerOk={ownerOk} executor={f.executor} loaded={!!quote || !!sim} />
      {note && <p className="callout" role="status">{note} Check the amounts, then simulate.</p>}
      {connected && !blocked && isAddress(f.executor) && isAddress(f.c0) && isAddress(f.c1) && (
        <section className="callout" aria-label="Trade summary">
          <p><b>{pairSym(f.c0)}/{pairSym(f.c1)}</b> on the Uniswap v4 PoolManager {short(status.data?.poolManager)}, fee {f.fee}, tick spacing {f.tickSpacing}. Sell {f.amountIn} {pairSym(f.zeroForOne ? f.c0 : f.c1)} on v4, buy it back from the Aqua strategy through SwapVM, settle both in one unlock.</p>
          {quote ? (
            <p>Bot quote at block {quote.block}: gross profit {fmtUnits(quote.quotedProfit, dec, 6)} {quote.symbol}, gas about {Number(quote.gas).toLocaleString()} (≈ {fmtUnits(quote.gasCost, dec, 6)} {quote.symbol}), net {fmtUnits(quote.netProfit, dec, 6)} {quote.symbol}. Minimum profit {f.minProfit} {quote.symbol}; the trade reverts below it.</p>
          ) : <p>No bot quote for these inputs. Load an opportunity from the Overview, or simulate to check them.</p>}
          {lastBlock !== undefined && fresh && <p>Simulated: expires after block {lastBlock}.</p>}
        </section>
      )}

      <div className="exec">
        <form className="slip" onSubmit={(e) => e.preventDefault()} noValidate>
          {submitted && Object.keys(errs).length > 0 && (
            <div className="summary" role="alert" tabIndex={-1} ref={summaryRef} aria-labelledby="sum-title">
              <h2 id="sum-title">Fix {Object.keys(errs).length} {Object.keys(errs).length === 1 ? "field" : "fields"} before simulating</h2>
              <ul>{Object.keys(errs).map((k) => <li key={k}><a href={`#fld-${k}`} onClick={(e) => { e.preventDefault(); document.getElementById(`fld-${k}`)?.focus(); }}>{LABELS[k]}</a>: {errs[k as keyof Form]}</li>)}</ul>
            </div>
          )}
          <fieldset>
            <legend>Executor</legend>
            <label className="fld"><span>Contract address</span>
              <input id="fld-executor" aria-invalid={!!E("executor")} onBlur={() => setTouched((t) => ({ ...t, executor: true }))} value={f.executor} onChange={(e) => set("executor", e.target.value.trim())} placeholder="0x…" spellCheck={false} />{E("executor") && <small className="ferr">{errs.executor}</small>}</label>
            {isAddress(f.executor) && connected && (
              <p className={`hint ${ownerOk === false ? "bad" : ""}`}>
                {ownerOk === undefined ? "Checking the owner." : ownerOk ? "Your wallet owns this executor." : `Owned by ${short(owner)}, not your wallet. The trade will revert.`}
              </p>
            )}
          </fieldset>

          <fieldset>
            <legend>Uniswap v4 pool</legend>
            <div className="two">
              <label className="fld"><span>Currency 0 (lower address)</span><input id="fld-c0" aria-invalid={!!E("c0")} onBlur={() => setTouched((t) => ({ ...t, c0: true }))} value={f.c0} onChange={(e) => set("c0", e.target.value.trim())} placeholder="0x…" spellCheck={false} />{E("c0") && <small className="ferr">{errs.c0}</small>}</label>
              <label className="fld"><span>Currency 1 (higher address)</span><input id="fld-c1" aria-invalid={!!E("c1")} onBlur={() => setTouched((t) => ({ ...t, c1: true }))} value={f.c1} onChange={(e) => set("c1", e.target.value.trim())} placeholder="0x…" spellCheck={false} />{E("c1") && <small className="ferr">{errs.c1}</small>}</label>
              <label className="fld"><span>Fee, in hundredths of a bip</span><input id="fld-fee" aria-invalid={!!E("fee")} onBlur={() => setTouched((t) => ({ ...t, fee: true }))} inputMode="numeric" value={f.fee} onChange={(e) => set("fee", e.target.value)} />{E("fee") && <small className="ferr">{errs.fee}</small>}</label>
              <label className="fld"><span>Tick spacing</span><input id="fld-tickSpacing" aria-invalid={!!E("tickSpacing")} onBlur={() => setTouched((t) => ({ ...t, tickSpacing: true }))} inputMode="numeric" value={f.tickSpacing} onChange={(e) => set("tickSpacing", e.target.value)} />{E("tickSpacing") && <small className="ferr">{errs.tickSpacing}</small>}</label>
            </div>
            <label className="fld"><span>Hooks contract (zero address for none)</span><input id="fld-hooks" aria-invalid={!!E("hooks")} onBlur={() => setTouched((t) => ({ ...t, hooks: true }))} value={f.hooks} onChange={(e) => set("hooks", e.target.value.trim())} spellCheck={false} />{E("hooks") && <small className="ferr">{errs.hooks}</small>}</label>
          </fieldset>

          <fieldset>
            <legend>Trade</legend>
            <div className="seg" role="group" aria-label="Direction">
              <button type="button" aria-pressed={f.zeroForOne} onClick={() => set("zeroForOne", true)}>Sell currency 0</button>
              <button type="button" aria-pressed={!f.zeroForOne} onClick={() => set("zeroForOne", false)}>Sell currency 1</button>
            </div>
            <div className="two">
              <label className="fld"><span>Amount to sell</span><input id="fld-amountIn" aria-invalid={!!E("amountIn")} onBlur={() => setTouched((t) => ({ ...t, amountIn: true }))} inputMode="decimal" value={f.amountIn} onChange={(e) => set("amountIn", e.target.value)} />{E("amountIn") && <small className="ferr">{errs.amountIn}</small>}</label>
              <label className="fld"><span>Minimum profit, same token</span><input id="fld-minProfit" aria-invalid={!!E("minProfit")} onBlur={() => setTouched((t) => ({ ...t, minProfit: true }))} inputMode="decimal" value={f.minProfit} onChange={(e) => set("minProfit", e.target.value)} />{E("minProfit") && <small className="ferr">{errs.minProfit}</small>}</label>
              <label className="fld"><span>Token decimals</span><input id="fld-decimals" aria-invalid={!!E("decimals")} onBlur={() => setTouched((t) => ({ ...t, decimals: true }))} inputMode="numeric" value={f.decimals} onChange={(e) => set("decimals", e.target.value)} />{E("decimals") && <small className="ferr">{errs.decimals}</small>}</label>
              <label className="fld"><span>Expires in, blocks</span><input id="fld-blocks" aria-invalid={!!E("blocks")} onBlur={() => setTouched((t) => ({ ...t, blocks: true }))} inputMode="numeric" value={f.blocks} onChange={(e) => set("blocks", e.target.value)} />{E("blocks") && <small className="ferr">{errs.blocks}</small>}</label>
            </div>
            <label className="check">
              <input type="checkbox" checked={f.profitAsClaim} onChange={(e) => set("profitAsClaim", e.target.checked)} />
              <span>Keep profit as a claim in the PoolManager. Cheaper after the first trade; withdraw it later under Maintenance.</span>
            </label>
          </fieldset>

          <fieldset>
            <legend>Aqua strategy</legend>
            <label className="fld"><span>SwapVM order as JSON, with maker, traits and data</span>
              <textarea id="fld-order" aria-invalid={!!E("order")} onBlur={() => setTouched((t) => ({ ...t, order: true }))} rows={5} value={f.order} onChange={(e) => set("order", e.target.value)} spellCheck={false} />{E("order") && <small className="ferr">{errs.order}</small>}</label>
          </fieldset>

          <div className="actions">
            <button type="button" className="btn" disabled={!connected || blocked || busy} onClick={() => { if (Object.keys(errs).length) { setSubmitted(true); setTimeout(() => summaryRef.current?.focus(), 0); } else simulate(); }} aria-busy={busy && phase < 2}>{busy && phase < 2 ? "Simulating" : "Simulate"}</button>
            <button type="button" className="btn solid" disabled={!fresh || busy || !connected || blocked} onClick={execute} aria-busy={busy && phase >= 2}>{busy && phase >= 2 ? "Sending" : "Send"}</button>
          </div>
          {sim && !fresh && <p className="hint bad">You changed an input after simulating. Simulate again to enable Send.</p>}
          {sim && fresh && <p className="hint">Simulation passed. Estimated gas {sim.gas.toLocaleString()}.</p>}
        </form>

        <div className="side">
          <Progress phase={phase} failed={failed} />
          <LogList logs={logs} />
          <Claims claims={claimsPoll.data?.claims} error={claimsPoll.error} connected={connected} onWithdraw={(c) => {
            setMaint("withdraw");
            setM({ tokens: "", token: c.address, to: w.account ?? status.data?.owner ?? "", amount: fmtUnits(c.claim, c.decimals, c.decimals).replace(/,/g, ""), decimals: String(c.decimals) });
            document.getElementById("maintenance")?.scrollIntoView({ block: "center" });
          }} />

          <Maintenance kind={maint} setKind={setMaint} m={m} setM={setM} executor={f.executor} defaultDecimals={Number(f.decimals)}
            busy={busy} setBusy={setBusy} disabled={!connected || blocked} log={log} />
        </div>
      </div>
    </div>
  );
}
