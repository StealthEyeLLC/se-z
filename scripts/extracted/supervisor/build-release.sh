#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
# Build release bundle only (no tests). CI validation runs separately.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./package.json').version")}"
export SEZ_SOURCE_COMMIT="${SEZ_SOURCE_COMMIT:-$(git rev-parse HEAD)}"

echo "==> Building release ${VERSION} from commit ${SEZ_SOURCE_COMMIT}"

npm ci --include=dev
npm run build:native
npm run build
chmod +x scripts/build-bundle.sh scripts/verify-runtime-deps.sh
bash scripts/verify-runtime-deps.sh
bash scripts/build-bundle.sh "$VERSION"

echo "==> Release bundle: release/se-z-${VERSION}.tar.gz"
cat "release/se-z-${VERSION}.sha256"
