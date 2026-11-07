---

## Stage 0: Orientation and guardrails

**Goal:** a verified starting point and a working log.

Tasks:
1. Follow the resume protocol. Create `PROGRESS.md`.
2. Ask the user once whether you may run the Huff compiler installer (`curl -L https://raw.githubusercontent.com/cakevm/huff-neo/main/hnc-up/install | bash`) when Stage 5 comes. The git question is already answered: commit each logical unit, no Claude attribution (§2, §2b). Record the Huff answer in `PROGRESS.md`.
3. Install the Uniswap skills (`npx skills add Uniswap/uniswap-ai`) after reading what the command does (§2c). Read `v4-security-foundations` with the `settle()` caveat in mind. If installing fails, note it and continue.
4. Record the baseline: `forge test -vv`, `forge fmt --check`, `cd web && npm ci && npm run build`.
5. **Commit the existing untracked work**, one logical unit at a time (§2b). Today `git status` shows `web/`, `assets/` and `.claude/` plus the two working files as untracked. In this order:
   1. `.gitignore`: add `web/dist/`, `bot/data/` and `deployments/31337.json`. Subject: `chore: ignore web build output and local demo state`.
   2. `.git/info/exclude`: add `.claude/`, `SONNET_EXECUTION_PLAN.md`, `PROGRESS.md` (local only, no commit).
   3. `assets/branding/flasharb-icon-prompt.txt`. Subject: `docs: add flasharb icon brief`. See Stage 4 for how it's used.
   4. `web/` (everything except what `.gitignore` excludes, including `web/package-lock.json`): run `cd web && npm ci && npm run build` first, confirm `git status` lists no `node_modules` or `dist`. Subject: `feat(web): add landing page, dashboard and trade console`, with a body that says the dashboard shows sample data until the bot exists and that the console simulates before it sends.
   5. If `CLAUDE.md` should mention `web/`, add one line in its own commit (`docs: note web/ in agent instructions`).

**Gate checks:** the baseline commands pass, `PROGRESS.md` exists and lists the Huff answer, `git status --short` is clean, and `git log --oneline -6` shows the commits above with no Claude trailers (`git log -6 --format=%B | grep -ci "claude\|co-authored"` prints 0).

## Stage 1: Harden the Solidity executor (tests first, ABI unchanged)

**Goal:** confidence that the reference executor is correct, including the quote-by-revert trick.

Tasks (add tests under `test/`, reusing `FlashArbTestBase`):
1. **Reverse direction.** Ship an Aqua strategy that pays *more* USDC per WETH than v4, then arb with `zeroForOne` flipped so USDC is sold on v4 and the profit is in USDC. Assert the USDC claim and that the executor holds zero balances. If the base helpers assume WETH-in, add a second helper. Don't break the existing ones.
2. **Quote by revert.** Call `arb` with `minProfit = type(uint128).max`, decode `InsufficientProfit`, and assert that `amountBack - amountOwed` equals the profit a real `arb` produces from the same state. Use `vm.snapshotState` / `vm.revertToState`. Do this for both directions and three sizes.
3. **Owner-only coverage** for `withdrawClaim`, `approveAqua` and `rescue`. Also test that `rescue` moves stray tokens.
4. **Callback abuse:** `preTransferInCallback` from the router with `taker != executor` must revert with `NotRouter`. Explain in a comment why a third party can't make SwapVM call back into the executor, with the reasoning checked against SwapVM's source.
5. **Invariant test** (forge `invariant_`, using a handler that calls arb with bounded sizes on both directions): after every call the executor holds no ERC-20 balances, and the PoolManager holds no unsettled deltas for it.
6. **Size curve:** a test that shows profit rising and then falling as `amountIn` grows. This guides the bot's search.
7. Run `forge snapshot` or `forge test` and confirm the snapshot file is unchanged, since there are no contract edits.

**Gate checks:** `forge test -vv` all pass, the count of new tests is recorded in `PROGRESS.md`, `forge fmt --check` is clean, and `git diff --stat snapshots/` is empty.

**Stop rule:** if the quote-by-revert result doesn't equal real profit, stop and report to the user before Stage 3. The bot design depends on it.

