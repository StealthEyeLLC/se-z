#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
set -Eeuo pipefail

CLIENT_ID="${SEZ_GATEWAY_GITHUB_CLIENT_ID:?SEZ_GATEWAY_GITHUB_CLIENT_ID required}"
CLIENT_SECRET_FILE="${SEZ_GATEWAY_GITHUB_CLIENT_SECRET_FILE:?SEZ_GATEWAY_GITHUB_CLIENT_SECRET_FILE required}"
ALLOWED_USER_ID="${SEZ_GATEWAY_GITHUB_ALLOWED_USER_ID:-247854506}"
LOGIN_HINT="${SEZ_GATEWAY_GITHUB_LOGIN_HINT:-StealthEyeLLC}"
PUBLIC_RESOURCE="${SEZ_GATEWAY_PUBLIC_RESOURCE:-https://se-z.stealtheye.io}"
CALLBACK_URI="${SEZ_GATEWAY_GITHUB_CALLBACK_URI:-$PUBLIC_RESOURCE/oauth/github/callback}"
CONFIG_ROOT="${SEZ_GATEWAY_CONFIG_ROOT:-/etc/se-z-gateway}"
ENVIRONMENT="$CONFIG_ROOT/environment"
INSTALLED_SECRET="$CONFIG_ROOT/github-client-secret"
STATE_PATH="${SEZ_GATEWAY_OAUTH_STATE_PATH:-/var/lib/se-z-gateway/oauth-state.json}"
CURRENT_LINK="${SEZ_GATEWAY_CURRENT_LINK:-/opt/se-z/gateway/current}"
SERVICE_NAME="${SEZ_GATEWAY_SERVICE_NAME:-se-z-gateway.service}"
NODE_PATH="${SEZ_NODE_PATH:-/opt/node-v24.18.0-linux-x64/bin/node}"
BACKUP=""
COMMITTED=0

cleanup() {
  set +e
  [ -z "$BACKUP" ] || rm -rf -- "$BACKUP"
}

rollback() {
  local rc=$1
  trap - ERR
  set +e
  if [ "$COMMITTED" = 0 ] && [ -n "$BACKUP" ]; then
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    if [ -f "$BACKUP/environment" ]; then
      install -o root -g sez -m 0640 "$BACKUP/environment" "$ENVIRONMENT"
    fi
    if [ -f "$BACKUP/github-client-secret" ]; then
      install -o se-z-gateway -g sez -m 0600 "$BACKUP/github-client-secret" "$INSTALLED_SECRET"
    else
      rm -f -- "$INSTALLED_SECRET"
    fi
    if [ -f "$BACKUP/oauth-state.json" ]; then
      install -o se-z-gateway -g sez -m 0600 "$BACKUP/oauth-state.json" "$STATE_PATH"
    else
      rm -f -- "$STATE_PATH"
    fi
    systemctl restart "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  cleanup
  exit "$rc"
}

trap cleanup EXIT
trap 'rollback $?' ERR

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root" >&2; exit 1; }
for command in install stat python3 systemctl runuser readlink grep; do
  command -v "$command" >/dev/null 2>&1 || { echo "ERROR: missing command: $command" >&2; exit 1; }
done
[[ "$CLIENT_ID" =~ ^[A-Za-z0-9._-]{10,128}$ ]] || { echo "ERROR: invalid GitHub App client ID" >&2; exit 1; }
[[ "$ALLOWED_USER_ID" =~ ^[1-9][0-9]{0,19}$ ]] || { echo "ERROR: invalid GitHub allowed user ID" >&2; exit 1; }
[ "$CALLBACK_URI" = "$PUBLIC_RESOURCE/oauth/github/callback" ] || { echo "ERROR: GitHub callback must be $PUBLIC_RESOURCE/oauth/github/callback" >&2; exit 1; }
[ -f "$CLIENT_SECRET_FILE" ] && [ ! -L "$CLIENT_SECRET_FILE" ] || { echo "ERROR: GitHub client secret file is missing or unsafe" >&2; exit 1; }
[ "$(stat -c %U "$CLIENT_SECRET_FILE")" = root ] || { echo "ERROR: GitHub client secret file must be root-owned" >&2; exit 1; }
[ "$(stat -c %a "$CLIENT_SECRET_FILE")" = 600 ] || { echo "ERROR: GitHub client secret file must have mode 0600" >&2; exit 1; }
[ -s "$CLIENT_SECRET_FILE" ] || { echo "ERROR: GitHub client secret file is empty" >&2; exit 1; }
[ -f "$ENVIRONMENT" ] || { echo "ERROR: gateway environment is missing" >&2; exit 1; }
[ -x "$NODE_PATH" ] || { echo "ERROR: pinned Node runtime is missing" >&2; exit 1; }
[ -f "$CURRENT_LINK/src/oauth-server.js" ] || { echo "ERROR: current release lacks the OAuth server" >&2; exit 1; }
[ -f "$CURRENT_LINK/scripts/oauth-github-preflight.js" ] || { echo "ERROR: current release lacks GitHub login support" >&2; exit 1; }
grep -Fq "/oauth/github/callback" "$CURRENT_LINK/src/oauth-server.js" || { echo "ERROR: current release lacks the GitHub callback" >&2; exit 1; }

