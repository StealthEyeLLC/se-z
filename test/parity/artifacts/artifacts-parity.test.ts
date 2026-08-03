import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { sourceSupervisor, target } from '../helpers/index.js';

function digest(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function captureError(action: () => unknown): { code?: string; message: string } {
  try { action(); return { message: '<NO_ERROR>' }; }
  catch (error: any) { return { code: error.code, message: String(error.message) }; }
}
function record(record: any) {
  return {
    name: record.name, status: record.status, sha256: record.sha256, size: record.size,
    expectedSize: record.expectedSize ?? null, expectedSha256: record.expectedSha256 ?? null,
    finalBasename: record.path ? (record.status === 'uploading' ? '<UPLOAD>.upload' : basename(record.path)) : '', pathPresent: Boolean(record.path),
  };
}

async function runArtifactScenario(kind: 'source' | 'target') {
  const [artifactModule, configModule, stateModule] = kind === 'source'
    ? await Promise.all([sourceSupervisor('src/artifacts/manager.ts'), sourceSupervisor('src/config.ts'), sourceSupervisor('src/state/store.ts')])
    : await Promise.all([target('src/artifacts/manager.ts'), target('src/supervisor/configuration/config.ts'), target('src/state/store/store.ts')]);
  const root = mkdtempSync(join(tmpdir(), `sez-parity-${kind}-artifacts-`));
  const config = configModule.loadRuntimeConfig({ stateRoot: join(root, 'state'), configRoot: join(root, 'config') });
  const store = new stateModule.StateStore(config);
  const manager = new artifactModule.ArtifactManager(store);
  try {
    const sourcePath = join(root, 'source.bin');
    const sourceBytes = Buffer.from([0, 1, 2, 127, 128, 255]);
    writeFileSync(sourcePath, sourceBytes);
    const fromFile = manager.createFromFile({ name: 'source.bin', sourcePath });
    const immutableCreateError = captureError(() => manager.uploadChunk({ artifactId: fromFile.artifactId, offset: sourceBytes.length, data: 'AA==' }));

    const expected = Buffer.from('hello\u0000world\u00ff', 'latin1');
    const upload = manager.beginUpload({ name: 'upload.bin', expectedSize: expected.length, expectedSha256: digest(expected) });
    const first = manager.uploadChunk({ artifactId: upload.artifactId, offset: 0, data: expected.subarray(0, 5).toString('base64') });
    const offsetError = captureError(() => manager.uploadChunk({ artifactId: upload.artifactId, offset: 2, data: 'YmFk' }));
    const resumed = manager.uploadChunk({ artifactId: upload.artifactId, offset: 5, data: expected.subarray(5).toString('base64') });
    const corruptionError = captureError(() => manager.finalize({ artifactId: upload.artifactId, expectedSize: expected.length, expectedSha256: '0'.repeat(64) }));
    const finalized = manager.finalize({ artifactId: upload.artifactId, expectedSize: expected.length, expectedSha256: digest(expected) });
    const stripDownloadId = ({ artifactId: _artifactId, ...result }: any) => result;
    const downloadFirst = stripDownloadId(manager.download({ artifactId: finalized.artifactId, offset: 0, limit: 4 }));
    const downloadRepeat = stripDownloadId(manager.download({ artifactId: finalized.artifactId, offset: 0, limit: 4 }));
    const downloadRest = stripDownloadId(manager.download({ artifactId: finalized.artifactId, offset: 4 }));
    const immutableFinalizeError = captureError(() => manager.finalize({ artifactId: finalized.artifactId, expectedSize: expected.length, expectedSha256: digest(expected) }));

    const abortUpload = manager.beginUpload({ name: 'abort.bin' });
    const abortPath = abortUpload.path;
    manager.uploadChunk({ artifactId: abortUpload.artifactId, offset: 0, data: Buffer.from('partial').toString('base64') });
    const aborted = manager.abort({ artifactId: abortUpload.artifactId });
    const abortedDownloadError = captureError(() => manager.download({ artifactId: abortUpload.artifactId }));

    const duplicatePath = join(root, 'duplicate.bin'); writeFileSync(duplicatePath, sourceBytes);
    const duplicate = manager.createFromFile({ name: 'duplicate.bin', sourcePath: duplicatePath });
    const list = manager.list().map(record).sort((a: any, b: any) => a.name.localeCompare(b.name));

    return {
      fromFile: record(fromFile), fromFileBytes: [...readFileSync(fromFile.path)], immutableCreateError,
      upload: record(upload), firstSize: first.size, offsetError, resumedSize: resumed.size, corruptionError,
      finalized: record(finalized), finalizedBytes: [...readFileSync(finalized.path)],
      downloadFirst, downloadRepeat, downloadRest, immutableFinalizeError,
      aborted: record(aborted), abortPathExists: existsSync(abortPath), abortedDownloadError,
      deduplicated: duplicate.path === fromFile.path && duplicate.sha256 === fromFile.sha256,
      list,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('artifact create/upload/resume/finalize/download/list/abort retain immutable digest-addressed behavior', async () => {
  const source = await runArtifactScenario('source');
  const targetResult = await runArtifactScenario('target');
  assert.deepEqual(source, targetResult);
  assert.equal(source.fromFile.status, 'finalized');
  assert.equal(source.fromFile.finalBasename, source.fromFile.sha256);
  assert.equal(source.immutableCreateError.code, 'artifact_immutable');
  assert.equal(source.offsetError.code, 'artifact_offset_mismatch');
  assert.equal(source.corruptionError.code, 'artifact_digest_mismatch');
  assert.deepEqual(source.downloadFirst, source.downloadRepeat);
  assert.equal(Buffer.concat([Buffer.from(source.downloadFirst.data, 'base64'), Buffer.from(source.downloadRest.data, 'base64')]).equals(Buffer.from(source.finalizedBytes)), true);
  assert.equal(source.immutableFinalizeError.code, 'artifact_immutable');
  assert.equal(source.aborted.status, 'aborted');
  assert.equal(source.abortPathExists, false);
  assert.equal(source.abortedDownloadError.code, 'artifact_not_finalized');
  assert.equal(source.deduplicated, true);
});
