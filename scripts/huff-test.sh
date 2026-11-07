#!/usr/bin/env bash
# Runs the Huff tests: the huff Foundry profile (ffi on) with the project-local hnc on PATH.
# Extra arguments go to forge, for example: scripts/huff-test.sh -vvv --match-test test_compiler
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x .tools/hnc ] || { echo "hnc is not installed. Run scripts/install-hnc.sh first." >&2; exit 1; }
PATH="$PWD/.tools:$PATH" FOUNDRY_PROFILE=huff exec forge test "$@"
