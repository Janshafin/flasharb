#!/usr/bin/env bash
# Starts a local anvil chain (31337) and deploys the whole flasharb demo stack onto it.
# Writes deployments/31337.json. Stop it with scripts/demo-stop.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
PORT="${PORT:-8545}"
STATE=".demo"
mkdir -p "$STATE"

if [ -f "$STATE/anvil.pid" ] && kill -0 "$(cat "$STATE/anvil.pid")" 2>/dev/null; then
  echo "anvil is already running (pid $(cat "$STATE/anvil.pid"))"
else
  args=(--port "$PORT" --chain-id 31337 --hardfork prague --silent)
  [ -n "${BLOCK_TIME:-}" ] && args+=(--block-time "$BLOCK_TIME")
  anvil "${args[@]}" >"$STATE/anvil.log" 2>&1 &
  echo $! >"$STATE/anvil.pid"
  for _ in $(seq 1 50); do
    cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
    sleep 0.2
  done
  cast chain-id --rpc-url "$RPC_URL" >/dev/null || { echo "anvil did not start, see $STATE/anvil.log" >&2; exit 1; }
  echo "anvil started (pid $(cat "$STATE/anvil.pid")) on $RPC_URL"
fi

# A full build first: the setup deploys PoolManager from its artifact (compiled via test/utils/V4Artifacts.sol, since it
# pins solc 0.8.26), and forge script alone only compiles what the script imports, so a fresh checkout would lack it.
forge build -q
forge script script/DemoSetup.s.sol:DemoSetup --rpc-url "$RPC_URL" --broadcast --slow -q

echo
echo "Deployed. Addresses: deployments/31337.json"
echo "  owner (anvil account 0) key: the well-known anvil default, for this local chain only"
echo "Next: scripts/reseed.sh opens a fresh gap; scripts/demo-stop.sh stops the chain."
