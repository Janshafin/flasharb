#!/usr/bin/env bash
# Opens a fresh price gap on the local demo chain: the maker ships a new Aqua strategy that sells WETH
# GAP_BPS (default 340) below the v4 pool price. Use it after the bot has closed the last gap.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
forge script script/Reseed.s.sol:Reseed --rpc-url "$RPC_URL" --broadcast --slow
