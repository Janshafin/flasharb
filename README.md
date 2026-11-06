# flasharb

Atomic flash arbitrage between Uniswap v4 and 1inch Aqua, built at ETHGlobal Mumbai 2026.

flasharb borrows through Uniswap v4 flash accounting, buys back from a 1inch Aqua strategy priced by SwapVM, and keeps the spread, all inside one `PoolManager.unlock`. There is no flash-loan fee and no starting capital, and a bad arb costs only gas.

## How it works

1. **Borrow by swapping first.** Sell WETH on the v4 pool, exact-in. The PoolManager only records deltas; no tokens move.
2. **Buy back on Aqua.** Call `sync(WETH)`, then swap the USDC on the SwapVM router with its output pointed at the PoolManager. Aqua pulls WETH from the maker's wallet straight in.
3. **Pay the maker in the callback.** In `preTransferInCallback`, `take` the USDC and `push` it to the maker through Aqua.
4. **Settle and keep the spread.** `settle()` credits the WETH. Profit stays as an ERC-6909 claim or goes to the owner.

The PoolManager reverts everything unless every delta nets to zero. One arb moves exactly three ERC20 transfers.

## Design choices

- **Flash source:** Uniswap v4 flash accounting instead of a flash-loan contract, so there is no fee.
- **Counter-venue:** Aqua strategies through the deployed SwapVM router v1.0.x, which pays out first and calls back for payment.
- **Chain:** Unichain, Uniswap's L2, where Aqua and the router are deployed. Base is the fallback; demos run on a fork.
- **Code:** a Huff executor (Huff Neo `hnc`) and a Solidity + Solady twin. The twin is compiled with both solc and Paradigm's Solar 0.3.0, so every gas claim is a measured diff.
- **Aqua position:** an `ArbTax` Extruction charges a fee scaled by the priority fee (Paradigm's MEV tax), so LPs keep most of each arb.

## Gas techniques

Already in the Solidity reference executor:

- No flash-loan call: the v4 leg only creates deltas.
- Aqua pays straight into the PoolManager, skipping a hop through the executor.
- The maker is paid inside the callback, not through SwapVM's transferFrom-and-push mode.
- No storage: addresses are immutables in bytecode, and the 22-byte SwapVM taker header is a constant.
- No `balanceOf` calls; Aqua is approved once per token.

The Huff build adds:

- Dispatch by caller instead of selector.
- Packed calldata, with a pool table in bytecode.
- No `EXTCODESIZE` checks, and bare `revert(0, 0)`.

## Status

| Piece | State |
| --- | --- |
| Solidity reference executor, Flow A | Done: 11 tests pass against the official PoolManager v4.0.0, Aqua 0.1.0 and SwapVM v1.0.2 router |
| Test at the canonical Unichain addresses | Ready; runs on a fork when `UNICHAIN_RPC_URL` is set |
| Huff executor | Next |
| `ArbTax` Aqua position and the viem searcher bot | Planned |
| Gas benchmarks (solc, Solar, Huff) | In progress |

Provisional gas, measured inside `forge test` with warm storage, is about 185,000 per repeat arb. The executor's runtime bytecode is 6,344 bytes with solc 0.8.30 and 3,711 bytes with Solar 0.3.0.

## Quickstart

You need Foundry 1.9 or later and Node 18 or later.

```bash
git clone --recurse-submodules <this repo> flasharb && cd flasharb
npm ci
forge test -vv
UNICHAIN_RPC_URL=https://<your-rpc> forge test --match-path 'test/fork/*' -vv
```

## Where Uniswap is used

| Call | Where |
| --- | --- |
| `unlock` and `unlockCallback` | [src/FlashArbExecutor.sol#L77-L81](src/FlashArbExecutor.sol#L77-L81), [#L102-L112](src/FlashArbExecutor.sol#L102-L112) |
| v4 `swap`, exact-in, deltas only | [#L133-L148](src/FlashArbExecutor.sol#L133-L148) |
| `sync` and `settle` | [#L152](src/FlashArbExecutor.sol#L152), [#L163](src/FlashArbExecutor.sol#L163) |
| `take` to pay the maker | [#L128](src/FlashArbExecutor.sol#L128) |
| ERC-6909 `mint`, `burn` and `take` | [#L168-L172](src/FlashArbExecutor.sol#L168-L172), [#L108-L109](src/FlashArbExecutor.sol#L108-L109) |

## Where 1inch Aqua and SwapVM are used

| Call | Where |
| --- | --- |
| Router `swap`, v1.0.x ABI | [src/FlashArbExecutor.sol#L150-L162](src/FlashArbExecutor.sol#L150-L162) |
| Taker header | [#L25-L27](src/FlashArbExecutor.sol#L25-L27) |
| `preTransferInCallback`, then `Aqua.push` | [#L114-L130](src/FlashArbExecutor.sol#L114-L130) |
| Strategy built and shipped to Aqua | [test/base/FlashArbTestBase.sol#L92-L112](test/base/FlashArbTestBase.sol#L92-L112) |

## Deployments

| Contract | Address |
| --- | --- |
| Uniswap v4 PoolManager (Unichain) | `0x1F98400000000000000000000000000000000004` |
| 1inch Aqua (same on all chains) | `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` |
| 1inch SwapVM router v1.0.x (same on all chains) | `0x111111338c5091E8440b67B168bAe16a668AC0De` |

## Prizes targeted

- **Uniswap, Build with Uniswap:** v4 PoolManager integration, a public repo, `FEEDBACK.md`, and the line links above.
- **1inch, Build an Aqua App:** the `ArbTax` maker position on the official Aqua and SwapVM contracts, with on-chain token transfers shown in a fork demo.

## License

flasharb's own code is MIT-licensed. Dependencies keep their own licenses; SwapVM and Aqua use Degensoft licenses.