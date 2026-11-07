import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { loadDeployment } from "../src/deployments";
import { Trader } from "../src/execute";
import { makeLogger } from "../src/log";
import { loadSelectors, makeProver } from "../src/proof";
import { scanOnce, type ScanCtx } from "../src/scanner";
import { TradeStore } from "../src/store";
import { StrategyTracker } from "../src/tracker";

// End to end against a real anvil node. Needs forge and anvil, so it only runs with DEMO_E2E=1.
// It starts the chain with scripts/demo-chain.sh, drives the bot's own modules, and stops the chain afterwards.
const root = resolve(__dirname, "../..");
const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const sh = (script: string) => {
  const r = spawnSync("bash", [join(root, "scripts", script)], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${script} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout + r.stderr;
};

describe.skipIf(!process.env.DEMO_E2E)("bot against the local demo chain", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "flasharb-e2e-"));
  const stopFile = join(dataDir, "STOP");
  const env = { DATA_DIR: dataDir, STOP_FILE: stopFile, MIN_NET_PROFIT_WETH: "0.0001", MAX_AMOUNT_IN_WETH: "10", MAX_AMOUNT_IN_USDC: "30000" };
  const log = makeLogger([ANVIL_KEY_0], () => {});
  const client = createPublicClient({ transport: http("http://127.0.0.1:8545"), cacheTime: 0 });
  let ctx: ScanCtx;
  let dep: ReturnType<typeof loadDeployment>;

  const build = (live: boolean) => {
    const cfg = parseConfig({ ...env, DRY_RUN: live ? "false" : "true", ...(live ? { OWNER_PRIVATE_KEY: ANVIL_KEY_0 } : {}) });
    const store = new TradeStore(dataDir);
    const backoff = new Map<string, number>();
    const wallet = live
      ? createWalletClient({
          account: privateKeyToAccount(ANVIL_KEY_0),
          chain: defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } } }),
          transport: http("http://127.0.0.1:8545"),
        })
      : undefined;
    return { cfg, store, trader: new Trader(client, wallet, dep, cfg, store, backoff, log), backoff };
  };

  beforeAll(() => {
    try { sh("demo-stop.sh"); } catch { /* nothing running */ }
    sh("demo-chain.sh");
    dep = loadDeployment(join(root, "deployments/31337.json"));
    const { cfg, backoff } = build(false);
    ctx = { client, dep, cfg, tracker: new StrategyTracker(client, dep, cfg.logChunk), wrappedNative: dep.tokens.find((t) => t.symbol === "WETH")!.address, backoff, skippedHooked: new Set<string>(), log };
  }, 180_000);

  afterAll(() => {
    try { sh("demo-stop.sh"); } catch { /* already stopped */ }
  });

  it("discovers the shipped Aqua strategy", async () => {
    await ctx.tracker.sync();
    expect(ctx.tracker.strategies.size).toBe(1);
  });

  it("finds a ready opportunity with a positive net profit", async () => {
    const ops = await scanOnce(ctx);
    const best = ops.find((o) => o.status === "ready");
    expect(best, JSON.stringify(ops)).toBeDefined();
    expect(BigInt(best!.quotedProfit)).toBeGreaterThan(0n);
    expect(BigInt(best!.netProfit)).toBeGreaterThan(0n);
    expect(best!.direction).toBe("sell-currency0");
  }, 60_000);

  it("a dry run never sends", async () => {
    const before = await client.getBlockNumber({ cacheTime: 0 });
    const { trader } = build(false);
    const ops = await scanOnce(ctx);
    expect(await trader.tryExecute(ops.find((o) => o.status === "ready")!, before)).toBeNull();
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(before);
  }, 60_000);

  it("the kill switch blocks a live trader", async () => {
    writeFileSync(stopFile, "");
    const { trader } = build(true);
    const ops = await scanOnce(ctx);
    expect(await trader.tryExecute(ops.find((o) => o.status === "ready")!, await client.getBlockNumber({ cacheTime: 0 }))).toBeNull();
    const { unlinkSync } = await import("node:fs");
    unlinkSync(stopFile);
  }, 60_000);

  it("sends the trade and books exactly the quoted profit, then the gap is closed", async () => {
    const { trader, store } = build(true);
    const ops = await scanOnce(ctx);
    const best = ops.find((o) => o.status === "ready")!;
    const trade = await trader.tryExecute(best, await client.getBlockNumber({ cacheTime: 0 }));
    expect(trade?.status).toBe("success");
    expect(trade!.realizedProfit).toBe(trade!.quotedProfit);
    expect(store.all().length).toBeGreaterThan(0);
    const after = await scanOnce(ctx);
    expect(after.find((o) => o.status === "ready" && o.direction === "sell-currency0")).toBeUndefined();
  }, 120_000);

  it("proves the trade from the chain: receipt, claim delta and every protocol call in the trace", async () => {
    const { store } = build(false);
    const trades = store.all();
    const prover = makeProver(client, dep, loadSelectors(join(root, "out")));
    const listed = await prover.recent(trades);
    expect(listed.map((t) => t.txHash)).toContain(trades[0].txHash);
    const p = (await prover.prove(trades[0].txHash!, trades)) as any;
    expect(p.tx.status).toBe("success");
    expect(p.network.kind).toBe("local-anvil");
    expect(p.profit.realized).toBe(trades[0].quotedProfit);
    expect(BigInt(p.balances.claimAfter) - BigInt(p.balances.claimBefore)).toBe(BigInt(p.profit.realized));
    expect(p.trace.available).toBe(true);
    const calls = p.trace.steps.map((s: { to: string; call: string }) => `${s.to}.${s.call}`);
    for (const c of ["Uniswap v4 PoolManager.unlock", "FlashArbExecutor.unlockCallback", "Uniswap v4 PoolManager.swap", "Uniswap v4 PoolManager.sync",
      "1inch SwapVM router.swap", "1inch Aqua.pull", "FlashArbExecutor.preTransferInCallback", "Uniswap v4 PoolManager.take", "1inch Aqua.push",
      "Uniswap v4 PoolManager.settle", "Uniswap v4 PoolManager.mint"]) expect(calls).toContain(c);
    expect(p.events.map((e: { name: string }) => e.name)).toEqual(expect.arrayContaining(["Swap", "Pulled", "Pushed", "Transfer (ERC-6909 claim)"]));
  }, 60_000);

  it("trades again after a reseed", async () => {
    sh("reseed.sh");
    await ctx.tracker.sync();
    expect(ctx.tracker.strategies.size).toBe(2);
    const { trader } = build(true);
    const best = (await scanOnce(ctx)).find((o) => o.status === "ready")!;
    expect(best).toBeDefined();
    const trade = await trader.tryExecute(best, await client.getBlockNumber({ cacheTime: 0 }));
    expect(trade?.status).toBe("success");
  }, 180_000);
});
