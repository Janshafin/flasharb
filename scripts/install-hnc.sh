#!/usr/bin/env bash
# Installs the pinned Huff Neo compiler (hnc) into ./.tools after checking its SHA-256.
#
# It touches nothing outside this project: no shell profile, no PATH edits. scripts/huff-test.sh puts ./.tools on PATH
# for a single run. The checksums are GitHub's published digests for the v1.7.1 release assets
# (https://api.github.com/repos/cakevm/huff-neo/releases/tags/v1.7.1). A download that does not match is rejected
# and nothing is installed.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=1.7.1
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)   TARGET=aarch64-apple-darwin;       SHA256=8928ff494b1c78955cd6d233d1bd3762f83375584a8536cc9fe14edb61c4628b ;;
  Darwin-x86_64)  TARGET=x86_64-apple-darwin;        SHA256=0de193675af100a6cdca1cb0639327f0f538e510a358b49587c39f96fdc9849d ;;
  Linux-x86_64)   TARGET=x86_64-unknown-linux-gnu;   SHA256=da57ff18630d75a27499adea7fe8e31a1cdb7984842b5ec533a32b3bdae1f1e2 ;;
  Linux-aarch64)  TARGET=aarch64-unknown-linux-gnu;  SHA256=73bb9de9acade6cc24c86cfd87ce1a6019842b34ad49b001537af7f39344c152 ;;
  *) echo "install-hnc: no pinned hnc build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

if [ -x .tools/hnc ] && .tools/hnc --version 2>/dev/null | grep -q "^hnc $VERSION "; then
  echo "hnc $VERSION already installed in .tools"
  exit 0
fi

ASSET="hnc-v$VERSION-$TARGET.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -sSfL -o "$TMP/$ASSET" "https://github.com/cakevm/huff-neo/releases/download/v$VERSION/$ASSET"

if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1)"; else ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | cut -d' ' -f1)"; fi
if [ "$ACTUAL" != "$SHA256" ]; then
  echo "install-hnc: checksum mismatch for $ASSET" >&2
  echo "  expected $SHA256" >&2
  echo "  got      $ACTUAL" >&2
  exit 1
fi

mkdir -p .tools
tar -xzf "$TMP/$ASSET" -C .tools hnc
chmod +x .tools/hnc
.tools/hnc --version | grep -q "^hnc $VERSION " || { echo "install-hnc: unexpected compiler version" >&2; exit 1; }
echo "installed $(.tools/hnc --version) (checksum verified)"
