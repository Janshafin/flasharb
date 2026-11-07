#!/usr/bin/env bash
# Shared by scripts/demo.sh and scripts/testnet.sh: checks the machine, installs what is missing, and clears leftovers
# from an earlier run, so a launch either starts everything or says exactly what to fix.

say() { printf '  %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\n  \033[31m✗ %s\033[0m\n' "$1" >&2; shift; for l in "$@"; do printf '    %s\n' "$l" >&2; done; exit 1; }

# The repository this script lives in. Running a copy without bot/ and web/ (an old download) cannot work.
repo_check() {
  [ -d bot/src ] && [ -d web/src ] && [ -f foundry.toml ] || die "This folder is not a complete flasharb checkout ($PWD)." \
    "Run the command from the folder that has bot/, web/ and scripts/, for example:" \
    "git clone --recurse-submodules https://github.com/Janshafin/flasharb.git && cd flasharb"
}

tools_check() {
  local t missing=()
  for t in forge anvil cast node npm jq curl lsof; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  [ ${#missing[@]} -eq 0 ] || die "Missing tools: ${missing[*]}" "Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup" "Node 18+: https://nodejs.org" "jq: brew install jq"
  ok "tools: forge $(forge --version 2>/dev/null | head -1 | awk '{print $3}'), node $(node --version)"
}

deps_check() {
  if [ ! -f lib/v4-core/src/PoolManager.sol ] || [ ! -f lib/swap-vm/src/SwapVM.sol ]; then
    say "fetching git submodules (first run only)"
    git submodule update --init --recursive >/dev/null 2>&1 || die "git submodule update failed" "Run: git submodule update --init --recursive"
  fi
  local d
  for d in . bot web; do
    if [ ! -d "$d/node_modules" ]; then
      say "installing npm packages in $d (first run only)"
      (cd "$d" && npm ci --silent >/dev/null 2>&1) || die "npm ci failed in $d" "Run: (cd $d && npm ci) to see the error"
    fi
  done
  ok "dependencies installed"
}

# Stops processes an earlier flasharb run left on our ports. Anything else on a port is reported, not killed.
free_ports() {
  local port pid cmd
  for port in "$@"; do
    for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
      cmd=$(ps -o command= -p "$pid" 2>/dev/null)
      if echo "$cmd" | grep -qE "anvil --port 8545 --chain-id 31337|$PWD/(bot|web)/node_modules|tsx src/main.ts|vite --port 5173"; then
        kill "$pid" 2>/dev/null; say "stopped a leftover flasharb process on port $port (pid $pid)"
      else
        die "Port $port is used by another program: ${cmd:0:80} (pid $pid)." "Close it, or stop it with: kill $pid"
      fi
    done
  done
  sleep 0.5
  for port in "$@"; do lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && die "Port $port is still busy." "Run: lsof -iTCP:$port -sTCP:LISTEN"; done
  ok "ports free: $*"
}

# Waits for a URL to answer; on failure names the service and prints the end of its log.
wait_for() {
  local name=$1 url=$2 log=$3 i
  for i in $(seq 1 120); do curl -sf "$url" >/dev/null 2>&1 && { ok "$name is up"; return 0; }; sleep 0.5; done
  printf '\n  \033[31m✗ %s did not start. Last lines of %s:\033[0m\n' "$name" "$log" >&2
  tail -n 20 "$log" >&2 2>/dev/null || true
  exit 1
}

# npx starts node as a child, so a stop must kill the whole tree.
kill_tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill "$1" 2>/dev/null || true; }

open_url() { if [ "${OPEN:-1}" = 1 ] && command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 || true; fi; }

# Keeps the launcher in the foreground and stops everything, loudly, if one service dies: name pid log, repeated.
watch_services() {
  while sleep 2; do
    local a=("$@") i
    for ((i = 0; i < ${#a[@]}; i += 3)); do
      if ! kill -0 "${a[i+1]}" 2>/dev/null; then
        printf '\n  \033[31m✗ %s stopped unexpectedly. Last lines of %s:\033[0m\n' "${a[i]}" "${a[i+2]}" >&2
        tail -n 20 "${a[i+2]}" >&2 2>/dev/null || true
        exit 1
      fi
    done
  done
}
