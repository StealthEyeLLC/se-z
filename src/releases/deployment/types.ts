// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Durable standalone deployment records owned by se-z. */

export const DEPLOYMENT_STATES = [
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
  'cancel_requested',
  'cancelling',
  'failed',
  'timed_out',
  'partial',
  'ambiguous',
  'unknown',
  'reconciling',
  'rollback_requested',
  'rolling_back',
  'rolled_back',
  'rollback_failed',
  'manual_recovery_required',
] as const;

export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

export const DEPLOYMENT_PRODUCTS = ['se-z', 'se-z-gateway'] as const;
export type DeploymentProduct = (typeof DEPLOYMENT_PRODUCTS)[number];

export type MutationClass =
  | 'none'
  | 'inactive_only'
  | 'guard_control'
  | 'active_product'
  | 'rollback';

export type CancellationBehavior =
  | 'clean_staging_then_fail'
  | 'reconcile_guard_then_clean_or_rollback'
  | 'request_rollback'
  | 'continue_rollback'
  | 'reconcile_first'
  | 'reject_terminal';

export type RollbackImplication =
  | 'none'
  | 'required_if_guard_armed'
  | 'rollback_in_progress'
  | 'rollback_complete'
  | 'manual_recovery';

export interface EvidenceReference {
  kind: string;
  digest: string;
}

export interface DeploymentRequestRecord {
  deploymentId: string;
  generation: number;
  machineId: string;
  planDigest: string;
  requestDigest: string;
  deadline: string;
  requestedAt: string;
  requestedBy: string;
  idempotencyKey: string;
}

export interface DeploymentRecord extends DeploymentRequestRecord {
  sourceSetDigest: string;
  state: DeploymentState;
  stateSequence: number;
  guardArmed: boolean;
  successMarkerDigest?: string;
  terminal: boolean;
  recordDigest: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentSourceRecord {
  deploymentId: string;
  product: DeploymentProduct;
  repository: string;
  commit: string;
  tree: string;
}

export interface DeploymentProductRecord {
  deploymentId: string;
  product: DeploymentProduct;
  repository: string;
  commit: string;
  tree: string;
  manifestDigest: string;
  artifactDigest: string;
  compatibilityDigest: string;
}

export interface DeploymentEvidenceRecord {
  deploymentId: string;
  digest: string;
  kind: string;
  contentLength: number;
  artifactReference: string;
  redacted: boolean;
  signatureAlgorithm: 'ed25519';
  signingKeyId: string;
  signature: string;
  createdAt: string;
}

export interface DeploymentTransitionInput {
  deploymentId: string;
  generation: number;
  expectedState: DeploymentState;
  expectedSequence: number;
  nextState: DeploymentState;
  idempotencyKey: string;
  evidence: EvidenceReference[];
  actor: string;
  occurredAt: string;
  reason?: string;
  guardStatus?: 'armed' | 'disarmed';
  successMarkerDigest?: string;
  signatureAlgorithm?: 'ed25519';
  signingKeyId?: string;
  signature?: string;
}

export interface DeploymentTransitionRecord extends DeploymentTransitionInput {
  sequence: number;
  priorState: DeploymentState;
  intentDigest: string;
  transitionDigest: string;
  terminal: boolean;
}

export interface DeploymentTransitionRule {
  from: DeploymentState;
  to: DeploymentState;
  transactionBoundary: 'sqlite_begin_immediate';
  compareAndSwap: readonly [
    'deploymentId',
    'generation',
    'stateSequence',
    'priorState',
  ];
  idempotency: 'semantic_replay_or_conflict';
  retryable: boolean;
  cancellationBehavior: CancellationBehavior;
  rollbackImplication: RollbackImplication;
  requiredEvidence: readonly string[];
  crashReconciliation: 'retry_exact' | 'readback_then_reconcile';
  mutationClass: MutationClass;
  terminalTruth: 'nonterminal' | 'success' | 'failure' | 'rolled_back' | 'manual_recovery';
}

export type DeploymentErrorCode =
  | 'deployment_invalid'
  | 'deployment_not_found'
  | 'deployment_conflict'
  | 'deployment_generation_conflict'
  | 'deployment_state_conflict'
  | 'deployment_transition_forbidden'
  | 'deployment_evidence_missing'
  | 'deployment_integrity_failed'
  | 'deployment_terminal'
  | 'idempotency_conflict';

export class DeploymentError extends Error {
  constructor(
    public readonly code: DeploymentErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DeploymentError';
  }
}
