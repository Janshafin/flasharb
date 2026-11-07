import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PublicClient } from "viem";
import { erc20Abi, executorAbi, poolManagerAbi } from "./abi";
import type { Config } from "./config";
import type { makeProver } from "./proof";
import type { TradeStore } from "./store";
import type { Address, Deployment, Opportunity } from "./types";

export type AppState = {
  opportunities: Opportunity[];
  startedAt: number;
  lastScanAt: number | null;
  scanCount: number;
  lastError: string | undefined;
  head: bigint;
  botAddress: Address | undefined;
  stopped: () => boolean;
};

const json = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function startServer(opts: {
  cfg: Config; dep: Deployment; client: PublicClient; store: TradeStore; state: AppState; prover?: ReturnType<typeof makeProver>;
}): Server {
  const { cfg, dep, client, store, state, prover } = opts;

  const send = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown) => {
    const origin = req.headers.origin;
    if (origin && cfg.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(status);
    res.end(JSON.stringify(body, json));
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        return send(req, res, 204, {});
      }
      if (req.method !== "GET") return send(req, res, 405, { error: "Only GET is supported." });
      const url = new URL(req.url ?? "/", "http://localhost");
      switch (url.pathname) {
        case "/api/health":
          return send(req, res, 200, { ok: true });
        case "/api/status": {
          let owner: string | undefined;
          try {
            owner = await client.readContract({ address: dep.executor, abi: executorAbi, functionName: "OWNER" });
          } catch {
            owner = undefined;
          }
          return send(req, res, 200, {
            chainId: dep.chainId,
            block: state.head,
            executor: dep.executor,
            owner,
            poolManager: dep.poolManager,
            aqua: dep.aqua,
            router: dep.router,
            tokens: dep.tokens,
            pools: dep.pools,
            botAddress: state.botAddress ?? null,
            dryRun: cfg.dryRun,
            stopped: state.stopped(),
            profitAsClaim: cfg.profitAsClaim,
            lastError: state.lastError ?? null,
            lastScanAt: state.lastScanAt,
            scanCount: state.scanCount,
            uptimeMs: Date.now() - state.startedAt,
          });
        }
        case "/api/opportunities":
          return send(req, res, 200, { opportunities: state.opportunities, scannedAt: state.lastScanAt });
        case "/api/trades": {
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
          return send(req, res, 200, { trades: store.recent(limit) });
        }
        case "/api/pnl":
          return send(req, res, 200, { series: store.pnl(Date.now()) });
        case "/api/claims": {
          const claims = await Promise.all(
            dep.tokens.map(async (t) => {
              const [claim, held] = await Promise.all([
                client.readContract({ address: dep.poolManager, abi: poolManagerAbi, functionName: "balanceOf", args: [dep.executor, BigInt(t.address)] }),
                client.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [dep.executor] }),
              ]);
              return { symbol: t.symbol, address: t.address, decimals: t.decimals, claim, held };
            }),
          );
          return send(req, res, 200, { claims });
        }
        case "/api/proofs":
          if (!prover) return send(req, res, 404, { error: "Proofs are not enabled." });
          return send(req, res, 200, { executor: dep.executor, transactions: await prover.recent(store.recent(200)) });
        case "/api/proof": {
          if (!prover) return send(req, res, 404, { error: "Proofs are not enabled." });
          const tx = url.searchParams.get("tx") ?? "";
          if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return send(req, res, 400, { error: "Pass ?tx= with a 32-byte transaction hash." });
          return send(req, res, 200, await prover.prove(tx as `0x${string}`, store.recent(200)));
        }
        default:
          return send(req, res, 404, { error: "Unknown endpoint." });
      }
    } catch (e) {
      return send(req, res, 500, { error: e instanceof Error ? e.message.split("\n")[0] : "Internal error." });
    }
  });
  server.listen(cfg.port, "127.0.0.1");
  return server;
}
