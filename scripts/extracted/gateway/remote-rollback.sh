#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
set -euo pipefail
CURRENT_LINK="${SEZ_GATEWAY_CURRENT_LINK:-/opt/se-z/gateway/current}"
PREVIOUS_LINK="${SEZ_GATEWAY_PREVIOUS_LINK:-/opt/se-z/gateway/previous}"
SERVICE_NAME="${SEZ_GATEWAY_SERVICE_NAME:-se-z-gateway.service}"
CURRENT=$(readlink -f "$CURRENT_LINK")
PREVIOUS=$(readlink -f "$PREVIOUS_LINK")
[ -n "$CURRENT" ] && [ -d "$CURRENT" ]
[ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]
ln -sfn "$PREVIOUS" "$CURRENT_LINK.new"
mv -Tf "$CURRENT_LINK.new" "$CURRENT_LINK"
ln -sfn "$CURRENT" "$PREVIOUS_LINK.new"
mv -Tf "$PREVIOUS_LINK.new" "$PREVIOUS_LINK"
systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME"
printf 'ROLLBACK_CURRENT=%s\nROLLBACK_PREVIOUS=%s\n' "$PREVIOUS" "$CURRENT"
