import { BaseError, ContractFunctionRevertedError, isAddress, isHex, parseUnits, type Address, type Hex } from "viem";

/** The trade console's inputs, kept as the strings the person typed. */
export type Form = {
  executor: string; c0: string; c1: string; fee: string; tickSpacing: string; hooks: string;
  zeroForOne: boolean; amountIn: string; minProfit: string; decimals: string; blocks: string;
  profitAsClaim: boolean; order: string;
};
const ZERO = "0x0000000000000000000000000000000000000000";
const DEFAULT: Form = {
  executor: "", c0: "", c1: "", fee: "500", tickSpacing: "10", hooks: ZERO,
  zeroForOne: true, amountIn: "1", minProfit: "0.001", decimals: "18", blocks: "20", profitAsClaim: true,
  order: '{\n  "maker": "0x…",\n  "traits": "0",\n  "data": "0x…"\n}',
};
export const FORM_KEY = "flasharb.form.v1";

export type Log = { t: string; level: "info" | "ok" | "err"; msg: string; href?: string };

export function loadForm(): Form {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(FORM_KEY) || "{}") }; } catch { return DEFAULT; }
}

/** An opportunity handed over by the Overview page ("Load into form"). It is read once and then cleared. */
export type Quote = { quotedProfit: string; gas: string; gasCost: string; netProfit: string; symbol: string; pool: string; block: string };
export type Prefill = Partial<Form> & { note?: string; quote?: Quote };
export function readPrefill(): Prefill | null {
  try { const raw = localStorage.getItem("flasharb.prefill"); return raw ? (JSON.parse(raw) as Prefill) : null; } catch { return null; }
}

const FIX: Record<string, string> = {
  NotOwner: "Only the executor's owner can start a trade. Connect the wallet that owns it.",
  Expired: "The expiry block has passed. Raise \"Expires in\" and simulate again.",
  InsufficientProfit: "The spread no longer covers the trade plus your minimum profit. Lower the minimum or wait for a better price.",
  NotRouter: "The SwapVM router called back from an unexpected address. Check the order and the executor's ROUTER.",
  NotPoolManager: "Only the PoolManager can call unlockCallback. Call arb() instead.",
};

/** Turns a failed call into a sentence: the decoded custom error and what to do about it. */
export function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      const n = r.data?.errorName;
      const a = r.data?.args as readonly unknown[] | undefined;
      if (n) return `${n}${a?.length ? ` (${a.map(String).join(", ")})` : ""}. ${FIX[n] ?? ""}`.trim();
      return `The contract reverted: ${r.reason ?? r.shortMessage}`;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Builds the executor's Arb argument from the form, expiring `blocks` after `latest`. Throws a readable error. */
export function buildArb(f: Form, latest: bigint) {
  const need = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg); };
  need(isAddress(f.executor), "Executor address is not valid");
  need(isAddress(f.c0) && isAddress(f.c1), "Both pool currencies must be addresses");
  need(BigInt(f.c0) < BigInt(f.c1), "currency0 must be numerically lower than currency1");
  need(isAddress(f.hooks), "Hooks must be an address (0x000…0 for none)");
  let order: { maker: string; traits: string; data: string };
  try { order = JSON.parse(f.order); } catch { throw new Error("Order is not valid JSON"); }
  need(isAddress(order.maker), "order.maker must be an address");
  need(isHex(order.data), "order.data must be hex");
  const dec = Number(f.decimals);
  const amountIn = parseUnits(f.amountIn || "0", dec);
  need(amountIn > 0n, "Amount in must be above zero");
  return {
    key: {
      currency0: f.c0 as Address, currency1: f.c1 as Address, fee: Number(f.fee),
      tickSpacing: Number(f.tickSpacing), hooks: f.hooks as Address,
    },
    zeroForOne: f.zeroForOne,
    amountIn,
    minProfit: parseUnits(f.minProfit || "0", dec),
    lastBlock: Number(latest) + Number(f.blocks),
    profitAsClaim: f.profitAsClaim,
    order: { maker: order.maker as Address, traits: BigInt(order.traits), data: order.data as Hex },
  };
}

/** Field-by-field problems with the form, worded as what to type instead. Empty when the form is valid. */
export function validate(f: Form): Partial<Record<keyof Form, string>> {
  const e: Partial<Record<keyof Form, string>> = {};
  const addr = (k: "executor" | "c0" | "c1" | "hooks") => {
    if (f[k] && !isAddress(f[k])) e[k] = "Enter a full address: 0x followed by 40 hex characters.";
  };
  if (!f.executor) e.executor = "Enter the FlashArbExecutor address you deployed.";
  addr("executor"); addr("c0"); addr("c1"); addr("hooks");
  if (!e.c0 && !e.c1 && isAddress(f.c0) && isAddress(f.c1) && BigInt(f.c0) >= BigInt(f.c1)) e.c0 = "Currency 0 must be the lower address. Swap the two fields.";
  const int = (k: "fee" | "tickSpacing" | "decimals" | "blocks", min: number, max: number, msg: string) => {
    if (!/^-?\d+$/.test(f[k]) || Number(f[k]) < min || Number(f[k]) > max) e[k] = msg;
  };
  int("fee", 0, 1000000, "Use a whole number from 0 to 1,000,000.");
  int("tickSpacing", 1, 32767, "Use a whole number from 1 to 32,767.");
  int("decimals", 0, 36, "Use a whole number from 0 to 36.");
  int("blocks", 1, 100000, "Use a whole number of blocks, at least 1.");
  if (!/^\d*\.?\d+$/.test(f.amountIn) || Number(f.amountIn) <= 0) e.amountIn = "Enter an amount above zero, for example 1.5.";
  if (!/^\d*\.?\d+$/.test(f.minProfit)) e.minProfit = "Enter zero or a positive number, for example 0.001.";
  try { const o = JSON.parse(f.order); if (!isAddress(o.maker) || !isHex(o.data)) throw 0; BigInt(o.traits); }
  catch { e.order = "Paste the order as JSON with a maker address, a numeric traits value and hex data."; }
  return e;
}
