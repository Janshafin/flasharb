#!/usr/bin/env bash
# Runs the whole demo on your machine: a local chain with the full stack deployed, the searcher bot, and the dashboard.
#
#   scripts/demo.sh                 the bot trades on its own (local chain only)
#   WALLET=0x... scripts/demo.sh    you trade from MetaMask: an executor owned by that address, bot in dry-run
#   BOT_MODE=dry scripts/demo.sh    the bot only finds trades
#   RESEED_EVERY=45 scripts/demo.sh open a fresh price gap every 45 seconds so the demo keeps going
#   OPEN=0 scripts/demo.sh          do not open the dashboard in your browser
#
# The bot signs with anvil's well-known account 0, which only exists on the local chain. Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh

ANVIL_KEY_0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
BOT_MODE="${BOT_MODE:-live}"
STATE=.demo
mkdir -p "$STATE"
pids=()

echo "flasharb local demo"
repo_check
tools_check
deps_check
free_ports 8545 8787 5173
bash scripts/demo-stop.sh >/dev/null 2>&1 || true

cleanup() {
  trap - EXIT INT TERM
  echo; echo "stopping the demo"
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill_tree "$p"; done
  bash scripts/demo-stop.sh >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# A fresh chain replays the same transactions, so the previous run's trade history would show up twice.
rm -rf "$STATE/bot-data"
say "starting the local chain and deploying the contracts (about 30 seconds the first time)"
if ! bash scripts/demo-chain.sh >"$STATE/chain.log" 2>&1; then
  printf '\n  \033[31m✗ The local chain or the contract deployment failed. Last lines of %s:\033[0m\n' "$STATE/chain.log" >&2
  tail -n 20 "$STATE/chain.log" >&2; exit 1
fi
ok "local chain 31337 on http://127.0.0.1:8545, contracts deployed (deployments/31337.json)"

# WALLET=0x... hands trading to your browser wallet: its own executor, and a bot that only finds trades, never sends.
if [ -n "${WALLET:-}" ]; then
  bash scripts/demo-wallet.sh "$WALLET" | sed 's/^/  /'
  BOT_MODE=dry
fi

(
  cd bot
  export CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
  export MIN_NET_PROFIT_WETH=0.0001 MAX_AMOUNT_IN_WETH=10 MAX_AMOUNT_IN_USDC=30000 MIN_NET_PROFIT_USDC=0.5
  export DATA_DIR="$PWD/../$STATE/bot-data"
  if [ "$BOT_MODE" = "dry" ]; then export DRY_RUN=true; else export DRY_RUN=false OWNER_PRIVATE_KEY="$ANVIL_KEY_0"; fi
  exec npx tsx src/main.ts
) >"$STATE/bot.log" 2>&1 &
BOT_PID=$!; pids+=($BOT_PID)
(cd web && exec npx vite --port 5173 --host 127.0.0.1 --strictPort) >"$STATE/web.log" 2>&1 &
WEB_PID=$!; pids+=($WEB_PID)
if [ -n "${RESEED_EVERY:-}" ]; then
  (while sleep "$RESEED_EVERY"; do bash scripts/reseed.sh >/dev/null 2>&1 || true; done) &
  pids+=($!)
fi

wait_for "the bot (mode: $BOT_MODE)" http://127.0.0.1:8787/api/health "$STATE/bot.log"
wait_for "the dashboard" http://127.0.0.1:5173/ "$STATE/web.log"

# Use 127.0.0.1, not localhost: on macOS localhost resolves to ::1 first, and the dashboard listens on IPv4 only.
URL="http://127.0.0.1:5173/#/app"
echo
echo "  Open this in your browser:  $URL"
[ -n "${WALLET:-}" ] && echo "  Trade from MetaMask:        http://127.0.0.1:5173/#/app/execute"
echo "  Execution proof:            http://127.0.0.1:5173/#/app/proof"
echo "  New price gap:              ./flasharb.sh reseed   (in another terminal)"
echo "  Logs:                       $STATE/chain.log, $STATE/bot.log, $STATE/web.log"
echo
echo "  Keep this terminal open: the app runs only while it does. Ctrl-C stops everything."
open_url "$URL"
watch_services "the bot" "$BOT_PID" "$STATE/bot.log" "the dashboard" "$WEB_PID" "$STATE/web.log" "the local chain" "$(cat $STATE/anvil.pid)" "$STATE/anvil.log"
