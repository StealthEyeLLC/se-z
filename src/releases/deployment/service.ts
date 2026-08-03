// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Durable public release/self-host operation service. Active effects are fixture-gated until bootstrap. */

import type { KeyObject } from 'node:crypto';
import { join } from 'node:path';
import type { RuntimeConfig } from '../../supervisor/configuration/config.js';
import { getMachineIdSha256 } from '../../supervisor/configuration/config.js';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import { signEd25519 } from '../../protocol/signatures/signing.js';
import { OperationError } from '../../operations/errors.js';
import { DeploymentDatabase } from './database.js';
import { getTransitionRule, TERMINAL_STATES } from './state-machine.js';
import {
  DeploymentError,
  type DeploymentEvidenceRecord,
  type DeploymentProduct,
  type DeploymentRecord,
  type DeploymentSourceRecord,
  type DeploymentState,
} from './types.js';

const RELEASE_OPERATIONS = new Set([
  'sez.release.status',
  'sez.release.build',
  'sez.release.stage',
  'sez.release.verify',
  'sez.release.activate',
  'sez.release.rollback',
  'sez.release.repair',
  'sez.release.prune',
  'sez.selfhost.source.get',
  'sez.selfhost.acceptance.run',
  'sez.selfhost.evidence.get',
]);

const BUILD_PATH: readonly DeploymentState[] = [
  'source_resolving', 'source_verified', 'building', 'testing', 'packaging',
  'reproducibility_verifying', 'artifact_verified',
];
const STAGE_PATH: readonly DeploymentState[] = [
  'compatibility_verifying', 'preflight', 'staging', 'candidate_verifying',
  'ready_to_activate',
];
const ACTIVATE_PATH: readonly DeploymentState[] = [
  'snapshotting', 'guard_arming', 'guard_armed', 'gateway_installing',
  'gateway_activating', 'gateway_accepting_legacy', 'sez_installing',
  'sez_activating', 'sez_accepting', 'restart_accepting', 'chatgpt_accepting',
  'success_marking', 'guard_disarming', 'succeeded',
];

export interface ServiceOptions {
  signingKey?: KeyObject;
  signingKeyId: string;
  fixtureMode?: boolean;
  now?: () => Date;
  /** Deterministic caller-loss/reboot fixture: persist this state and return. */
  stopAfterState?: DeploymentState;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('invalid_request', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OperationError('invalid_request', `${label} is required`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new OperationError('invalid_request', `${label} must be a nonnegative integer`);
  }
  return Number(value);
}

function mappedError(error: unknown): OperationError {
  if (error instanceof OperationError) return error;
  if (error instanceof DeploymentError) {
    return new OperationError(error.code, error.message, false, error.details);
  }
  return new OperationError(
    'operation_failed',
    error instanceof Error ? error.message : 'Deployment operation failed',
  );
}

export class StandaloneDeploymentService {
  private readonly database: DeploymentDatabase;
  private readonly now: () => Date;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly options: ServiceOptions,
  ) {
    this.database = new DeploymentDatabase(join(config.stateRoot, 'deployment-state.sqlite'));
    this.now = options.now ?? (() => new Date());
  }

  static handles(operation: string): boolean {
    return RELEASE_OPERATIONS.has(operation);
  }

  close(): void {
    this.database.close();
  }

  async execute(operation: string, requestId: string, raw: Record<string, unknown>): Promise<unknown> {
    if (!StandaloneDeploymentService.handles(operation)) {
      throw new OperationError('unknown_operation', `Unknown deployment operation: ${operation}`);
    }
    const semanticDigest = sha256Hex(canonicalJson({ operation, payload: raw }));
    const deploymentId = typeof raw.deploymentId === 'string' ? raw.deploymentId : undefined;
    const reservation = this.database.reserveIntent({
      idempotencyKey: requestId,
      semanticDigest,
      operation,
      ...(operation === 'sez.release.build' ? {} : deploymentId ? { deploymentId } : {}),
      createdAt: this.now().toISOString(),
    });
    if (reservation.state === 'conflict') {
      throw new OperationError('idempotency_conflict', 'Deployment request key changed semantic intent');
    }
    if (reservation.state === 'pending') {
      throw new OperationError('ambiguous', 'Deployment request is durably pending exact reconciliation', true);
    }
    if (reservation.state === 'completed') return reservation.result;

    try {
      const result = await this.run(operation, requestId, raw);
      this.database.completeIntent({
        idempotencyKey: requestId,
        semanticDigest,
        result,
        completedAt: this.now().toISOString(),
      });
      return result;
    } catch (error) {
      throw mappedError(error);
    }
  }

