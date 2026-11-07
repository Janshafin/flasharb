import type { Address, Hex } from "viem";

export type { Address, Hex };

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** SwapVM Order as the executor takes it. */
export type Order = { maker: Address; traits: bigint; data: Hex };

export type Strategy = { maker: Address; strategyHash: Hex; order: Order; shippedBlock: bigint; hooked: boolean };

export type TokenInfo = { address: Address; symbol: string; decimals: number };

export type PoolInfo = { symbol: string; key: PoolKey };

export type Deployment = {
  chainId: number;
  startBlock: bigint;
  poolManager: Address;
  aqua: Address;
  router: Address;
  executor: Address;
  owner: Address;
  tokens: TokenInfo[];
  pools: PoolInfo[];
};

export type Direction = "sell-currency0" | "sell-currency1";

export type OpportunityStatus = "ready" | "below-threshold" | "unprofitable" | "unpriced" | "backoff";

/** Everything is a decimal string where it could exceed 2^53, so the API stays JSON-safe. */
export type Opportunity = {
  id: string;
  pool: string;
  poolKey: PoolKey;
  strategyHash: Hex;
  order: { maker: Address; traits: string; data: Hex };
  direction: Direction;
  sellToken: Address;
  profitSymbol: string;
  decimals: number;
  amountIn: string;
  quotedProfit: string;
  gas: string;
  gasCost: string;
  netProfit: string;
  status: OpportunityStatus;
  note?: string;
  block: string;
  scannedAt: number;
};

export type Trade = {
  id: string;
  ts: number;
  block: string;
  txHash: Hex | null;
  pool: string;
  direction: Direction;
  profitSymbol: string;
  profitToken: Address;
  decimals: number;
  amountIn: string;
  quotedProfit: string;
  minProfit: string;
  realizedProfit: string;
  gasUsed: string;
  effectiveGasPrice: string;
  status: "success" | "reverted" | "failed";
  error?: string;
};
