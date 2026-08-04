#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
archive=$(node scripts/phase3/package.mjs | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).archive')
bash scripts/phase2/nspawn-acceptance.sh --package "$archive" --evidence evidence/phase3/nspawn-acceptance.json
node --test test/phase3/*.test.mjs