  private async run(operation: string, requestId: string, body: Record<string, unknown>): Promise<unknown> {
    switch (operation) {
      case 'sez.release.status': return this.status(body);
      case 'sez.release.build': return this.build(requestId, body);
      case 'sez.release.stage': return this.stage(requestId, body);
      case 'sez.release.verify': return this.verify(body);
      case 'sez.release.activate': return this.activate(requestId, body);
      case 'sez.release.rollback': return this.rollback(requestId, body);
      case 'sez.release.repair': return this.repair(requestId, body);
      case 'sez.release.prune': return this.prune(body);
      case 'sez.selfhost.source.get': return this.sourceGet(body);
      case 'sez.selfhost.acceptance.run': return this.acceptance(requestId, body);
      case 'sez.selfhost.evidence.get': return this.evidencePage(body);
      default: throw new OperationError('unknown_operation', `Unknown operation: ${operation}`);
    }
  }

  private status(body: Record<string, unknown>): Record<string, unknown> {
    const limit = body.limit === undefined ? 50 : integer(body.limit, 'limit');
    const offset = body.offset === undefined ? 0 : integer(body.offset, 'offset');
    if (typeof body.deploymentId !== 'string') {
      const deployments = this.database.listDeployments(offset, Math.min(Math.max(limit, 1), 200));
      return { deployments, offset, nextOffset: offset + deployments.length };
    }
    return this.snapshot(body.deploymentId);
  }

  private build(requestId: string, body: Record<string, unknown>): Record<string, unknown> {
    this.assertFixtureExecution('sez.release.build');
    const deploymentId = text(body.deploymentId, 'deploymentId');
    const generation = integer(body.generation, 'generation');
    if (generation < 1) throw new OperationError('invalid_request', 'generation must be positive');
    const sources = object(body.sources, 'sources');
    const sez = object(sources.sez, 'sources.sez');
    const gateway = object(sources.gateway, 'sources.gateway');
    const requestedAt = this.now().toISOString();
    const sourceRecords: DeploymentSourceRecord[] = [
      {
        deploymentId, product: 'se-z', repository: 'StealthEyeLLC/se-z',
        commit: text(sez.commit, 'sources.sez.commit'), tree: text(sez.tree, 'sources.sez.tree'),
      },
      {
        deploymentId, product: 'se-z-gateway', repository: 'StealthEyeLLC/se-z-gateway',
        commit: text(gateway.commit, 'sources.gateway.commit'), tree: text(gateway.tree, 'sources.gateway.tree'),
      },
    ];
    this.database.createDeployment({
      deploymentId,
      generation,
      machineId: getMachineIdSha256() || 'fixture-machine',
      planDigest: text(body.planDigest, 'planDigest'),
      requestDigest: sha256Hex(canonicalJson(body)),
      deadline: text(body.deadline, 'deadline'),
      requestedAt,
      requestedBy: this.config.expectedSubject,
      idempotencyKey: requestId,
    }, sourceRecords);
    this.advance(deploymentId, BUILD_PATH, `${requestId}:build`);
    const compatibilityDigest = sha256Hex(canonicalJson({
      protocol: 'SEZ1/1.0.0', receipts: ['1.0.0', '2.0.0'], catalog: ['legacy-26', 'runtime-native-v2'],
    }));
    for (const source of sourceRecords) {
      this.database.addProduct({
        ...source,
        manifestDigest: sha256Hex(canonicalJson({ ...source, kind: 'manifest' })),
        artifactDigest: sha256Hex(canonicalJson({ ...source, kind: 'artifact' })),
        compatibilityDigest,
      });
    }
    return this.result('sez.release.build', deploymentId);
  }

  private stage(requestId: string, body: Record<string, unknown>): Record<string, unknown> {
    this.assertFixtureExecution('sez.release.stage');
    const deploymentId = text(body.deploymentId, 'deploymentId');
    this.assertSequence(deploymentId, body.expectedSequence);
    this.advance(deploymentId, STAGE_PATH, `${requestId}:stage`);
    return this.result('sez.release.stage', deploymentId);
  }

  private verify(body: Record<string, unknown>): Record<string, unknown> {
    const deploymentId = text(body.deploymentId, 'deploymentId');
    this.database.assertIntegrity();
    const snapshot = this.snapshot(deploymentId);
    const verificationDigest = sha256Hex(canonicalJson(snapshot));
    return { ...snapshot, verification: { status: 'verified', verificationDigest } };
  }

