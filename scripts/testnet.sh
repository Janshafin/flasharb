#!/usr/bin/env bash
# Runs the bot (dry-run: it finds and proves trades, you send them from MetaMask) and the dashboard against the flasharb
# deployment on Unichain Sepolia (chain 1301), recorded in deployments/1301.json by script/TestnetSetup.s.sol.
#
#   scripts/testnet.sh            RPC_URL=... to use another Unichain Sepolia endpoint
#
# No key is used here. Ctrl-C stops both services.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_URL="${RPC_URL:-https://sepolia.unichain.org}"
REC=deployments/1301.json
STATE=.demo
mkdir -p "$STATE"
[ -f "$REC" ] || { echo "$REC not found. Deploy first: forge script script/TestnetSetup.s.sol:TestnetSetup --rpc-url $RPC_URL --account <name> --broadcast" >&2; exit 1; }
[ "$(cast chain-id --rpc-url "$RPC_URL")" = "1301" ] || { echo "$RPC_URL is not Unichain Sepolia (1301)" >&2; exit 1; }
[ "$(jq -r .chainId "$REC")" = "1301" ] || { echo "$REC is not a chain 1301 record" >&2; exit 1; }
for port in 8787 5173; do
  lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $port is busy; stop the other demo first" >&2; exit 1; }
done

pids=()
kill_tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill "$1" 2>/dev/null || true; }
cleanup() { trap - EXIT INT TERM; echo; echo "stopping"; for p in "${pids[@]:-}"; do [ -n "$p" ] && kill_tree "$p"; done; }
trap cleanup EXIT INT TERM

(
  cd bot
  export RPC_URL CHAIN_ID=1301 DEPLOYMENTS="$PWD/../$REC" DRY_RUN=true DATA_DIR="$PWD/../$STATE/bot-data-1301"
  export CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
  export MIN_NET_PROFIT_WETH=0.0001 MAX_AMOUNT_IN_WETH=10 MAX_AMOUNT_IN_USDC=30000 MIN_NET_PROFIT_USDC=0.5 POLL_MS=4000
  exec npx tsx src/main.ts
) >"$STATE/bot-1301.log" 2>&1 &
pids+=($!)
(cd web && exec npx vite --port 5173 --host 127.0.0.1 --strictPort) >"$STATE/web.log" 2>&1 &
pids+=($!)

for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:8787/api/health >/dev/null 2>&1 && curl -sf http://127.0.0.1:5173 >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf http://127.0.0.1:8787/api/health >/dev/null || { echo "the bot did not start; end of $STATE/bot-1301.log:" >&2; tail -n 15 "$STATE/bot-1301.log" >&2; exit 1; }
curl -sf http://127.0.0.1:5173 >/dev/null || { echo "the dashboard did not start; see $STATE/web.log" >&2; exit 1; }

URL="http://127.0.0.1:5173/#/app/execute"
echo
echo "  Unichain Sepolia (1301), executor $(jq -r .executor "$REC"), owner $(jq -r .owner "$REC")"
echo "  dashboard   $URL   (pick Unichain Sepolia in MetaMask)"
echo "  proof       http://127.0.0.1:5173/#/app/proof"
echo "  bot log     $STATE/bot-1301.log"
echo
echo "Ctrl-C to stop."
if [ "${OPEN:-1}" = 1 ] && command -v open >/dev/null 2>&1; then open "$URL" || true; fi
wait
