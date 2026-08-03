// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/deployment-state-machine-v2.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_MUTATION_STATES,
  TERMINAL_STATES,
  TRANSITION_RULES,
  assertTransitionAllowed,
  getTransitionRule,
} from '../../../../src/releases/deployment/state-machine.js';
import {
  DEPLOYMENT_STATES,
  DeploymentError,
  type DeploymentState,
  type DeploymentTransitionInput,
} from '../../../../src/releases/deployment/types.js';

const digest = 'a'.repeat(64);

function transition(
  expectedState: DeploymentState,
  nextState: DeploymentState,
  evidenceKinds: readonly string[],
  overrides: Partial<DeploymentTransitionInput> = {},
): DeploymentTransitionInput {
  return {
    deploymentId: 'deployment-test-001',
    generation: 1,
    expectedState,
    expectedSequence: 0,
    nextState,
    idempotencyKey: 'transition-test-001',
    evidence: evidenceKinds.map((kind) => ({ kind, digest })),
    actor: 'se-z',
    occurredAt: '2026-07-22T12:00:00.000Z',
    ...overrides,
  };
}

function expectCode(callback: () => unknown, code: DeploymentError['code']): void {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof DeploymentError);
    assert.equal(error.code, code);
    return true;
  });
}

describe('standalone deployment state inventory', () => {
  it('contains every mandatory state once', () => {
    assert.equal(DEPLOYMENT_STATES.length, 40);
    assert.equal(new Set(DEPLOYMENT_STATES).size, DEPLOYMENT_STATES.length);
    for (const required of [
      'reproducibility_verifying',
      'guard_armed',
      'gateway_accepting_legacy',
      'chatgpt_accepting',
      'ambiguous',
      'unknown',
      'rolled_back',
      'manual_recovery_required',
    ] satisfies DeploymentState[]) {
      assert.ok(DEPLOYMENT_STATES.includes(required));
    }
  });

  it('describes every legal edge with durable CAS and evidence metadata', () => {
    const keys = TRANSITION_RULES.map((rule) => `${rule.from}->${rule.to}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(TRANSITION_RULES.length > DEPLOYMENT_STATES.length);
    for (const rule of TRANSITION_RULES) {
      assert.equal(rule.transactionBoundary, 'sqlite_begin_immediate');
      assert.deepEqual(rule.compareAndSwap, [
        'deploymentId',
        'generation',
        'stateSequence',
        'priorState',
      ]);
      assert.equal(rule.idempotency, 'semantic_replay_or_conflict');
      assert.ok(rule.requiredEvidence.length > 0);
      assert.ok(['retry_exact', 'readback_then_reconcile'].includes(rule.crashReconciliation));
    }
  });

  it('makes every terminal state immutable', () => {
    for (const state of TERMINAL_STATES) {
      assert.equal(TRANSITION_RULES.some((rule) => rule.from === state), false, state);
    }
    assert.equal(getTransitionRule('rolled_back', 'succeeded'), undefined);
  });
});

describe('standalone deployment safety invariants', () => {
  it('requires exact evidence declared by the edge', () => {
    expectCode(
      () => assertTransitionAllowed(false, transition('requested', 'source_resolving', [])),
      'deployment_evidence_missing',
    );
    assert.equal(
      assertTransitionAllowed(
        false,
        transition('requested', 'source_resolving', ['request.validated']),
      ).to,
      'source_resolving',
    );
  });

  it('blocks every active-product state before guard readback', () => {
    for (const state of ACTIVE_MUTATION_STATES) {
      const incoming = TRANSITION_RULES.find((rule) => rule.to === state);
      assert.ok(incoming, `missing incoming rule for ${state}`);
      expectCode(
        () =>
          assertTransitionAllowed(
            false,
            transition(incoming.from, incoming.to, incoming.requiredEvidence),
          ),
        'deployment_transition_forbidden',
      );
    }
  });

  it('also fences inactive installs that occur after guard arming', () => {
    for (const state of ['gateway_installing', 'sez_installing'] as const) {
      const incoming = TRANSITION_RULES.find((rule) => rule.to === state);
      assert.ok(incoming);
      expectCode(
        () =>
          assertTransitionAllowed(
            false,
            transition(incoming.from, incoming.to, incoming.requiredEvidence),
          ),
        'deployment_transition_forbidden',
      );
    }
  });

  it('requires explicit armed readback and routes armed cancellation to rollback', () => {
    const rule = getTransitionRule('guard_arming', 'guard_armed');
    assert.ok(rule);
    expectCode(
      () =>
        assertTransitionAllowed(
          false,
          transition('guard_arming', 'guard_armed', rule.requiredEvidence),
        ),
      'deployment_transition_forbidden',
    );
    assert.equal(
      assertTransitionAllowed(
        false,
        transition('guard_arming', 'guard_armed', rule.requiredEvidence, {
          guardStatus: 'armed',
        }),
      ).to,
      'guard_armed',
    );

    const cancelRule = getTransitionRule('cancelling', 'failed');
    assert.ok(cancelRule);
    expectCode(
      () =>
        assertTransitionAllowed(
          true,
          transition('cancelling', 'failed', cancelRule.requiredEvidence),
        ),
      'deployment_transition_forbidden',
    );
    assert.ok(getTransitionRule('cancelling', 'rollback_requested'));
  });

  it('requires both a generation-bound success marker and guard disarm readback', () => {
    const rule = getTransitionRule('guard_disarming', 'succeeded');
    assert.ok(rule);
    expectCode(
      () =>
        assertTransitionAllowed(
          true,
          transition('guard_disarming', 'succeeded', rule.requiredEvidence),
        ),
      'deployment_transition_forbidden',
    );
    assert.equal(
      assertTransitionAllowed(
        true,
        transition('guard_disarming', 'succeeded', rule.requiredEvidence, {
          guardStatus: 'disarmed',
          successMarkerDigest: digest,
        }),
      ).terminalTruth,
      'success',
    );
  });

  it('never reports rolled_back while the guard still reads armed', () => {
    const rule = getTransitionRule('rolling_back', 'rolled_back');
    assert.ok(rule);
    expectCode(
      () =>
        assertTransitionAllowed(
          true,
          transition('rolling_back', 'rolled_back', rule.requiredEvidence),
        ),
      'deployment_transition_forbidden',
    );
    assert.equal(
      assertTransitionAllowed(
        true,
        transition('rolling_back', 'rolled_back', rule.requiredEvidence, {
          guardStatus: 'disarmed',
        }),
      ).terminalTruth,
      'rolled_back',
    );
  });

  it('keeps ambiguous and unknown results nonterminal until readback reconciliation', () => {
    assert.equal(TERMINAL_STATES.has('ambiguous'), false);
    assert.equal(TERMINAL_STATES.has('unknown'), false);
    assert.ok(getTransitionRule('ambiguous', 'reconciling'));
    assert.ok(getTransitionRule('unknown', 'reconciling'));
    assert.equal(getTransitionRule('unknown', 'succeeded'), undefined);
  });
});