## Stage 2: Deploy and demo scripts

**Goal:** one command turns an empty local chain into a live arbitrage opportunity.

Tasks:
1. `script/Deploy.s.sol` deploys `FlashArbExecutor` with constructor arguments taken from per-chain constants: canonical Unichain addresses for chainId 130, or addresses from `deployments/<chainId>.json` for local. The owner is the broadcaster. It then calls `approveAqua` for configured tokens and writes the result to `deployments/<chainId>.json` with `vm.writeJson`.
2. `script/DemoSetup.s.sol`, local only. It refuses to run unless `block.chainid == 31337`. It:
   - deploys PoolManager by artifact (`deployCode("PoolManager.sol:PoolManager", ...)`), Aqua, and the SwapVM Aqua router by artifact, following the same split-compiler approach as the tests;
   - deploys mock WETH (18 decimals) and USDC (6 decimals), initializes a 0.3% WETH/USDC pool at 3,000 USDC per WETH, and adds full-range liquidity;
   - funds a maker account and ships a constant-product Aqua strategy at about 2,900 USDC per WETH. Build it with `ProgramBuilder`, as in the fork test;
   - deploys the executor and runs `approveAqua`;
   - writes every address, the pool key, the order (maker, traits as a decimal string, data as hex) and the strategy hash to `deployments/31337.json`.
3. `scripts/demo-chain.sh` starts `anvil` (chain id 31337, block time 2 s) and runs `forge script script/DemoSetup.s.sol --rpc-url http://127.0.0.1:8545 --broadcast` with anvil's first default account. Read that key from anvil's output or an env var, and never reuse it on a real network. Then it prints next steps.
4. `scripts/reseed.sh` (or a script function) re-opens a gap by shipping a fresh cheap strategy or moving the v4 price with a swap, so the demo can run again after the bot closes the gap.
5. A fork rehearsal: `anvil --fork-url $UNICHAIN_RPC_URL` plus `Deploy.s.sol` against the fork, if the user provides an RPC. Record the canonical-address deployment works. Skip it with a note if there's no RPC.
6. Add `deployments/31337.json` to `.gitignore`, since it's regenerated every run. Keep other `deployments/*.json` trackable.

**Gate checks:**
- `scripts/demo-chain.sh` runs end to end and the JSON exists.
- A `cast call` of `arb` with `minProfit = max` from the owner returns an `InsufficientProfit` revert with `amountBack > amountOwed`.
- One real `cast send` of `arb` succeeds and mints a claim. Check it with `cast call <PoolManager> "balanceOf(address,uint256)" <executor> <wethId>`.

## Stage 3: The searcher bot (`bot/`, TypeScript + viem)

**Goal:** an unattended process that finds, sizes, proves and executes arbs safely, and serves its state to the dashboard.

Layout: `bot/package.json` (pin exact versions; viem 2.21.54 to match `web/`), `bot/src/{config,abi,discover,quote,size,execute,server,store,main}.ts`, `bot/test/*.test.ts` (vitest) and `bot/.env.example`.

