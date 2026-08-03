// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/deployment-database.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '../../../../src/protocol/canonical/canonical.js';
import { DeploymentDatabase } from '../../../../src/releases/deployment/database.js';
import { getTransitionRule } from '../../../../src/releases/deployment/state-machine.js';
import {
  DeploymentError,
  type DeploymentEvidenceRecord,
  type DeploymentProductRecord,
  type DeploymentRequestRecord,
  type DeploymentSourceRecord,
  type DeploymentState,
  type DeploymentTransitionInput,
} from '../../../../src/releases/deployment/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'bq-deployment-db-'));
  roots.push(root);
  return join(root, 'state', 'deployment-state.sqlite');
}

function hash(value: string): string {
  return sha256Hex(value);
}

function request(
  overrides: Partial<DeploymentRequestRecord> = {},
): DeploymentRequestRecord {
  return {
    deploymentId: 'deployment-v2-test-001',
    generation: 42,
    machineId: 'machine-fixture-001',
    planDigest: hash('plan'),
    requestDigest: hash('request'),
    deadline: '2026-07-22T13:00:00.000Z',
    requestedAt: '2026-07-22T12:00:00.000Z',
    requestedBy: 'stealtheye-owner',
    idempotencyKey: 'deployment-request-001',
    ...overrides,
  };
}

function product(
  deploymentId: string,
  name: DeploymentProductRecord['product'],
): DeploymentProductRecord {
  return {
    deploymentId,
    product: name,
    repository: `StealthEyeLLC/${name}`,
    commit: name === 'se-z' ? 'd'.repeat(40) : '9'.repeat(40),
    tree: name === 'se-z' ? '2'.repeat(40) : '5'.repeat(40),
    manifestDigest: hash(`${name}:manifest`),
    artifactDigest: hash(`${name}:artifact`),
    compatibilityDigest: hash('compatibility'),
  };
}

function sources(deploymentId: string): DeploymentSourceRecord[] {
  return (['se-z', 'se-z-gateway'] as const).map((name) => ({
    deploymentId,
    product: name,
    repository: `StealthEyeLLC/${name}`,
    commit: name === 'se-z' ? 'd'.repeat(40) : '9'.repeat(40),
    tree: name === 'se-z' ? '2'.repeat(40) : '5'.repeat(40),
  }));
}

function create(
  database: DeploymentDatabase,
  deploymentRequest: DeploymentRequestRecord = request(),
) {
  return database.createDeployment(
    deploymentRequest,
    sources(deploymentRequest.deploymentId),
  );
}

function evidence(
  deploymentId: string,
  kind: string,
): DeploymentEvidenceRecord {
  const digest = hash(`evidence:${kind}`);
  return {
    deploymentId,
    digest,
    kind,
    contentLength: kind.length,
    artifactReference: `artifact:sha256:${digest}`,
    redacted: true,
    signatureAlgorithm: 'ed25519',
    signingKeyId: 'fixture-evidence-key',
    signature: 'A'.repeat(86),
    createdAt: '2026-07-22T12:01:00.000Z',
  };
}

function expectCode(callback: () => unknown, code: DeploymentError['code']): void {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof DeploymentError);
    assert.equal(error.code, code);
    return true;
  });
}

function addRequiredEvidence(
  database: DeploymentDatabase,
  deploymentId: string,
  current: DeploymentState,
  next: DeploymentState,
): DeploymentTransitionInput['evidence'] {
  const rule = getTransitionRule(current, next);
  assert.ok(rule, `${current} -> ${next}`);
  return rule.requiredEvidence.map((kind) => {
    const record = evidence(deploymentId, kind);
    database.appendEvidence(record);
    return { kind, digest: record.digest };
  });
}

