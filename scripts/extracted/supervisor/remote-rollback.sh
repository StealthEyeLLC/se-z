#!/usr/bin/env bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
# Retired v1 SSH rollback. Standalone v2 uses the reboot-persistent Sez guard.
set -euo pipefail
echo "ERROR: remote rollback is superseded by the standalone Sez deployment guard" >&2
exit 64
