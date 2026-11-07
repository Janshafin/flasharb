#!/usr/bin/env bash
# Hands the local demo to YOUR browser wallet: deploys a second FlashArbExecutor whose immutable OWNER is the address
# you pass, gives that address local test ETH, approves Aqua for it, and points deployments/31337.json at it so the
# bot (in dry-run mode) quotes for your executor and the dashboard loads it.
#
#   scripts/demo-wallet.sh 0xYourTestAccount
#
# Local anvil chain (31337) only: it refuses any other chain. It never sees a private key of yours. The executor is
# deployed by anvil's public account 0, and the one owner-only setup call (approveAqua) is made with anvil's
# impersonation cheat, which exists only on a local dev chain. Use a dedicated MetaMask test account.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
ANVIL_KEY_0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
REC=deployments/31337.json

[ $# -eq 1 ] || { echo "usage: $0 0xYourTestAccount" >&2; exit 2; }
OWNER=$(cast to-check-sum-address "$1" 2>/dev/null) || { echo "not an address: $1" >&2; exit 2; }
[ "$OWNER" != "0x0000000000000000000000000000000000000000" ] || { echo "the zero address cannot own an executor" >&2; exit 2; }
[ "$(cast chain-id --rpc-url "$RPC_URL")" = "31337" ] || { echo "refusing: $RPC_URL is not the local demo chain (31337)" >&2; exit 1; }
[ -f "$REC" ] || { echo "$REC not found; run scripts/demo-chain.sh first" >&2; exit 1; }

PM=$(jq -r .poolManager "$REC"); ROUTER=$(jq -r .router "$REC"); AQUA=$(jq -r .aqua "$REC")
WETH=$(jq -r .tokens.weth.address "$REC"); USDC=$(jq -r .tokens.usdc.address "$REC")

# 100 local test ETH for gas. This ETH exists only on this anvil chain.
cast rpc --rpc-url "$RPC_URL" anvil_setBalance "$OWNER" 0x56bc75e2d63100000 >/dev/null

EXEC=$(forge create src/FlashArbExecutor.sol:FlashArbExecutor --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY_0" \
  --broadcast --json --constructor-args "$PM" "$ROUTER" "$AQUA" "$OWNER" | jq -r .deployedTo)
[ "$(cast call --rpc-url "$RPC_URL" "$EXEC" 'OWNER()(address)')" = "$OWNER" ] || { echo "OWNER check failed" >&2; exit 1; }

cast rpc --rpc-url "$RPC_URL" anvil_impersonateAccount "$OWNER" >/dev/null
cast send --rpc-url "$RPC_URL" --unlocked --from "$OWNER" "$EXEC" 'approveAqua(address[])' "[$WETH,$USDC]" >/dev/null
cast rpc --rpc-url "$RPC_URL" anvil_stopImpersonatingAccount "$OWNER" >/dev/null

tmp=$(mktemp); jq --arg e "$EXEC" --arg o "$OWNER" '.botExecutor = .executor | .executor = $e | .owner = $o' "$REC" >"$tmp" && mv "$tmp" "$REC"

echo "executor $EXEC, OWNER $OWNER (checked on-chain), Aqua approved for WETH and USDC"
echo "$OWNER has 100 local test ETH. $REC now points at this executor."
