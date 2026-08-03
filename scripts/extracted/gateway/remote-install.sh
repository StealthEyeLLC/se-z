#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
set -Eeuo pipefail

VERSION="${SEZ_GATEWAY_VERSION:?SEZ_GATEWAY_VERSION required}"
STAGING_PATH="${SEZ_GATEWAY_STAGING_PATH:?SEZ_GATEWAY_STAGING_PATH required}"
EXPECTED_COMMIT="${SEZ_GATEWAY_EXPECTED_COMMIT:?SEZ_GATEWAY_EXPECTED_COMMIT required}"
EXPECTED_HOSTNAME="${SEZ_EXPECTED_HOSTNAME:?SEZ_EXPECTED_HOSTNAME required}"
EXPECTED_MACHINE_ID="${SEZ_EXPECTED_MACHINE_ID_SHA256:?SEZ_EXPECTED_MACHINE_ID_SHA256 required}"
EXPECTED_PUBLIC_KEY_SHA256="${SEZ_OWNER_PRINCIPAL_FINGERPRINT:?SEZ_OWNER_PRINCIPAL_FINGERPRINT required}"
EXPECTED_PUBLIC_IPV4="${SEZ_GATEWAY_EXPECTED_PUBLIC_IPV4:-51.81.86.225}"
PUBLIC_RESOURCE="${SEZ_GATEWAY_PUBLIC_RESOURCE:-https://se-z.stealtheye.io}"
PROTECTED_RESOURCE="${SEZ_GATEWAY_RESOURCE_URI:-$PUBLIC_RESOURCE/mcp}"
OAUTH_ISSUER="${SEZ_GATEWAY_OAUTH_ISSUER:-$PUBLIC_RESOURCE}"
OAUTH_RESOURCE="${SEZ_GATEWAY_OAUTH_RESOURCE:-$PROTECTED_RESOURCE}"
OAUTH_JWKS_URI="${SEZ_GATEWAY_OAUTH_JWKS_URI:-$OAUTH_ISSUER/oauth/jwks.json}"
REQUIRED_SCOPE="${SEZ_GATEWAY_REQUIRED_SCOPE:-sez.root}"
GITHUB_CLIENT_ID="${SEZ_GATEWAY_GITHUB_CLIENT_ID:-}"
GITHUB_CLIENT_SECRET_PATH="${SEZ_GATEWAY_GITHUB_CLIENT_SECRET_PATH:-/etc/se-z-gateway/github-client-secret}"
GITHUB_ALLOWED_USER_ID="${SEZ_GATEWAY_GITHUB_ALLOWED_USER_ID:-247854506}"
GITHUB_LOGIN_HINT="${SEZ_GATEWAY_GITHUB_LOGIN_HINT:-StealthEyeLLC}"
GITHUB_CALLBACK_URI="${SEZ_GATEWAY_GITHUB_CALLBACK_URI:-$PUBLIC_RESOURCE/oauth/github/callback}"
INSTALL_CADDY="${SEZ_GATEWAY_INSTALL_CADDY:-1}"
RELEASE_ROOT="${SEZ_GATEWAY_RELEASE_ROOT:-/opt/se-z/gateway/releases}"
CURRENT_LINK="${SEZ_GATEWAY_CURRENT_LINK:-/opt/se-z/gateway/current}"
PREVIOUS_LINK="${SEZ_GATEWAY_PREVIOUS_LINK:-/opt/se-z/gateway/previous}"
CONFIG_ROOT="${SEZ_GATEWAY_CONFIG_ROOT:-/etc/se-z-gateway}"
OAUTH_STATE_PATH="${SEZ_GATEWAY_OAUTH_STATE_PATH:-/var/lib/se-z-gateway/oauth-state.json}"
NODE_PATH="${SEZ_NODE_PATH:-/opt/node-v24.18.0-linux-x64/bin/node}"
SERVICE_NAME="${SEZ_GATEWAY_SERVICE_NAME:-se-z-gateway.service}"
CADDYFILE="${SEZ_GATEWAY_CADDYFILE:-/etc/caddy/Caddyfile}"

EXTRACT_ROOT=""
BACKUP_ROOT=""
TARGET=""
OLD_CURRENT=""
OLD_PREVIOUS=""
ROLLBACK_ARMED=0
CADDY_CHANGED=0

cleanup() {
  set +e
  [ -z "$EXTRACT_ROOT" ] || rm -rf -- "$EXTRACT_ROOT"
  [ -z "$BACKUP_ROOT" ] || rm -rf -- "$BACKUP_ROOT"
}

