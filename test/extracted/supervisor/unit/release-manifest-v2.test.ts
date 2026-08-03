// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/release-manifest-v2.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256Hex } from '../../../../src/protocol/canonical/canonical.js';
import {
  generateEd25519KeyPair,
  loadPrivateKey,
  loadPublicKey,
} from '../../../../src/protocol/signatures/signing.js';
import { packagePreparedRelease } from '../../../../src/releases/package-release.js';
import {
  buildSignedReleaseManifest,
  verifySignedReleaseManifest,
  type PackageReleaseSpec,
} from '../../../../src/releases/release-manifest.js';
import { strictExtractRelease } from '../../../../src/releases/strict-extractor.js';

const roots: string[] = [];
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function workspace(): string {
  const value = mkdtempSync(join(tmpdir(), 'bq-release-manifest-'));
  roots.push(value);
  return value;
}

function stage(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(join(path, 'bin'), { recursive: true });
  mkdirSync(join(path, 'lib', 'build', 'Release'), { recursive: true });
  writeFileSync(join(path, 'bin', 'se-z'), '#!/bin/sh\necho fixture\n', { mode: 0o755 });
  writeFileSync(join(path, 'lib', 'build', 'Release', 'peer_cred.node'), 'fixture-native');
  return path;
}

function spec(): PackageReleaseSpec {
  return {
    schemaVersion: '2.0.0',
    product: 'se-z',
    repository: 'StealthEyeLLC/se-z',
    releaseVersion: '0.3.0-fixture',
    commit: 'd'.repeat(40),
    tree: '2'.repeat(40),
    sourceDateEpoch: 1_700_000_000,
    lockfileDigest: sha256Hex('lock'),
    buildCommandDigest: sha256Hex('build command'),
    environmentIdentity: {
      os: 'linux-fixture',
      architecture: 'x64',
      locale: 'C.UTF-8',
      timezone: 'UTC',
      umask: '0022',
      toolchainDigest: sha256Hex('toolchain'),
    },
    testEvidenceIndexDigest: sha256Hex('tests'),
    compatibilityDigest: sha256Hex('compatibility'),
    stateMigration: {
      supported: true,
      strategy: 'fixture-copy-on-write',
      evidenceDigest: sha256Hex('migration'),
    },
    rollback: {
      supported: true,
      strategy: 'fixture-snapshot-restore',
      evidenceDigest: sha256Hex('rollback'),
    },
    peerCompatibility: {
      minimumRelease: '0.1.0',
      maximumRelease: '0.x',
      protocolVersions: ['1.0.0'],
      receiptVersions: ['1.0.0', '2.0.0'],
      catalogVersions: ['1.0.0', '2.0.0'],
    },
    requiredEntrypoints: ['bin/se-z', 'lib/build/Release/peer_cred.node'],
    sbomPackages: [
      { name: 'se-z', version: '0.3.0-fixture', license: 'UNLICENSED' },
    ],
    nativeAddon: {
      path: 'lib/build/Release/peer_cred.node',
      nodeAbi: '137',
      loadEvidenceDigest: sha256Hex('native load'),
    },
  };
}

describe('signed release manifest v2', () => {
  it('finalizes only byte-identical builds and verifies deterministic Ed25519 bindings', async () => {
    const root = workspace();
    const outputA = join(root, 'out-a');
    const outputB = join(root, 'out-b');
    mkdirSync(outputA);
    mkdirSync(outputB);
    const first = await packagePreparedRelease({
      releaseRoot: stage(root, 'stage-a'),
      outputDirectory: outputA,
      spec: spec(),
    });
    const second = await packagePreparedRelease({
      releaseRoot: stage(root, 'stage-b'),
      outputDirectory: outputB,
      spec: spec(),
    });
    assert.equal(first.archive.digest, second.archive.digest);
    assert.deepEqual(first.buildRecord, second.buildRecord);

    const publicKeyPath = join(root, 'release-public.pem');
    const privateKeyPath = join(root, 'release-private.pem');
    generateEd25519KeyPair({
      publicKeyPath,
      privateKeyPath,
      keyId: 'fixture-release-key',
    });
    const manifest = buildSignedReleaseManifest({
      first: first.buildRecord,
      second: second.buildRecord,
      signingKeyId: 'fixture-release-key',
      privateKey: loadPrivateKey(privateKeyPath),
    });
    assert.equal(manifest.signatureAlgorithm, 'ed25519');
    assert.equal(manifest.reproducibility.byteIdentical, true);
    assert.equal(manifest.reproducibility.firstDigest, manifest.archive.digest);
    assert.equal(verifySignedReleaseManifest(manifest, loadPublicKey(publicKeyPath)), true);
    assert.equal(
      verifySignedReleaseManifest(
        { ...manifest, compatibilityDigest: sha256Hex('changed') },
        loadPublicKey(publicKeyPath),
      ),
      false,
    );

    const extracted = await strictExtractRelease({
      archivePath: join(outputA, 'se-z-0.3.0-fixture.tar.gz'),
      destination: join(root, 'extracted'),
      manifest,
    });
    assert.match(readFileSync(join(extracted.releaseRoot, 'release.json'), 'utf8'), /"tree"/u);
    assert.match(readFileSync(join(extracted.releaseRoot, 'sbom.spdx.json'), 'utf8'), /SPDX-2\.3/u);
  });

  it('blocks release finalization when either isolated build record differs', async () => {
    const root = workspace();
    const outputA = join(root, 'out-a');
    const outputB = join(root, 'out-b');
    mkdirSync(outputA);
    mkdirSync(outputB);
    const first = await packagePreparedRelease({
      releaseRoot: stage(root, 'stage-a'),
      outputDirectory: outputA,
      spec: spec(),
    });
    const second = await packagePreparedRelease({
      releaseRoot: stage(root, 'stage-b'),
      outputDirectory: outputB,
      spec: { ...spec(), testEvidenceIndexDigest: sha256Hex('different tests') },
    });
    const privateKeyPath = join(root, 'private.pem');
    generateEd25519KeyPair({
      publicKeyPath: join(root, 'public.pem'),
      privateKeyPath,
      keyId: 'fixture-release-key',
    });
    assert.throws(
      () =>
        buildSignedReleaseManifest({
          first: first.buildRecord,
          second: second.buildRecord,
          signingKeyId: 'fixture-release-key',
          privateKey: loadPrivateKey(privateKeyPath),
        }),
      /differ/u,
    );
  });
});
