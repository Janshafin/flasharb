# flasharb

Atomic flash arbitrage between Uniswap v4 and 1inch Aqua, built at ETHGlobal Mumbai 2026.

flasharb borrows through Uniswap v4 flash accounting, so there is no flash-loan fee. It trades against an Aqua strategy priced by 1inch SwapVM and keeps the spread, all inside one `PoolManager.unlock`.

**Status: working end to end on a local chain.** The Solidity executor runs Flow A against the official Uniswap v4 PoolManager, Aqua and SwapVM router, in both directions. A searcher bot ([bot/](bot/)) finds, sizes, proves and sends trades, and a dashboard ([web/](web/)) shows its live data and lets you run a trade from a wallet. `scripts/demo.sh` starts all of it. A Huff executor ([src/huff/](src/huff/)) is in progress: its first milestone (the getters, `rescue` and `approveAqua`) matches the Solidity reference in 33 differential tests, but it does not run `arb` yet, so every trade goes through the Solidity executor. The rest of the Huff executor and the `ArbTax` Aqua position come next. The full plan is the [build plan](ai/execution-plan-1.md).

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

## Which link should I open?

- **GitHub source:** https://github.com/Janshafin/flasharb — the published code, not a hosted application.
- **Local app:** http://127.0.0.1:5173/#/app — works on the same computer **only while** `scripts/demo.sh` is running; the script opens it for you. The **Execution proof** page is http://127.0.0.1:5173/#/app/proof.
- **Bot API:** http://127.0.0.1:8787/api/status — must also be running for live opportunities, profit and status. The dashboard reads the API at this local address by default.

Use `127.0.0.1`, not `localhost`: on macOS `localhost` resolves to the IPv6 address `::1` first, and the dashboard listens on IPv4 only, so some browsers fail to connect. If the page still does not open, keep the demo's terminal open: when a service fails to start, the script names it and prints the end of its log (`.demo/chain.log`, `.demo/bot.log` or `.demo/web.log`). Remote VS Code or container setups need port forwarding and a reachable RPC; `127.0.0.1` always refers to the browser's own computer.

**There is no public hosted app URL yet.** Running `npm run build` only creates static frontend files; to host a fully working shared dashboard, deploy both the frontend and a reachable bot API, then configure `VITE_BOT_API_URL`. Local Anvil demo addresses and test liquidity are not Unichain mainnet deployments.

## Run the demo

You need Foundry 1.9 or later and Node 18 or later. One command starts a local chain, deploys the whole stack, opens a real price gap, starts the bot and serves the dashboard:

```bash
git clone --recurse-submodules https://github.com/Janshafin/flasharb.git && cd flasharb
npm ci
scripts/demo.sh
```

The script opens <http://127.0.0.1:5173/#/app> (set `OPEN=0` to skip that). Within seconds the bot finds the gap between a 3,000 USDC per WETH v4 pool and an Aqua strategy selling WETH about 3.4% cheaper, sizes the trade, sends it and books the profit as an ERC-6909 claim. The **Proof** page then shows that transaction as the chain records it: the call trace through the PoolManager, the SwapVM router and Aqua, the receipt's events, gas, and the claim before and after. `scripts/reseed.sh` opens a new gap. Ctrl-C stops everything and frees the ports. Two variations:

- `BOT_MODE=dry scripts/demo.sh` keeps the bot from sending. It still lists trades on the Overview page.
- `RESEED_EVERY=45 scripts/demo.sh` opens a fresh gap every 45 seconds so the demo keeps trading.

The bot signs with anvil's well-known account 0, which exists only on the local chain. Never use that key anywhere else.

### Trade from MetaMask

`arb` is owner-only, and the executor's owner is fixed at deployment. To trade from your own wallet, use a dedicated MetaMask test account (never import anvil's keys into a wallet you use for real funds) and pass its address:

```bash
WALLET=0xYourTestAccount scripts/demo.sh
```

[`scripts/demo-wallet.sh`](scripts/demo-wallet.sh) runs on the local chain only. It deploys a second, unchanged `FlashArbExecutor` whose `OWNER` is that address, gives the address 100 local test ETH, approves Aqua for the executor and points `deployments/31337.json` at it. The bot then runs in dry-run mode: it quotes for your executor but never sends, so it cannot take the trade before you do. No key of yours is used or stored.

