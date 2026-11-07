#!/usr/bin/env bash
# Runs the whole demo on your machine: a local chain with the full stack deployed, the searcher bot, and the dashboard.
#
#   scripts/demo.sh                 the bot trades on its own (local chain only)
#   BOT_MODE=dry scripts/demo.sh    the bot only finds trades; send them yourself from the console
#   RESEED_EVERY=45 scripts/demo.sh open a fresh price gap every 45 seconds so the demo keeps going
#   WALLET=0x... scripts/demo.sh    you trade from MetaMask: an executor owned by that address, bot in dry-run
#   OPEN=0 scripts/demo.sh          do not open the dashboard in your browser
#
# The bot signs with anvil's well-known account 0, which only exists on the local chain. Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL_KEY_0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
BOT_MODE="${BOT_MODE:-live}"
STATE=.demo
mkdir -p "$STATE"
pids=()

# npx starts node as a child, so killing only the recorded pid would leave the bot or vite running.
kill_tree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
  kill "$1" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  echo; echo "stopping the demo"
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill_tree "$p"; done
  bash scripts/demo-stop.sh >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Prints which service failed, where its log is, and the end of that log.
fail() {
  echo "$1 did not start. Its log is $2; the last lines:" >&2
  tail -n 15 "$2" >&2 2>/dev/null || true
  exit 1
}

for port in 8545 8787 5173; do
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use, probably by an earlier demo: $(lsof -nP -iTCP:"$port" -sTCP:LISTEN | awk 'NR==2 {print $1" pid "$2}')." >&2
    echo "Stop it (Ctrl-C in its terminal, or scripts/demo-stop.sh for the chain) and run this again." >&2
    trap - EXIT; exit 1
  fi
done

[ -d bot/node_modules ] || (cd bot && npm ci --silent)
[ -d web/node_modules ] || (cd web && npm ci --silent)

# A fresh chain replays the same transactions, so the previous run's trade history would show up twice.
rm -rf "$STATE/bot-data"
bash scripts/demo-chain.sh >"$STATE/chain.log" 2>&1 || fail "The local chain or the contract deployment" "$STATE/chain.log"
echo "chain up, stack deployed (deployments/31337.json)"

# WALLET=0x... hands trading to your browser wallet: its own executor, and a bot that only finds trades, never sends.
if [ -n "${WALLET:-}" ]; then
  bash scripts/demo-wallet.sh "$WALLET"
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
pids+=($!)

(cd web && exec npx vite --port 5173 --host 127.0.0.1 --strictPort) >"$STATE/web.log" 2>&1 &
pids+=($!)

if [ -n "${RESEED_EVERY:-}" ]; then
  (while sleep "$RESEED_EVERY"; do bash scripts/reseed.sh >/dev/null 2>&1 || true; done) &
  pids+=($!)
fi

for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:8787/api/health >/dev/null 2>&1 && curl -sf http://127.0.0.1:5173 >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf http://127.0.0.1:8787/api/health >/dev/null || fail "The searcher bot" "$STATE/bot.log"
curl -sf http://127.0.0.1:5173 >/dev/null || fail "The dashboard" "$STATE/web.log"

# Use 127.0.0.1, not localhost: on macOS localhost resolves to ::1 first, and the dashboard listens on IPv4 only.
URL="http://127.0.0.1:5173/#/app"

echo
echo "  dashboard   $URL"
echo "  proof       http://127.0.0.1:5173/#/app/proof"
echo "  bot API     http://127.0.0.1:8787/api/status   (mode: $BOT_MODE)"
echo "  logs        $STATE/chain.log, $STATE/bot.log, $STATE/web.log"
echo "  new gap     scripts/reseed.sh"
echo
echo "Ctrl-C to stop."
if [ "${OPEN:-1}" = 1 ] && command -v open >/dev/null 2>&1; then open "$URL" || true; fi
wait
