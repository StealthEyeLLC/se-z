#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./package.json').version")}"
export SEZ_SOURCE_COMMIT="${SEZ_SOURCE_COMMIT:-$(git rev-parse HEAD)}"

echo "==> Building se-z ${VERSION} from commit ${SEZ_SOURCE_COMMIT}"

npm ci --include=dev
npm run build:native
npm run build
npm run test
npm run test:integration
npm run test:contracts

chmod +x scripts/extracted/supervisor/build-bundle.sh
bash scripts/extracted/supervisor/build-bundle.sh "$VERSION"

echo "==> Release bundle: release/se-z-${VERSION}.tar.gz"
cat "release/se-z-${VERSION}.sha256"
