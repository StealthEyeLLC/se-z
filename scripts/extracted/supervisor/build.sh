#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Building se-z"
npm ci
npm run build

echo "==> Build complete"
ls -la dist/
