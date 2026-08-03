#!/usr/bin/env python3
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
"""Retired v1 bootstrap entrypoint; v2 uses the fixed Sez controller."""

import sys

print(
    "ERROR: standalone v2 candidates must be verified by the fixed Sez deployment controller",
    file=sys.stderr,
)
raise SystemExit(64)