1. Open <http://127.0.0.1:5173/#/app/execute> (**Run a trade**). Until you can trade, it shows a checklist with a button for each step: **Connect wallet**, then **Switch network** (MetaMask asks to add Local demo, chain 31337, RPC `http://127.0.0.1:8545`; approve it). If the demo was started without `WALLET=`, the executor belongs to anvil's account and the checklist shows the exact command to restart with your address.
2. On the Overview page, load the ready opportunity into the console. The console shows the pair, direction, the bot's gross profit, gas and net profit, and the minimum profit.
3. **Simulate**, then **Send** and confirm in MetaMask. The log shows the hash, block, gas and the profit read back from chain.
4. The profit is an ERC-6909 claim held by the executor inside the PoolManager, not a token in your wallet. **Withdraw** under Claims turns it into WETH in your wallet.
5. The **Proof** page lists your arbitrage and your withdrawal with their receipts and traces.
6. `scripts/reseed.sh` opens the next gap.

Restarting anvil resets MetaMask's view of the chain: if a send is stuck on a nonce, clear the account's activity in MetaMask (Settings, Advanced).

## How the bot quotes

The bot needs no separate quoter. It calls the real executor with `eth_call` from the owner and an unreachable `minProfit`. The executor always reverts with `InsufficientProfit(amountBack, amountOwed, minProfit)`, and the profit is `amountBack - amountOwed`, which can be negative. That quote runs the exact on-chain path: the v4 swap, the SwapVM callback, the Aqua push and settle. It works on any chain, including a plain local anvil. [test/FlashArbExecutorHardening.t.sol](test/FlashArbExecutorHardening.t.sol) shows the quote equals the profit a real arb books, in both directions.

Profit rises to one peak as the trade grows and then falls, so the bot finds the best size with a golden-section search of about 20 quotes. It prices gas in the profit token from the pool's own price (read straight from PoolManager storage), re-proves the best opportunity on the latest block, sets `minProfit` 10% under the quote, simulates, sends and records the quoted and realised profit.

Safety defaults, all in [bot/.env.example](bot/.env.example):

- `DRY_RUN=true`. The bot sends nothing until you set it to false and give it the owner's key.
- A `bot/STOP` file halts sending immediately. A gas-price cap and an expiry block (`lastBlock`) bound each trade.
- Orders with maker hooks are skipped (`ALLOW_HOOKED_ORDERS=false`), because a hook is maker-chosen code inside your trade.
- The API listens on 127.0.0.1, answers GET only and allows only the dashboard's origin.
- Profit is kept as a claim in the PoolManager by default, so the hot key never holds profit. Withdraw it from the console.

A failed or stale trade costs only gas, because the PoolManager reverts the whole transaction unless every delta nets to zero. See [SECURITY_NOTES.md](SECURITY_NOTES.md) for the trust assumptions.

## Repository layout

| Path | What it is |
| --- | --- |
| `src/` | `FlashArbExecutor` and the SwapVM router interface |
| `test/` | Unit, fuzz and invariant tests, the demo-script tests and the Unichain fork test |
| `script/` | `Deploy` (existing contracts), `DemoSetup` and `Reseed` (local chain) |
| `scripts/` | `demo.sh`, `demo-chain.sh`, `reseed.sh`, `demo-stop.sh` |
| `bot/` | The searcher bot (TypeScript, viem) and its HTTP API |
| `web/` | The landing page, dashboard and trade console (React, Vite, viem) |
| `deployments/` | Deployment records; `31337.json` is regenerated by the demo |

## Quickstart

To work on the contracts only:

```bash
git clone --recurse-submodules https://github.com/Janshafin/flasharb.git && cd flasharb
npm ci        # SwapVM v1.0.2 and Aqua resolve OpenZeppelin and 1inch utils from npm
forge test -vv
```

The bot and the dashboard have their own tests:

```bash
(cd bot && npm ci && npm test)                              # 39 unit tests
(cd bot && DEMO_E2E=1 npx vitest run test/e2e.test.ts)      # 6 tests against a real anvil node (needs anvil and forge)
(cd web && npm ci && npm run build)
```

The Huff tests compile `src/huff/` with Huff Neo and compare it with the Solidity executor. They use their own Foundry profile, so the default profile keeps `ffi` off:

```bash
scripts/install-hnc.sh      # pinned hnc 1.7.1 into ./.tools, checksum-verified
scripts/huff-test.sh -vv    # 38 tests
```

`test/FlashArbExecutor.t.sol` deploys the official contracts from their pinned sources. `test/fork/FlashArbExecutorFork.t.sol` runs the same arb at the canonical Unichain addresses:

```bash
UNICHAIN_RPC_URL=https://<your-unichain-rpc> forge test --match-path 'test/fork/*' -vv
```

