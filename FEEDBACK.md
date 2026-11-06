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
