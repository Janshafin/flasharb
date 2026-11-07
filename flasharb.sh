#!/usr/bin/env bash
# One entry point for the flasharb app. Run it from anywhere; it works on the checkout it lives in.
#
#   ./flasharb.sh                 local demo: chain, contracts, bot (trades on its own) and dashboard
#   ./flasharb.sh wallet 0x...    local demo where you trade from MetaMask with that test account
#   ./flasharb.sh testnet         Unichain Sepolia: deploy once with your keystore, then bot and dashboard
#   ./flasharb.sh reseed          open a new price gap on the running local demo
#   ./flasharb.sh stop            stop anything a flasharb run left behind
set -euo pipefail
cd "$(dirname "$0")"

case "${1:-demo}" in
  demo) exec bash scripts/demo.sh ;;
  wallet)
    [ -n "${2:-}" ] || { echo "usage: ./flasharb.sh wallet 0xYourMetaMaskTestAccount" >&2; exit 2; }
    WALLET="$2" exec bash scripts/demo.sh ;;
  testnet) exec bash scripts/testnet.sh ;;
  reseed) exec bash scripts/reseed.sh ;;
  stop)
    source scripts/lib.sh
    free_ports 8545 8787 5173
    bash scripts/demo-stop.sh >/dev/null 2>&1 || true ;;
  -h|--help|help) sed -n 2,8p "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "unknown command: $1 (try ./flasharb.sh help)" >&2; exit 2 ;;
esac
