#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
# Verify required se-z runtime dependencies are present.
set -euo pipefail

failures=0

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: missing command: $1" >&2
    failures=$((failures + 1))
    return 1
  fi
  echo "ok: $1"
}

require_version() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: $label version mismatch: got $actual, expected $expected" >&2
    failures=$((failures + 1))
    return 1
  fi
  echo "ok: $label $actual"
}

require_cmd node
require_cmd npm
require_cmd git
require_cmd bash
require_cmd tar
require_cmd gzip
require_cmd openssl
require_cmd tmux
require_cmd systemctl

NODE_VERSION=$(node -p "process.versions.node")
require_version node "$NODE_VERSION" "24.18.0"

if [ "$failures" -ne 0 ]; then
  echo "Runtime dependency verification failed with $failures error(s)" >&2
  exit 1
fi

echo "All required runtime dependencies verified"
