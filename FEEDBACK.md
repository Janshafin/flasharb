# Uniswap developer feedback

Notes from building flasharb, a flash-arbitrage executor on Uniswap v4 flash accounting, at ETHGlobal Mumbai 2026. This is a running log; we add to it as we build.

## What worked well

- **Flash accounting removes the flash loan.** Swapping on v4 first and paying at the end of `unlock` made the arbitrage capital-free with no separate flash-loan API. Pointing another protocol's payout straight at the PoolManager and calling `settle()` worked first time.
- **`unlockCallback` revert bubbling.** Custom errors thrown inside the callback reach the caller intact, so tests can assert on them.

## Friction

- **Skills list out of date.** The [Uniswap Skills page](https://developers.uniswap.org/docs/uniswap-ai/skills) lists 11 skills, but `npx skills add Uniswap/uniswap-ai` installs 18. The page omits `v4-hook-generator`, `v4-sdk-integration`, `lp-integration`, `pay-with-app` and the three permissioned-pools skills.
- **`v4-security-foundations` shows an old `settle` signature.** Its delta table and example call `settle(currency)`. In v4-core v4.0.0 (the deployed PoolManager), `settle()` takes no argument and settles whatever `sync` recorded. An agent following the skill writes code that does not compile.
- **Struct locations differ by version.** On v4-core `main`, `SwapParams` and `ModifyLiquidityParams` live in `src/types/PoolOperation.sol`. In v4.0.0 they are `IPoolManager.SwapParams` and `IPoolManager.ModifyLiquidityParams`. Examples that don't name the version they target send integrators to the wrong import.
- **The exact `pragma solidity 0.8.26` on PoolManager.** Projects that also depend on code pinned to another exact version, such as 1inch SwapVM at 0.8.30, cannot import PoolManager into the same test. We compile it in a separate file and deploy it by artifact. A caret pragma, or a published test artifact, would make local integration tests easier.

## Notes for the docs

- **When ERC-6909 claims save gas.** Minting profit as a claim instead of `take` costs about 16,000 more gas on the first arb, because the claim slot starts empty. On later arbs it saved about 840 gas in our tests. A sentence on when claims pay off would help people choosing between them.

## Building the searcher bot

- **Reading a pool's price without StateView.** The docs point integrators at the StateView contract, which is not deployed on a fresh local chain. Reading `slot0` straight from the PoolManager works with `extsload`, but the storage layout (`POOLS_SLOT` is 6 in v4-core v4.0.0, and the pool slot is `keccak256(poolId ++ 6)`) is only written down in `StateLibrary.sol`. A short "reading state off-chain without StateView" note with that layout would save local-development setups a detour.
- **Quoting an arbitrage by revert.** Flash accounting makes a quote cheap to build: call the executor with an unreachable minimum profit and read the numbers out of the revert. No quoter contract is needed, and it follows the exact on-chain path, including callbacks into other protocols. V4Quoter uses the same idea for plain swaps; a sentence in the docs saying the pattern extends to custom flash-accounting contracts would help.
- **`deployCode` works under `forge script --broadcast`.** Deploying PoolManager (solc 0.8.26) from a 0.8.30 script by artifact is recorded and broadcast like a normal deploy, so the split-compiler workaround for tests also works for local deploy scripts.
- **Test isolation.** Forge runs tests in parallel and environment variables are process-wide, so a test that sets an env var with `vm.setEnv` can race with another one. Passing parameters to a script's `deploy(...)` function instead of reading the environment in `run()` avoids it.
