// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Pure, exhaustively described standalone deployment state machine. */

import {
  DEPLOYMENT_STATES,
  DeploymentError,
  type CancellationBehavior,
  type DeploymentState,
  type DeploymentTransitionInput,
  type DeploymentTransitionRule,
  type MutationClass,
  type RollbackImplication,
} from './types.js';

const HAPPY_PATH: readonly DeploymentState[] = [
  'requested',
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

export const TERMINAL_STATES = new Set<DeploymentState>([
  'succeeded',
  'failed',
  'timed_out',
  'rolled_back',
  'manual_recovery_required',
]);

export const ACTIVE_MUTATION_STATES = new Set<DeploymentState>([
  'gateway_activating',
  'gateway_accepting_legacy',
  'sez_activating',
  'sez_accepting',
  'restart_accepting',
  'chatgpt_accepting',
  'success_marking',
  'guard_disarming',
]);

export const POST_ARM_STATES = new Set<DeploymentState>([
  'guard_armed',
  'gateway_installing',
  'sez_installing',
  ...ACTIVE_MUTATION_STATES,
]);

const PRE_ARM_WORK_STATES = new Set<DeploymentState>(HAPPY_PATH.slice(0, 15));
const DIAGNOSTIC_STATES = new Set<DeploymentState>(['partial', 'ambiguous', 'unknown']);
const ROLLBACK_STATES = new Set<DeploymentState>([
  'rollback_requested',
  'rolling_back',
  'rollback_failed',
]);

const MUTATION_CLASS: Readonly<Record<DeploymentState, MutationClass>> = Object.freeze({
  requested: 'none',
  source_resolving: 'none',
  source_verified: 'none',
  building: 'none',
  testing: 'none',
  packaging: 'none',
  reproducibility_verifying: 'none',
  artifact_verified: 'none',
  compatibility_verifying: 'none',
  preflight: 'none',
  staging: 'inactive_only',
  candidate_verifying: 'inactive_only',
  ready_to_activate: 'none',
  snapshotting: 'none',
  guard_arming: 'guard_control',
  guard_armed: 'guard_control',
  gateway_installing: 'inactive_only',
  gateway_activating: 'active_product',
  gateway_accepting_legacy: 'active_product',
  sez_installing: 'inactive_only',
  sez_activating: 'active_product',
  sez_accepting: 'active_product',
  restart_accepting: 'active_product',
  chatgpt_accepting: 'active_product',
  success_marking: 'active_product',
  guard_disarming: 'guard_control',
  succeeded: 'none',
  cancel_requested: 'none',
  cancelling: 'none',
  failed: 'none',
  timed_out: 'none',
  partial: 'none',
  ambiguous: 'none',
  unknown: 'none',
  reconciling: 'none',
  rollback_requested: 'rollback',
  rolling_back: 'rollback',
  rolled_back: 'rollback',
  rollback_failed: 'rollback',
  manual_recovery_required: 'none',
});

const REQUIRED_EVIDENCE: Readonly<Record<DeploymentState, readonly string[]>> = Object.freeze({
  requested: ['request.validated'],
  source_resolving: ['request.validated'],
  source_verified: ['source.identity'],
  building: ['source.materialization'],
  testing: ['build.result'],
  packaging: ['test.result'],
  reproducibility_verifying: ['package.first'],
  artifact_verified: ['reproducibility.match', 'artifact.manifest'],
  compatibility_verifying: ['artifact.verification'],
  preflight: ['compatibility.declaration'],
  staging: ['preflight.report'],
  candidate_verifying: ['stage.readback'],
  ready_to_activate: ['candidate.acceptance'],
  snapshotting: ['activation.intent'],
  guard_arming: ['snapshot.verified'],
  guard_armed: ['guard.readback'],
  gateway_installing: ['guard.readback'],
  gateway_activating: ['gateway.inactive_install'],
  gateway_accepting_legacy: ['gateway.activation.readback'],
  sez_installing: ['gateway.legacy.acceptance'],
  sez_activating: ['sez.inactive_install'],
  sez_accepting: ['sez.activation.readback'],
  restart_accepting: ['sez.acceptance'],
  chatgpt_accepting: ['restart.acceptance'],
  success_marking: ['chatgpt.acceptance'],
  guard_disarming: ['success.marker'],
  succeeded: ['success.marker', 'guard.disarm.readback'],
  cancel_requested: ['cancellation.intent'],
  cancelling: ['cancellation.readback'],
  failed: ['failure.terminal'],
  timed_out: ['deadline.readback'],
  partial: ['partial.readback'],
  ambiguous: ['mutation.ambiguous'],
  unknown: ['state.unknown'],
  reconciling: ['reconciliation.readback'],
  rollback_requested: ['rollback.intent'],
  rolling_back: ['rollback.preflight'],
  rolled_back: ['rollback.acceptance', 'guard.disarm.readback'],
  rollback_failed: ['rollback.failure'],
  manual_recovery_required: ['manual_recovery.record'],
});

function cancellationBehavior(state: DeploymentState): CancellationBehavior {
  if (TERMINAL_STATES.has(state)) return 'reject_terminal';
  if (ROLLBACK_STATES.has(state)) return 'continue_rollback';
  if (DIAGNOSTIC_STATES.has(state) || state === 'reconciling') return 'reconcile_first';
  if (state === 'guard_arming') return 'reconcile_guard_then_clean_or_rollback';
  if (POST_ARM_STATES.has(state)) return 'request_rollback';
  return 'clean_staging_then_fail';
}

function rollbackImplication(state: DeploymentState): RollbackImplication {
  if (state === 'rolled_back') return 'rollback_complete';
  if (state === 'rollback_failed' || state === 'manual_recovery_required') {
    return 'manual_recovery';
  }
  if (ROLLBACK_STATES.has(state)) return 'rollback_in_progress';
  if (POST_ARM_STATES.has(state)) return 'required_if_guard_armed';
  return 'none';
}

function terminalTruth(
  state: DeploymentState,
): DeploymentTransitionRule['terminalTruth'] {
  if (state === 'succeeded') return 'success';
  if (state === 'rolled_back') return 'rolled_back';
  if (state === 'manual_recovery_required') return 'manual_recovery';
  if (state === 'failed' || state === 'timed_out') return 'failure';
  return 'nonterminal';
}

function transitionKey(from: DeploymentState, to: DeploymentState): string {
  return `${from}->${to}`;
}

function buildTransitionPairs(): Array<readonly [DeploymentState, DeploymentState]> {
  const pairs = new Map<string, readonly [DeploymentState, DeploymentState]>();
  const add = (from: DeploymentState, to: DeploymentState): void => {
    if (from === to || TERMINAL_STATES.has(from)) return;
    pairs.set(transitionKey(from, to), [from, to]);
  };

  for (let index = 0; index < HAPPY_PATH.length - 1; index += 1) {
    add(HAPPY_PATH[index]!, HAPPY_PATH[index + 1]!);
  }

  for (const state of PRE_ARM_WORK_STATES) {
    add(state, 'cancel_requested');
    add(state, 'failed');
    add(state, 'timed_out');
    add(state, 'partial');
    add(state, 'ambiguous');
    add(state, 'unknown');
  }

  for (const state of POST_ARM_STATES) {
    add(state, 'rollback_requested');
    add(state, 'partial');
    add(state, 'ambiguous');
    add(state, 'unknown');
  }

  add('guard_arming', 'rollback_requested');
  add('cancel_requested', 'cancelling');
  add('cancel_requested', 'reconciling');
  add('cancelling', 'failed');
  add('cancelling', 'rollback_requested');
  add('partial', 'reconciling');
  add('partial', 'rollback_requested');
  add('ambiguous', 'reconciling');
  add('unknown', 'reconciling');
  add('unknown', 'manual_recovery_required');

  const reconcilable = HAPPY_PATH.filter((state) => !TERMINAL_STATES.has(state));
  for (const state of reconcilable) add('reconciling', state);
  add('reconciling', 'rollback_requested');
  add('reconciling', 'rolling_back');
  add('reconciling', 'rolled_back');
  add('reconciling', 'rollback_failed');
  add('reconciling', 'manual_recovery_required');

  add('rollback_requested', 'rolling_back');
  add('rollback_requested', 'unknown');
  add('rolling_back', 'rolled_back');
  add('rolling_back', 'rollback_failed');
  add('rolling_back', 'ambiguous');
  add('rolling_back', 'unknown');
  add('rollback_failed', 'rolling_back');
  add('rollback_failed', 'manual_recovery_required');

  return [...pairs.values()];
}

function createRule(
  from: DeploymentState,
  to: DeploymentState,
): DeploymentTransitionRule {
  const mutationClass = MUTATION_CLASS[to];
  return Object.freeze({
    from,
    to,
    transactionBoundary: 'sqlite_begin_immediate',
    compareAndSwap: [
      'deploymentId',
      'generation',
      'stateSequence',
      'priorState',
    ] as const,
    idempotency: 'semantic_replay_or_conflict',
    retryable: !TERMINAL_STATES.has(to),
    cancellationBehavior: cancellationBehavior(to),
    rollbackImplication: rollbackImplication(to),
    requiredEvidence: REQUIRED_EVIDENCE[to],
    crashReconciliation:
      mutationClass === 'active_product' ||
      mutationClass === 'guard_control' ||
      mutationClass === 'rollback'
        ? 'readback_then_reconcile'
        : 'retry_exact',
    mutationClass,
    terminalTruth: terminalTruth(to),
  });
}

export const TRANSITION_RULES: readonly DeploymentTransitionRule[] = Object.freeze(
  buildTransitionPairs().map(([from, to]) => createRule(from, to)),
);

const RULE_BY_KEY = new Map(
  TRANSITION_RULES.map((rule) => [transitionKey(rule.from, rule.to), rule]),
);

export function isDeploymentState(value: string): value is DeploymentState {
  return (DEPLOYMENT_STATES as readonly string[]).includes(value);
}

export function getTransitionRule(
  from: DeploymentState,
  to: DeploymentState,
): DeploymentTransitionRule | undefined {
  return RULE_BY_KEY.get(transitionKey(from, to));
}

export function assertTransitionAllowed(
  currentGuardArmed: boolean,
  input: DeploymentTransitionInput,
): DeploymentTransitionRule {
  const rule = getTransitionRule(input.expectedState, input.nextState);
  if (!rule) {
    throw new DeploymentError(
      TERMINAL_STATES.has(input.expectedState)
        ? 'deployment_terminal'
        : 'deployment_transition_forbidden',
      `Transition ${input.expectedState} -> ${input.nextState} is forbidden`,
      { from: input.expectedState, to: input.nextState },
    );
  }

  const evidenceKinds = new Set(input.evidence.map((item) => item.kind));
  const missing = rule.requiredEvidence.filter((kind) => !evidenceKinds.has(kind));
  if (missing.length > 0) {
    throw new DeploymentError(
      'deployment_evidence_missing',
      `Transition ${input.expectedState} -> ${input.nextState} lacks required evidence`,
      { missing },
    );
  }

  if (ACTIVE_MUTATION_STATES.has(input.nextState) && !currentGuardArmed) {
    throw new DeploymentError(
      'deployment_transition_forbidden',
      `Active mutation state ${input.nextState} requires guard_armed readback`,
    );
  }

  if (
    POST_ARM_STATES.has(input.nextState) &&
    input.nextState !== 'guard_armed' &&
    !currentGuardArmed
  ) {
    throw new DeploymentError(
      'deployment_transition_forbidden',
      `Post-arm state ${input.nextState} requires guard_armed readback`,
    );
  }

  if (
    currentGuardArmed &&
    PRE_ARM_WORK_STATES.has(input.nextState) &&
    input.nextState !== 'guard_arming'
  ) {
    throw new DeploymentError(
      'deployment_transition_forbidden',
      `An armed deployment cannot return to pre-arm state ${input.nextState}`,
    );
  }

  if (input.nextState === 'guard_armed' && input.guardStatus !== 'armed') {
    throw new DeploymentError(
      'deployment_transition_forbidden',
      'guard_armed requires an explicit armed readback',
    );
  }

  if (input.guardStatus === 'armed' && input.nextState !== 'guard_armed') {
    throw new DeploymentError(
      'deployment_transition_forbidden',
      'An armed readback may only establish guard_armed',
    );
  }

  if (
    input.guardStatus === 'disarmed' &&
    input.nextState !== 'succeeded' &&
    input.nextState !== 'rolled_back'
  ) {
    throw new DeploymentError(
      'deployment_transition_forbidden',
      'Guard disarm readback may only terminalize succeeded or rolled_back',
    );
  }

  if (
    currentGuardArmed &&
    (input.nextState === 'failed' ||
      input.nextState === 'timed_out' ||
      input.nextState === 'cancelling')
  ) {
    throw new DeploymentError(
      'deployment_transition_forbidden',
      `An armed deployment must request rollback instead of entering ${input.nextState}`,
    );
  }

  if (input.nextState === 'succeeded') {
    if (input.guardStatus !== 'disarmed' || !input.successMarkerDigest) {
      throw new DeploymentError(
        'deployment_transition_forbidden',
        'succeeded requires the exact success marker and guard disarm readback',
      );
    }
  }

  if (input.nextState === 'rolled_back' && input.guardStatus !== 'disarmed') {
    throw new DeploymentError(
      'deployment_transition_forbidden',
      'rolled_back requires guard disarm readback',
    );
  }

  if (input.nextState === 'guard_disarming' || input.nextState === 'succeeded') {
    const marker = input.evidence.find((item) => item.kind === 'success.marker');
    if (!input.successMarkerDigest || marker?.digest !== input.successMarkerDigest) {
      throw new DeploymentError(
        'deployment_transition_forbidden',
        `${input.nextState} requires evidence for the exact success marker digest`,
      );
    }
  }

  if (
    input.successMarkerDigest &&
    input.nextState !== 'guard_disarming' &&
    input.nextState !== 'succeeded'
  ) {
    throw new DeploymentError(
      'deployment_transition_forbidden',
      'Success marker digest is invalid for this transition',
    );
  }

  return rule;
}
