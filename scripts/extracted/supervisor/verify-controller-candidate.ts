#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Strictly extract and verify one fixed-controller candidate package. */

import { loadControllerBuildRecord, verifyControllerCandidate } from '../../../src/selfhost/controller/package.js';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const result = await verifyControllerCandidate({
  archivePath: option('--archive'),
  buildRecord: loadControllerBuildRecord(option('--build-record')),
});
process.stdout.write(`${JSON.stringify({ verified: true, product: 'se-z-controller', ...result })}\n`);
