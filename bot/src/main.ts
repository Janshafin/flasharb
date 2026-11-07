import { createPublicClient, createWalletClient, defineChain, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { executorAbi } from "./abi";
import { ConfigError, loadDotenv, parseConfig } from "./config";
import { loadDeployment } from "./deployments";
import { Trader } from "./execute";
import { makeLogger } from "./log";
import { loadSelectors, makeProver } from "./proof";
import { scanOnce, type ScanCtx } from "./scanner";
import { startServer, type AppState } from "./server";
import { TradeStore } from "./store";
import { StrategyTracker } from "./tracker";
import type { Address } from "./types";

async function main() {
  loadDotenv(".env");
  let cfg;
  try {
    cfg = parseConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const log = makeLogger(cfg.ownerKey ? [cfg.ownerKey] : []);
  const dep = loadDeployment(cfg.deploymentsPath);
  const client = createPublicClient({ transport: http(cfg.rpcUrl), cacheTime: 0 });

  const chainId = await client.getChainId();
  if (chainId !== cfg.chainId || chainId !== dep.chainId) {
    log.error(`Chain mismatch: RPC reports ${chainId}, CHAIN_ID is ${cfg.chainId}, deployment record is for ${dep.chainId}.`);
    process.exit(1);
  }
  const onChainOwner = await client.readContract({ address: dep.executor, abi: executorAbi, functionName: "OWNER" });

  let wallet: WalletClient | undefined;
  let botAddress: Address | undefined;
  if (cfg.ownerKey) {
    const account = privateKeyToAccount(cfg.ownerKey);
    botAddress = account.address;
    if (account.address.toLowerCase() !== onChainOwner.toLowerCase()) {
      log.error(`OWNER_PRIVATE_KEY controls ${account.address}, but the executor is owned by ${onChainOwner}. Use the owner's key.`);
      if (!cfg.dryRun) process.exit(1);
    }
    wallet = createWalletClient({
      account,
      chain: defineChain({ id: chainId, name: "target", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } }),
      transport: http(cfg.rpcUrl),
    });
  }

  const wrapped = process.env.WRAPPED_NATIVE
    ? (process.env.WRAPPED_NATIVE as Address)
    : dep.tokens.find((t) => t.symbol === "WETH")?.address;
  const store = new TradeStore(cfg.dataDir);
  const tracker = new StrategyTracker(client, dep, cfg.logChunk);
  const backoff = new Map<string, number>();
  const trader = new Trader(client, wallet, dep, cfg, store, backoff, log);
  const ctx: ScanCtx = { client, dep, cfg, tracker, wrappedNative: wrapped, backoff, skippedHooked: new Set<string>(), log };

  const state: AppState = {
    opportunities: [], startedAt: Date.now(), lastScanAt: null, scanCount: 0, lastError: undefined,
    head: 0n, botAddress, stopped: () => trader.stopped(),
  };
  const prover = makeProver(client, dep, loadSelectors(cfg.artifactsDir));
  const server = startServer({ cfg, dep, client, store, state, prover });
  log.info(`flasharb bot up: chain ${chainId}, executor ${dep.executor}, ${cfg.dryRun ? "DRY RUN (no transactions)" : "LIVE"}, api http://127.0.0.1:${cfg.port}`);

  let running = true;
  const stop = () => {
    running = false;
    server.close();
    log.info("shutting down");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    try {
      const { head, added } = await tracker.sync();
      if (added) log.info(`found ${added} new Aqua strategy(ies); tracking ${tracker.strategies.size}`);
      state.head = head;
      state.opportunities = await scanOnce(ctx);
      state.lastScanAt = Date.now();
      state.scanCount++;
      state.lastError = trader.lastError;
      const best = state.opportunities.find((o) => o.status === "ready");
      if (best) {
        log.info(`ready: ${best.id} size ${best.amountIn} quoted ${best.quotedProfit} ${best.profitSymbol} net ${best.netProfit}`);
        await trader.tryExecute(best, head);
      }
    } catch (e) {
      state.lastError = e instanceof Error ? e.message.split("\n")[0] : String(e);
      log.error(`scan failed: ${state.lastError}`);
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
