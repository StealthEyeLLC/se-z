// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/deployment-operations.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntimeConfig } from '../../../../src/supervisor/configuration/config.js';
import { sha256Hex } from '../../../../src/protocol/canonical/canonical.js';
import { StandaloneDeploymentService } from '../../../../src/releases/deployment/service.js';
import { OperationError } from '../../../../src/operations/errors.js';

const roots: string[] = [];
const { privateKey } = generateKeyPairSync('ed25519');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(stopAfterState?: 'guard_armed') {
  const root = mkdtempSync(join(tmpdir(), 'bq-release-ops-'));
  roots.push(root);
  const config = loadRuntimeConfig({ stateRoot: join(root, 'state'), configRoot: join(root, 'config') });
  return {
    config,
    service: new StandaloneDeploymentService(config, {
      signingKey: privateKey,
      signingKeyId: 'fixture-evidence-key-v2',
      fixtureMode: true,
      ...(stopAfterState ? { stopAfterState } : {}),
    }),
  };
}

function buildPayload(deploymentId: string, generation: number) {
  return {
    deploymentId,
    generation,
    planDigest: sha256Hex(`plan:${deploymentId}`),
    deadline: new Date(Date.now() + 60_000).toISOString(),
    sources: {
      sez: { commit: 'd'.repeat(40), tree: '2'.repeat(40) },
      gateway: { commit: '9'.repeat(40), tree: '5'.repeat(40) },
    },
  };
}

async function buildAndStage(service: StandaloneDeploymentService, id: string, generation: number) {
  const built = await service.execute('sez.release.build', `${id}:build`, buildPayload(id, generation)) as { stateSequence: number };
  assert.equal(built.stateSequence, 7);
  return service.execute('sez.release.stage', `${id}:stage`, {
    deploymentId: id,
    expectedSequence: built.stateSequence,
  }) as Promise<{ state: string; stateSequence: number }>;
}

describe('standalone public deployment operations', () => {
  it('cycle 1 reaches signed success and exposes bounded source and evidence readback', async () => {
    const { service } = fixture();
    const staged = await buildAndStage(service, 'cycle-success-001', 1);
    assert.equal(staged.state, 'ready_to_activate');
    const source = await service.execute('sez.selfhost.source.get', 'cycle-success-source', {
      deploymentId: 'cycle-success-001', product: 'se-z',
    }) as { commit: string; clean: boolean };
    assert.equal(source.commit, 'd'.repeat(40));
    assert.equal(source.clean, true);
    await service.execute('sez.selfhost.acceptance.run', 'cycle-success-acceptance', {
      deploymentId: 'cycle-success-001', profile: 'preactivation',
    });
    const activated = await service.execute('sez.release.activate', 'cycle-success-activate', {
      deploymentId: 'cycle-success-001', expectedSequence: staged.stateSequence,
      confirmationDigest: sha256Hex('confirmed'),
    }) as { state: string; terminal: boolean; evidence: unknown[] };
    assert.equal(activated.state, 'succeeded');
    assert.equal(activated.terminal, true);
    assert.ok(activated.evidence.length >= 28);
    const verified = await service.execute('sez.release.verify', 'cycle-success-verify', {
      deploymentId: 'cycle-success-001',
    }) as { verification: { status: string; verificationDigest: string } };
    assert.equal(verified.verification.status, 'verified');
    assert.match(verified.verification.verificationDigest, /^[a-f0-9]{64}$/u);
    service.close();
  });

  it('cycle 2 persists caller loss after guard arm and a restarted service rolls back', async () => {
    const { config, service } = fixture('guard_armed');
    const staged = await buildAndStage(service, 'cycle-rollback-002', 2);
    const interrupted = await service.execute('sez.release.activate', 'cycle-rollback-activate', {
      deploymentId: 'cycle-rollback-002', expectedSequence: staged.stateSequence,
      confirmationDigest: sha256Hex('confirmed'),
    }) as { state: string; terminal: boolean };
    assert.equal(interrupted.state, 'guard_armed');
    assert.equal(interrupted.terminal, false);
    service.close();
    const restarted = new StandaloneDeploymentService(config, {
      signingKey: privateKey, signingKeyId: 'fixture-evidence-key-v2', fixtureMode: true,
    });
    const rolledBack = await restarted.execute('sez.release.rollback', 'cycle-rollback-request', {
      deploymentId: 'cycle-rollback-002', reason: 'caller disappeared after guard arm',
    }) as { state: string; terminal: boolean };
    assert.equal(rolledBack.state, 'rolled_back');
    assert.equal(rolledBack.terminal, true);
    restarted.close();
  });

  it('cycle 3 resumes from the durable build across restart and reaches success', async () => {
    const { config, service } = fixture();
    const built = await service.execute('sez.release.build', 'cycle-reboot-build', buildPayload('cycle-reboot-003', 3)) as { stateSequence: number };
    service.close();
    const restarted = new StandaloneDeploymentService(config, {
      signingKey: privateKey, signingKeyId: 'fixture-evidence-key-v2', fixtureMode: true,
    });
    const staged = await restarted.execute('sez.release.stage', 'cycle-reboot-stage', {
      deploymentId: 'cycle-reboot-003', expectedSequence: built.stateSequence,
    }) as { stateSequence: number };
    const activated = await restarted.execute('sez.release.activate', 'cycle-reboot-activate', {
      deploymentId: 'cycle-reboot-003', expectedSequence: staged.stateSequence,
      confirmationDigest: sha256Hex('confirmed'),
    }) as { state: string };
    assert.equal(activated.state, 'succeeded');
    restarted.close();
  });

  it('refuses active release mutation outside the isolated fixture/controller boundary', async () => {
    const { config, service } = fixture();
    service.close();
    const unavailable = new StandaloneDeploymentService(config, {
      signingKey: privateKey, signingKeyId: 'fixture-evidence-key-v2', fixtureMode: false,
    });
    await assert.rejects(
      unavailable.execute('sez.release.build', 'production-refusal-001', buildPayload('refused-004', 4)),
      (error: unknown) => error instanceof OperationError && error.code === 'resource_unavailable',
    );
    unavailable.close();
  });
});
