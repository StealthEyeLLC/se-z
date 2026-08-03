#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
# Prepare a gateway tree and delegate deterministic packaging to se-z.
set -euo pipefail

export LC_ALL=C.UTF-8
export LANG=C.UTF-8
export TZ=UTC
umask 0022

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
PACKAGE_VERSION=$(node -p "require('./package.json').version")
VERSION="${1:-$PACKAGE_VERSION}"
BUILD_ROOT="${SEZ_GATEWAY_BUILD_ROOT:-$(mktemp -d)}"
OUTPUT_DIR="${SEZ_GATEWAY_OUTPUT_DIR:-$ROOT/release}"
PREFIX="se-z-gateway-$VERSION"
RELEASE_ROOT="$BUILD_ROOT/$PREFIX"
SPEC="$BUILD_ROOT/package-spec.json"
PACKAGER_ROOT="${SEZ_PACKAGER_ROOT:?SEZ_PACKAGER_ROOT must identify the verified se-z source tree}"

cleanup() {
  if [ "${SEZ_GATEWAY_KEEP_BUILD_ROOT:-0}" != "1" ]; then
    rm -rf -- "$BUILD_ROOT"
  fi
}
trap cleanup EXIT

if [ "$VERSION" != "$PACKAGE_VERSION" ] && [ "${SEZ_GATEWAY_ALLOW_FIXTURE_VERSION:-0}" != "1" ]; then
  echo "ERROR: release version must match package.json" >&2
  exit 1
fi
if [ -e "$RELEASE_ROOT" ]; then
  echo "ERROR: gateway build target already exists: $RELEASE_ROOT" >&2
  exit 1
fi
test -f "$PACKAGER_ROOT/scripts/package-release.ts"
test -f "$PACKAGER_ROOT/node_modules/tsx/dist/loader.mjs"
mkdir -p "$RELEASE_ROOT" "$OUTPUT_DIR"

for path in package.json package-lock.json AGENTS.md NOTICE.md README.md SECURITY.md bin src ops docs; do
  if [ -e "$ROOT/$path" ]; then
    cp -R "$ROOT/$path" "$RELEASE_ROOT/"
  fi
done
mkdir -p "$RELEASE_ROOT/scripts"
for script in verify-install.sh oauth-github-preflight.js live-smoke.js; do
  if [ -f "$ROOT/scripts/$script" ]; then
    cp "$ROOT/scripts/$script" "$RELEASE_ROOT/scripts/"
  fi
done

if find "$RELEASE_ROOT" -type l -print -quit | grep -q .; then
  echo "ERROR: gateway release tree contains a link" >&2
  exit 1
fi
if find "$RELEASE_ROOT" -type f -exec grep -Il -- 'PRIVATE KEY' {} + | grep -q .; then
  echo "ERROR: gateway release tree contains private key material" >&2
  exit 1
fi
find "$RELEASE_ROOT" -type d -exec chmod 0755 {} +
find "$RELEASE_ROOT" -type f -exec chmod 0644 {} +
find "$RELEASE_ROOT/bin" -type f -exec chmod 0755 {} +
find "$RELEASE_ROOT/scripts" -type f -name '*.sh' -exec chmod 0755 {} +

node scripts/create-package-spec.mjs \
  --root "$ROOT" \
  --version "$VERSION" \
  --output "$SPEC"

for output in \
  "$OUTPUT_DIR/$PREFIX.tar.gz" \
  "$OUTPUT_DIR/$PREFIX.build.json" \
  "$OUTPUT_DIR/$PREFIX.sha256"; do
  if [ -e "$output" ]; then
    echo "ERROR: gateway candidate output already exists: $output" >&2
    exit 1
  fi
done

node --import "$PACKAGER_ROOT/node_modules/tsx/dist/loader.mjs" \
  "$PACKAGER_ROOT/scripts/package-release.ts" \
  --release-root "$RELEASE_ROOT" \
  --output-directory "$OUTPUT_DIR" \
  --spec "$SPEC"

echo "CANDIDATE_ARCHIVE=$OUTPUT_DIR/$PREFIX.tar.gz"
echo "CANDIDATE_BUILD_RECORD=$OUTPUT_DIR/$PREFIX.build.json"
