// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Machine-readable se-z operation definitions and discovery response. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeConfig } from '../supervisor/configuration/config.js';
import type { LoadedPackageSet } from '../skills/types.js';
import {
  CONTRACT_VERSION,
  DEFAULTS,
  PRODUCT_NAME,
  PROTOCOL_VERSION,
  getHostname,
  getMachineIdSha256,
} from '../supervisor/configuration/config.js';

export const CANONICAL_SEZ_TOOL = 'call_sez';
export const CANONICAL_SEZ_ACTION_DESCRIPTION =
  'Run one authorized se-z operation through the single authenticated se-z interface and return its durable result with verified signed evidence.';

export interface OperationDefinition {
  operation: string;
  family:
    | 'discovery'
    | 'health'
    | 'github'
    | 'execution'
    | 'job'
    | 'file'
    | 'pty'
    | 'artifact'
    | 'release'
    | 'selfhost' | 'skill';
  version: string;
  description: string;
  mutation: boolean;
  idempotency: 'read_only' | 'caller_key' | 'conditional' | 'non_idempotent';
  risk: 'low' | 'medium' | 'high';
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  authority?: Readonly<{
    class: 'unrestricted-owner';
    confirmation: 'risk_dependent';
    scope: 'sez.root';
    issuer: 'https://se-z.stealtheye.io';
    resource: 'https://se-z.stealtheye.io/mcp';
  }>;
  costClass?: 'local_zero';
  support?: Readonly<{
    state: 'supported' | 'unavailable' | 'unsupported' | 'ambiguous' | 'unknown';
    provider: 'sez-standalone-deployment-v2';
  }>;
  errors?: readonly string[];
  cancellation?: 'not_applicable' | 'pre_arm_cleanup_post_arm_rollback';
  restartBehavior?: 'read_only' | 'durable_reconcile';
  postActionVerification?: boolean;
  receiptVersion?: '2.0.0';
  limits?: Readonly<Record<string, number | string>>;
  limitations?: string[];
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const string = { type: 'string' } as const;
const integer = { type: 'integer', minimum: 0 } as const;
const boolean = { type: 'boolean' } as const;
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const gitObject = { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' } as const;
const identifier = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' } as const;
const timestamp = { type: 'string', format: 'date-time' } as const;

const deploymentResult = objectSchema({
  operation: string,
  deploymentId: identifier,
  generation: integer,
  state: string,
  stateSequence: integer,
  terminal: boolean,
  resultDigest: digest,
  evidence: { type: 'array', items: objectSchema({ kind: identifier, digest }) },
});

const RELEASE_ERRORS = Object.freeze([
  'invalid_request',
  'idempotency_conflict',
  'deployment_not_found',
  'deployment_conflict',
  'deployment_state_conflict',
  'deployment_transition_forbidden',
  'deployment_evidence_missing',
  'deployment_integrity_failed',
  'resource_unavailable',
  'ambiguous',
  'unknown',
]);

function releaseOperation(
  definition: Omit<OperationDefinition, 'authority' | 'costClass' | 'support' | 'errors' |
    'cancellation' | 'restartBehavior' | 'postActionVerification' | 'receiptVersion'>,
): OperationDefinition {
  return {
    ...definition,
    authority: {
      class: 'unrestricted-owner',
      confirmation: 'risk_dependent',
      scope: 'sez.root',
      issuer: 'https://se-z.stealtheye.io',
      resource: 'https://se-z.stealtheye.io/mcp',
    },
    costClass: 'local_zero',
    support: { state: 'supported', provider: 'sez-standalone-deployment-v2' },
    errors: RELEASE_ERRORS,
    cancellation: definition.mutation ? 'pre_arm_cleanup_post_arm_rollback' : 'not_applicable',
    restartBehavior: definition.mutation ? 'durable_reconcile' : 'read_only',
    postActionVerification: true,
    receiptVersion: '2.0.0',
    limits: { maxInlineEvidenceBytes: 65536, defaultPageSize: 50, maximumPageSize: 200 },
  };
}

export const OPERATION_DEFINITIONS: readonly OperationDefinition[] = [
  {
    operation: 'sez.describe', family: 'discovery', version: '1.0.0',
    description: 'Describe the installed se-z protocol, limits, operations, schemas, release identity, and canonical invocation rules.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({}),
  },
  {
    operation: 'sez.health', family: 'health', version: '1.0.0',
    description: 'Return bounded runtime health and exact host identity.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({}),
  },
  {
    operation: 'sez.github.app.verify', family: 'github', version: '1.0.0',
    description: 'Verify the exact Sez GitHub Authority App, StealthEyeLLC installation, encrypted credential, and single-repository read access using an ephemeral token.',
    mutation: false, idempotency: 'read_only', risk: 'low',
    input: objectSchema({
      repository: { type: 'string', pattern: '^StealthEyeLLC\/[A-Za-z0-9_.-]{1,100}$' },
    }),
    errors: ['invalid_request', 'credential_unavailable', 'github_identity_mismatch', 'github_request_failed'],
    cancellation: 'not_applicable', restartBehavior: 'read_only', postActionVerification: true,
  },
  {
    operation: 'sez.github.app.proof', family: 'github', version: '1.0.0',
    description: 'Create, read back, and positively delete one ephemeral proof branch through the exact Sez GitHub Authority installation.',
    mutation: true, idempotency: 'caller_key', risk: 'high',
    input: objectSchema({
      repository: { type: 'string', pattern: '^StealthEyeLLC\/[A-Za-z0-9_.-]{1,100}$' },
    }, ['repository']),
    errors: ['invalid_request', 'credential_unavailable', 'github_identity_mismatch', 'github_request_failed', 'github_cleanup_failed'],
    cancellation: 'pre_arm_cleanup_post_arm_rollback', restartBehavior: 'durable_reconcile', postActionVerification: true,
  },
  {
    operation: 'sez.exec', family: 'execution', version: '1.0.0',
    description: 'Execute an exact executable and argv as a durable job.',
    mutation: true, idempotency: 'caller_key', risk: 'high',
    input: objectSchema({ argv: { type: 'array', minItems: 1, items: string }, cwd: string, environment: { type: 'array' }, env: { type: 'object' }, detached: boolean }, ['argv']),
  },
  {
    operation: 'sez.shell', family: 'execution', version: '1.0.0',
    description: 'Execute a shell command or script as a durable job.',
    mutation: true, idempotency: 'caller_key', risk: 'high',
    input: objectSchema({ shell: string, command: string, script: string, cwd: string, environment: { type: 'array' }, env: { type: 'object' }, detached: boolean }),
  },
  {
    operation: 'sez.job.get', family: 'job', version: '1.0.0', description: 'Get one durable job by ID.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({ jobId: string }, ['jobId']),
  },
  {
    operation: 'sez.job.list', family: 'job', version: '1.0.0', description: 'List durable jobs with optional status and count bounds.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({ status: string, limit: integer }),
  },
  {
    operation: 'sez.job.wait', family: 'job', version: '1.0.0', description: 'Wait for or poll a durable job terminal state.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({ jobId: string, timeoutMs: integer }, ['jobId']),
  },
  {
    operation: 'sez.job.cancel', family: 'job', version: '1.0.0', description: 'Persist cancellation and signal an identified job process group.',
    mutation: true, idempotency: 'caller_key', risk: 'high', input: objectSchema({ jobId: string, signal: string }, ['jobId']),
  },
  {
    operation: 'sez.job.stream.read', family: 'job', version: '1.0.0', description: 'Read stdout or stderr bytes from an exact offset.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({ jobId: string, stream: { enum: ['stdout', 'stderr'] }, offset: integer, limit: integer }, ['jobId', 'stream']),
  },
  {
    operation: 'sez.file.stat', family: 'file', version: '1.0.0', description: 'Return file metadata and a bounded SHA-256 digest.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({ path: string }, ['path']),
  },
  {
    operation: 'sez.file.read', family: 'file', version: '1.0.0', description: 'Read binary-safe file content from an exact offset.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({ path: string, offset: integer, limit: integer, encoding: { enum: ['base64', 'utf8'] } }, ['path']),
  },
  {
    operation: 'sez.file.write', family: 'file', version: '1.0.0', description: 'Write bounded binary-safe content, optionally at an offset.',
    mutation: true, idempotency: 'conditional', risk: 'high', input: objectSchema({ path: string, data: string, encoding: { enum: ['base64', 'utf8'] }, offset: integer, create: boolean }, ['path', 'data']),
    limitations: ['Whole-file replacement is not compare-and-swap; prefer sez.file.replace when available.'],
  },
  {
    operation: 'sez.file.replace', family: 'file', version: '1.0.0',
    description: 'Atomically replace a regular file beneath an explicit confinement root with compare-and-swap preconditions.',
    mutation: true, idempotency: 'caller_key', risk: 'high',
    input: objectSchema({ root: string, path: string, data: string, encoding: { enum: ['base64', 'utf8'] }, expectedSha256: string, expectedAbsent: boolean, preserveMode: boolean, durable: boolean, createParents: boolean }, ['root', 'path', 'data']),
    limitations: ['Symlink components are rejected in userspace; kernel openat2 confinement is a later native hardening layer.'],
  },
  {
    operation: 'sez.file.patch', family: 'file', version: '1.0.0', description: 'Apply one or more binary patches at exact offsets.',
    mutation: true, idempotency: 'conditional', risk: 'high', input: objectSchema({ path: string, patches: { type: 'array', minItems: 1 } }, ['path', 'patches']),
  },
  {
    operation: 'sez.file.copy', family: 'file', version: '1.0.0', description: 'Copy one file to a destination.',
    mutation: true, idempotency: 'conditional', risk: 'high', input: objectSchema({ source: string, destination: string, overwrite: boolean }, ['source', 'destination']),
  },
  {
    operation: 'sez.file.move', family: 'file', version: '1.0.0', description: 'Move or rename one path.',
    mutation: true, idempotency: 'conditional', risk: 'high', input: objectSchema({ source: string, destination: string, overwrite: boolean }, ['source', 'destination']),
  },
  {
    operation: 'sez.file.remove', family: 'file', version: '1.0.0', description: 'Remove a file or an explicitly recursive directory.',
    mutation: true, idempotency: 'caller_key', risk: 'high', input: objectSchema({ path: string, recursive: boolean }, ['path']),
  },
  {
    operation: 'sez.file.list', family: 'file', version: '1.0.0', description: 'List directory entries with recursion and count bounds.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({ path: string, recursive: boolean, maxDepth: integer, maxEntries: integer }, ['path']),
  },
  {
    operation: 'sez.pty.create', family: 'pty', version: '1.0.0', description: 'Create a durable tmux-backed interactive PTY.',
    mutation: true, idempotency: 'caller_key', risk: 'high', input: objectSchema({ shell: string, cwd: string, cols: integer, rows: integer, env: { type: 'object' } }),
  },
  {
    operation: 'sez.pty.input', family: 'pty', version: '1.0.0', description: 'Send raw input bytes to an active PTY.',
    mutation: true, idempotency: 'non_idempotent', risk: 'high', input: objectSchema({ sessionId: string, data: string, encoding: { enum: ['base64', 'utf8'] } }, ['sessionId', 'data']),
  },
  {
    operation: 'sez.pty.resize', family: 'pty', version: '1.0.0', description: 'Resize an active PTY.',
    mutation: true, idempotency: 'caller_key', risk: 'medium', input: objectSchema({ sessionId: string, cols: integer, rows: integer }, ['sessionId', 'cols', 'rows']),
  },
  {
    operation: 'sez.pty.read', family: 'pty', version: '1.0.0', description: 'Read raw terminal output from an exact offset.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({ sessionId: string, offset: integer, limit: integer }, ['sessionId']),
  },
  {
    operation: 'sez.pty.close', family: 'pty', version: '1.0.0', description: 'Close a durable PTY session.',
    mutation: true, idempotency: 'caller_key', risk: 'high', input: objectSchema({ sessionId: string, signal: string }, ['sessionId']),
  },
  {
    operation: 'sez.artifact.create', family: 'artifact', version: '1.0.0', description: 'Capture an artifact from an existing file.',
    mutation: true, idempotency: 'caller_key', risk: 'medium', input: objectSchema({ name: string, sourcePath: string, metadata: { type: 'object' } }, ['name', 'sourcePath']),
  },
  {
    operation: 'sez.artifact.begin', family: 'artifact', version: '1.0.0', description: 'Begin a resumable artifact upload with optional expected size and SHA-256.',
    mutation: true, idempotency: 'caller_key', risk: 'medium', input: objectSchema({ name: string, metadata: { type: 'object' }, expectedSize: integer, expectedSha256: string }, ['name']),
  },
  {
    operation: 'sez.artifact.upload', family: 'artifact', version: '1.0.0', description: 'Upload a binary artifact chunk at an exact offset.',
    mutation: true, idempotency: 'conditional', risk: 'medium', input: objectSchema({ artifactId: string, offset: integer, data: string, encoding: { enum: ['base64'] }, finalize: boolean }, ['artifactId', 'offset', 'data']),
    limitations: ['Legacy operation; finalized immutability is enforced by the explicit begin/finalize lifecycle when available.'],
  },
  {
    operation: 'sez.artifact.finalize', family: 'artifact', version: '1.0.0', description: 'Verify size and SHA-256, then make an upload immutable and digest-addressed.',
    mutation: true, idempotency: 'caller_key', risk: 'medium', input: objectSchema({ artifactId: string, expectedSize: integer, expectedSha256: string }, ['artifactId', 'expectedSize', 'expectedSha256']),
  },
  {
    operation: 'sez.artifact.abort', family: 'artifact', version: '1.0.0', description: 'Abort and remove an incomplete artifact upload.',
    mutation: true, idempotency: 'caller_key', risk: 'medium', input: objectSchema({ artifactId: string }, ['artifactId']),
  },
  {
    operation: 'sez.artifact.download', family: 'artifact', version: '1.0.0', description: 'Download artifact bytes from an exact offset.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({ artifactId: string, offset: integer, limit: integer }, ['artifactId']),
  },
  {
    operation: 'sez.artifact.list', family: 'artifact', version: '1.0.0', description: 'List artifact metadata.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({}),
  },
  {
    operation: 'sez.artifact.get', family: 'artifact', version: '1.0.0', description: 'Get artifact metadata by ID.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({ artifactId: string }, ['artifactId']),
  },
  releaseOperation({
    operation: 'sez.release.status', family: 'release', version: '2.0.0',
    description: 'Read durable standalone deployment state, products, transitions, and bounded evidence indexes.',
    mutation: false, idempotency: 'read_only', risk: 'low',
    input: objectSchema({ deploymentId: identifier, offset: integer, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
    output: deploymentResult,
  }),
  releaseOperation({
    operation: 'sez.release.build', family: 'release', version: '2.0.0',
    description: 'Create or resume an exact-source, reproducible, durable coordinated Sez and gateway build.',
    mutation: true, idempotency: 'caller_key', risk: 'medium',
    input: objectSchema({
      deploymentId: identifier,
      generation: { type: 'integer', minimum: 1 },
      planDigest: digest,
      deadline: timestamp,
      sources: objectSchema({
        sez: objectSchema({ commit: gitObject, tree: gitObject }, ['commit', 'tree']),
        gateway: objectSchema({ commit: gitObject, tree: gitObject }, ['commit', 'tree']),
      }, ['sez', 'gateway']),
    }, ['deploymentId', 'generation', 'planDigest', 'deadline', 'sources']),
    output: deploymentResult,
  }),
  releaseOperation({
    operation: 'sez.release.stage', family: 'release', version: '2.0.0',
    description: 'Verify compatibility, run read-only preflight, and create inactive release targets without pointer mutation.',
    mutation: true, idempotency: 'caller_key', risk: 'medium',
    input: objectSchema({ deploymentId: identifier, expectedSequence: integer }, ['deploymentId', 'expectedSequence']),
    output: deploymentResult,
  }),
  releaseOperation({
    operation: 'sez.release.verify', family: 'release', version: '2.0.0',
    description: 'Verify deployment database integrity, source and product identity, evidence, candidates, guard, and terminal truth.',
    mutation: false, idempotency: 'read_only', risk: 'low',
    input: objectSchema({ deploymentId: identifier }, ['deploymentId']),
    output: deploymentResult,
  }),
  releaseOperation({
    operation: 'sez.release.activate', family: 'release', version: '2.0.0',
    description: 'Snapshot, arm and read back the independent guard, activate gateway first, accept, mark success, and disarm.',
    mutation: true, idempotency: 'caller_key', risk: 'high',
    input: objectSchema({ deploymentId: identifier, expectedSequence: integer, confirmationDigest: digest }, ['deploymentId', 'expectedSequence', 'confirmationDigest']),
    output: deploymentResult,
  }),
  releaseOperation({
    operation: 'sez.release.rollback', family: 'release', version: '2.0.0',
    description: 'Request and reconcile deterministic independent rollback for one exact guarded generation.',
    mutation: true, idempotency: 'caller_key', risk: 'high',
    input: objectSchema({ deploymentId: identifier, reason: { type: 'string', minLength: 8, maxLength: 512 } }, ['deploymentId', 'reason']),
    output: deploymentResult,
  }),
  releaseOperation({
    operation: 'sez.release.repair', family: 'release', version: '2.0.0',
    description: 'Reconcile incomplete, conflicting, ambiguous, unknown, or rollback-failed deployment state by exact readback.',
    mutation: true, idempotency: 'caller_key', risk: 'high',
    input: objectSchema({ deploymentId: identifier, expectedSequence: integer }, ['deploymentId', 'expectedSequence']),
    output: deploymentResult,
  }),
  releaseOperation({
    operation: 'sez.release.prune', family: 'release', version: '2.0.0',
    description: 'Prune only unprotected inactive release data under bounded retention and exact reference checks.',
    mutation: true, idempotency: 'caller_key', risk: 'medium',
    input: objectSchema({ dryRun: boolean, retain: { type: 'integer', minimum: 2, maximum: 100 } }, ['dryRun']),
    output: objectSchema({ protected: { type: 'array', items: string }, candidates: { type: 'array', items: string }, removed: { type: 'array', items: string }, dryRun: boolean }),
  }),
  releaseOperation({
    operation: 'sez.selfhost.source.get', family: 'selfhost', version: '2.0.0',
    description: 'Materialize or read back exact Sez and gateway source identities in a deployment-owned workspace.',
    mutation: true, idempotency: 'caller_key', risk: 'medium',
    input: objectSchema({ deploymentId: identifier, product: { enum: ['se-z', 'se-z-gateway'] } }, ['deploymentId', 'product']),
    output: objectSchema({ deploymentId: identifier, repository: string, commit: gitObject, tree: gitObject, workspaceReference: string, clean: boolean }),
  }),
  releaseOperation({
    operation: 'sez.selfhost.acceptance.run', family: 'selfhost', version: '2.0.0',
    description: 'Run the fixed bounded acceptance profile and persist a signed content-addressed evidence index.',
    mutation: true, idempotency: 'caller_key', risk: 'medium',
    input: objectSchema({ deploymentId: identifier, profile: { enum: ['preactivation', 'postactivation', 'full'] } }, ['deploymentId', 'profile']),
    output: deploymentResult,
  }),
  releaseOperation({
    operation: 'sez.selfhost.evidence.get', family: 'selfhost', version: '2.0.0',
    description: 'Read a bounded page of signed content-addressed deployment evidence without private recovery payloads.',
    mutation: false, idempotency: 'read_only', risk: 'low',
    input: objectSchema({ deploymentId: identifier, kind: identifier, offset: integer, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['deploymentId']),
    output: objectSchema({ deploymentId: identifier, offset: integer, nextOffset: integer, total: integer, items: { type: 'array' } }),
  }),
  {
    operation: 'sez.skill.deploy', family: 'skill', version: '1.0.0',
    description: 'Deploy or idempotently reuse one exact trusted first-party JavaScript skill.',
    mutation: true, idempotency: 'caller_key', risk: 'high',
    input: objectSchema({
      repository: { type: 'string', pattern: '^StealthEyeLLC\/[A-Za-z0-9_.-]{1,100}$' },
      ref: { type: 'string', minLength: 1, maxLength: 255 },
      skillPath: { type: 'string', minLength: 1, maxLength: 512 },
      expectedCommit: { type: 'string', pattern: '^[a-f0-9]{40}$' },
      expectedCurrentSetDigest: digest,
      smokeOperation: { type: 'string', minLength: 1, maxLength: 200 },
      smokePayload: { type: 'object' },
    }, ['repository', 'ref', 'skillPath']),
    output: { type: 'object' },
    errors: ['invalid_request', 'deployment_conflict', 'deployment_integrity_failed', 'operation_failed'],
    cancellation: 'pre_arm_cleanup_post_arm_rollback', restartBehavior: 'durable_reconcile', postActionVerification: true,
  },
  {
    operation: 'sez.skill.status', family: 'skill', version: '1.0.0',
    description: 'Read the active skill package set, catalog identity, runtime release, and last deployment.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({}), output: { type: 'object' },
    errors: ['operation_failed'], cancellation: 'not_applicable', restartBehavior: 'read_only', postActionVerification: true,
  },
  {
    operation: 'sez.skill.rollback', family: 'skill', version: '1.0.0',
    description: 'Atomically activate the previous immutable skill package set with verified Sez restart.',
    mutation: true, idempotency: 'caller_key', risk: 'high',
    input: objectSchema({ expectedCurrentSetDigest: digest, reason: { type: 'string', minLength: 1, maxLength: 512 } }, ['reason']),
    output: { type: 'object' },
    errors: ['invalid_request', 'resource_unavailable', 'deployment_conflict', 'deployment_integrity_failed', 'operation_failed'],
    cancellation: 'pre_arm_cleanup_post_arm_rollback', restartBehavior: 'durable_reconcile', postActionVerification: true,
  },
  {
    operation: 'sez.skill.list', family: 'skill', version: '1.0.0',
    description: 'List bounded immutable skill bundles and package sets with active and previous flags.',
    mutation: false, idempotency: 'read_only', risk: 'low', input: objectSchema({}), output: { type: 'object' },
    errors: ['operation_failed'], cancellation: 'not_applicable', restartBehavior: 'read_only', postActionVerification: true,
  },
] as const;

function discoveredDefinition(definition: OperationDefinition): Record<string, unknown> {
  return {
    ...definition,
    output: definition.output ?? objectSchema({}),
    authority: definition.authority ?? {
      class: 'unrestricted-owner',
      confirmation: 'risk_dependent',
      scope: 'sez.root',
      issuer: 'https://se-z.stealtheye.io',
      resource: 'https://se-z.stealtheye.io/mcp',
    },
    costClass: definition.costClass ?? 'local_zero',
    support: definition.support ?? {
      state: 'supported',
      provider: 'sez-standalone-deployment-v2',
    },
    errors: definition.errors ?? ['invalid_request', 'operation_failed'],
    cancellation: definition.cancellation ?? (definition.mutation
      ? 'pre_arm_cleanup_post_arm_rollback'
      : 'not_applicable'),
    restartBehavior: definition.restartBehavior ?? (definition.mutation
      ? 'durable_reconcile'
      : 'read_only'),
    postActionVerification: definition.postActionVerification ?? true,
    receiptVersion: definition.receiptVersion ?? '2.0.0',
    limits: definition.limits ?? { maxInlineResultBytes: 65536 },
  };
}

export function readReleaseIdentity(): Record<string, unknown> {
  const manifestPath = join(DEFAULTS.currentLink, 'manifest.json');
  try {
    if (!existsSync(manifestPath)) return { status: 'unknown', manifestPath };
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    return {
      status: 'installed',
      manifestPath,
      version: manifest.version ?? 'unknown',
      commit: manifest.commit ?? 'unknown',
      tree: manifest.tree ?? 'unknown',
      sourceDateEpoch: manifest.sourceDateEpoch ?? 'unknown',
    };
  } catch {
    return { status: 'unknown', manifestPath };
  }
}

export function buildCapabilityDescription(config: RuntimeConfig, loadedSkills?: LoadedPackageSet): Record<string, unknown> {
  const definitions = loadedSkills === undefined ? OPERATION_DEFINITIONS : [...OPERATION_DEFINITIONS, ...loadedSkills.definitions];
  return {
    product: PRODUCT_NAME,
    protocolVersion: PROTOCOL_VERSION,
    contractVersion: CONTRACT_VERSION,
    supervisorId: config.supervisorId,
    hostname: getHostname(),
    machineIdSha256: getMachineIdSha256() || 'unknown',
    authority: {
      subject: config.expectedSubject,
      authorityClass: config.authorityClass,
      gatewayId: config.gatewayId,
      transport: 'private_unix_socket',
    },
    release: readReleaseIdentity(),
    skills: {
      activeSetDigest: loadedSkills?.setDigest ?? null,
      catalogDigest: loadedSkills?.catalogDigest ?? null,
      coreOperationCount: OPERATION_DEFINITIONS.length,
      skillOperationCount: loadedSkills?.definitions.length ?? 0,
      loaded: loadedSkills?.skills.map((skill) => ({
        ...skill.source,
        operations: skill.definitions.map((definition) => definition.operation),
      })) ?? [],
    },
    limits: {
      maxFrameSize: config.maxFrameSize,
      maxOutputBytes: config.maxOutputBytes,
      maxJobQueue: config.maxJobQueue,
      maxRetentionJobs: config.maxRetentionJobs,
      requestMaxAgeMs: config.requestMaxAgeMs,
      nonceRetentionMs: config.nonceRetentionMs,
      idempotencyRetentionMs: config.idempotencyRetentionMs,
      streamChunkSize: DEFAULTS.streamChunkSize,
      maxArchiveBytes: DEFAULTS.maxArchiveBytes,
      maxArchiveFileBytes: DEFAULTS.maxArchiveFileBytes,
    },
    invocation: {
      tool: CANONICAL_SEZ_TOOL,
      actionDescription: CANONICAL_SEZ_ACTION_DESCRIPTION,
      variableFields: ['operation', 'payload', 'idempotencyKey'],
      annotations: { idempotentHint: true },
      securitySchemes: [{ type: 'oauth2', scopes: ['sez.root'] }],
      rules: [
        'Use only the single call_sez tool for se-z operations.',
        'Do not rediscover, rename, or wrap se-z with alternate tool identities.',
        'Reuse an idempotency key only for the exact same logical request.',
        'Use a new idempotency key whenever the operation or payload changes.',
      ],
    },
    operations: definitions.map(discoveredDefinition),
  };
}
