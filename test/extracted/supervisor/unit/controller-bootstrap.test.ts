// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/controller-bootstrap.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { canonicalJson, sha256Hex } from '../../../../src/protocol/canonical/canonical.js';
import {
  generateEd25519KeyPair,
  loadPrivateKey,
  loadPublicKey,
} from '../../../../src/protocol/signatures/signing.js';
import {
  buildSignedControllerRelease,
  ControllerBootstrapManager,
  inventoryControllerCandidate,
  type ControllerReleasePayload,
} from '../../../../src/selfhost/controller/bootstrap.js';
import { CONTROLLER_RECORD_VERSION, ControllerError } from '../../../../src/selfhost/controller/types.js';

function candidate(root: string, label: string): string {
  const path = join(root, label);
  mkdirSync(join(path, 'bin'), { recursive: true });
  mkdirSync(join(path, 'lib'), { recursive: true });
  writeFileSync(join(path, 'bin', 'se-z-deploy-guard'), `#!/bin/sh\n# ${label}\nexit 64\n`);
  chmodSync(join(path, 'bin', 'se-z-deploy-guard'), 0o755);
  writeFileSync(join(path, 'lib', 'controller.js'), `export const release = '${label}';\n`);
  chmodSync(join(path, 'lib', 'controller.js'), 0o644);
  return path;
}

describe('fixed controller bootstrap and A/B upgrade', () => {
  it('installs immutable verified bytes and preserves a known-good fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'se-z-controller-bootstrap-'));
    try {
      const publicPath = join(root, 'authority-public.pem');
      const privatePath = join(root, 'authority-private.pem');
      generateEd25519KeyPair({
        publicKeyPath: publicPath,
        privateKeyPath: privatePath,
        keyId: 'controller-release-authority-v2',
      });
      const privateKey = loadPrivateKey(privatePath);
      const controllerRoot = join(root, 'installed');
      let guardActive = false;
      const manager = new ControllerBootstrapManager({
        root: controllerRoot,
        releaseAuthorityPublicKey: loadPublicKey(publicPath),
        assertNoActiveProductGuard: () => {
          if (guardActive) throw new ControllerError('controller_active_guard_conflict', 'guard active');
        },
      });

      const firstCandidate = candidate(root, 'controller-r1-candidate');
      const firstFiles = inventoryControllerCandidate(firstCandidate);
      const firstPayload: ControllerReleasePayload = {
        recordVersion: CONTROLLER_RECORD_VERSION,
        recordType: 'se-z-controller-release',
        releaseId: 'controller-r1',
        repository: 'StealthEyeLLC/se-z',
        sourceCommit: '1'.repeat(40),
        sourceTree: '2'.repeat(40),
        sourceDateEpoch: 1_784_741_000,
        archiveDigest: sha256Hex('archive-r1'),
        nodeVersion: '24.18.0',
        buildCommandDigest: sha256Hex('build-controller'),
        candidateDigest: sha256Hex(canonicalJson(firstFiles)),
        files: firstFiles,
        targetSlot: 'a',
        expectedCurrentReleaseId: null,
        fallbackReleaseId: null,
        signingKeyId: 'controller-release-authority-v2',
        signatureAlgorithm: 'ed25519',
      };
      const first = buildSignedControllerRelease(firstPayload, privateKey);
      const installedFirst = manager.install('controller_bootstrap', first, firstCandidate);
      assert.equal(installedFirst.previous, null);
      assert.equal(readlinkSync(join(controllerRoot, 'current')), installedFirst.current);
      assert.equal(readlinkSync(join(controllerRoot, 'slots', 'a')), installedFirst.current);
      assert.equal(
        readFileSync(join(installedFirst.current, 'lib', 'controller.js'), 'utf8'),
        "export const release = 'controller-r1-candidate';\n",
      );
      assert.equal(lstatSync(join(installedFirst.current, 'bin', 'se-z-deploy-guard')).mode & 0o777, 0o755);

      const secondCandidate = candidate(root, 'controller-r2-candidate');
      const secondFiles = inventoryControllerCandidate(secondCandidate);
      const second = buildSignedControllerRelease({
        ...firstPayload,
        releaseId: 'controller-r2',
        sourceCommit: '3'.repeat(40),
        sourceTree: '4'.repeat(40),
        candidateDigest: sha256Hex(canonicalJson(secondFiles)),
        files: secondFiles,
        targetSlot: 'b',
        expectedCurrentReleaseId: 'controller-r1',
        fallbackReleaseId: 'controller-r1',
      }, privateKey);

      assert.throws(
        () => manager.install('product_deployment', second, secondCandidate),
        (error: unknown) => error instanceof ControllerError && error.code === 'controller_invalid_record',
      );
      assert.equal(existsSync(join(controllerRoot, 'releases', 'controller-r2')), false);

      guardActive = true;
      assert.throws(
        () => manager.install('controller_upgrade', second, secondCandidate),
        (error: unknown) => error instanceof ControllerError && error.code === 'controller_active_guard_conflict',
      );
      guardActive = false;

      const installedSecond = manager.install('controller_upgrade', second, secondCandidate);
      assert.equal(readlinkSync(join(controllerRoot, 'current')), installedSecond.current);
      assert.equal(readlinkSync(join(controllerRoot, 'previous')), installedFirst.current);
      assert.equal(readlinkSync(join(controllerRoot, 'slots', 'b')), installedSecond.current);
      assert.equal(existsSync(installedFirst.current), true);
      assert.equal(existsSync(installedSecond.current), true);

      assert.throws(
        () => manager.install('controller_upgrade', second, secondCandidate),
        (error: unknown) => error instanceof ControllerError &&
          ['controller_generation_conflict', 'controller_integrity_failed'].includes(error.code),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects candidate-byte drift before publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'se-z-controller-drift-'));
    try {
      const publicPath = join(root, 'authority-public.pem');
      const privatePath = join(root, 'authority-private.pem');
      generateEd25519KeyPair({
        publicKeyPath: publicPath,
        privateKeyPath: privatePath,
        keyId: 'controller-release-authority-v2',
      });
      const candidateRoot = candidate(root, 'candidate');
      const files = inventoryControllerCandidate(candidateRoot);
      const record = buildSignedControllerRelease({
        recordVersion: CONTROLLER_RECORD_VERSION,
        recordType: 'se-z-controller-release',
        releaseId: 'controller-r1',
        repository: 'StealthEyeLLC/se-z',
        sourceCommit: '5'.repeat(40),
        sourceTree: '6'.repeat(40),
        sourceDateEpoch: 1_784_741_000,
        archiveDigest: sha256Hex('archive-r1'),
        nodeVersion: '24.18.0',
        buildCommandDigest: sha256Hex('build-controller'),
        candidateDigest: sha256Hex(canonicalJson(files)),
        files,
        targetSlot: 'a',
        expectedCurrentReleaseId: null,
        fallbackReleaseId: null,
        signingKeyId: 'controller-release-authority-v2',
        signatureAlgorithm: 'ed25519',
      }, loadPrivateKey(privatePath));
      writeFileSync(join(candidateRoot, 'lib', 'controller.js'), 'tampered\n');
      const manager = new ControllerBootstrapManager({
        root: join(root, 'installed'),
        releaseAuthorityPublicKey: loadPublicKey(publicPath),
        assertNoActiveProductGuard: () => undefined,
      });
      assert.throws(
        () => manager.install('controller_bootstrap', record, candidateRoot),
        (error: unknown) => error instanceof ControllerError && error.code === 'controller_integrity_failed',
      );
      assert.equal(existsSync(join(root, 'installed', 'current')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
