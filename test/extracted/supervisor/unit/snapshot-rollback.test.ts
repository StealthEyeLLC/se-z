// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/snapshot-rollback.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { buildSignedGuardRecord } from '../../../../src/selfhost/controller/contract.js';
import { FixedDeploymentController } from '../../../../src/selfhost/controller/controller.js';
import {
  FilesystemGuardHost,
  type FixedServiceControl,
} from '../../../../src/selfhost/controller/filesystem-host.js';
import { CONTROLLER_RECORD_VERSION, type ExpectedPointers } from '../../../../src/selfhost/controller/types.js';
import { canonicalJson, sha256Hex } from '../../../../src/protocol/canonical/canonical.js';
import {
  generateEd25519KeyPair,
  loadPrivateKey,
  loadPublicKey,
} from '../../../../src/protocol/signatures/signing.js';
import {
  activateSezCandidate,
  activateGatewayCandidate,
} from '../../../../src/releases/deployment/activation.js';
import {
  FIXTURE_EMPTY_EXTENDED_METADATA,
  SnapshotManager,
  mapHostPath,
  type SnapshotObservations,
} from '../../../../src/releases/deployment/snapshot.js';

const digest = (label: string): string => sha256Hex(label);

class FixtureServices implements FixedServiceControl {
  readonly events: string[] = [];
  stopCandidateServices(): void { this.events.push('stop'); }
  recreateRuntimeDirectories(): void { this.events.push('tmpfiles'); }
  validateAndReloadCaddy(): void { this.events.push('caddy'); }
  startKnownGoodServices(): void { this.events.push('start'); }
  verifyKnownGood(): Record<string, unknown> {
    this.events.push('verify');
    return { signedPrivateHealth: true, publicHealth: true, fixture: true };
  }
}

function writeLogical(root: string, path: string, contents: string): void {
  const physical = mapHostPath(root, path);
  mkdirSync(dirname(physical), { recursive: true, mode: 0o700 });
  writeFileSync(physical, contents, { mode: 0o600 });
}

function observations(): SnapshotObservations {
  return {
    machineIdentityDigest: digest('machine'),
    releaseInventoryDigest: digest('releases'),
    serviceInventoryDigest: digest('services'),
    processInventoryDigest: digest('processes'),
    listenerInventoryDigest: digest('listeners'),
    permissionInventoryDigest: digest('permissions'),
    knownGoodHealthDigest: digest('health'),
    publicMetadataDigest: digest('public-metadata'),
    keyFingerprintInventoryDigest: digest('key-fingerprints'),
  };
}