  private activate(requestId: string, body: Record<string, unknown>): Record<string, unknown> {
    this.assertFixtureExecution('sez.release.activate');
    const deploymentId = text(body.deploymentId, 'deploymentId');
    this.assertSequence(deploymentId, body.expectedSequence);
    text(body.confirmationDigest, 'confirmationDigest');
    this.advance(deploymentId, ACTIVATE_PATH, `${requestId}:activate`);
    return this.result('sez.release.activate', deploymentId);
  }

  private rollback(requestId: string, body: Record<string, unknown>): Record<string, unknown> {
    this.assertFixtureExecution('sez.release.rollback');
    const deploymentId = text(body.deploymentId, 'deploymentId');
    text(body.reason, 'reason');
    const deployment = this.required(deploymentId);
    if (deployment.terminal) throw new DeploymentError('deployment_terminal', 'Terminal deployment is immutable');
    const path: DeploymentState[] = deployment.state === 'rollback_requested'
      ? ['rolling_back', 'rolled_back']
      : deployment.state === 'rolling_back'
        ? ['rolled_back']
        : ['rollback_requested', 'rolling_back', 'rolled_back'];
    this.advance(deploymentId, path, `${requestId}:rollback`);
    return this.result('sez.release.rollback', deploymentId);
  }

  private repair(requestId: string, body: Record<string, unknown>): Record<string, unknown> {
    this.assertFixtureExecution('sez.release.repair');
    const deploymentId = text(body.deploymentId, 'deploymentId');
    this.assertSequence(deploymentId, body.expectedSequence);
    const state = this.required(deploymentId).state;
    if (!['partial', 'ambiguous', 'unknown', 'rollback_failed'].includes(state)) {
      throw new DeploymentError('deployment_state_conflict', 'Repair requires partial, ambiguous, unknown, or rollback_failed state');
    }
    const path: DeploymentState[] = state === 'rollback_failed'
      ? ['rolling_back', 'rolled_back']
      : ['reconciling', 'rollback_requested', 'rolling_back', 'rolled_back'];
    this.advance(deploymentId, path, `${requestId}:repair`);
    return this.result('sez.release.repair', deploymentId);
  }

  private prune(body: Record<string, unknown>): Record<string, unknown> {
    this.assertFixtureExecution('sez.release.prune');
    const dryRun = body.dryRun !== false;
    const protectedReferences = this.database.listDeployments(0, 200).map((item) => item.deploymentId);
    return { dryRun, retain: body.retain ?? 2, protected: protectedReferences, candidates: [], removed: [] };
  }

  private sourceGet(body: Record<string, unknown>): Record<string, unknown> {
    const deploymentId = text(body.deploymentId, 'deploymentId');
    const product = text(body.product, 'product') as DeploymentProduct;
    const source = this.database.listSources(deploymentId).find((item) => item.product === product);
    if (!source) throw new DeploymentError('deployment_not_found', 'Frozen source identity not found');
    return {
      ...source,
      workspaceReference: `deployment-source:${deploymentId}:${product}:${source.commit}`,
      clean: true,
    };
  }

  private acceptance(requestId: string, body: Record<string, unknown>): Record<string, unknown> {
    this.assertFixtureExecution('sez.selfhost.acceptance.run');
    const deploymentId = text(body.deploymentId, 'deploymentId');
    const profile = text(body.profile, 'profile');
    const evidence = this.appendEvidence(deploymentId, `acceptance.${profile}`, {
      profile, result: 'passed', fixture: true,
    });
    const result = this.result('sez.selfhost.acceptance.run', deploymentId);
    return { ...result, acceptanceEvidence: { kind: evidence.kind, digest: evidence.digest }, requestId };
  }

  private evidencePage(body: Record<string, unknown>): Record<string, unknown> {
    const deploymentId = text(body.deploymentId, 'deploymentId');
    const offset = body.offset === undefined ? 0 : integer(body.offset, 'offset');
    const limit = body.limit === undefined ? 50 : Math.min(Math.max(integer(body.limit, 'limit'), 1), 200);
    const kind = typeof body.kind === 'string' ? body.kind : undefined;
    const all = this.database.listEvidence(deploymentId, kind);
    const items = all.slice(offset, offset + limit);
    return { deploymentId, offset, nextOffset: offset + items.length, total: all.length, items };
  }

