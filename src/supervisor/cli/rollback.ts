#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Retired product-owned rollback entrypoint. */

process.stderr.write(
  'Product-owned rollback is disabled. Use the fixed standalone Sez deployment controller with an exact signed deployment and snapshot identifier.\n',
);
process.exitCode = 64;
