import { readFileSync } from "node:fs";
import { isAddress } from "viem";
import type { Address, Deployment, PoolInfo, TokenInfo } from "./types";

function addr(v: unknown, field: string): Address {
  if (typeof v !== "string" || !isAddress(v)) throw new Error(`deployments: ${field} is not an address`);
  return v as Address;
}

/** Validates a deployment record written by script/DemoSetup.s.sol or script/Deploy.s.sol. */
export function parseDeployment(json: unknown): Deployment {
  if (typeof json !== "object" || json === null) throw new Error("deployments: not an object");
  const j = json as Record<string, any>;
  const tokens: TokenInfo[] = [];
  if (j.tokens && typeof j.tokens === "object") {
    for (const [name, t] of Object.entries<any>(j.tokens)) {
      tokens.push({
        address: addr(t.address, `tokens.${name}.address`),
        symbol: String(t.symbol ?? name).toUpperCase(),
        decimals: Number(t.decimals),
      });
      if (!Number.isInteger(tokens[tokens.length - 1].decimals)) throw new Error(`deployments: tokens.${name}.decimals`);
    }
  }
  const pools: PoolInfo[] = (Array.isArray(j.pools) ? j.pools : []).map((p: any, i: number) => {
    const k = p?.key ?? {};
    return {
      symbol: String(p.symbol ?? `pool-${i}`),
      key: {
        currency0: addr(k.currency0, `pools[${i}].key.currency0`),
        currency1: addr(k.currency1, `pools[${i}].key.currency1`),
        fee: Number(k.fee),
        tickSpacing: Number(k.tickSpacing),
        hooks: addr(k.hooks, `pools[${i}].key.hooks`),
      },
    };
  });
  if (BigInt(pools[0]?.key.currency0 ?? 0) >= BigInt(pools[0]?.key.currency1 ?? 1) && pools.length)
    throw new Error("deployments: currency0 must be below currency1");
  return {
    chainId: Number(j.chainId),
    startBlock: BigInt(j.startBlock ?? 0),
    poolManager: addr(j.poolManager, "poolManager"),
    aqua: addr(j.aqua, "aqua"),
    router: addr(j.router, "router"),
    executor: addr(j.executor, "executor"),
    owner: addr(j.owner, "owner"),
    tokens,
    pools,
  };
}

export function loadDeployment(path: string): Deployment {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Cannot read ${path}. Run scripts/demo-chain.sh first, or set DEPLOYMENTS to your record.`);
  }
  return parseDeployment(JSON.parse(raw));
}

export function tokenInfo(dep: Deployment, address: Address): TokenInfo {
  return (
    dep.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase()) ?? {
      address,
      symbol: `${address.slice(0, 6)}…${address.slice(-4)}`.toUpperCase(),
      decimals: 18,
    }
  );
}
