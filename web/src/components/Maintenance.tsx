import { isAddress, parseUnits, type Address } from "viem";
import { erc20Abi, executorAbi, poolManagerAbi } from "../lib/abi";
import { explain, type Log } from "../lib/console";
import { fmtUnits } from "../lib/format";
import { short, useWallet } from "../lib/wallet";

export type MaintKind = "approve" | "withdraw" | "rescue";
export type MaintForm = { tokens: string; token: string; to: string; amount: string; decimals: string };

type Props = {
  kind: MaintKind; setKind: (k: MaintKind) => void;
  m: MaintForm; setM: (m: MaintForm) => void;
  executor: string; defaultDecimals: number;
  busy: boolean; setBusy: (b: boolean) => void; disabled: boolean;
  log: (level: Log["level"], msg: string, href?: string) => void;
};

/** Owner-only upkeep: approve Aqua, turn a claim into tokens, or rescue tokens sent to the executor by mistake. */
export default function Maintenance({ kind, setKind, m, setM, executor, defaultDecimals, busy, setBusy, disabled, log }: Props) {
  const w = useWallet();

  async function run() {
    const c = w.clients();
    if (!c || !w.account) return;
    setBusy(true);
    try {
      const base = { account: w.account, address: executor as Address, abi: executorAbi } as const;
      const dec = m.decimals ? Number(m.decimals) : defaultDecimals;
      let req;
      if (kind === "approve") {
        const tokens = m.tokens.split(/[\s,]+/).filter(Boolean) as Address[];
        if (!tokens.length || !tokens.every((t) => isAddress(t))) throw new Error("Enter one or more token addresses");
        req = (await c.pub.simulateContract({ ...base, functionName: "approveAqua", args: [tokens] })).request;
      } else if (kind === "withdraw") {
        if (!isAddress(m.token) || !isAddress(m.to)) throw new Error("Currency and recipient must be addresses");
        req = (await c.pub.simulateContract({ ...base, functionName: "withdrawClaim", args: [m.token, parseUnits(m.amount || "0", dec), m.to] })).request;
      } else {
        if (!isAddress(m.token) || !isAddress(m.to)) throw new Error("Token and recipient must be addresses");
        req = (await c.pub.simulateContract({ ...base, functionName: "rescue", args: [m.token, m.to, parseUnits(m.amount || "0", dec)] })).request;
      }
      // For a withdrawal, read the claim and the recipient's tokens on both sides of the receipt.
      const reads = kind === "withdraw" ? async () => {
        const pm = (await c.pub.readContract({ ...base, functionName: "POOL_MANAGER" })) as Address;
        const claim = (await c.pub.readContract({ address: pm, abi: poolManagerAbi, functionName: "balanceOf", args: [executor as Address, BigInt(m.token)] })) as bigint;
        const held = (await c.pub.readContract({ address: m.token as Address, abi: erc20Abi, functionName: "balanceOf", args: [m.to as Address] })) as bigint;
        return { claim, held };
      } : null;
      const before = reads && (await reads());
      const hash = await c.wallet.writeContract(req as any);
      log("info", `Sent ${short(hash)}. Waiting for confirmation.`);
      const rc = await c.pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`Transaction ${short(hash)} reverted on-chain`);
      let detail = "";
      if (reads && before) {
        const after = await reads();
        detail = ` Claim ${fmtUnits(before.claim, dec, 6)} → ${fmtUnits(after.claim, dec, 6)}; recipient's tokens ${fmtUnits(before.held, dec, 6)} → ${fmtUnits(after.held, dec, 6)}.`;
      }
      log("ok", `Confirmed in block ${rc.blockNumber}, gas used ${rc.gasUsed.toLocaleString()}.${detail}`);
    } catch (e) { log("err", explain(e)); } finally { setBusy(false); }
  }

  return (
    <section id="maintenance">
      <h2>Maintenance</h2>
      <div className="seg" role="group" aria-label="Maintenance action">
        {(["approve", "withdraw", "rescue"] as const).map((k) => (
          <button type="button" key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k === "approve" ? "Approve Aqua" : k === "withdraw" ? "Withdraw claim" : "Rescue tokens"}</button>
        ))}
      </div>
      {kind === "approve" ? (
        <label className="fld"><span>Token addresses, separated by commas or spaces</span>
          <textarea rows={2} value={m.tokens} onChange={(e) => setM({ ...m, tokens: e.target.value })} spellCheck={false} /></label>
      ) : (
        <>
          <label className="fld"><span>{kind === "withdraw" ? "Currency" : "Token"}</span><input value={m.token} onChange={(e) => setM({ ...m, token: e.target.value.trim() })} spellCheck={false} /></label>
          <label className="fld"><span>Recipient</span><input value={m.to} onChange={(e) => setM({ ...m, to: e.target.value.trim() })} spellCheck={false} /></label>
          <label className="fld"><span>Amount{m.decimals ? ` (token has ${m.decimals} decimals)` : ", using the token decimals above"}</span><input value={m.amount} onChange={(e) => setM({ ...m, amount: e.target.value })} /></label>
        </>
      )}
      <div className="actions"><button type="button" className="btn" disabled={busy || disabled || !isAddress(executor)} onClick={run}>Send</button></div>
    </section>
  );
}
