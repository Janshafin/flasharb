import { parseAbi } from "viem";

// Mirrors src/FlashArbExecutor.sol
export const executorAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Order { address maker; uint256 traits; bytes data; }",
  "struct Arb { PoolKey key; bool zeroForOne; uint128 amountIn; uint128 minProfit; uint32 lastBlock; bool profitAsClaim; Order order; }",
  "function arb(Arb p)",
  "function withdrawClaim(address currency, uint256 amount, address to)",
  "function approveAqua(address[] tokens)",
  "function rescue(address token, address to, uint256 amount)",
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

export const poolManagerAbi = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);
export const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