restore_link() {
  local link=$1 target=$2
  if [ -n "$target" ] && [ -e "$target" ]; then
    ln -sfn "$target" "$link.restore"
    mv -Tf "$link.restore" "$link"
  else
    rm -f -- "$link" "$link.restore"
  fi
}

rollback() {
  local rc=$1
  trap - ERR
  set +e
  if [ "$ROLLBACK_ARMED" = 1 ]; then
    printf 'ROLLBACK: restoring previous se-z gateway state after rc=%s\n' "$rc" >&2
    restore_link "$CURRENT_LINK" "$OLD_CURRENT"
    restore_link "$PREVIOUS_LINK" "$OLD_PREVIOUS"
    if [ -f "$BACKUP_ROOT/service" ]; then
      install -o root -g root -m 0644 "$BACKUP_ROOT/service" "/etc/systemd/system/$SERVICE_NAME"
    else
      rm -f -- "/etc/systemd/system/$SERVICE_NAME"
    fi
    if [ -f "$BACKUP_ROOT/environment" ]; then
      install -d -o root -g sez -m 0750 "$CONFIG_ROOT"
      install -o root -g sez -m 0640 "$BACKUP_ROOT/environment" "$CONFIG_ROOT/environment"
    else
      rm -f -- "$CONFIG_ROOT/environment"
    fi
    systemctl daemon-reload
    if [ -n "$OLD_CURRENT" ] && [ -e "$OLD_CURRENT" ]; then
      systemctl restart "$SERVICE_NAME"
    else
      systemctl stop "$SERVICE_NAME"
    fi
    if [ "$CADDY_CHANGED" = 1 ] && [ -f "$BACKUP_ROOT/Caddyfile" ]; then
      install -o root -g root -m 0644 "$BACKUP_ROOT/Caddyfile" "$CADDYFILE"
      caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 && systemctl reload caddy
    fi
    if [ -n "$TARGET" ] && [ "$TARGET" != "$OLD_CURRENT" ] && [ -d "$TARGET" ]; then
      rm -rf -- "$TARGET"
    fi
  fi
  cleanup
  exit "$rc"
}