describe('transactional deployment ledger', () => {
  it('uses strict migrations, survives reopen, and verifies integrity', () => {
    const path = makePath();
    const database = new DeploymentDatabase(path);
    const created = create(database);
    assert.equal(created.state, 'requested');
    assert.equal(created.stateSequence, 0);
    assert.equal(created.terminal, false);
    assert.deepEqual(database.listSources(created.deploymentId), sources(created.deploymentId));
    database.assertIntegrity();
    database.close();

    const reopened = new DeploymentDatabase(path);
    assert.deepEqual(reopened.getDeployment(created.deploymentId), created);
    reopened.assertIntegrity();
    reopened.close();
  });

  it('enforces semantic deployment idempotency and immutable product identities', () => {
    const database = new DeploymentDatabase(makePath());
    const first = create(database);
    assert.deepEqual(create(database), first);
    expectCode(
      () => create(database, request({ requestDigest: hash('changed request') })),
      'idempotency_conflict',
    );

    const sez = product(first.deploymentId, 'se-z');
    const gateway = product(first.deploymentId, 'se-z-gateway');
    assert.deepEqual(database.addProduct(sez), sez);
    assert.deepEqual(database.addProduct(gateway), gateway);
    assert.deepEqual(database.listProducts(first.deploymentId), [sez, gateway]);
    expectCode(
      () => database.addProduct({ ...sez, artifactDigest: hash('different artifact') }),
      'deployment_conflict',
    );
    database.close();
  });

  it('commits evidence and transitions under generation/state/sequence CAS', () => {
    const database = new DeploymentDatabase(makePath());
    const created = create(database);
    const refs = addRequiredEvidence(
      database,
      created.deploymentId,
      'requested',
      'source_resolving',
    );
    const input: DeploymentTransitionInput = {
      deploymentId: created.deploymentId,
      generation: created.generation,
      expectedState: 'requested',
      expectedSequence: 0,
      nextState: 'source_resolving',
      idempotencyKey: 'transition-source-001',
      evidence: refs,
      actor: 'se-z',
      occurredAt: '2026-07-22T12:02:00.000Z',
    };
    const committed = database.transition(input);
    assert.equal(committed.sequence, 1);
    assert.equal(committed.priorState, 'requested');
    assert.match(committed.transitionDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(database.transition(input), committed);
    assert.equal(database.getDeployment(created.deploymentId)?.state, 'source_resolving');

    expectCode(
      () =>
        database.transition({
          ...input,
          idempotencyKey: 'transition-source-stale',
        }),
      'deployment_state_conflict',
    );
    expectCode(
      () => database.transition({ ...input, nextState: 'failed' }),
      'idempotency_conflict',
    );
    database.close();
  });

  it('refuses uncommitted evidence and makes terminal truth signed and immutable', () => {
    const database = new DeploymentDatabase(makePath());
    const created = create(database);
    const terminalEvidence = evidence(created.deploymentId, 'failure.terminal');
    const input: DeploymentTransitionInput = {
      deploymentId: created.deploymentId,
      generation: created.generation,
      expectedState: 'requested',
      expectedSequence: 0,
      nextState: 'failed',
      idempotencyKey: 'transition-failed-001',
      evidence: [{ kind: terminalEvidence.kind, digest: terminalEvidence.digest }],
      actor: 'se-z',
      occurredAt: '2026-07-22T12:02:00.000Z',
      signatureAlgorithm: 'ed25519',
      signingKeyId: 'fixture-terminal-key',
      signature: 'B'.repeat(86),
    };
    expectCode(() => database.transition(input), 'deployment_evidence_missing');
    database.appendEvidence(terminalEvidence);
    const unsigned = { ...input, signingKeyId: undefined, signature: undefined };
    expectCode(() => database.transition(unsigned), 'deployment_transition_forbidden');
    const committed = database.transition(input);
    assert.equal(committed.terminal, true);
    assert.equal(database.getDeployment(created.deploymentId)?.terminal, true);
    expectCode(
      () =>
        database.transition({
          ...input,
          expectedState: 'failed',
          expectedSequence: 1,
          nextState: 'source_resolving',
          idempotencyKey: 'transition-after-terminal',
        }),
      'deployment_terminal',
    );
    database.close();
  });

  it('walks the complete success path and proves guard-before-mutation ordering', () => {
    const database = new DeploymentDatabase(makePath());
    let current = create(database);
    const path: DeploymentState[] = [
      'source_resolving',
      'source_verified',
      'building',
      'testing',
      'packaging',
      'reproducibility_verifying',
      'artifact_verified',
      'compatibility_verifying',
      'preflight',
      'staging',
      'candidate_verifying',
      'ready_to_activate',
      'snapshotting',
      'guard_arming',
      'guard_armed',
      'gateway_installing',
      'gateway_activating',
      'gateway_accepting_legacy',
      'sez_installing',
      'sez_activating',
      'sez_accepting',
      'restart_accepting',
      'chatgpt_accepting',
      'success_marking',
      'guard_disarming',
      'succeeded',
    ];

    let successMarkerDigest: string | undefined;
    for (const nextState of path) {
      if (current.state === 'compatibility_verifying' && nextState === 'preflight') {
        database.addProduct(product(current.deploymentId, 'se-z'));
        database.addProduct(product(current.deploymentId, 'se-z-gateway'));
      }
      const refs = addRequiredEvidence(
        database,
        current.deploymentId,
        current.state,
        nextState,
      );
      const terminal = nextState === 'succeeded';
      if (nextState === 'guard_disarming') {
        successMarkerDigest = refs.find((item) => item.kind === 'success.marker')?.digest;
        assert.ok(successMarkerDigest);
      }
      database.transition({
        deploymentId: current.deploymentId,
        generation: current.generation,
        expectedState: current.state,
        expectedSequence: current.stateSequence,
        nextState,
        idempotencyKey: `transition-${String(current.stateSequence + 1).padStart(3, '0')}`,
        evidence: refs,
        actor: 'se-z',
        occurredAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
        ...(nextState === 'guard_armed' ? { guardStatus: 'armed' as const } : {}),
        ...(nextState === 'guard_disarming' ? { successMarkerDigest } : {}),
        ...(terminal
          ? {
              guardStatus: 'disarmed' as const,
              successMarkerDigest,
              signatureAlgorithm: 'ed25519' as const,
              signingKeyId: 'fixture-terminal-key',
              signature: 'C'.repeat(86),
            }
          : {}),
      });
      current = database.getDeployment(current.deploymentId)!;
      if (
        [
          'gateway_activating',
          'gateway_accepting_legacy',
          'sez_activating',
          'sez_accepting',
          'restart_accepting',
          'chatgpt_accepting',
          'success_marking',
        ].includes(nextState)
      ) {
        assert.equal(current.guardArmed, true, nextState);
      }
    }

    assert.equal(current.state, 'succeeded');
    assert.equal(current.guardArmed, false);
    assert.equal(current.successMarkerDigest, successMarkerDigest);
    assert.equal(database.listTransitions(current.deploymentId).length, path.length);
    database.close();
  });

  it('persists request intent before dispatch and commits exact results afterward', () => {
    const database = new DeploymentDatabase(makePath());
    const semanticDigest = hash('semantic operation intent');
    const intent = {
      idempotencyKey: 'operation-intent-001',
      semanticDigest,
      operation: 'sez.release.activate',
      createdAt: '2026-07-22T12:00:00.000Z',
    };
    assert.deepEqual(database.reserveIntent(intent), { state: 'reserved' });
    assert.deepEqual(database.reserveIntent(intent), { state: 'pending' });
    assert.deepEqual(
      database.reserveIntent({ ...intent, semanticDigest: hash('changed intent') }),
      { state: 'conflict', existingSemanticDigest: semanticDigest },
    );
    const completion = database.completeIntent({
      idempotencyKey: intent.idempotencyKey,
      semanticDigest,
      result: { state: 'succeeded', generation: 42 },
      completedAt: '2026-07-22T12:05:00.000Z',
    });
    assert.match(completion.resultDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(database.reserveIntent(intent), {
      state: 'completed',
      resultDigest: completion.resultDigest,
      result: { generation: 42, state: 'succeeded' },
    });
    database.close();
  });

  it('detects migration identity tampering on reopen', () => {
    const path = makePath();
    const database = new DeploymentDatabase(path);
    database.close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE schema_migrations SET checksum = '" + '0'.repeat(64) + "' WHERE version = 1");
    raw.close();
    expectCode(() => new DeploymentDatabase(path), 'deployment_integrity_failed');
  });
});
