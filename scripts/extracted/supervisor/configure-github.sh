#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
# Configure GitHub repository secrets and variables for se-z bootstrap lane.
set -euo pipefail

if [ -z "${sez_sec_gh_token:-}" ]; then
  echo "ERROR: sez_sec_gh_token is required for secret administration" >&2
  exit 1
fi

export GH_TOKEN="$sez_sec_gh_token"

REPO="${SEZ_REPOSITORY:-StealthEyeLLC/se-z}"
BOOTSTRAP="${HOME}/.se-z-bootstrap"

require_file() {
  if [ ! -f "$1" ]; then
    echo "ERROR: required bootstrap file missing: $1" >&2
    exit 1
  fi
}

require_file "$BOOTSTRAP/ci-deploy"
require_file "$BOOTSTRAP/known_hosts"
require_file "$BOOTSTRAP/gateway-authority-private.pem"
require_file "$BOOTSTRAP/gateway-authority-public.pem"

gh secret set SEZ_VPS_SSH_PRIVATE_KEY --repo "$REPO" < "$BOOTSTRAP/ci-deploy"
gh secret set SEZ_VPS_SSH_KNOWN_HOSTS --repo "$REPO" < "$BOOTSTRAP/known_hosts"
gh secret set SEZ_GATEWAY_SIGNING_PRIVATE_KEY --repo "$REPO" < "$BOOTSTRAP/gateway-authority-private.pem"

gh variable set SEZ_VPS_HOST --repo "$REPO" --body "51.81.86.225"
gh variable set SEZ_VPS_PORT --repo "$REPO" --body "22"
gh variable set SEZ_VPS_USER --repo "$REPO" --body "ubuntu"
gh variable set SEZ_EXPECTED_HOSTNAME --repo "$REPO" --body "vps-c9f04f5e"
gh variable set SEZ_EXPECTED_MACHINE_ID_SHA256 --repo "$REPO" --body "cd189817b39fea60d338b73878240a6fe7db71374c7a0f35ad60f8eb641e8817"
gh variable set SEZ_GATEWAY_USER --repo "$REPO" --body "se-z-gateway"
gh variable set SEZ_GATEWAY_UID --repo "$REPO" --body "997"
gh variable set SEZ_GATEWAY_ID --repo "$REPO" --body "stealtheye-sez-gateway"
gh variable set SEZ_EXPECTED_SUBJECT --repo "$REPO" --body "stealtheye-owner"
gh variable set SEZ_AUTHORITY_CLASS --repo "$REPO" --body "unrestricted-owner"
gh variable set SEZ_OAUTH_ISSUER --repo "$REPO" --body "https://se-z.stealtheye.io"
gh variable set SEZ_OAUTH_RESOURCE --repo "$REPO" --body "https://se-z.stealtheye.io/mcp"
gh variable set SEZ_OAUTH_AUDIENCE --repo "$REPO" --body "https://se-z.stealtheye.io/mcp"
gh variable set SEZ_OAUTH_JWKS_URI --repo "$REPO" --body "https://se-z.stealtheye.io/oauth/jwks.json"

GATEWAY_FP=$(sha256sum "$BOOTSTRAP/gateway-authority-public.pem" | awk '{print $1}')
gh variable set SEZ_OWNER_PRINCIPAL_FINGERPRINT --repo "$REPO" --body "$GATEWAY_FP"

SECRET_COUNT=$(gh secret list --repo "$REPO" --json name -q 'length')
if [ "$SECRET_COUNT" -lt 4 ]; then
  echo "ERROR: expected at least 4 repository secrets, found $SECRET_COUNT" >&2
  gh secret list --repo "$REPO"
  exit 1
fi

gh secret list --repo "$REPO" | awk '{print $1}' | grep -qx 'sez_all_gh_token' || {
  echo "ERROR: sez_all_gh_token secret is missing" >&2
  exit 1
}
gh secret list --repo "$REPO" | awk '{print $1}' | grep -qx 'SEZ_VPS_SSH_PRIVATE_KEY' || exit 1
gh secret list --repo "$REPO" | awk '{print $1}' | grep -qx 'SEZ_GATEWAY_SIGNING_PRIVATE_KEY' || exit 1
gh secret list --repo "$REPO" | awk '{print $1}' | grep -qx 'SEZ_VPS_SSH_KNOWN_HOSTS' || exit 1

echo "Configured secrets and variables for $REPO"