Behavior:
1. **Config** (env and file): `RPC_URL`, `CHAIN_ID`, `DEPLOYMENTS` path, `OWNER_PRIVATE_KEY` (required only when `DRY_RUN=false`), `DRY_RUN=true` by default, `MIN_PROFIT_WEI` per profit token, `MAX_AMOUNT_IN` per token, `MAX_GAS_PRICE_GWEI`, `POLL_MS`, `PORT=8787`, and the list of v4 pool keys to watch. Validate at startup and exit with a clear message on bad config.
2. **Discovery:** read Aqua `Shipped` and `Docked` logs where `app == ROUTER`, from a start block to latest, then incrementally. Decode `strategy` as `abi.encode(Order)`. Check against Aqua's source how `strategyHash` is derived, and verify it with `router.hash` or on-chain balances. Keep strategies whose `safeBalances(maker, ROUTER, hash, token0, token1)` succeeds for a watched pool's pair with non-zero balances. Use try/catch, because a strategy without that pair reverts.
3. **Quote:** for each (pool, strategy, direction), quote with §4's revert trick using `publicClient.call` from `OWNER`, then decode the error with viem's `decodeErrorResult`.
4. **Size:** run a golden-section search over `amountIn` in [a small floor, `MAX_AMOUNT_IN`], about 25 quotes, maximizing profit. Stage 1's size-curve test shows the profit curve has a single peak.
5. **Economics:** estimate gas with `estimateContractGas` at the chosen size with a real `minProfit`. Convert gas cost into the profit token. For WETH this is 1:1 with ETH. For other tokens, use the v4 pool price read via PoolManager `extsload` (StateLibrary slot layout) or StateView once its address is verified. Execute only if `profit - gasCost >= MIN_PROFIT` and the gas price is at or below the cap.
6. **Execute:** set `minProfit = floor(profit * (1 - SLIPPAGE_BPS))` and `lastBlock = latest + 2`. Simulate again with `simulateContract`, send with `writeContract`, and wait for the receipt. Manage nonces serially, one trade in flight at a time. On a revert, decode the error, log it, and back off that opportunity for N blocks.
7. **Store:** append JSON lines to `bot/data/trades.jsonl` with tx hash, block, pool, direction, amountIn, quoted profit, realized profit (claim balance delta or token transfer), gas used, effective gas price and status. Keep the current opportunities in memory.
8. **HTTP API** (`node:http`, CORS restricted to the web dev origin):
   - `GET /api/status`: chain, block, owner, executor, dry-run flag, last error, uptime.
   - `GET /api/opportunities`: pool key, strategy hash, order (`maker`, `traits` as a decimal string, `data` as hex), direction, best size, quoted profit and net profit, and a status of `ready`, `below-threshold` or `stale`.
   - `GET /api/trades`: recent trades.
   - `GET /api/pnl`: cumulative realized profit by hour per profit token.
   - `GET /api/claims`: the executor's ERC-6909 balances for watched tokens.
9. **Safety:** dry-run by default, a kill switch (`touch bot/STOP` halts sending), never log the key, and do clean shutdown on SIGINT.
10. **Tests:** unit tests for the golden-section search, error decoding, the config validator and the profit/gas math. Add one integration test that runs against the Stage 2 demo chain when `DEMO_RPC` is set. It must show discovery finding the seeded strategy, a positive quote, and in non-dry-run mode a confirmed trade.

**Gate checks:**
- `cd bot && npm ci && npm test` passes.
- With the demo chain up: `DRY_RUN=true npm start` lists the opportunity at `/api/opportunities`.
- `DRY_RUN=false` executes it once, records it in `trades.jsonl`, and the next scan shows the gap closed, either `below-threshold` or gone.
- Run `scripts/reseed.sh`, and the bot trades again.

## Stage 4: Wire the dashboard to live data (`web/`)

**Goal:** the UI that already exists shows real data and executes real trades.

Before you change anything visual, load the `frontend-design` and `ui-ux-pro-max` skills. Keep the current Bauhaus design system, with the circle/square/triangle shapes, flat colours, Outfit type and the stage hero. Follow the skills' rules: 44 px targets, inline errors, visible focus, reduced motion, and no fake data presented as real.

Tasks:
1. Add a local chain (id 31337, `http://127.0.0.1:8545`, named "Local demo") to `src/lib/wallet.tsx`.
2. Add `src/lib/api.ts`. It fetches from `VITE_BOT_API_URL`, defaulting to `http://127.0.0.1:8787`, with polling of about 3 s that pauses when the tab is hidden. It returns typed loading, error and data states.
3. **Overview:** replace `src/data.ts` with API data. Profit tiles come from `/api/pnl`, the chart from hourly PnL, and the tables from opportunities and trades. Gas bars combine the snapshot numbers, labelled as test measurements, with real receipt averages once trades exist. When the bot is offline, show a clear empty state with the command to start it. Never fall back to invented numbers. Delete `src/data.ts`, or keep it only as a clearly labelled storybook fixture that the app doesn't import.
4. **Run a trade:**
   - Prefill the executor address from `deployments/<chainId>.json`, served by the bot at `/api/status`.
   - Add a "Load into form" action on each opportunity row that fills the pool key, direction, amount, minimum profit and order JSON, then routes to `#/app/execute`.
   - Show ERC-6909 claim balances with a working "Withdraw claim" prefill.
   - Keep simulate-then-send and the error summary.
