# Notes for coding agents

flasharb is a flash-arbitrage executor: Uniswap v4 flash accounting on one side, 1inch Aqua strategies priced by SwapVM on the other. The plan lives at https://claude.ai/artifact/GBN6BgXjyJqCQ64srJBFgC.

## Commands

- Once per clone: `git submodule update --init --recursive && npm ci`
- Build and test: `forge build`, `forge test -vv`
- Canonical Unichain contracts: `UNICHAIN_RPC_URL=... forge test --match-path 'test/fork/*' -vv`
- Gas: `forge test` rewrites `snapshots/FlashArbExecutor.json`; compare before and after each optimization.
- Demo: `scripts/demo.sh` starts a local chain with the full stack, the bot and the dashboard (`BOT_MODE=dry` keeps the bot from sending; `scripts/reseed.sh` opens a new gap). `deployments/31337.json` is regenerated each run.
- Bot: `cd bot && npm ci && npm test`; with anvil and forge installed, `DEMO_E2E=1 npx vitest run test/e2e.test.ts` runs it against a real local chain.
- Dashboard: `cd web && npm ci && npm run build`; `npm run dev` serves it on 5173.
- Sandboxes that cannot reach binaries.soliditylang.org: put solc 0.8.26 and 0.8.30 in `~/.svm/<version>/solc-<version>` and set `FOUNDRY_OFFLINE=true`.

## Rules

- `lib/swap-vm` stays pinned at v1.0.2, the deployed router ABI (five-argument `swap`). Do not move it to `main`.
- Build SwapVM programs with its `ProgramBuilder` and instruction libraries. Never hand-number opcodes: numbering differs between v1.0.x and `main`.
- Instruction order inside a program changes pricing. Fee instructions wrap the rest of the program, so they come first.
- PoolManager pins solc 0.8.26 and everything 1inch pins 0.8.30. PoolManager compiles through `test/utils/V4Artifacts.sol`, and tests deploy it with `deployCode`. Do not import it into a 0.8.30 file.
- The Huff executor must behave exactly like `src/FlashArbExecutor.sol`; differential tests compare the two.
- Keep a gas optimization only if the snapshot moves.
- Never read the environment or call `vm.setEnv` in Foundry tests: forge runs tests in parallel and env vars are process-wide. Give scripts a `deploy(...)` function that takes parameters.
- Always pass `cacheTime: 0` when reading the block number with viem; the default cache hides new blocks for 4 seconds.
- Commit at every gate in the plan's timeline; 1inch reviews the commit history.
- Keep Aqua and SwapVM as dependencies under their own licenses; never paste their source into this repo.

## Useful skills

`v4-security-foundations` (delta rules), `v4-sdk-integration` (StateView, V4Quoter), `viem-integration` (the bot), `1inch-aqua` (live strategies), `solidity-auditor` and `property-based-testing`. One caveat: `v4-security-foundations` writes `settle(currency)`, but v4.0.0's `settle()` takes no argument.