trap cleanup EXIT
trap 'rollback $?' ERR

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  echo "ERROR: invalid version" >&2; exit 1
fi
if [[ ! "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  echo "ERROR: invalid expected commit" >&2; exit 1
fi
if [[ ! "$EXPECTED_MACHINE_ID" =~ ^[a-f0-9]{64}$ ]]; then
  echo "ERROR: invalid expected machine identity" >&2; exit 1
fi
if [[ ! "$EXPECTED_PUBLIC_KEY_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "ERROR: invalid expected public key fingerprint" >&2; exit 1
fi
if [[ ! "$EXPECTED_PUBLIC_IPV4" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "ERROR: invalid expected public IPv4" >&2; exit 1
fi
if [ "$PROTECTED_RESOURCE" != "$PUBLIC_RESOURCE/mcp" ]; then
  echo "ERROR: protected resource must be the exact public MCP endpoint" >&2; exit 1
fi
if [ "$OAUTH_ISSUER" != "$PUBLIC_RESOURCE" ] || [ "$OAUTH_RESOURCE" != "$PROTECTED_RESOURCE" ]; then
  echo "ERROR: OAuth issuer/resource do not match the embedded authorization server contract" >&2; exit 1
fi
if [ "$OAUTH_JWKS_URI" != "$OAUTH_ISSUER/oauth/jwks.json" ]; then
  echo "ERROR: OAuth JWKS URI does not match the embedded authorization server" >&2; exit 1
fi
if [ "$STAGING_PATH" != "/tmp/se-z-gateway-deploy-$VERSION" ]; then
  echo "ERROR: unexpected staging path" >&2; exit 1
fi
if [ "$INSTALL_CADDY" != 0 ] && [ "$INSTALL_CADDY" != 1 ]; then
  echo "ERROR: SEZ_GATEWAY_INSTALL_CADDY must be 0 or 1" >&2; exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: remote installer must run as root" >&2
  exit 1
fi
for command in python3 sha256sum openssl tar gzip install systemctl runuser curl getent id cmp readlink find mv cp ln sleep dirname awk mktemp grep tr cat stat; do
  command -v "$command" >/dev/null 2>&1 || { echo "ERROR: missing command: $command" >&2; exit 1; }
done
if [ "$INSTALL_CADDY" = 1 ]; then
  command -v caddy >/dev/null 2>&1 || { echo "ERROR: caddy is required" >&2; exit 1; }
  [ -f "$CADDYFILE" ] || { echo "ERROR: Caddyfile is missing" >&2; exit 1; }
fi
[ "$(hostname)" = "$EXPECTED_HOSTNAME" ] || { echo "ERROR: hostname mismatch" >&2; exit 1; }
ACTUAL_MACHINE_ID=$(tr -d '\r\n' </etc/machine-id | sha256sum | awk '{print $1}')
[ "$ACTUAL_MACHINE_ID" = "$EXPECTED_MACHINE_ID" ] || { echo "ERROR: machine identity mismatch" >&2; exit 1; }
[ -x "$NODE_PATH" ] || { echo "ERROR: pinned Node runtime unavailable" >&2; exit 1; }
[ "$(id -u se-z-gateway)" = 997 ] || { echo "ERROR: se-z-gateway must be UID 997" >&2; exit 1; }
getent group sez >/dev/null 2>&1
id -nG se-z-gateway | tr ' ' '\n' | grep -Fxq sez
[ -S /run/se-z/gateway.sock ]
[ -f /etc/se-z/gateway-authority-public.pem ]
[ -f /etc/se-z/supervisor-receipt-public.pem ]

if [ -z "$GITHUB_CLIENT_ID" ] && [ -f "$CONFIG_ROOT/environment" ]; then
  GITHUB_CLIENT_ID=$(awk -F= '$1=="SEZ_GATEWAY_GITHUB_CLIENT_ID" {sub(/^[^=]*=/, ""); print; exit}' "$CONFIG_ROOT/environment")
fi
[ -n "$GITHUB_CLIENT_ID" ] || { echo "ERROR: SEZ_GATEWAY_GITHUB_CLIENT_ID is required" >&2; exit 1; }
[ "$GITHUB_ALLOWED_USER_ID" = 247854506 ] || { echo "ERROR: GitHub owner numeric ID mismatch" >&2; exit 1; }
[ "$GITHUB_CALLBACK_URI" = "$PUBLIC_RESOURCE/oauth/github/callback" ] || { echo "ERROR: GitHub callback URI mismatch" >&2; exit 1; }
[ -f "$GITHUB_CLIENT_SECRET_PATH" ] && [ ! -L "$GITHUB_CLIENT_SECRET_PATH" ] || {
  echo "ERROR: configured GitHub client-secret reference is missing or unsafe" >&2; exit 1;
}

cd "$STAGING_PATH"
ARCHIVE="se-z-gateway-$VERSION.tar.gz"
SHA_FILE="se-z-gateway-$VERSION.sha256"
MANIFEST="se-z-gateway-$VERSION.manifest.json"
PRIVATE_KEY="gateway-authority-private.pem"
for file in "$ARCHIVE" "$SHA_FILE" "$MANIFEST" "$PRIVATE_KEY"; do
  [ -f "$file" ] && [ ! -L "$file" ] || { echo "ERROR: missing unsafe staging file: $file" >&2; exit 1; }
done

ACTUAL_SHA=$(sha256sum "$ARCHIVE" | awk '{print $1}')
FILE_SHA=$(awk 'NF {print $1; exit}' "$SHA_FILE")
MANIFEST_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$MANIFEST")
MANIFEST_COMMIT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$MANIFEST")
MANIFEST_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$MANIFEST")
[ "$ACTUAL_SHA" = "$FILE_SHA" ] && [ "$ACTUAL_SHA" = "$MANIFEST_SHA" ]
[ "$MANIFEST_COMMIT" = "$EXPECTED_COMMIT" ] && [ "$MANIFEST_VERSION" = "$VERSION" ]

INSTALLED_PUBLIC_SHA=$(sha256sum /etc/se-z/gateway-authority-public.pem | awk '{print $1}')
[ "$INSTALLED_PUBLIC_SHA" = "$EXPECTED_PUBLIC_KEY_SHA256" ] || { echo "ERROR: se-z authority key mismatch" >&2; exit 1; }
DERIVED_ROOT=$(mktemp -d "$STAGING_PATH/derived.XXXXXX")
openssl pkey -pubin -in /etc/se-z/gateway-authority-public.pem -outform DER > "$DERIVED_ROOT/expected.der"
openssl pkey -in "$PRIVATE_KEY" -pubout -outform DER > "$DERIVED_ROOT/actual.der"
cmp -s "$DERIVED_ROOT/expected.der" "$DERIVED_ROOT/actual.der" || { echo "ERROR: staged private key does not match se-z authority" >&2; exit 1; }
rm -rf -- "$DERIVED_ROOT"

TARGET="$RELEASE_ROOT/$VERSION"
[ ! -e "$TARGET" ] || { echo "ERROR: immutable release already exists" >&2; exit 1; }
EXTRACT_ROOT=$(mktemp -d "$STAGING_PATH/extracted.XXXXXX")
tar -tzf "$ARCHIVE" | python3 -c 'import posixpath,sys
for raw in sys.stdin:
 p=raw.strip(); n=posixpath.normpath(p)
 if not p or p.startswith("/") or n==".." or n.startswith("../"):
  raise SystemExit("unsafe archive path")'
tar -xzf "$ARCHIVE" -C "$EXTRACT_ROOT" --no-same-owner --no-same-permissions
SOURCE="$EXTRACT_ROOT/se-z-gateway-$VERSION"
for required in src/main.js src/server.js src/oauth-server.js manifest.json ops/systemd/se-z-gateway.service ops/caddy/se-z-gateway.Caddyfile scripts/install-caddy-site.py scripts/oauth-github-preflight.js; do
  [ -f "$SOURCE/$required" ] && [ ! -L "$SOURCE/$required" ] || { echo "ERROR: release is missing required path: $required" >&2; exit 1; }
done
INTERNAL_COMMIT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$SOURCE/manifest.json")
[ "$INTERNAL_COMMIT" = "$EXPECTED_COMMIT" ]

OLD_CURRENT=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
OLD_PREVIOUS=$(readlink -f "$PREVIOUS_LINK" 2>/dev/null || true)
BACKUP_ROOT=$(mktemp -d /root/se-z-gateway-rollback.XXXXXX)
[ ! -f "/etc/systemd/system/$SERVICE_NAME" ] || cp -a "/etc/systemd/system/$SERVICE_NAME" "$BACKUP_ROOT/service"
[ ! -f "$CONFIG_ROOT/environment" ] || cp -a "$CONFIG_ROOT/environment" "$BACKUP_ROOT/environment"
[ ! -f "$CADDYFILE" ] || cp -a "$CADDYFILE" "$BACKUP_ROOT/Caddyfile"
ROLLBACK_ARMED=1

install -d -o root -g root -m 0755 "$RELEASE_ROOT"
cp -a "$SOURCE" "$TARGET"
chown -R root:root "$TARGET"
find "$TARGET" -type d -exec chmod 0755 {} +
find "$TARGET" -type f -exec chmod 0644 {} +
chmod 0755 "$TARGET/scripts/"*.sh "$TARGET/scripts/"*.py

install -d -o root -g sez -m 0750 "$CONFIG_ROOT"
install -o se-z-gateway -g sez -m 0600 "$PRIVATE_KEY" "$CONFIG_ROOT/gateway-authority-private.pem"
OAUTH_PRIVATE_KEY="$CONFIG_ROOT/oauth-signing-private.pem"
if [ ! -f "$OAUTH_PRIVATE_KEY" ]; then
  OAUTH_TEMP=$(mktemp "$CONFIG_ROOT/oauth-signing-private.XXXXXX")
  openssl genpkey -algorithm Ed25519 -out "$OAUTH_TEMP"
  install -o se-z-gateway -g sez -m 0600 "$OAUTH_TEMP" "$OAUTH_PRIVATE_KEY"
  rm -f "$OAUTH_TEMP"
else
  openssl pkey -in "$OAUTH_PRIVATE_KEY" -noout >/dev/null
  chown se-z-gateway:sez "$OAUTH_PRIVATE_KEY"
  chmod 0600 "$OAUTH_PRIVATE_KEY"
fi
install -d -o se-z-gateway -g sez -m 0700 "$(dirname "$OAUTH_STATE_PATH")"

cat > "$CONFIG_ROOT/environment" <<ENV
SEZ_GATEWAY_BIND_HOST=127.0.0.1
SEZ_GATEWAY_HTTP_PORT=2096
SEZ_GATEWAY_PUBLIC_RESOURCE=$PUBLIC_RESOURCE
SEZ_GATEWAY_RESOURCE_URI=$PROTECTED_RESOURCE
SEZ_GATEWAY_OAUTH_ISSUER=$OAUTH_ISSUER
SEZ_GATEWAY_OAUTH_RESOURCE=$OAUTH_RESOURCE
SEZ_GATEWAY_OAUTH_JWKS_URI=$OAUTH_JWKS_URI
SEZ_GATEWAY_OAUTH_SIGNING_PRIVATE_KEY_PATH=$OAUTH_PRIVATE_KEY
SEZ_GATEWAY_OAUTH_STATE_PATH=$OAUTH_STATE_PATH
SEZ_GATEWAY_IDENTITY_PROVIDER=github
SEZ_GATEWAY_OWNER_PASSWORD_SCRYPT=
SEZ_GATEWAY_GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID
SEZ_GATEWAY_GITHUB_CLIENT_SECRET_PATH=$GITHUB_CLIENT_SECRET_PATH
SEZ_GATEWAY_GITHUB_ALLOWED_USER_ID=$GITHUB_ALLOWED_USER_ID
SEZ_GATEWAY_GITHUB_LOGIN_HINT=$GITHUB_LOGIN_HINT
SEZ_GATEWAY_GITHUB_CALLBACK_URI=$GITHUB_CALLBACK_URI
SEZ_GATEWAY_REQUIRED_SCOPE=$REQUIRED_SCOPE
SEZ_GATEWAY_EXPECTED_SUBJECT=stealtheye-owner
SEZ_SOCKET_PATH=/run/se-z/gateway.sock
SEZ_EXPECTED_HOSTNAME=$EXPECTED_HOSTNAME
SEZ_EXPECTED_MACHINE_ID_SHA256=$EXPECTED_MACHINE_ID
SEZ_GATEWAY_ID=stealtheye-sez-gateway
SEZ_GATEWAY_KEY_ID=gateway-authority-v1
SEZ_GATEWAY_AUTHORITY_PRIVATE_KEY_PATH=$CONFIG_ROOT/gateway-authority-private.pem
SEZ_RECEIPT_PUBLIC_KEY_PATH=/etc/se-z/supervisor-receipt-public.pem
SEZ_RECEIPT_KEY_ID=supervisor-receipt-v1
SEZ_OWNER_PRINCIPAL_FINGERPRINT=$EXPECTED_PUBLIC_KEY_SHA256
SEZ_GATEWAY_UID=997
SEZ_GATEWAY_ENFORCE_UID=1
SEZ_GATEWAY_VERSION=$VERSION
SEZ_GATEWAY_COMMIT_SHA=$EXPECTED_COMMIT
ENV
chown root:sez "$CONFIG_ROOT/environment"
chmod 0640 "$CONFIG_ROOT/environment"

ln -sfn "$TARGET" "$CURRENT_LINK.new"
mv -Tf "$CURRENT_LINK.new" "$CURRENT_LINK"
if [ -n "$OLD_CURRENT" ] && [ "$OLD_CURRENT" != "$TARGET" ]; then
  ln -sfn "$OLD_CURRENT" "$PREVIOUS_LINK.new"
  mv -Tf "$PREVIOUS_LINK.new" "$PREVIOUS_LINK"
fi

install -o root -g root -m 0644 "$TARGET/ops/systemd/se-z-gateway.service" "/etc/systemd/system/$SERVICE_NAME"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 2
SEZ_GATEWAY_VERSION="$VERSION" \
SEZ_GATEWAY_EXPECTED_COMMIT="$EXPECTED_COMMIT" \
SEZ_EXPECTED_HOSTNAME="$EXPECTED_HOSTNAME" \
SEZ_EXPECTED_MACHINE_ID_SHA256="$EXPECTED_MACHINE_ID" \
"$TARGET/scripts/verify-install.sh"

if [ "$INSTALL_CADDY" = 1 ]; then
  CADDY_CANDIDATE=$(mktemp /etc/caddy/Caddyfile.se-z-gateway.XXXXXX)
  python3 "$TARGET/scripts/install-caddy-site.py" --config "$CADDYFILE" --fragment "$TARGET/ops/caddy/se-z-gateway.Caddyfile" --output "$CADDY_CANDIDATE"
  caddy validate --config "$CADDY_CANDIDATE" --adapter caddyfile >/dev/null
  install -o root -g root -m 0644 "$CADDY_CANDIDATE" "$CADDYFILE"
  rm -f "$CADDY_CANDIDATE"
  CADDY_CHANGED=1
  systemctl reload caddy
  systemctl is-active --quiet caddy
fi

PUBLIC_HOST=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.urlparse(sys.argv[1]).hostname)' "$PUBLIC_RESOURCE")
DNS_ADDRESSES=$(getent ahostsv4 "$PUBLIC_HOST" | awk '{print $1}' | sort -u)
printf '%s\n' "$DNS_ADDRESSES" | grep -Fxq "$EXPECTED_PUBLIC_IPV4"
CURL_PUBLIC=(curl --fail --silent --show-error --connect-timeout 5 --max-time 15 --resolve "$PUBLIC_HOST:443:$EXPECTED_PUBLIC_IPV4")
PUBLIC_HEALTH=$("${CURL_PUBLIC[@]}" "$PUBLIC_RESOURCE/healthz")
HEALTH_JSON="$PUBLIC_HEALTH" python3 - "$EXPECTED_COMMIT" "$VERSION" <<'PYHEALTH'
import json, os, sys
value=json.loads(os.environ['HEALTH_JSON'])
assert value.get('status') == 'ok'
assert value.get('commit') == sys.argv[1]
assert value.get('version') == sys.argv[2]
assert value.get('publicTools') == 1
assert value.get('oauthIssuer') == 'https://se-z.stealtheye.io'
assert value.get('protectedResource') == 'https://se-z.stealtheye.io/mcp'
PYHEALTH
for path in /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/mcp; do
  META=$("${CURL_PUBLIC[@]}" "$PUBLIC_RESOURCE$path")
  META_JSON="$META" python3 - <<'PYMETA'
import json,os
value=json.loads(os.environ['META_JSON'])
assert value.get('resource') == 'https://se-z.stealtheye.io/mcp'
assert value.get('authorization_servers') == ['https://se-z.stealtheye.io']
assert 'sez.root' in value.get('scopes_supported', [])
PYMETA
done
AUTH_META=$("${CURL_PUBLIC[@]}" "$PUBLIC_RESOURCE/.well-known/oauth-authorization-server")
AUTH_META_JSON="$AUTH_META" python3 - <<'PYAUTH'
import json,os
value=json.loads(os.environ['AUTH_META_JSON'])
assert value.get('issuer') == 'https://se-z.stealtheye.io'
assert value.get('registration_endpoint') == 'https://se-z.stealtheye.io/oauth/register'
assert 'refresh_token' in value.get('grant_types_supported', [])
assert 'S256' in value.get('code_challenge_methods_supported', [])
PYAUTH
JWKS=$("${CURL_PUBLIC[@]}" "$PUBLIC_RESOURCE/oauth/jwks.json")
JWKS_JSON="$JWKS" python3 - <<'PYJWKS'
import json,os
keys=json.loads(os.environ['JWKS_JSON']).get('keys')
assert isinstance(keys,list) and len(keys)==1
assert keys[0].get('alg') == 'EdDSA' and keys[0].get('kid') and 'd' not in keys[0]
PYJWKS
CHALLENGE_HEADERS=$(mktemp)
CHALLENGE_BODY=$(mktemp)
CHALLENGE_CODE=$(curl --silent --show-error --connect-timeout 5 --max-time 15 --resolve "$PUBLIC_HOST:443:$EXPECTED_PUBLIC_IPV4" -D "$CHALLENGE_HEADERS" -o "$CHALLENGE_BODY" -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' "$PROTECTED_RESOURCE")
[ "$CHALLENGE_CODE" = 401 ]
tr -d '\r' <"$CHALLENGE_HEADERS" | grep -Eiq '^www-authenticate:.*resource_metadata="https://se-z.stealtheye.io/.well-known/oauth-protected-resource/mcp".*scope="sez.root"'
rm -f "$CHALLENGE_HEADERS" "$CHALLENGE_BODY"

SEZ_GATEWAY_SMOKE_BASE_URL="http://127.0.0.1:2096" \
SEZ_GATEWAY_PUBLIC_RESOURCE="$PUBLIC_RESOURCE" \
SEZ_GATEWAY_RESOURCE_URI="$PROTECTED_RESOURCE" \
SEZ_GATEWAY_GITHUB_CLIENT_ID="$GITHUB_CLIENT_ID" \
SEZ_GATEWAY_GITHUB_CALLBACK_URI="$GITHUB_CALLBACK_URI" \
runuser -u se-z-gateway --preserve-environment -- "$NODE_PATH" "$TARGET/scripts/oauth-github-preflight.js"

ROLLBACK_ARMED=0
printf 'DEPLOY_VERSION=%s\nDEPLOY_COMMIT=%s\nDEPLOY_SHA256=%s\nDEPLOY_OAUTH=embedded-github-numeric-id-pkce-refresh\n' "$VERSION" "$EXPECTED_COMMIT" "$ACTUAL_SHA"