5. Make the hero stage's sample numbers stay clearly labelled as samples, as they are today.
6. **Logo and favicon from `assets/branding/flasharb-icon-prompt.txt`.** That file is a brief only: there is no image in `assets/`, and it was written for an image generator you may not have. Its palette (cobalt `#1b3fe4`, red `#e63227`) is exactly the site's `--blue` and `--red`, so it fits. Do this:
   - If an image-generation tool is available in your session, use it with the brief and save the 1024×1024 PNG to `assets/branding/flasharb-icon.png`.
   - Either way, hand-draw an SVG version at `web/public/favicon.svg` that follows the brief: two interlocking angular swap-arrow ribbons forming one compact circular loop, cobalt on top and red below, with a lightning-bolt cutout in the centre. Flat fills only: no outlines, gradients, shadows or text, and transparent background with a 12% safety margin.
   - Use it as the favicon (`<link rel="icon" type="image/svg+xml" href="/favicon.svg">` in `web/index.html`) and replace the small three-shape mark in the top bar (`src/App.tsx`). Keep the circle, square and triangle shapes in the hero stage.
   - Check it at 32 px and 16 px in a headless-Chrome screenshot. If the lightning cutout isn't clear at 32 px, simplify the shape. If the SVG can't reach that quality, keep the existing mark and say so.
   - Commit the brief, the SVG and the wiring as separate commits (`feat(web): add flasharb logo and favicon`).
7. Run the checks below and take headless-Chrome screenshots at 1440, 1024, 768 and 500 px. Review them against the skills' pre-delivery checklist and fix what fails.

**Gate checks:**
- `cd web && npm run build` passes.
- With the demo chain and bot running, the Overview shows the live opportunity.
- Using a browser wallet on the Local demo chain, with anvil's account #0 imported, "Load into form" → Simulate → Send produces a confirmed trade that then appears under Recent trades.
- If no browser wallet can be driven from the sandbox, verify the same path with a viem script that runs the console's code path (same ABI and arguments), and tell the user that the manual wallet test is still to do.

## Stage 5: Huff executor with differential tests

**Goal:** a Huff build that behaves exactly like the Solidity reference, at lower gas.

Only proceed if the user allowed the installer in Stage 0. Otherwise ask now. Pin the compiler version noted in README (`hnc` 1.7.1) and record `hnc --version`.

Tasks:
1. `src/huff/FlashArbExecutor.huff`: same selectors, same constructor arguments (immutables appended to the bytecode or stored, matching behavior), and the same custom-error selectors and argument encoding. It needs the same checks in the same order (owner, expiry, PoolManager-only callback, router-and-taker check, the profit check and its exact revert data), the same `TAKER_HEADER`, and the same claim-versus-take branch.
2. Deploy it in tests via `foundry-huff-neo`'s `HuffNeoDeployer`. Check its README at the pinned v1.2.0 for the API.
3. **Differential tests:** a base contract that deploys both executors on identical state (use `vm.snapshotState`), runs the same inputs through both, and asserts equal success or revert, equal revert data, equal balance and claim changes, and equal Aqua balances. Fuzz sizes, directions, `minProfit`, `lastBlock` and callers. Include the quote-by-revert path.
4. Add the Huff gas to the snapshot (`flowA_huff_*` names) and record the numbers in the README gas table. Only keep Huff micro-optimizations that move the snapshot.

**Gate checks:** all differential tests pass with 1,000 or more fuzz runs (`FOUNDRY_FUZZ_RUNS=1000 forge test --match-contract Differential`), the snapshot file contains Huff entries, and `forge test` is fully green.

**Stop rule:** if a divergence can't be resolved without changing the Solidity reference, stop and report it to the user with the failing input.

## Stage 6: End-to-end demo, docs and CI