  private advance(deploymentId: string, path: readonly DeploymentState[], key: string): void {
    let successMarkerDigest: string | undefined;
    for (const nextState of path) {
      const current = this.required(deploymentId);
      if (current.state === nextState) continue;
      const rule = getTransitionRule(current.state, nextState);
      if (!rule) {
        throw new DeploymentError('deployment_transition_forbidden', `No transition ${current.state} -> ${nextState}`);
      }
      const evidence = rule.requiredEvidence.map((kind) => {
        if (kind === 'success.marker' && current.successMarkerDigest) {
          return { kind, digest: current.successMarkerDigest };
        }
        const item = this.appendEvidence(deploymentId, kind, {
          from: current.state, to: nextState, generation: current.generation, fixture: true,
        });
        if (kind === 'success.marker') successMarkerDigest = item.digest;
        return { kind, digest: item.digest };
      });
      if (nextState === 'succeeded' && successMarkerDigest) {
        const marker = this.database.listEvidence(deploymentId, 'success.marker').at(-1);
        if (marker && !evidence.some((item) => item.kind === 'success.marker')) {
          evidence.push({ kind: 'success.marker', digest: marker.digest });
        }
      }
      const terminal = TERMINAL_STATES.has(nextState);
      const occurredAt = this.now().toISOString();
      const transitionBody = {
        deploymentId, generation: current.generation, expectedState: current.state,
        expectedSequence: current.stateSequence, nextState, evidence,
        actor: this.config.expectedSubject, occurredAt,
      };
      this.database.transition({
        ...transitionBody,
        idempotencyKey: `${key}:${String(current.stateSequence).padStart(3, '0')}`,
        ...(nextState === 'guard_armed' ? { guardStatus: 'armed' as const } : {}),
        ...(['succeeded', 'rolled_back'].includes(nextState) ? { guardStatus: 'disarmed' as const } : {}),
        ...(['guard_disarming', 'succeeded'].includes(nextState) && (successMarkerDigest ?? current.successMarkerDigest)
          ? { successMarkerDigest: successMarkerDigest ?? current.successMarkerDigest }
          : {}),
        ...(terminal ? {
          signatureAlgorithm: 'ed25519' as const,
          signingKeyId: this.options.signingKeyId,
          signature: this.sign(transitionBody),
        } : {}),
      });
      if (nextState === this.options.stopAfterState) return;
    }
  }

  private appendEvidence(deploymentId: string, kind: string, details: unknown): DeploymentEvidenceRecord {
    const createdAt = this.now().toISOString();
    const bytes = Buffer.from(canonicalJson({ deploymentId, kind, details, createdAt }));
    const digest = sha256Hex(bytes);
    return this.database.appendEvidence({
      deploymentId,
      digest,
      kind,
      contentLength: bytes.length,
      artifactReference: `artifact:sha256:${digest}`,
      redacted: true,
      signatureAlgorithm: 'ed25519',
      signingKeyId: this.options.signingKeyId,
      signature: this.sign(bytes),
      createdAt,
    });
  }

  private sign(value: unknown): string {
    if (!this.options.signingKey) {
      throw new OperationError('resource_unavailable', 'Deployment evidence signing key is unavailable');
    }
    const document = Buffer.isBuffer(value)
      ? value.toString('utf8')
      : typeof value === 'string'
        ? value
        : canonicalJson(value);
    return signEd25519(document, this.options.signingKey);
  }

  private assertSequence(deploymentId: string, expected: unknown): void {
    const actual = this.required(deploymentId).stateSequence;
    if (integer(expected, 'expectedSequence') !== actual) {
      throw new DeploymentError('deployment_state_conflict', 'Deployment sequence compare-and-swap failed', { expected, actual });
    }
  }

  private required(deploymentId: string): DeploymentRecord {
    const record = this.database.getDeployment(deploymentId);
    if (!record) throw new DeploymentError('deployment_not_found', `Deployment ${deploymentId} not found`);
    return record;
  }

  private snapshot(deploymentId: string): Record<string, unknown> {
    const deployment = this.required(deploymentId);
    return {
      deployment,
      sources: this.database.listSources(deploymentId),
      products: this.database.listProducts(deploymentId),
      transitions: this.database.listTransitions(deploymentId),
      evidence: this.database.listEvidence(deploymentId),
    };
  }

  private result(operation: string, deploymentId: string): Record<string, unknown> {
    const record = this.required(deploymentId);
    const evidence = this.database.listEvidence(deploymentId).map(({ kind, digest }) => ({ kind, digest }));
    const body = {
      operation, deploymentId, generation: record.generation, state: record.state,
      stateSequence: record.stateSequence, terminal: record.terminal, evidence,
    };
    return { ...body, resultDigest: sha256Hex(canonicalJson(body)) };
  }

  private assertFixtureExecution(operation: string): void {
    if (!this.options.fixtureMode) {
      throw new OperationError(
        'resource_unavailable',
        `${operation} requires the separately bootstrapped fixed standalone controller`,
        true,
        { supportState: 'unavailable', productionMutation: false },
      );
    }
  }
}
