#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
# Prepare and deterministically package one exact se-z source tree.
set -euo pipefail

export LC_ALL=C.UTF-8
export LANG=C.UTF-8
export TZ=UTC
umask 0022

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

PACKAGE_VERSION=$(node -p "require('./package.json').version")
VERSION="${1:-$PACKAGE_VERSION}"
BUILD_ROOT="${SEZ_BUILD_ROOT:-$(mktemp -d)}"
OUTPUT_DIR="${SEZ_OUTPUT_DIR:-$ROOT/release}"
RELEASE_NAME="se-z-$VERSION"
RELEASE_DIR="$BUILD_ROOT/$RELEASE_NAME"
SPEC="$BUILD_ROOT/package-spec.json"
PRODUCTION_DEPS="$BUILD_ROOT/production-dependencies"

cleanup() {
  if [ "${SEZ_KEEP_BUILD_ROOT:-0}" != "1" ]; then
    rm -rf -- "$BUILD_ROOT"
  fi
}
trap cleanup EXIT

if [ "$VERSION" != "$PACKAGE_VERSION" ] && [ "${SEZ_ALLOW_FIXTURE_VERSION:-0}" != "1" ]; then
  echo "ERROR: release version must match package.json" >&2
  exit 1
fi
if [ -e "$RELEASE_DIR" ]; then
  echo "ERROR: build target already exists: $RELEASE_DIR" >&2
  exit 1
fi

mkdir -p "$RELEASE_DIR/bin" "$RELEASE_DIR/lib/dist" \
  "$RELEASE_DIR/lib/build/Release" "$RELEASE_DIR/ops" "$OUTPUT_DIR" \
  "$PRODUCTION_DEPS"

npm run build
npm run build:native
test -d dist-extracted/supervisor
test -f src/native/peercred/build/Release/peer_cred.node

cp -R dist-extracted/. "$RELEASE_DIR/lib/dist/"
cp package.json package-lock.json "$RELEASE_DIR/lib/"
cp src/native/peercred/binding.gyp "$RELEASE_DIR/lib/binding.gyp"
cp src/native/peercred/build/Release/peer_cred.node "$RELEASE_DIR/lib/build/Release/peer_cred.node"

cp package.json package-lock.json "$PRODUCTION_DEPS/"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --bin-links=false --prefix "$PRODUCTION_DEPS"
# npm does not create node_modules when the production dependency set is empty.
# Preserve a deterministic empty directory so the release layout and copy step remain valid.
mkdir -p "$PRODUCTION_DEPS/node_modules"
if find "$PRODUCTION_DEPS/node_modules" -type l -print -quit | grep -q .; then
  echo "ERROR: production dependency graph contains a link and is not packageable" >&2
  exit 1
fi
cp -R "$PRODUCTION_DEPS/node_modules" "$RELEASE_DIR/lib/node_modules"

cat > "$RELEASE_DIR/bin/se-z-daemon" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RELEASE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
NODE_BIN=${SEZ_NODE_BIN:-/opt/node-v24.18.0-linux-x64/bin/node}
exec "$NODE_BIN" "$RELEASE_ROOT/lib/dist/supervisor/server/index.js"
EOF

cat > "$RELEASE_DIR/bin/se-z" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RELEASE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
NODE_BIN=${SEZ_NODE_BIN:-/opt/node-v24.18.0-linux-x64/bin/node}
exec "$NODE_BIN" "$RELEASE_ROOT/lib/dist/supervisor/cli/main.js" "$@"
EOF

for command in install verify rollback repair; do
  cat > "$RELEASE_DIR/bin/se-z-$command" <<EOF
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)
RELEASE_ROOT=\$(CDPATH= cd -- "\$SCRIPT_DIR/.." && pwd)
NODE_BIN=\${SEZ_NODE_BIN:-/opt/node-v24.18.0-linux-x64/bin/node}
exec "\$NODE_BIN" "\$RELEASE_ROOT/lib/dist/cli/$command.js" "\$@"
EOF
done

cp -R packaging/systemd "$RELEASE_DIR/ops/"
cp -R packaging/tmpfiles "$RELEASE_DIR/ops/"
cp -R protocol/schemas "$RELEASE_DIR/schemas"
cp -R contracts "$RELEASE_DIR/"

find "$RELEASE_DIR" -type d -exec chmod 0755 {} +
find "$RELEASE_DIR" -type f -exec chmod 0644 {} +
find "$RELEASE_DIR/bin" -type f -exec chmod 0755 {} +

NATIVE_EVIDENCE="$BUILD_ROOT/native-load-evidence.json"
node -e '
  const path = process.argv[1];
  const native = require(path);
  if (typeof native.getPeerCred !== "function") throw new Error("getPeerCred export missing");
  process.stdout.write(JSON.stringify({status:"loaded",node:process.versions.node,nodeAbi:process.versions.modules,path:"lib/build/Release/peer_cred.node"})+"\n");
' "$RELEASE_DIR/lib/build/Release/peer_cred.node" > "$NATIVE_EVIDENCE"
export SEZ_NATIVE_LOAD_EVIDENCE_DIGEST="${SEZ_NATIVE_LOAD_EVIDENCE_DIGEST:-$(sha256sum "$NATIVE_EVIDENCE" | awk '{print $1}')}"

node --import tsx scripts/extracted/supervisor/create-package-spec.ts \
  --root "$ROOT" \
  --version "$VERSION" \
  --output "$SPEC"

for output in \
  "$OUTPUT_DIR/$RELEASE_NAME.tar.gz" \
  "$OUTPUT_DIR/$RELEASE_NAME.build.json" \
  "$OUTPUT_DIR/$RELEASE_NAME.sha256"; do
  if [ -e "$output" ]; then
    echo "ERROR: candidate output already exists: $output" >&2
    exit 1
  fi
done

node --import tsx scripts/extracted/supervisor/package-release.ts \
  --release-root "$RELEASE_DIR" \
  --output-directory "$OUTPUT_DIR" \
  --spec "$SPEC"

echo "CANDIDATE_ARCHIVE=$OUTPUT_DIR/$RELEASE_NAME.tar.gz"
echo "CANDIDATE_BUILD_RECORD=$OUTPUT_DIR/$RELEASE_NAME.build.json"
