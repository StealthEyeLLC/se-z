// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/artifacts.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactManager } from '../../../../src/artifacts/manager.js';
import { loadRuntimeConfig } from '../../../../src/supervisor/configuration/config.js';
import { OperationError } from '../../../../src/operations/errors.js';
import { StateStore } from '../../../../src/state/store/store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function makeManager(): { manager: ArtifactManager; root: string; store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), 'se-z-artifacts-'));
  roots.push(root);
  const config = loadRuntimeConfig({ stateRoot: join(root, 'state'), configRoot: join(root, 'config') });
  const store = new StateStore(config);
  return { manager: new ArtifactManager(store), root, store };
}

describe('artifact manager', () => {
  it('creates finalized digest-addressed immutable artifacts from files', () => {
    const { manager, root } = makeManager();
    const source = join(root, 'source.txt');
    writeFileSync(source, 'alpha');
    const record = manager.createFromFile({ name: 'source.txt', sourcePath: source });
    assert.equal(record.status, 'finalized');
    assert.equal(record.sha256, sha256('alpha'));
    assert.equal(basename(record.path), record.sha256);
    assert.equal(readFileSync(record.path, 'utf8'), 'alpha');
    assert.throws(
      () => manager.uploadChunk({ artifactId: record.artifactId, offset: 5, data: 'IQ==' }),
      (error: unknown) => error instanceof OperationError && error.code === 'artifact_immutable',
    );
  });

  it('rejects file capture above the configured bound before object persistence', () => {
    const { root, store } = makeManager();
    const manager = new ArtifactManager(store, 4);
    const source = join(root, 'oversized.bin');
    writeFileSync(source, '12345');
    assert.throws(
      () => manager.createFromFile({ name: 'oversized.bin', sourcePath: source }),
      (error: unknown) => error instanceof OperationError && error.code === 'artifact_too_large',
    );
    assert.equal(readdirSync(join(store.artifactsDir(), 'sha256')).length, 0);
  });

  it('uploads contiguous chunks and finalizes only with matching size and digest', () => {
    const { manager } = makeManager();
    const expected = 'hello world';
    const upload = manager.beginUpload({
      name: 'hello.txt',
      expectedSize: Buffer.byteLength(expected),
      expectedSha256: sha256(expected),
    });
    assert.equal(upload.status, 'uploading');
    const first = manager.uploadChunk({
      artifactId: upload.artifactId,
      offset: 0,
      data: Buffer.from('hello ').toString('base64'),
    });
    assert.equal(first.size, 6);
    assert.throws(
      () => manager.uploadChunk({
        artifactId: upload.artifactId,
        offset: 2,
        data: Buffer.from('bad').toString('base64'),
      }),
      (error: unknown) =>
        error instanceof OperationError && error.code === 'artifact_offset_mismatch',
    );
    manager.uploadChunk({
      artifactId: upload.artifactId,
      offset: 6,
      data: Buffer.from('world').toString('base64'),
    });
    assert.throws(
      () => manager.finalize({
        artifactId: upload.artifactId,
        expectedSize: expected.length,
        expectedSha256: '0'.repeat(64),
      }),
      (error: unknown) =>
        error instanceof OperationError && error.code === 'artifact_digest_mismatch',
    );
    const finalized = manager.finalize({
      artifactId: upload.artifactId,
      expectedSize: expected.length,
      expectedSha256: sha256(expected),
    });
    assert.equal(finalized.status, 'finalized');
    assert.equal(finalized.sha256, sha256(expected));
    assert.equal(basename(finalized.path), finalized.sha256);
    assert.equal(readFileSync(finalized.path, 'utf8'), expected);
    const downloaded = manager.download({ artifactId: finalized.artifactId, offset: 6 });
    assert.equal(Buffer.from(downloaded.data, 'base64').toString('utf8'), 'world');
    assert.equal(downloaded.eof, true);
    assert.throws(
      () => manager.finalize({
        artifactId: finalized.artifactId,
        expectedSize: expected.length,
        expectedSha256: sha256(expected),
      }),
      (error: unknown) => error instanceof OperationError && error.code === 'artifact_immutable',
    );
  });

  it('supports legacy finalize flag without permitting later mutation', () => {
    const { manager } = makeManager();
    const upload = manager.beginUpload({ name: 'legacy.bin' });
    const finalized = manager.uploadChunk({
      artifactId: upload.artifactId,
      offset: 0,
      data: Buffer.from('legacy').toString('base64'),
      finalize: true,
    });
    assert.equal(finalized.status, 'finalized');
    assert.throws(
      () => manager.uploadChunk({
        artifactId: finalized.artifactId,
        offset: finalized.size,
        data: Buffer.from('!').toString('base64'),
      }),
      (error: unknown) => error instanceof OperationError && error.code === 'artifact_immutable',
    );
  });

  it('aborts and removes incomplete uploads', () => {
    const { manager } = makeManager();
    const upload = manager.beginUpload({ name: 'abort.bin' });
    const uploadPath = upload.path;
    manager.uploadChunk({
      artifactId: upload.artifactId,
      offset: 0,
      data: Buffer.from('partial').toString('base64'),
    });
    const aborted = manager.abort({ artifactId: upload.artifactId });
    assert.equal(aborted.status, 'aborted');
    assert.equal(aborted.path, '');
    assert.equal(existsSync(uploadPath), false);
    assert.throws(
      () => manager.download({ artifactId: upload.artifactId }),
      (error: unknown) => error instanceof OperationError && error.code === 'artifact_not_finalized',
    );
  });

  it('deduplicates identical finalized object bytes by digest', () => {
    const { manager, root } = makeManager();
    const sourceA = join(root, 'a');
    const sourceB = join(root, 'b');
    writeFileSync(sourceA, 'same');
    writeFileSync(sourceB, 'same');
    const a = manager.createFromFile({ name: 'a', sourcePath: sourceA });
    const b = manager.createFromFile({ name: 'b', sourcePath: sourceB });
    assert.notEqual(a.artifactId, b.artifactId);
    assert.equal(a.path, b.path);
    assert.equal(a.sha256, b.sha256);
  });

  it('migrates legacy manifest records as finalized', () => {
    const { root, store } = makeManager();
    const legacyPath = join(store.artifactsDir(), 'legacy.blob');
    writeFileSync(legacyPath, 'legacy');
    writeFileSync(
      join(store.artifactsDir(), 'manifest.json'),
      JSON.stringify([
        {
          artifactId: 'legacy-id',
          name: 'legacy',
          sha256: sha256('legacy'),
          size: 6,
          createdAt: '2026-01-01T00:00:00.000Z',
          path: legacyPath,
        },
      ]),
    );
    const manager = new ArtifactManager(store);
    const record = manager.get('legacy-id')!;
    assert.equal(record.status, 'finalized');
    assert.equal(record.finalizedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(manager.download({ artifactId: 'legacy-id' }).size, 6);
    assert.equal(root.length > 0, true);
  });

  it('leaves no manifest temporary files', () => {
    const { manager, store } = makeManager();
    manager.beginUpload({ name: 'temp-check' });
    assert.equal(
      readdirSync(store.artifactsDir()).some((name) => name.startsWith('manifest.json.tmp-')),
      false,
    );
  });
});
