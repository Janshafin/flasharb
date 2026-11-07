# flasharb

Atomic flash arbitrage between Uniswap v4 and 1inch Aqua, built at ETHGlobal Mumbai 2026.

flasharb borrows through Uniswap v4 flash accounting, so there is no flash-loan fee. It trades against an Aqua strategy priced by 1inch SwapVM and keeps the spread, all inside one `PoolManager.unlock`.

**Status: the contracts are complete and tested; the bot and dashboard are not published yet.** The Solidity executor runs Flow A against the official Uniswap v4 PoolManager, Aqua and SwapVM router, in both directions, with hardening and invariant tests and local deploy, demo and reseed scripts. A Huff executor ([src/huff/](src/huff/)) is in progress: its first milestone (the getters, `rescue` and `approveAqua`) matches the Solidity reference in 33 differential tests, but it does not run `arb` yet. The searcher bot and the dashboard exist but are held back from this repository until their npm lockfiles can be published. The `ArbTax` Aqua position comes next. The full plan is the [build plan](https://claude.ai/artifact/GBN6BgXjyJqCQ64srJBFgC).

## How one arb works (Flow A)

1. Sell `amountIn` WETH on the v4 pool, exact-in. The PoolManager only records deltas; no tokens move.
2. `sync(WETH)`, then swap all of the USDC output on the SwapVM router. Its `to` slice points at the PoolManager, so Aqua pulls WETH from the maker's wallet straight into it.
3. SwapVM calls `preTransferInCallback`: the executor `take`s the USDC it is owed and `push`es it to the maker through Aqua.
4. `settle()` credits the WETH that arrived. The executor keeps WETH back minus WETH sold, as an ERC-6909 claim or a transfer.

The PoolManager reverts the whole transaction unless every delta nets to zero, so a bad arb costs only gas. One arb moves three ERC20 transfers in total.

## Where Uniswap is used

| Call | Where |
| --- | --- |
| `unlock` (entry) and `unlockCallback` | [src/FlashArbExecutor.sol#L77-L81](src/FlashArbExecutor.sol#L77-L81), [#L102-L112](src/FlashArbExecutor.sol#L102-L112) |
| `swap`, the v4 leg (exact-in, deltas only) | [src/FlashArbExecutor.sol#L133-L148](src/FlashArbExecutor.sol#L133-L148) |
| `sync` + `settle`, Aqua paying straight into the PoolManager | [src/FlashArbExecutor.sol#L152](src/FlashArbExecutor.sol#L152), [#L163](src/FlashArbExecutor.sol#L163) |
| `take`, paying the Aqua maker from the v4 delta | [src/FlashArbExecutor.sol#L128](src/FlashArbExecutor.sol#L128) |
| `mint` / `burn` / `take`, ERC-6909 profit claims | [src/FlashArbExecutor.sol#L168-L172](src/FlashArbExecutor.sol#L168-L172), [#L108-L109](src/FlashArbExecutor.sol#L108-L109) |
| PoolManager, pool and liquidity in tests | [test/base/FlashArbTestBase.sol#L50-L77](test/base/FlashArbTestBase.sol#L50-L77) |

## Where 1inch Aqua and SwapVM are used

| Call | Where |
| --- | --- |
| Router `swap` (deployed v1.0.x ABI) | [src/FlashArbExecutor.sol#L150-L162](src/FlashArbExecutor.sol#L150-L162), [src/interfaces/ISwapVMRouter.sol](src/interfaces/ISwapVMRouter.sol) |
| Taker header: exact-in, pre-transfer-in callback, output to the PoolManager | [src/FlashArbExecutor.sol#L25-L27](src/FlashArbExecutor.sol#L25-L27) |
| `preTransferInCallback`, then `Aqua.push` to the maker | [src/FlashArbExecutor.sol#L114-L130](src/FlashArbExecutor.sol#L114-L130) |
| Strategy built with SwapVM's builders and shipped to Aqua | [test/base/FlashArbTestBase.sol#L92-L112](test/base/FlashArbTestBase.sol#L92-L112) |
| The header checked against SwapVM's own `TakerTraitsLib.build` | [test/FlashArbExecutor.t.sol](test/FlashArbExecutor.t.sol) (`test_takerHeaderMatchesSwapVMBuilder`) |

## Quickstart

You need Foundry 1.9 or later (`foundryup`) and Node 18 or later.

```bash
git clone --recurse-submodules <this repo> flasharb && cd flasharb
npm ci        # SwapVM v1.0.2 and Aqua resolve OpenZeppelin and 1inch utils from npm
forge test -vv
```

`test/FlashArbExecutor.t.sol` deploys the official contracts from their pinned sources. `test/fork/FlashArbExecutorFork.t.sol` runs the same arb at the canonical Unichain addresses:

```bash
UNICHAIN_RPC_URL=https://<your-unichain-rpc> forge test --match-path 'test/fork/*' -vv
```

No API key is needed: the public endpoint `https://mainnet.unichain.org` works. The fork test only reads chain state and sends nothing; it uses the real deployed PoolManager, Aqua and router with test tokens, a test pool and a test strategy it creates on the fork. Without `UNICHAIN_RPC_URL`, the fork test rehearses locally by deploying the official sources at those addresses.

To run a local chain with the whole stack deployed and a real price gap between the v4 pool and an Aqua strategy (anvil and forge only):

```bash
scripts/demo-chain.sh     # anvil on 8545, writes deployments/31337.json
scripts/reseed.sh         # opens a fresh gap
scripts/demo-stop.sh
```

The Huff tests compile `src/huff/` with Huff Neo and compare it with the Solidity executor. They use their own Foundry profile, so the default profile keeps `ffi` off:

```bash
scripts/install-hnc.sh      # pinned hnc 1.7.1 into ./.tools, checksum-verified
scripts/huff-test.sh -vv    # 38 tests
```

## Gas, provisional

These numbers are call-frame gas from `forge test` (`snapshots/FlashArbExecutor.json`). Storage that the test touched earlier is warm, so real transactions cost more; whole-transaction numbers will come from fork receipts.

| Build | First arb, claim | First arb, take | Later arb, claim | Later arb, take | Runtime bytecode |
| --- | --- | --- | --- | --- | --- |
| Solidity reference, solc 0.8.30 via-IR | 219,380 | 203,122 | 185,148 | 185,990 | 6,344 B |
| Same source, Solar 0.3.0 | pending | pending | pending | pending | 3,711 B |
| Huff (`hnc` 1.7.1) | pending | pending | pending | pending | pending |

The first ERC-6909 mint fills an empty storage slot, so it costs more than a transfer. After that, a claim beats a transfer only slightly.

## Dependencies

| Dependency | Version | Why this version |
| --- | --- | --- |
| [Uniswap v4-core](https://github.com/Uniswap/v4-core) | v4.0.0 | The deployed PoolManager |
| [1inch SwapVM](https://github.com/1inch/swap-vm) | v1.0.2 | The deployed router's ABI; `main` has a different `swap` signature and opcode numbering |
| [1inch Aqua](https://github.com/1inch/aqua) | 0.1.0 | What SwapVM v1.0.2 builds against |
| [Solady](https://github.com/Vectorized/solady) | v0.1.26 | `SafeTransferLib` |
| [foundry-huff-neo](https://github.com/cakevm/foundry-huff-neo) | v1.2.0 | Huff tests, next |
| `@1inch/solidity-utils`, `@openzeppelin/contracts` (npm) | 6.9.7, 5.4.0 | SwapVM v1.0.2's own pins |

PoolManager pins solc 0.8.26 while SwapVM and Aqua pin 0.8.30. [test/utils/V4Artifacts.sol](test/utils/V4Artifacts.sol) compiles PoolManager on its own, and tests deploy it with `deployCode`.

## License

flasharb's own code is MIT-licensed. Dependencies keep their own licenses; SwapVM and Aqua use Degensoft licenses (see `lib/swap-vm/LICENSE` and `lib/aqua/LICENSE`).
