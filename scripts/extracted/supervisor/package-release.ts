#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** CLI for packaging one prepared Sez or gateway release tree. */

import { resolve } from 'node:path';
import { loadPackageReleaseSpec, packagePreparedRelease } from '../../../src/releases/package-release.js';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return resolve(value);
}

const result = await packagePreparedRelease({
  releaseRoot: option('--release-root'),
  outputDirectory: option('--output-directory'),
  spec: loadPackageReleaseSpec(option('--spec')),
});
console.log(JSON.stringify({
  archiveDigest: result.archive.digest,
  compressedSize: result.archive.compressedSize,
  decompressedSize: result.archive.decompressedSize,
  memberCount: result.archive.memberCount,
}));
