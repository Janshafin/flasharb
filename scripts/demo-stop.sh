#!/usr/bin/env bash
# Stops the local demo chain started by scripts/demo-chain.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .demo/anvil.pid ] && kill -0 "$(cat .demo/anvil.pid)" 2>/dev/null; then
  kill "$(cat .demo/anvil.pid)"
  echo "stopped anvil (pid $(cat .demo/anvil.pid))"
fi
rm -f .demo/anvil.pid
