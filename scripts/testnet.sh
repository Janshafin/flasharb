#!/usr/bin/env bash
# The demo on Unichain Sepolia (chain 1301), in one command. The first run deploys the stack with your Foundry keystore
# account (script/TestnetSetup.s.sol); every run then starts the bot in dry-run (it finds and proves trades, you send
# them from MetaMask) and the dashboard.
#
#   scripts/testnet.sh                    ACCOUNT=<keystore name> (default flasharb), RPC_URL=... (default public RPC)
#
# Your key stays in Foundry's encrypted keystore; forge asks for its password. Ctrl-C stops the bot and dashboard.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh

RPC_URL="${RPC_URL:-https://sepolia.unichain.org}"
ACCOUNT="${ACCOUNT:-flasharb}"
REC=deployments/1301.json
STATE=.demo
mkdir -p "$STATE"
pids=()

echo "flasharb on Unichain Sepolia"
repo_check
tools_check
deps_check
[ "$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null)" = "1301" ] || die "Cannot reach Unichain Sepolia at $RPC_URL." "Check your internet connection, or set RPC_URL to another Unichain Sepolia endpoint."
ok "Unichain Sepolia RPC reachable, block $(cast block-number --rpc-url "$RPC_URL")"

if [ ! -f "$REC" ]; then
  say "no deployment yet: deploying the stack with keystore account '$ACCOUNT'"
  cast wallet list 2>/dev/null | grep -qE "^$ACCOUNT( |$)" || die "Foundry has no keystore account named '$ACCOUNT'." \
    "Import your MetaMask TEST account (MetaMask: Account details, Show private key):" \
    "  cast wallet import $ACCOUNT --interactive" \
    "Paste the key at cast's prompt and choose a password; never paste it anywhere else. Then run this again."
  say "forge will ask for the keystore password"
  OWNER=$(cast wallet address --account "$ACCOUNT") || die "Could not unlock keystore account '$ACCOUNT' (wrong password?)."
  BAL=$(cast balance --rpc-url "$RPC_URL" "$OWNER")
  [ "$BAL" != "0" ] || die "$OWNER has no Unichain Sepolia ETH." "Get some from a Unichain Sepolia faucet, then run this again."
  ok "deployer $OWNER has $(cast from-wei "$BAL") ETH (the setup needs about 13.2M gas)"
  say "deploying (2 to 4 minutes; forge asks for the password once more)"
  if ! forge script script/TestnetSetup.s.sol:TestnetSetup --rpc-url "$RPC_URL" --account "$ACCOUNT" --sender "$OWNER" --broadcast --slow 2>&1 | tee "$STATE/testnet-deploy.log" | grep -E "Wrote|Executor|Error|error|COMPLETE|Paid"; then
    die "The deployment failed." "See $STATE/testnet-deploy.log"
  fi
  [ -f "$REC" ] || die "The deployment did not write $REC." "See $STATE/testnet-deploy.log"
fi

# Check the record against the chain before trusting it.
EXEC=$(jq -r .executor "$REC"); OWN=$(jq -r .owner "$REC")
[ "$(jq -r .chainId "$REC")" = "1301" ] || die "$REC is not a chain 1301 record."
for k in poolManager aqua router executor; do
  a=$(jq -r ".$k" "$REC"); [ "$(cast code --rpc-url "$RPC_URL" "$a" | wc -c)" -gt 4 ] || die "No contract at $k $a on Unichain Sepolia." "Delete $REC and run this again to redeploy."
done
[ "$(cast call --rpc-url "$RPC_URL" "$EXEC" 'OWNER()(address)')" = "$OWN" ] || die "The executor's OWNER does not match $REC."
ok "deployment verified on chain: executor $EXEC, owner $OWN"
free_ports 8787 5173

cleanup() { trap - EXIT INT TERM; echo; echo "stopping"; for p in "${pids[@]:-}"; do [ -n "$p" ] && kill_tree "$p"; done; }
trap cleanup EXIT INT TERM
(
  cd bot
  export RPC_URL CHAIN_ID=1301 DEPLOYMENTS="$PWD/../$REC" DRY_RUN=true DATA_DIR="$PWD/../$STATE/bot-data-1301"
  export CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
  export MIN_NET_PROFIT_WETH=0.0001 MAX_AMOUNT_IN_WETH=10 MAX_AMOUNT_IN_USDC=30000 MIN_NET_PROFIT_USDC=0.5 POLL_MS=4000
  exec npx tsx src/main.ts
) >"$STATE/bot-1301.log" 2>&1 &
BOT_PID=$!; pids+=($BOT_PID)
(cd web && exec npx vite --port 5173 --host 127.0.0.1 --strictPort) >"$STATE/web.log" 2>&1 &
WEB_PID=$!; pids+=($WEB_PID)
wait_for "the bot (dry-run)" http://127.0.0.1:8787/api/health "$STATE/bot-1301.log"
wait_for "the dashboard" http://127.0.0.1:5173/ "$STATE/web.log"

URL="http://127.0.0.1:5173/#/app/execute"
echo
echo "  Open this in your browser:  $URL"
echo "  In MetaMask use the account $OWN and the Unichain Sepolia network."
echo "  Execution proof:            http://127.0.0.1:5173/#/app/proof"
echo "  Logs:                       $STATE/bot-1301.log, $STATE/web.log"
echo
echo "  Keep this terminal open: the app runs only while it does. Ctrl-C stops it."
open_url "$URL"
watch_services "the bot" "$BOT_PID" "$STATE/bot-1301.log" "the dashboard" "$WEB_PID" "$STATE/web.log"
