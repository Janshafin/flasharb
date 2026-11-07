import { existsSync, readFileSync } from "node:fs";
import { decodeEventLog, decodeFunctionData, parseAbi, type PublicClient } from "viem";
import { erc20Abi, executorAbi, poolManagerAbi } from "./abi";
import { nativeToToken, readSqrtPrice } from "./price";
import type { Address, Deployment, Hex, Trade } from "./types";

/** Which compiled artifact names the functions of each contract the executor talks to. */
const ARTIFACTS = {
  executor: "FlashArbExecutor.sol/FlashArbExecutor",
  poolManager: "PoolManager.sol/PoolManager",
  aqua: "Aqua.sol/Aqua",
  router: "AquaSwapVMRouter.sol/AquaSwapVMRouter",
  token: "TokenMock.sol/TokenMock",
} as const;
type Role = keyof typeof ARTIFACTS | "owner" | "maker" | "other";
export type Selectors = Partial<Record<Role, Map<string, string>>>;

/** Reads selector -> signature from forge's build output, so trace labels come from the pinned sources themselves. */
export function loadSelectors(outDir: string): Selectors {
  const s: Selectors = {};
  for (const [role, path] of Object.entries(ARTIFACTS)) {
    const f = `${outDir}/${path}.json`;
    if (!existsSync(f)) continue;
    const ids = (JSON.parse(readFileSync(f, "utf8")).methodIdentifiers ?? {}) as Record<string, string>;
    s[role as Role] = new Map(Object.entries(ids).map(([sig, sel]) => [`0x${sel}`, sig]));
  }
  return s;
}

const eventsAbi = parseAbi([
  "event Transfer(address caller, address indexed from, address indexed to, uint256 indexed id, uint256 amount)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event Pulled(address maker, address app, bytes32 strategyHash, address token, uint256 amount)",
  "event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount)",
]);
const erc20Events = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const ZERO = "0x0000000000000000000000000000000000000000";

type Frame = { type: string; from: Address; to: Address; input: Hex; gasUsed: Hex; error?: string; calls?: Frame[] };
export type Step = { depth: number; type: string; from: string; to: string; call: string; gasUsed: string; error?: string };