BACKUP=$(mktemp -d /root/se-z-github-login.XXXXXX)
cp -a "$ENVIRONMENT" "$BACKUP/environment"
[ ! -f "$INSTALLED_SECRET" ] || cp -a "$INSTALLED_SECRET" "$BACKUP/github-client-secret"
[ ! -f "$STATE_PATH" ] || cp -a "$STATE_PATH" "$BACKUP/oauth-state.json"

systemctl stop "$SERVICE_NAME"
install -d -o root -g sez -m 0750 "$CONFIG_ROOT"
install -o se-z-gateway -g sez -m 0600 "$CLIENT_SECRET_FILE" "$INSTALLED_SECRET"

TEMP_ENV=$(mktemp "$CONFIG_ROOT/environment.XXXXXX")
python3 - "$ENVIRONMENT" "$TEMP_ENV" "$CLIENT_ID" "$INSTALLED_SECRET" "$ALLOWED_USER_ID" "$LOGIN_HINT" "$CALLBACK_URI" <<'PY'
import sys
source, target, client_id, secret_path, allowed_id, login_hint, callback = sys.argv[1:]
updates = {
    'SEZ_GATEWAY_IDENTITY_PROVIDER': 'github',
    'SEZ_GATEWAY_OWNER_PASSWORD_SCRYPT': '',
    'SEZ_GATEWAY_GITHUB_CLIENT_ID': client_id,
    'SEZ_GATEWAY_GITHUB_CLIENT_SECRET_PATH': secret_path,
    'SEZ_GATEWAY_GITHUB_ALLOWED_USER_ID': allowed_id,
    'SEZ_GATEWAY_GITHUB_LOGIN_HINT': login_hint,
    'SEZ_GATEWAY_GITHUB_CALLBACK_URI': callback,
}
seen = set()
output = []
with open(source, encoding='utf-8') as handle:
    for raw in handle:
        line = raw.rstrip('\n')
        key = line.split('=', 1)[0] if '=' in line else ''
        if key in updates:
            output.append(f'{key}={updates[key]}')
            seen.add(key)
        else:
            output.append(line)
for key, value in updates.items():
    if key not in seen:
        output.append(f'{key}={value}')
with open(target, 'w', encoding='utf-8') as handle:
    handle.write('\n'.join(output) + '\n')
PY
install -o root -g sez -m 0640 "$TEMP_ENV" "$ENVIRONMENT"
rm -f -- "$TEMP_ENV"
rm -f -- "$STATE_PATH"
install -d -o se-z-gateway -g sez -m 0700 "$(dirname "$STATE_PATH")"

systemctl restart "$SERVICE_NAME"
sleep 2
systemctl is-active --quiet "$SERVICE_NAME"
runuser -u se-z-gateway -- test -r "$INSTALLED_SECRET"
runuser -u se-z-gateway -- /bin/bash -c '
  set -a
  . /etc/se-z-gateway/environment
  set +a
  export SEZ_GATEWAY_SMOKE_BASE_URL=https://se-z.stealtheye.io
  exec /opt/node-v24.18.0-linux-x64/bin/node /opt/se-z/gateway/current/scripts/oauth-github-preflight.js
'

COMMITTED=1
printf 'GITHUB_LOGIN_READY provider=github allowed_user_id=%s callback=%s release=%s\n' \
  "$ALLOWED_USER_ID" "$CALLBACK_URI" "$(readlink -f "$CURRENT_LINK")"
