// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:acceptance/release.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateEd25519KeyPair,
  loadPrivateKey,
  loadPublicKey,
} from '../../../../src/protocol/signatures/signing.js';
import {
  buildSignedReleaseManifest,
  verifySignedReleaseManifest,
  type CandidateBuildRecord,
} from '../../../../src/releases/release-manifest.js';

describe('acceptance: reproducible release builds', () => {
  it('produces, compares, signs, and verifies two byte-identical exact-source builds', { timeout: 300_000 }, () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const commit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
    const tree = execSync('git rev-parse HEAD^{tree}', { cwd: root, encoding: 'utf8' }).trim();
    const releaseWrapper = readFileSync(join(root, 'scripts/extracted/supervisor/release.sh'), 'utf8');
    assert.match(
      releaseWrapper,
      /npm ci --include=dev/u,
      'release wrapper must install build-time dependencies under production npm defaults',
    );
    const bundleBuilder = readFileSync(join(root, 'scripts/extracted/supervisor/build-bundle.sh'), 'utf8');
    assert.match(
      bundleBuilder,
      /npm ci --omit=dev .*--bin-links=false/u,
      'bundle builder must disable npm bin symlinks without relying on ambient npm configuration',
    );
    const workspace = mkdtempSync(join(tmpdir(), 'bq-repro-'));
    const buildA = join(workspace, 'build-a');
    const buildB = join(workspace, 'build-b');
    const outputA = join(workspace, 'output-a');
    const outputB = join(workspace, 'output-b');
    for (const path of [buildA, buildB, outputA, outputB]) mkdirSync(path);
    const version = '0.1.0-repro-test';
    const baseEnv = {
      ...process.env,
      SEZ_SOURCE_COMMIT: commit,
      SEZ_SOURCE_TREE: tree,
      SEZ_ALLOW_FIXTURE_VERSION: '1',
      LC_ALL: 'C.UTF-8',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
    };

    try {
      execFileSync('bash', ['scripts/extracted/supervisor/build-bundle.sh', version], {
        cwd: root,
        env: {
          ...baseEnv,
          SEZ_BUILD_ROOT: buildA,
          SEZ_OUTPUT_DIR: outputA,
        },
        stdio: 'pipe',
      });
      execFileSync('bash', ['scripts/extracted/supervisor/build-bundle.sh', version], {
        cwd: root,
        env: {
          ...baseEnv,
          SEZ_BUILD_ROOT: buildB,
          SEZ_OUTPUT_DIR: outputB,
        },
        stdio: 'pipe',
      });
      const archiveName = `se-z-${version}.tar.gz`;
      const buildName = `se-z-${version}.build.json`;
      const archiveA = readFileSync(join(outputA, archiveName));
      const archiveB = readFileSync(join(outputB, archiveName));
      assert.deepEqual(archiveA, archiveB);
      const first = JSON.parse(readFileSync(join(outputA, buildName), 'utf8')) as CandidateBuildRecord;
      const second = JSON.parse(readFileSync(join(outputB, buildName), 'utf8')) as CandidateBuildRecord;
      assert.deepEqual(first, second);
      assert.equal(first.commit, commit);
      assert.equal(first.tree, tree);
      assert.equal(first.nativeAddon?.path, 'lib/build/Release/peer_cred.node');

      const privateKeyPath = join(workspace, 'release-private.pem');
      const publicKeyPath = join(workspace, 'release-public.pem');
      generateEd25519KeyPair({
        privateKeyPath,
        publicKeyPath,
        keyId: 'acceptance-release-key',
      });
      const manifest = buildSignedReleaseManifest({
        first,
        second,
        signingKeyId: 'acceptance-release-key',
        privateKey: loadPrivateKey(privateKeyPath),
      });
      assert.equal(verifySignedReleaseManifest(manifest, loadPublicKey(publicKeyPath)), true);

      const verified = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/extracted/supervisor/verify-candidate.ts',
          '--archive',
          join(outputA, archiveName),
          '--build-record',
          join(outputA, buildName),
        ],
        { cwd: root, encoding: 'utf8' },
      );
      assert.match(verified, /"verified":true/u);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
