import { parseAbi } from "viem";

// Mirrors src/FlashArbExecutor.sol
export const executorAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Order { address maker; uint256 traits; bytes data; }",
  "struct Arb { PoolKey key; bool zeroForOne; uint128 amountIn; uint128 minProfit; uint32 lastBlock; bool profitAsClaim; Order order; }",
  "function arb(Arb p)",
  "function withdrawClaim(address currency, uint256 amount, address to)",
  "function OWNER() view returns (address)",
  "function POOL_MANAGER() view returns (address)",
  "function ROUTER() view returns (address)",
  "function AQUA() view returns (address)",
  "error NotOwner()",
  "error NotPoolManager()",
  "error NotRouter()",
  "error Expired(uint256 lastBlock)",
  "error InsufficientProfit(uint256 amountBack, uint256 amountOwed, uint256 minProfit)",
  "error ZeroAddress()",
]);

// 1inch Aqua 0.1.0
export const aquaAbi = parseAbi([
  "event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)",
  "event Docked(address maker, address app, bytes32 strategyHash)",
  "function safeBalances(address maker, address app, bytes32 strategyHash, address token0, address token1) view returns (uint256 balance0, uint256 balance1)",
]);

// Uniswap v4 PoolManager (ERC-6909 claims and raw storage reads)
export const poolManagerAbi = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function extsload(bytes32 slot) view returns (bytes32)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
