import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Hex } from "viem";

export type Config = {
  rpcUrl: string;
  chainId: number;
  deploymentsPath: string;
  /** forge's build output; the proof endpoint names traced calls from it. */
  artifactsDir: string;
  dryRun: boolean;
  ownerKey?: Hex;
  pollMs: number;
  port: number;
  corsOrigins: string[];
  slippageBps: number;
  expiryBlocks: number;
  maxGasPriceGwei: number;
  logChunk: number;
  dataDir: string;
  stopFile: string;
  profitAsClaim: boolean;
  /** Trade against orders that carry maker hooks. Off by default: a hook is maker-chosen code inside our arb. */
  allowHookedOrders: boolean;
  backoffMs: number;
  maxQuotesPerSearch: number;
  /** Decimal strings in token units, keyed by upper-case symbol. */
  minNetProfit: Record<string, string>;
  maxAmountIn: Record<string, string>;
};

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
}

/** Reads KEY=VALUE lines. Existing environment variables win over the file. */
export function loadDotenv(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (env[key] === undefined) env[key] = value;
  }
}

const int = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];
  const chainId = int(env.CHAIN_ID, 31337);
  const dryRun = (env.DRY_RUN ?? "true").toLowerCase() !== "false";
  const pollMs = int(env.POLL_MS, 3000);
  const port = int(env.PORT, 8787);
  const slippageBps = int(env.SLIPPAGE_BPS, 1000);
  const expiryBlocks = int(env.EXPIRY_BLOCKS, 3);
  const maxGasPriceGwei = int(env.MAX_GAS_PRICE_GWEI, 50);
  const logChunk = int(env.LOG_CHUNK_BLOCKS, 9000);
  const backoffMs = int(env.BACKOFF_MS, 30_000);
  const maxQuotesPerSearch = int(env.MAX_QUOTES_PER_SEARCH, 24);

  const rpcUrl = env.RPC_URL ?? "http://127.0.0.1:8545";
  if (!/^https?:\/\//.test(rpcUrl)) problems.push("RPC_URL must start with http:// or https://");
  if (!Number.isInteger(chainId) || chainId <= 0) problems.push("CHAIN_ID must be a positive integer");
  if (!Number.isInteger(pollMs) || pollMs < 250) problems.push("POLL_MS must be an integer of at least 250");
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push("PORT must be between 1 and 65535");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) problems.push("SLIPPAGE_BPS must be between 0 and 10000");
  if (!Number.isInteger(expiryBlocks) || expiryBlocks < 1 || expiryBlocks > 100) problems.push("EXPIRY_BLOCKS must be between 1 and 100");
  if (!Number.isFinite(maxGasPriceGwei) || maxGasPriceGwei <= 0) problems.push("MAX_GAS_PRICE_GWEI must be above 0");
  if (!Number.isInteger(logChunk) || logChunk < 1) problems.push("LOG_CHUNK_BLOCKS must be a positive integer");
  if (!Number.isInteger(maxQuotesPerSearch) || maxQuotesPerSearch < 6 || maxQuotesPerSearch > 80) problems.push("MAX_QUOTES_PER_SEARCH must be between 6 and 80");

  let ownerKey: Hex | undefined;
  if (!dryRun) {
    if (!env.OWNER_PRIVATE_KEY) problems.push("OWNER_PRIVATE_KEY is required when DRY_RUN=false");
    else if (!/^0x[0-9a-fA-F]{64}$/.test(env.OWNER_PRIVATE_KEY)) problems.push("OWNER_PRIVATE_KEY must be 0x followed by 64 hex characters");
    else ownerKey = env.OWNER_PRIVATE_KEY as Hex;
  } else if (env.OWNER_PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(env.OWNER_PRIVATE_KEY)) {
    ownerKey = env.OWNER_PRIVATE_KEY as Hex; // lets dry-run report the owner check
  }

  const decimalMap = (prefix: string) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (!k.startsWith(prefix) || v === undefined) continue;
      if (!/^\d+(\.\d+)?$/.test(v)) problems.push(`${k} must be a decimal number`);
      else out[k.slice(prefix.length).toUpperCase()] = v;
    }
    return out;
  };

  const minNetProfit = decimalMap("MIN_NET_PROFIT_");
  const maxAmountIn = decimalMap("MAX_AMOUNT_IN_");

  const origins = (env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (problems.length) throw new ConfigError(problems);

  return {
    rpcUrl,
    chainId,
    deploymentsPath: resolve(env.DEPLOYMENTS ?? `../deployments/${chainId}.json`),
    artifactsDir: resolve(env.ARTIFACTS_DIR ?? "../out"),
    dryRun,
    ownerKey,
    pollMs,
    port,
    corsOrigins: origins,
    slippageBps,
    expiryBlocks,
    maxGasPriceGwei,
    logChunk,
    dataDir: resolve(env.DATA_DIR ?? "data"),
    stopFile: resolve(env.STOP_FILE ?? "STOP"),
    profitAsClaim: (env.PROFIT_AS_CLAIM ?? "true").toLowerCase() !== "false",
    allowHookedOrders: (env.ALLOW_HOOKED_ORDERS ?? "false").toLowerCase() === "true",
    backoffMs,
    maxQuotesPerSearch,
    minNetProfit,
    maxAmountIn,
  };
}