Tasks:
1. `scripts/demo.sh` runs everything in order: chain, setup, bot (non-dry-run on 31337 only), and `web` dev server. It prints the URLs and how to stop it. It cleans up child processes on exit.
2. README: a quickstart for contracts, demo, bot and web. Fill in the gas table, including whole-transaction gas from demo or fork receipts and the Huff numbers. Explain the quote-by-revert design and the safety defaults, and link the files that implement each Uniswap and 1inch call. Keep the existing tone: plain and specific. Update the status paragraph to match reality, but leave the ArbTax wording as it is.
3. FEEDBACK.md: add new, true friction points you hit, such as SwapVM quote nuances, Huff tooling or v4 extsload layout. Don't invent any.
4. CI (`.github/workflows/test.yml`): keep the Foundry job, and add jobs for `bot` (`npm ci && npm test`) and `web` (`npm ci && npm run build`). Pin action versions the way the existing file does. The Huff compile needs `hnc` in CI; install the pinned version in the job.
5. Run a security review of the executor and bot with the `solidity-auditor` skill if it's installed, or a careful manual checklist otherwise. Cover reentrancy through callbacks, the trust assumptions around router and Aqua, key handling, nonce and race handling, and what happens if a maker docks mid-flight. Write findings to `SECURITY_NOTES.md` and fix anything real.

**Gate checks:** a fresh run of `scripts/demo.sh` from a clean state reaches a confirmed bot trade, the dashboard shows it, all test suites pass, and `forge fmt --check` is clean.

## Stage 7: Mainnet readiness (stops for the user)

1. Rehearse `Deploy.s.sol` on an Unichain fork with the canonical addresses. Use the real tokens (verify the WETH and USDC addresses on Unichain from official sources and with `cast code`) and real pool keys found on-chain.
2. Run the bot in dry-run against the fork. Report whether any live Aqua strategies overlap a v4 pool and what the quoted spreads look like. If there's no overlap, say so plainly. That's a market fact, not a bug.
3. **Stop and ask the user** before broadcasting anything to mainnet. Present the exact command, the owner address, the estimated gas cost, and the size and minimum-profit caps. Proceed only on an explicit yes.

## Optional stages (only if the user asks)

- **Solar build.** Compile the same source with Solar 0.3.0 and fill the README row.

Out of scope, don't touch: ArbTax (see §2).

## 5. Working method

- Make small, verified steps. After each meaningful change, run the narrowest test that proves it, then the full suite at the gate.
- `via_ir` compiles are slow. Use `--match-path` or `--match-test` while iterating.
- Read dependency source to learn behavior, for example `lib/swap-vm/src/SwapVM.sol` and `lib/aqua/src/Aqua.sol`, but never copy it.
- When a fact is uncertain (an address, an ABI detail, a slot layout), verify it with `cast`, a test, or the dependency source before building on it, and note how you verified it in `PROGRESS.md`.
- Prefer clear, boring code. No new dependencies without a reason written in `PROGRESS.md`. Pin exact versions.
- Background processes (anvil, bot, vite) must be stopped at the end of each session unless the user wants them running.

## 6. Reporting to the user

At each gate, give a short report: what now works, the commit hashes for the stage (`git log --oneline`), the exact commands that prove it with pass counts, and anything skipped or still unverified. Name it plainly. If you're blocked by missing permission, an RPC, a wallet or the compiler, say what you need and what you'll do in the meantime, then continue with the next unblocked task.

## 7. `PROGRESS.md` template

```markdown
# flasharb progress

Answers from the user
- Commit policy: each logical unit, never push, no Claude attribution (answered)
- ArbTax: out of scope (answered)
- Install hnc: <yes/no/unanswered>
- Unichain RPC available: <yes/no>

| Stage | Status | Gate evidence |
| --- | --- | --- |
| 0 Orientation | todo | |
| 1 Executor hardening | todo | |
| 2 Deploy + demo scripts | todo | |
| 3 Searcher bot | todo | |
| 4 Dashboard live data | todo | |
| 5 Huff + differential | todo | |
| 6 Demo, docs, CI | todo | |
| 7 Mainnet readiness | todo | |

## Log
<!-- newest first: date, stage, what changed, files, commands run and results, commit hashes -->
```

Start with Stage 0 now.
