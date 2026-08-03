#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Compare two build records and emit one signed final release manifest. */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson } from '../../../src/protocol/canonical/canonical.js';
import { loadPrivateKey } from '../../../src/protocol/signatures/signing.js';
import {
  buildSignedReleaseManifest,
  type CandidateBuildRecord,
} from '../../../src/releases/release-manifest.js';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const first = JSON.parse(readFileSync(resolve(option('--first')), 'utf8')) as CandidateBuildRecord;
const second = JSON.parse(readFileSync(resolve(option('--second')), 'utf8')) as CandidateBuildRecord;
const output = resolve(option('--output'));
const manifest = buildSignedReleaseManifest({
  first,
  second,
  signingKeyId: option('--key-id'),
  privateKey: loadPrivateKey(resolve(option('--private-key'))),
});
writeFileSync(output, `${canonicalJson(manifest)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({
  manifestDigest: manifest.manifestDigest,
  archiveDigest: manifest.archive.digest,
  signingKeyId: manifest.signingKeyId,
}));
