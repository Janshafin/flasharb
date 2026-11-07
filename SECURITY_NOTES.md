# Security notes

This is a review by the people who built it, not an audit. It lists what the code relies on, what was checked and how, and what is not covered. Do not put funds you cannot lose behind it.

## What the executor guarantees

| Property | Why it holds | Checked by |
| --- | --- | --- |
| Only the owner can start a trade, withdraw claims, approve tokens or rescue tokens | `onlyOwner` on all four; `OWNER` is immutable | `test_onlyOwner_forEveryAdminFunction`, `test_onlyOwnerCanArb` |
| The callbacks cannot be used by anyone else | `unlockCallback` requires the PoolManager; `preTransferInCallback` requires the router and `taker == address(this)` | `test_callback_*`, `test_unlockCallback_rejectsEverythingButThePoolManager` |
| A third party cannot make SwapVM call back into the executor | SwapVM calls back `msg.sender` of `swap` (`SwapVM.sol` sets `query.taker = msg.sender`), so a stranger's swap calls the stranger | read from `lib/swap-vm/src/SwapVM.sol` |
| A third party cannot use Aqua to pull the executor's tokens | `Aqua.push` pays from `msg.sender` (`Aqua.sol` `push`) | read from `lib/aqua/src/Aqua.sol` |
| The executor never keeps a token balance between transactions | flash accounting settles inside `unlock`; profit leaves as a claim or a transfer | `invariant_executorHoldsNoTokens` |
| A successful arb always clears `minProfit`; claims never shrink on their own | the profit check runs before the profit is minted or taken | `invariant_noBrokenPromises`, `invariant_poolManagerCoversClaims` |
| A failed arb changes nothing | the PoolManager reverts the whole transaction unless every delta nets to zero | `testFuzz_flowA_profitsOrRevertsCleanly`, `test_quoteByRevert_changesNothing` |

## Trust assumptions

- **Aqua and the SwapVM router are trusted.** `approveAqua` gives Aqua a maximum allowance for each token you list, because Aqua moves the payment to the maker. The executor holds nothing between trades, so the exposure is what a single transaction holds, but you are still trusting that contract. Approve only the tokens you trade.
- **The owner key controls everything.** There is no ownership transfer and no recovery. Losing the key strands any claims in the PoolManager, so withdraw claims regularly and keep the amount you leave there small. Use a dedicated key for the bot with a little gas money, and keep profit as claims so the hot key never holds it. In `take` mode profit is sent to the owner address, which is the hot key.
- **Pools without hooks only.** `swap` assumes an exact-in swap on a hook-free pool makes `spent` negative and `received` non-negative. A pool whose hook changes deltas could break that. The bot only trades pools listed in its deployment record; the demo pool has no hook.
- **Standard tokens only.** Fee-on-transfer and rebasing tokens will not settle correctly and the trade will revert.
- **Orders from makers are untrusted input.** A maker's order can carry hooks (code that runs inside your trade) and a program that makes external calls. Neither can take the executor's funds: deltas are tracked per caller, and every admin path is owner-only. What they can do is revert or burn gas. The bot skips orders that carry hooks unless `ALLOW_HOOKED_ORDERS=true`. A program with external calls cannot be detected from the traits, so the revert-based quote and the on-chain `minProfit` are what protect you.

## Not solved

- **MEV.** A trade in a public mempool can be copied or sandwiched. `minProfit` and the `lastBlock` expiry bound the damage; they do not stop copying. On a real chain, prefer private order flow.
- **Unbounded price limit.** The v4 leg uses the widest possible `sqrtPriceLimitX96`, so size is the only limit on how far a trade moves the pool. The bot sizes trades from quotes and the profit floor reverts a bad one, but a caller who sets a huge size by hand is sizing it themselves.
- **No external audit,** no formal verification, and no run against the real Unichain deployments. The fork test rehearses at the canonical addresses with the official sources deployed locally; it only forks the live chain when `UNICHAIN_RPC_URL` is set.

## The bot

- **Keys.** The key comes only from the environment or `bot/.env` (gitignored). The logger scrubs it, the API never returns it, and `web/` never sees it. In live mode the bot exits if the key is not the executor's owner.
- **Network surface.** The API binds to 127.0.0.1, answers GET only and allows only the dashboard's origin. It has no authentication, so do not expose it.
- **Untrusted RPC.** A dishonest RPC could return false quotes. Every trade is simulated again immediately before sending and the chain enforces `minProfit`, so the worst outcome is wasted gas. Use an RPC you trust.
- **Races.** One trade is in flight at a time; each opportunity is re-proved on the latest block; a failed trade backs that opportunity off for 30 seconds by default; a `bot/STOP` file halts sending.
- **A maker docks mid-flight.** The trade reverts, costs gas, and the opportunity is backed off.
- **Dry run first.** `DRY_RUN=true` is the default.

## The dashboard

The wallet signs; the page never holds a key. The console simulates the exact transaction first, and Send enables only for the inputs that passed. Trades it sends are listed from the browser's own storage, since the bot cannot see them.

## Local demo only

The demo scripts refuse to run unless `block.chainid == 31337`, and the bot signs with anvil's published account 0 key only in `scripts/demo.sh`. That key is public knowledge; anything it controls on a real network is already lost.

## Reporting

Open an issue, or message the maintainers directly for anything that could lose funds.
