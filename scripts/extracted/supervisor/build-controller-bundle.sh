#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
# Reproducibly stage and package the fixed controller outside product releases.
set -euo pipefail

export LC_ALL=C.UTF-8
export LANG=C.UTF-8
export TZ=UTC
umask 0022

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
PACKAGE_VERSION=$(node -p "require('./package.json').version")
VERSION="${1:-$PACKAGE_VERSION}"
BUILD_ROOT="${SEZ_CONTROLLER_BUILD_ROOT:-$(mktemp -d)}"
OUTPUT_DIR="${SEZ_CONTROLLER_OUTPUT_DIR:-$ROOT/release}"
RELEASE_NAME="se-z-controller-$VERSION"
RELEASE_ROOT="$BUILD_ROOT/$RELEASE_NAME"

cleanup() {
  if [ "${SEZ_CONTROLLER_KEEP_BUILD_ROOT:-0}" != "1" ]; then
    rm -rf -- "$BUILD_ROOT"
  fi
}
trap cleanup EXIT

if [ "$VERSION" != "$PACKAGE_VERSION" ] && [ "${SEZ_CONTROLLER_ALLOW_FIXTURE_VERSION:-0}" != "1" ]; then
  echo "ERROR: controller version must match package.json" >&2
  exit 1
fi
if [ -e "$RELEASE_ROOT" ]; then
  echo "ERROR: controller build target already exists" >&2
  exit 1
fi
for output in \
  "$OUTPUT_DIR/$RELEASE_NAME.tar.gz" \
  "$OUTPUT_DIR/$RELEASE_NAME.build.json" \
  "$OUTPUT_DIR/$RELEASE_NAME.sha256"; do
  if [ -e "$output" ]; then
    echo "ERROR: controller candidate output already exists: $output" >&2
    exit 1
  fi
done

npm run build
mkdir -p "$RELEASE_ROOT/bin" "$RELEASE_ROOT/lib/dist/controller" \
  "$RELEASE_ROOT/lib/dist/crypto" "$RELEASE_ROOT/lib/dist/deployment" \
  "$RELEASE_ROOT/lib/dist/install" "$RELEASE_ROOT/ops/systemd"
cp ops/controller/bin/se-z-deploy-guard "$RELEASE_ROOT/bin/"
for file in cli contract controller filesystem-host storage types; do
  cp "dist/src/controller/$file.js" "$RELEASE_ROOT/lib/dist/controller/"
done
for file in canonical signing; do
  cp "dist/src/crypto/$file.js" "$RELEASE_ROOT/lib/dist/crypto/"
done
for file in snapshot types; do
  cp "dist/src/deployment/$file.js" "$RELEASE_ROOT/lib/dist/deployment/"
done
cp dist/src/install/symlinks.js "$RELEASE_ROOT/lib/dist/install/"
cp dist/src/config.js "$RELEASE_ROOT/lib/dist/"
cp ops/systemd/se-z-deploy-guard@.service "$RELEASE_ROOT/ops/systemd/"
cp ops/systemd/se-z-deploy-guard@.timer "$RELEASE_ROOT/ops/systemd/"
cp ops/tmpfiles/se-z.conf "$RELEASE_ROOT/ops/"
cp package.json "$RELEASE_ROOT/"

find "$RELEASE_ROOT" -type d -exec chmod 0755 {} +
find "$RELEASE_ROOT" -type f -exec chmod 0644 {} +
chmod 0755 "$RELEASE_ROOT/bin/se-z-deploy-guard"
mkdir -p "$OUTPUT_DIR"

node --import tsx scripts/package-controller.ts \
  --source-root "$ROOT" \
  --release-root "$RELEASE_ROOT" \
  --output-directory "$OUTPUT_DIR" \
  --version "$VERSION"

echo "CONTROLLER_CANDIDATE=$OUTPUT_DIR/$RELEASE_NAME.tar.gz"
echo "CONTROLLER_BUILD_RECORD=$OUTPUT_DIR/$RELEASE_NAME.build.json"