describe('signed snapshot, gateway-first CAS activation, and independent rollback', () => {
  it('restores exact private bytes, metadata, pointers, and fixed service order', () => {
    const root = mkdtempSync(join(tmpdir(), 'se-z-snapshot-'));
    try {
      const hostRoot = join(root, 'host');
      mkdirSync(hostRoot, { mode: 0o700 });
      for (const path of [
        '/opt/se-z/releases/0.1.3',
        '/opt/se-z/releases/0.1.2',
        '/opt/se-z/releases/0.3.0',
        '/opt/se-z/gateway/releases/0.1.0',
        '/opt/se-z/gateway/releases/0.3.0',
      ]) mkdirSync(mapHostPath(hostRoot, path), { recursive: true });
      mkdirSync(mapHostPath(hostRoot, '/opt/se-z'), { recursive: true });
      mkdirSync(mapHostPath(hostRoot, '/opt/se-z/gateway'), { recursive: true });
      symlinkSync('/opt/se-z/releases/0.1.3', mapHostPath(hostRoot, '/opt/se-z/current'));
      symlinkSync('/opt/se-z/releases/0.1.2', mapHostPath(hostRoot, '/opt/se-z/previous'));
      symlinkSync('/opt/se-z/gateway/releases/0.1.0', mapHostPath(hostRoot, '/opt/se-z/gateway/current'));

      writeLogical(hostRoot, '/etc/systemd/system/se-z.service', 'known-good sez unit\n');
      writeLogical(hostRoot, '/etc/systemd/system/se-z.socket', 'known-good sez socket\n');
      writeLogical(hostRoot, '/etc/systemd/system/se-z-gateway.service', 'known-good gateway unit\n');
      writeLogical(hostRoot, '/etc/tmpfiles.d/se-z.conf', 'known-good sez tmpfiles\n');
      writeLogical(hostRoot, '/etc/tmpfiles.d/se-z-gateway.conf', 'known-good gateway tmpfiles\n');
      writeLogical(hostRoot, '/etc/se-z/runtime.json', '{"release":"0.1.3"}\n');
      writeLogical(hostRoot, '/etc/se-z/supervisor-receipt-private.pem', 'PRIVATE_FIXTURE_BYTES\n');
      writeLogical(hostRoot, '/etc/se-z-gateway/environment', 'GITHUB_CLIENT_SECRET_FILE=/run/credentials/github\n');
      writeLogical(hostRoot, '/var/lib/se-z/deployment-state.sqlite', 'fixture sqlite bytes\n');
      writeLogical(hostRoot, '/var/lib/se-z-gateway/oauth-state.json', 'OAUTH_PRIVATE_FIXTURE_BYTES\n');
      writeLogical(hostRoot, '/etc/caddy/Caddyfile', 'known-good caddy\n');
      writeLogical(hostRoot, '/etc/caddy/sites-enabled/se-z-gateway.Caddyfile', 'known-good site\n');

      const keyRoot = join(root, 'keys');
      const sezPublicPath = join(keyRoot, 'sez-public.pem');
      const sezPrivatePath = join(keyRoot, 'sez-private.pem');
      const evidencePublicPath = join(keyRoot, 'evidence-public.pem');
      const evidencePrivatePath = join(keyRoot, 'evidence-private.pem');
      generateEd25519KeyPair({
        publicKeyPath: sezPublicPath,
        privateKeyPath: sezPrivatePath,
        keyId: 'sez-deployment-authority-v2',
      });
      generateEd25519KeyPair({
        publicKeyPath: evidencePublicPath,
        privateKeyPath: evidencePrivatePath,
        keyId: 'controller-evidence-v2',
      });
      const sezPrivate = loadPrivateKey(sezPrivatePath);
      const sezPublic = loadPublicKey(sezPublicPath);
      const evidencePrivate = loadPrivateKey(evidencePrivatePath);
      const evidencePublic = loadPublicKey(evidencePublicPath);
      const machineId = 'fixture-machine:snapshot-v2';
      const snapshots = new SnapshotManager({
        hostRoot,
        recoveryRoot: join(root, 'recovery'),
        machineId,
        snapshotPrivateKey: sezPrivate,
        snapshotPublicKey: sezPublic,
        signingKeyId: 'sez-deployment-authority-v2',
        extendedMetadata: FIXTURE_EMPTY_EXTENDED_METADATA,
      });
      const snapshot = snapshots.capture({
        deploymentId: 'deployment:snapshot-v2',
        generation: 1,
        capturedAt: '2026-07-22T17:00:00.000Z',
        observations: observations(),
      });
      const redacted = readFileSync(
        join(root, 'recovery', snapshot.snapshotDigest, 'redacted-evidence.json'),
        'utf8',
      );
      assert.doesNotMatch(redacted, /PRIVATE_FIXTURE_BYTES|OAUTH_PRIVATE_FIXTURE_BYTES/u);
      assert.match(redacted, /privatePayloadReference/u);

      const expectedPointers: ExpectedPointers = {
        sez: {
          current: { link: '/opt/se-z/current', target: '/opt/se-z/releases/0.1.3' },
          previous: { link: '/opt/se-z/previous', target: '/opt/se-z/releases/0.1.2' },
        },
        gateway: {
          current: { link: '/opt/se-z/gateway/current', target: '/opt/se-z/gateway/releases/0.1.0' },
          previous: { link: '/opt/se-z/gateway/previous', target: null },
        },
      };
      const guard = buildSignedGuardRecord({
        recordVersion: CONTROLLER_RECORD_VERSION,
        recordType: 'se-z-deployment-guard',
        deploymentId: snapshot.deploymentId,
        generation: snapshot.generation,
        machineId,
        planDigest: digest('plan'),
        snapshotDigest: snapshot.snapshotDigest,
        candidateManifestDigests: { sez: digest('sez-manifest'), gateway: digest('gateway-manifest') },
        candidatePointerTargets: {
          sez: '/opt/se-z/releases/0.3.0',
          gateway: '/opt/se-z/gateway/releases/0.3.0',
        },
        expectedPointers,
        deadline: '2026-07-22T18:00:00.000Z',
        evidenceDigest: digest('acceptance-evidence'),
        signingKeyId: 'sez-deployment-authority-v2',
        signatureAlgorithm: 'ed25519',
      }, sezPrivate);
      const services = new FixtureServices();
      const host = new FilesystemGuardHost({ hostRoot, machineId, snapshots, services });
      let now = new Date('2026-07-22T17:10:00.000Z');
      const controller = new FixedDeploymentController({
        root: join(root, 'controller-state'),
        lockPath: join(root, 'run', 'deploy.lock'),
        machineId,
        sezAuthorityPublicKey: sezPublic,
        controllerEvidencePrivateKey: evidencePrivate,
        controllerEvidencePublicKey: evidencePublic,
        controllerSigningKeyId: 'controller-evidence-v2',
        host,
        now: () => new Date(now),
      });
      const armed = controller.arm(guard);
      assert.equal(armed.disposition, 'armed');

      const gateway = activateGatewayCandidate({ hostRoot, guard, guardStatus: armed });
      assert.equal(gateway.currentTarget, guard.candidatePointerTargets.gateway);
      assert.throws(() => activateSezCandidate({
        hostRoot,
        guard,
        guardStatus: armed,
        gatewayAcceptedLegacy: false,
      }));
      const sez = activateSezCandidate({
        hostRoot,
        guard,
        guardStatus: armed,
        gatewayAcceptedLegacy: true,
      });
      assert.equal(sez.currentTarget, guard.candidatePointerTargets.sez);

      writeLogical(hostRoot, '/etc/se-z/runtime.json', '{"release":"candidate"}\n');
      writeLogical(hostRoot, '/var/lib/se-z-gateway/oauth-state.json', 'candidate oauth bytes\n');
      writeLogical(hostRoot, '/etc/caddy/Caddyfile', 'candidate caddy\n');
      writeLogical(hostRoot, '/etc/se-z/candidate-only', 'must be removed\n');

      now = new Date('2026-07-22T18:00:01.000Z');
      const rolledBack = controller.evaluate(guard.deploymentId);
      assert.equal(rolledBack.disposition, 'rolled_back');
      assert.deepEqual(services.events, ['stop', 'tmpfiles', 'caddy', 'start', 'verify']);
      assert.equal(
        readFileSync(mapHostPath(hostRoot, '/etc/se-z/runtime.json'), 'utf8'),
        '{"release":"0.1.3"}\n',
      );
      assert.equal(
        readFileSync(mapHostPath(hostRoot, '/etc/se-z/supervisor-receipt-private.pem'), 'utf8'),
        'PRIVATE_FIXTURE_BYTES\n',
      );
      assert.equal(
        readFileSync(mapHostPath(hostRoot, '/var/lib/se-z-gateway/oauth-state.json'), 'utf8'),
        'OAUTH_PRIVATE_FIXTURE_BYTES\n',
      );
      assert.equal(readFileSync(mapHostPath(hostRoot, '/etc/caddy/Caddyfile'), 'utf8'), 'known-good caddy\n');
      assert.equal(existsSync(mapHostPath(hostRoot, '/etc/se-z/candidate-only')), false);
      assert.equal(readlinkSync(mapHostPath(hostRoot, '/opt/se-z/current')), expectedPointers.sez.current.target);
      assert.equal(readlinkSync(mapHostPath(hostRoot, '/opt/se-z/previous')), expectedPointers.sez.previous.target);
      assert.equal(readlinkSync(mapHostPath(hostRoot, '/opt/se-z/gateway/current')), expectedPointers.gateway.current.target);
      assert.equal(existsSync(mapHostPath(hostRoot, '/opt/se-z/gateway/previous')), false);
      assert.ok(rolledBack.evidence);
      assert.doesNotMatch(canonicalJson(rolledBack.evidence), /PRIVATE_FIXTURE_BYTES|OAUTH_PRIVATE_FIXTURE_BYTES/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a private recovery payload is corrupt', () => {
    const root = mkdtempSync(join(tmpdir(), 'se-z-snapshot-corrupt-'));
    try {
      const hostRoot = join(root, 'host');
      mkdirSync(hostRoot, { recursive: true });
      writeLogical(hostRoot, '/etc/se-z/runtime.json', 'known-good\n');
      const publicPath = join(root, 'public.pem');
      const privatePath = join(root, 'private.pem');
      generateEd25519KeyPair({ publicKeyPath: publicPath, privateKeyPath: privatePath, keyId: 'snapshot' });
      const snapshots = new SnapshotManager({
        hostRoot,
        recoveryRoot: join(root, 'recovery'),
        machineId: 'fixture-machine:corrupt',
        snapshotPrivateKey: loadPrivateKey(privatePath),
        snapshotPublicKey: loadPublicKey(publicPath),
        signingKeyId: 'snapshot',
        extendedMetadata: FIXTURE_EMPTY_EXTENDED_METADATA,
      });
      const snapshot = snapshots.capture({
        deploymentId: 'deployment:corrupt',
        generation: 1,
        capturedAt: '2026-07-22T17:00:00.000Z',
        observations: observations(),
      });
      const entry = snapshot.entries.find((item) => item.path === '/etc/se-z/runtime.json');
      assert.ok(entry?.payloadReference);
      const blobDigest = entry.payloadReference.split(':').at(-1)!;
      writeFileSync(join(root, 'recovery', snapshot.snapshotDigest, 'payload', `${blobDigest}.blob`), 'corrupt');
      assert.throws(
        () => snapshots.restoreNonPointerTargets(snapshot.snapshotDigest, ['/etc/se-z']),
        /payload digest mismatch/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
