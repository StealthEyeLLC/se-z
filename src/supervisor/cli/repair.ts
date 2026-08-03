#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Retired unfenced repair entrypoint. */

process.stderr.write(
  'Unfenced product-owned repair is disabled. Use sez.release.repair through the fixed standalone controller.\n',
);
process.exitCode = 64;
