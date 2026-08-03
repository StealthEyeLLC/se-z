#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Strict inactive-only Sez candidate installer. It never publishes pointers. */

import { readFileSync } from 'node:fs';
import { loadPublicKey } from '../../protocol/signatures/signing.js';
import { installInactiveCandidate } from '../../releases/deployment/inactive-install.js';
import type { SignedReleaseManifest } from '../../releases/release-manifest.js';

const RELEASE_AUTHORITY_PUBLIC_KEY =
  '/etc/se-z/deployment/release-authority-public.pem';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowed = new Set(['--archive', '--manifest']);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]!)) throw new Error(`Unknown inactive install option ${args[index] ?? ''}`);
    if (args[index + 1] === undefined) throw new Error(`Missing value for ${args[index]}`);
  }
  const manifest = JSON.parse(readFileSync(option('--manifest'), 'utf8')) as SignedReleaseManifest;
  const result = await installInactiveCandidate({
    hostRoot: '/',
    product: 'se-z',
    archivePath: option('--archive'),
    manifest,
    releaseAuthorityPublicKey: loadPublicKey(RELEASE_AUTHORITY_PUBLIC_KEY),
  });
  process.stdout.write(`${JSON.stringify({
    action: 'inactive_install',
    pointerMutation: false,
    ...result,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