No API key is needed: the public endpoint `https://mainnet.unichain.org` works. The fork test only reads chain state and sends nothing. It uses the real deployed PoolManager, Aqua and router, with test tokens, a test pool and a test strategy that it creates on the fork, so it checks the ABIs and wiring rather than live prices. Without `UNICHAIN_RPC_URL`, the fork test rehearses locally by deploying the official sources at those addresses.

## Gas

The first table is call-frame gas from `forge test` (`snapshots/FlashArbExecutor.json`). Storage that a test touched earlier is already warm, so costs on a live chain can be higher; whole-transaction numbers from a Unichain fork will replace these when an RPC is available.

| Build | First arb, claim | First arb, take | Later arb, claim | Later arb, take | Runtime bytecode |
| --- | --- | --- | --- | --- | --- |
| Solidity reference, solc 0.8.30 via-IR | 219,380 | 203,122 | 185,148 | 185,990 | 6,344 B |
| Same source, Solar 0.3.0 | pending | pending | pending | pending | 3,711 B |
| Huff (`hnc` 1.7.1) | pending | pending | pending | pending | pending |

The first ERC-6909 mint fills an empty storage slot, so it costs more than a transfer. After that, a claim beats a transfer only slightly.

Whole-transaction gas from receipts on the local demo chain (anvil, prague), sent by the bot and by `cast`:

| Trade | Gas used |
| --- | --- |
| First arb, WETH claim | 219,396 to 219,496 |
| Later arb, WETH claim | 185,328 |
| First arb in the other direction, USDC claim | 219,312 |

The receipts agree with the call-frame numbers above to within 0.1%. The Huff and Solar rows stay "pending" until those builds exist.

## Deploying to Unichain

Nothing here has been deployed to a real network. The steps below were rehearsed on a local anvil fork of Unichain (chain 130), where the canonical contracts exist and nothing real is touched. Read [SECURITY_NOTES.md](SECURITY_NOTES.md) first: there is no external audit.

Verified against the live chain (read-only calls to the public RPC): PoolManager `0x1F98…0004`, Aqua `0x1111…a90a` and the SwapVM router `0x1111…C0De` all have code, and `forge test --match-path 'test/fork/*'` with `UNICHAIN_RPC_URL` set runs Flow A through them and books a profit. WETH is `0x4200…0006` (18 decimals) and USDC is `0x078D…7AD6` (6 decimals), checked by reading `symbol()` and `decimals()`.

1. Use a dedicated owner key and keep it out of the repository: a hardware wallet (`--ledger`) or an encrypted keystore (`--account <name>`), never `--private-key` on the command line of a real deployment.
2. Rehearse on a fork first:
   ```bash
   anvil --fork-url "$UNICHAIN_RPC_URL" --port 8546
   TOKENS=0x4200000000000000000000000000000000000006,0x078D782b760474a361dDA0AF3839290b0EF57AD6 \
     forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8546 --broadcast --private-key <an anvil test key>
   ```
3. Deploy for real. The executor costs about 1.43M gas and the approvals about 87k, which at the 0.0015 gwei seen on the chain when this was written is a few millionths of an ETH:
   ```bash
   TOKENS=<weth>,<usdc> forge script script/Deploy.s.sol:Deploy --rpc-url "$UNICHAIN_RPC_URL" --broadcast --ledger
   ```
   The script writes `deployments/130.json` with the executor, owner and approved tokens.
4. Add `tokens` and `pools` to that record by hand (copy the shape from `deployments/31337.json`). A pool is its key: the two currencies in address order, the fee, the tick spacing and the hooks address. Use hook-free pools only.
5. Find where a trade could exist before you fund anything: `cd bot && RPC_URL=$UNICHAIN_RPC_URL FROM_BLOCK=<recent block> npm run survey` lists live Aqua strategies and the hook-free v4 pools for their token pairs.
6. Run the bot in dry run against the real chain and watch the Overview page. Set caps in `bot/.env` first: `MAX_AMOUNT_IN_WETH`, `MIN_NET_PROFIT_WETH`, `MAX_GAS_PRICE_GWEI`, and keep `DRY_RUN=true` until the quotes make sense. Going live means `DRY_RUN=false` and the owner key in `OWNER_PRIVATE_KEY`; put only a small amount of ETH for gas on that key.

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

## AI usage

Most of the code after the first import was written with an AI coding assistant under the author's direction. [AI_USAGE.md](AI_USAGE.md) lists which parts, how they were checked, and links the plan and progress log the assistant worked from.

## License

flasharb's own code is MIT-licensed. Dependencies keep their own licenses; SwapVM and Aqua use Degensoft licenses (see `lib/swap-vm/LICENSE` and `lib/aqua/LICENSE`).
