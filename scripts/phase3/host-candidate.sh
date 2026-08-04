#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
# Real isolated non-root gateway candidate and accepted-kernel socket proof.
archive=$(node scripts/phase3/package.mjs | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).archive')
bash scripts/phase2/host-candidate.sh --package "$archive" --evidence evidence/phase3/host-candidate.json
node --test test/phase3/http.test.mjs test/phase3/phase3.test.mjs