export function makeProver(client: PublicClient, dep: Deployment, selectors: Selectors) {
  const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const role = (a: string, maker?: string): Role =>
    eq(a, dep.executor) ? "executor" : eq(a, dep.poolManager) ? "poolManager" : eq(a, dep.aqua) ? "aqua" : eq(a, dep.router) ? "router"
      : dep.tokens.some((t) => eq(t.address, a)) ? "token" : eq(a, dep.owner) ? "owner" : eq(a, maker) ? "maker" : "other";
  const NAMES: Record<Role, string> = { executor: "FlashArbExecutor", poolManager: "Uniswap v4 PoolManager", aqua: "1inch Aqua", router: "1inch SwapVM router", token: "", owner: "Executor owner", maker: "Aqua maker", other: "" };
  const label = (a: string, maker?: string) => {
    const r = role(a, maker);
    return r === "token" ? dep.tokens.find((t) => eq(t.address, a))!.symbol : NAMES[r] || a;
  };
  const fn = (to: string, input: Hex) => {
    const sel = input.slice(0, 10).toLowerCase();
    const sig = selectors[role(to) as keyof Selectors]?.get(sel);
    return sig ? sig.slice(0, sig.indexOf("(")) : sel;
  };
  const cache = new Map<string, unknown>();

  async function trace(hash: Hex, maker?: string): Promise<{ available: boolean; reason?: string; steps: Step[] }> {
    try {
      const root = (await client.request({ method: "debug_traceTransaction" as any, params: [hash, { tracer: "callTracer" }] as any })) as Frame;
      const steps: Step[] = [];
      const walk = (f: Frame, depth: number) => {
        steps.push({ depth, type: f.type, from: label(f.from, maker), to: label(f.to, maker), call: fn(f.to, f.input), gasUsed: BigInt(f.gasUsed).toString(), error: f.error });
        for (const c of f.calls ?? []) walk(c, depth + 1);
      };
      walk(root, 0);
      return { available: true, steps };
    } catch (e) {
      return { available: false, reason: `The RPC did not return a call trace (${(e as Error).message.split("\n")[0]}).`, steps: [] };
    }
  }

  /** Everything the chain says about one transaction sent to the executor, plus the bot's quote when it sent it. */
  async function prove(hash: Hex, trades: Trade[]) {
    if (cache.has(hash)) return cache.get(hash);
    const [rc, tx, chainId] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash }), client.getChainId()]);
    if (!eq(tx.to ?? undefined, dep.executor)) throw new Error("That transaction was not sent to this executor.");
    const call = decodeFunctionData({ abi: executorAbi, data: tx.input });
    const block = rc.blockNumber;
    const arb = call.functionName === "arb" ? (call.args[0] as any) : undefined;
    const maker: string | undefined = arb?.order.maker;

    const events: { contract: string; name: string; args: Record<string, string> }[] = [];
    for (const l of rc.logs) {
      try {
        const isToken = role(l.address) === "token";
        const d = isToken ? decodeEventLog({ abi: erc20Events, data: l.data, topics: l.topics }) : decodeEventLog({ abi: eventsAbi, data: l.data, topics: l.topics });
        const args = Object.fromEntries(Object.entries(d.args as object).map(([k, v]) => [k, typeof v === "string" && v.startsWith("0x") && v.length === 42 ? label(v, maker) : String(v)]));
        events.push({ contract: label(l.address, maker), name: isToken ? "Transfer (ERC-20)" : d.eventName === "Transfer" ? "Transfer (ERC-6909 claim)" : d.eventName, args });
      } catch { /* an event this page does not decode */ }
    }

    const token = arb ? ((arb.zeroForOne ? arb.key.currency0 : arb.key.currency1) as Address) : (call.args![0] as Address);
    const info = dep.tokens.find((t) => eq(t.address, token));
    const claimAt = (b: bigint) => client.readContract({ address: dep.poolManager, abi: poolManagerAbi, functionName: "balanceOf", args: [dep.executor, BigInt(token)], blockNumber: b });
    const holder = arb ? dep.owner : (call.args![2] as Address);
    const heldAt = (b: bigint) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder], blockNumber: b });
    const [claimBefore, claimAfter, heldBefore, heldAfter] = await Promise.all([claimAt(block - 1n), claimAt(block), heldAt(block - 1n), heldAt(block)]);

    const gasCostWei = rc.gasUsed * rc.effectiveGasPrice;
    const realized = arb ? (arb.profitAsClaim ? claimAfter - claimBefore : heldAfter - heldBefore) : null;
    const weth = dep.tokens.find((t) => t.symbol === "WETH")?.address;
    let gasInToken: bigint | null = null;
    if (arb && weth) gasInToken = nativeToToken(gasCostWei, token, weth, arb.key, await readSqrtPrice(client, dep, arb.key).catch(() => 0n));
    const botTrade = trades.find((t) => eq(t.txHash ?? undefined, hash));
    const code = async (a: Address) => ((await client.getCode({ address: a, blockNumber: block })) ?? "0x").length / 2 - 1;

    const proof = {
      network: { chainId, kind: chainId === 31337 ? "local-anvil" : "live" },
      tx: { hash, from: tx.from, block: block.toString(), status: rc.status, gasUsed: rc.gasUsed.toString(), effectiveGasPrice: rc.effectiveGasPrice.toString(), gasCostWei: gasCostWei.toString() },
      kind: call.functionName,
      arb: arb && { pair: `${label(arb.key.currency0)}/${label(arb.key.currency1)}`, fee: arb.key.fee, tickSpacing: arb.key.tickSpacing, hooks: arb.key.hooks, sold: label(token), amountIn: arb.amountIn.toString(), minProfit: arb.minProfit.toString(), lastBlock: arb.lastBlock, profitAsClaim: arb.profitAsClaim, maker },
      withdraw: arb ? undefined : { amount: (call.args![1] as bigint).toString(), to: holder },
      contracts: {
        executor: { address: dep.executor, codeBytes: await code(dep.executor) },
        poolManager: { address: dep.poolManager, codeBytes: await code(dep.poolManager) },
        aqua: { address: dep.aqua, codeBytes: await code(dep.aqua) },
        router: { address: dep.router, codeBytes: await code(dep.router) },
      },
      token: { address: token, symbol: info?.symbol ?? token, decimals: info?.decimals ?? 18 },
      balances: { claimBefore: claimBefore.toString(), claimAfter: claimAfter.toString(), holder, heldBefore: heldBefore.toString(), heldAfter: heldAfter.toString() },
      profit: arb && {
        realized: realized!.toString(),
        quoted: botTrade ? botTrade.quotedProfit : null,
        quotedBy: botTrade ? "the bot's saved quote" : "no saved quote: this trade was not sent by the bot",
        gasCostInToken: gasInToken === null ? null : gasInToken.toString(),
        gasAdjusted: gasInToken === null ? null : (realized! - gasInToken).toString(),
      },
      events,
      trace: await trace(hash, maker),
    };
    if (rc.status === "success") cache.set(hash, proof);
    return proof;
  }

  /** Executor transactions found on chain: every claim minted to it (an arb) or burned from it (a withdrawal). */
  async function recent(trades: Trade[]) {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const recentFloor = head > 9_000n ? head - 9_000n : 0n;
    const fromBlock = dep.chainId === 31337 || dep.startBlock > recentFloor ? dep.startBlock : recentFloor;
    const ev = eventsAbi[0];
    const [mints, burns] = await Promise.all([
      client.getLogs({ address: dep.poolManager, event: ev, args: { from: ZERO, to: dep.executor }, fromBlock, toBlock: head }),
      client.getLogs({ address: dep.poolManager, event: ev, args: { from: dep.executor, to: ZERO }, fromBlock, toBlock: head }),
    ]);
    const seen = new Map<string, { txHash: Hex; block: string; kind: string }>();
    for (const l of mints) seen.set(l.transactionHash!, { txHash: l.transactionHash!, block: l.blockNumber!.toString(), kind: "arb" });
    for (const l of burns) seen.set(l.transactionHash!, { txHash: l.transactionHash!, block: l.blockNumber!.toString(), kind: "withdrawClaim" });
    for (const t of trades) if (t.txHash && !seen.has(t.txHash)) seen.set(t.txHash, { txHash: t.txHash, block: t.block, kind: "arb" });
    return [...seen.values()].sort((a, b) => Number(BigInt(b.block) - BigInt(a.block))).slice(0, 30);
  }

  return { prove, recent };
}
