// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/safe-extract.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeExtractTarGz } from '../../../../src/selfhost/install/safe-extract.js';
import { PINNED_NODE_VERSION, type ExtractableReleaseManifest } from '../../../../src/releases/archive-contract.js';
import { createDeterministicTarGz } from '../../../../src/releases/deterministic-archive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('safe archive extraction compatibility wrapper', () => {
  it('installs one strictly verified create-once inactive target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bq-safe-wrapper-'));
    roots.push(root);
    const source = join(root, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'hello.txt'), 'hello');
    const archivePath = join(root, 'candidate.tar.gz');
    const archive = await createDeterministicTarGz({
      releaseRoot: source,
      topLevelPrefix: 'se-z-0.3.0-fixture',
      archivePath,
      sourceDateEpoch: 1_700_000_000,
    });
    const manifest: ExtractableReleaseManifest = {
      schemaVersion: '2.0.0',
      product: 'se-z',
      repository: 'StealthEyeLLC/se-z',
      releaseVersion: '0.3.0-fixture',
      sourceDateEpoch: 1_700_000_000,
      nodeVersion: PINNED_NODE_VERSION,
      archive: archive.archive,
      files: archive.files,
    };
    const destination = join(root, 'releases', '0.3.0-fixture');
    mkdirSync(join(root, 'releases'));
    await safeExtractTarGz(
      archivePath,
      destination,
      'se-z-0.3.0-fixture',
      { manifest },
    );
    assert.equal(readFileSync(join(destination, 'hello.txt'), 'utf8'), 'hello');
    await assert.rejects(
      safeExtractTarGz(
        archivePath,
        destination,
        'se-z-0.3.0-fixture',
        { manifest },
      ),
      /already exists/u,
    );
    assert.equal(existsSync(destination), true);
  });
});
