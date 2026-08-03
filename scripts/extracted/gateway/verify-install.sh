#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
set -euo pipefail

VERSION="${SEZ_GATEWAY_VERSION:?SEZ_GATEWAY_VERSION required}"
EXPECTED_COMMIT="${SEZ_GATEWAY_EXPECTED_COMMIT:?SEZ_GATEWAY_EXPECTED_COMMIT required}"
EXPECTED_HOSTNAME="${SEZ_EXPECTED_HOSTNAME:?SEZ_EXPECTED_HOSTNAME required}"
EXPECTED_MACHINE_ID="${SEZ_EXPECTED_MACHINE_ID_SHA256:?SEZ_EXPECTED_MACHINE_ID_SHA256 required}"
RELEASE_ROOT="${SEZ_GATEWAY_RELEASE_ROOT:-/opt/se-z/gateway/releases}"
CURRENT_LINK="${SEZ_GATEWAY_CURRENT_LINK:-/opt/se-z/gateway/current}"
NODE_PATH="${SEZ_NODE_PATH:-/opt/node-v24.18.0-linux-x64/bin/node}"
SERVICE_NAME="${SEZ_GATEWAY_SERVICE_NAME:-se-z-gateway.service}"
PORT="${SEZ_GATEWAY_HTTP_PORT:-2096}"
BASE="http://127.0.0.1:$PORT"

[ "$(hostname)" = "$EXPECTED_HOSTNAME" ]
MACHINE_ID=$(tr -d '\r\n' </etc/machine-id | sha256sum | awk '{print $1}')
[ "$MACHINE_ID" = "$EXPECTED_MACHINE_ID" ]
[ -x "$NODE_PATH" ]
[ "$(id -u se-z-gateway)" = 997 ]
[ -S /run/se-z/gateway.sock ]
[ -r /etc/se-z/supervisor-receipt-public.pem ]
[ -r /etc/se-z/gateway-authority-public.pem ]
[ -r /etc/se-z-gateway/gateway-authority-private.pem ]
[ -r /etc/se-z-gateway/oauth-signing-private.pem ]
[ -d /var/lib/se-z-gateway ]
[ "$(stat -c %U /var/lib/se-z-gateway)" = se-z-gateway ]
[ "$(readlink -f "$CURRENT_LINK")" = "$RELEASE_ROOT/$VERSION" ]
[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$CURRENT_LINK/manifest.json")" = "$EXPECTED_COMMIT" ]
[ "$(systemctl show -p User --value "$SERVICE_NAME")" = "se-z-gateway" ]
[ "$(systemctl show -p Group --value "$SERVICE_NAME")" = "se-z" ]
EXEC=$(systemctl show -p ExecStart --value "$SERVICE_NAME")
[[ "$EXEC" == *"/src/main.js"* ]]
[[ "$EXEC" != *"--preserve-symlinks-main"* ]]
[[ "$EXEC" != *"/src/server.js"* ]]
systemctl is-active --quiet se-z.socket
systemctl is-active --quiet "$SERVICE_NAME"

HEALTH=$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 "$BASE/healthz")
HEALTH_JSON="$HEALTH" python3 - "$EXPECTED_COMMIT" <<'PYHEALTH'
import json, os, sys
value = json.loads(os.environ['HEALTH_JSON'])
expected = sys.argv[1]
assert value.get('status') == 'ok'
assert value.get('product') == 'se-z-gateway'
assert value.get('commit') == expected
assert value.get('publicTools') == 1
assert value.get('oauthIssuer') == 'https://se-z.stealtheye.io'
assert value.get('protectedResource') == 'https://se-z.stealtheye.io/mcp'
PYHEALTH

for path in /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/mcp; do
  META=$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 "$BASE$path")
  META_JSON="$META" python3 - <<'PYMETA'
import json, os
value = json.loads(os.environ['META_JSON'])
assert value.get('resource') == 'https://se-z.stealtheye.io/mcp'
assert value.get('authorization_servers') == ['https://se-z.stealtheye.io']
assert 'header' in value.get('bearer_methods_supported', [])
assert 'sez.root' in value.get('scopes_supported', [])
PYMETA
done

AUTH_META=$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 "$BASE/.well-known/oauth-authorization-server")
AUTH_META_JSON="$AUTH_META" python3 - <<'PYAUTH'
import json, os
value = json.loads(os.environ['AUTH_META_JSON'])
assert value.get('issuer') == 'https://se-z.stealtheye.io'
assert value.get('authorization_endpoint') == 'https://se-z.stealtheye.io/oauth/authorize'
assert value.get('token_endpoint') == 'https://se-z.stealtheye.io/oauth/token'
assert value.get('registration_endpoint') == 'https://se-z.stealtheye.io/oauth/register'
assert 'authorization_code' in value.get('grant_types_supported', [])
assert 'refresh_token' in value.get('grant_types_supported', [])
assert 'S256' in value.get('code_challenge_methods_supported', [])
assert 'offline_access' in value.get('scopes_supported', [])
PYAUTH

JWKS=$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 "$BASE/oauth/jwks.json")
JWKS_JSON="$JWKS" python3 - <<'PYJWKS'
import json, os
value = json.loads(os.environ['JWKS_JSON'])
keys = value.get('keys')
assert isinstance(keys, list) and len(keys) == 1
assert keys[0].get('kid') and keys[0].get('alg') == 'EdDSA'
assert 'd' not in keys[0]
PYJWKS

runuser -u se-z-gateway -- test -r /etc/se-z-gateway/gateway-authority-private.pem
runuser -u se-z-gateway -- test -r /etc/se-z-gateway/oauth-signing-private.pem
runuser -u se-z-gateway -- test -w /run/se-z/gateway.sock
runuser -u se-z-gateway -- test -w /var/lib/se-z-gateway
SMOKE=$(runuser -u se-z-gateway -- /bin/bash -c 'set -a; . /etc/se-z-gateway/environment; set +a; exec /opt/node-v24.18.0-linux-x64/bin/node /opt/se-z/gateway/current/scripts/live-smoke.js')
SMOKE_JSON="$SMOKE" python3 - <<'PYSMOKE'
import json, os
value = json.loads(os.environ['SMOKE_JSON'])
assert value.get('status') == 'ok'
assert value.get('operation') == 'sez.health'
assert value.get('receiptVerified') is True
PYSMOKE

CHALLENGE_HEADERS=$(mktemp)
CHALLENGE_BODY=$(mktemp)
trap 'rm -f "$CHALLENGE_HEADERS" "$CHALLENGE_BODY"' EXIT
CODE=$(curl --silent --show-error --connect-timeout 3 --max-time 5 -D "$CHALLENGE_HEADERS" -o "$CHALLENGE_BODY" -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' "$BASE/mcp")
[ "$CODE" = 401 ]
tr -d '\r' <"$CHALLENGE_HEADERS" | grep -Eiq '^www-authenticate:.*resource_metadata="https://se-z.stealtheye.io/.well-known/oauth-protected-resource/mcp".*scope="sez.root"'
printf 'VERIFY_VERSION=%s\nVERIFY_COMMIT=%s\nVERIFY_HEALTH=ok\nVERIFY_OAUTH=ok\nVERIFY_SEZ1=ok\n' "$VERSION" "$EXPECTED_COMMIT"
