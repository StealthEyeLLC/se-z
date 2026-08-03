// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { OPERATION_DEFINITIONS } from '../operations/definitions.js';
import { loadPackageSetFromPath } from './loader.js';

async function main(): Promise<void> {
  const setPath = process.argv[2];
  if (!setPath) throw new Error('package-set path is required');
  const releaseRoot = process.argv[3];
  const started = Date.now();
  const loaded = await loadPackageSetFromPath(setPath, OPERATION_DEFINITIONS, releaseRoot);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    setDigest: loaded.setDigest,
    catalogDigest: loaded.catalogDigest,
    skillCount: loaded.skills.length,
    operationCount: loaded.definitions.length,
    operations: loaded.definitions.map((item) => item.operation),
    durationMs: Date.now() - started,
  })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : 'candidate preload failed',
  })}\n`);
  process.exit(1);
});
