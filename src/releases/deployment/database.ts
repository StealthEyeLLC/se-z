// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Transactional Sez-owned deployment ledger. */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import {
  DEPLOYMENT_PRODUCTS,
  DeploymentError,
  type DeploymentEvidenceRecord,
  type DeploymentProduct,
  type DeploymentProductRecord,
  type DeploymentRecord,
  type DeploymentRequestRecord,
  type DeploymentSourceRecord,
  type DeploymentTransitionInput,
  type DeploymentTransitionRecord,
} from './types.js';
import {
  TERMINAL_STATES,
  assertTransitionAllowed,
  isDeploymentState,
} from './state-machine.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,256}$/;

const MIGRATION_1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE deployments (
  deployment_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL UNIQUE CHECK (generation > 0),
  machine_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  source_set_digest TEXT NOT NULL CHECK (length(source_set_digest) = 64),
  deadline TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  state_sequence INTEGER NOT NULL CHECK (state_sequence >= 0),
  guard_armed INTEGER NOT NULL CHECK (guard_armed IN (0, 1)),
  success_marker_digest TEXT CHECK (
    success_marker_digest IS NULL OR length(success_marker_digest) = 64
  ),
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE deployment_sources (
  deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),
  product TEXT NOT NULL CHECK (product IN ('se-z', 'se-z-gateway')),
  repository TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  tree_id TEXT NOT NULL,
  PRIMARY KEY (deployment_id, product)
) STRICT;

CREATE TABLE deployment_products (
  deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),
  product TEXT NOT NULL CHECK (product IN ('se-z', 'se-z-gateway')),
  repository TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  tree_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  compatibility_digest TEXT NOT NULL CHECK (length(compatibility_digest) = 64),
  PRIMARY KEY (deployment_id, product)
) STRICT;

CREATE TABLE deployment_evidence (
  deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  kind TEXT NOT NULL,
  content_length INTEGER NOT NULL CHECK (content_length >= 0),
  artifact_reference TEXT NOT NULL,
  redacted INTEGER NOT NULL CHECK (redacted IN (0, 1)),
  signature_algorithm TEXT NOT NULL CHECK (signature_algorithm = 'ed25519'),
  signing_key_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, digest, kind)
) STRICT;

CREATE TABLE deployment_transitions (
  deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  generation INTEGER NOT NULL CHECK (generation > 0),
  prior_state TEXT NOT NULL,
  next_state TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  reason TEXT,
  guard_status TEXT CHECK (guard_status IS NULL OR guard_status IN ('armed', 'disarmed')),
  success_marker_digest TEXT CHECK (
    success_marker_digest IS NULL OR length(success_marker_digest) = 64
  ),
  signature_algorithm TEXT CHECK (
    signature_algorithm IS NULL OR signature_algorithm = 'ed25519'
  ),
  signing_key_id TEXT,
  signature TEXT,
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  transition_digest TEXT NOT NULL CHECK (length(transition_digest) = 64),
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  PRIMARY KEY (deployment_id, sequence),
  UNIQUE (deployment_id, idempotency_key),
  UNIQUE (deployment_id, transition_digest)
) STRICT;

CREATE TABLE request_intents (
  idempotency_key TEXT PRIMARY KEY,
  semantic_digest TEXT NOT NULL CHECK (length(semantic_digest) = 64),
  operation TEXT NOT NULL,
  deployment_id TEXT REFERENCES deployments(deployment_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE INDEX deployment_transitions_state_idx
  ON deployment_transitions(deployment_id, next_state, sequence);
CREATE INDEX deployment_evidence_kind_idx
  ON deployment_evidence(deployment_id, kind, created_at);

CREATE TRIGGER deployments_no_delete
BEFORE DELETE ON deployments BEGIN
  SELECT RAISE(ABORT, 'deployment records are append-only');
END;

CREATE TRIGGER deployments_identity_immutable
BEFORE UPDATE ON deployments
WHEN OLD.deployment_id != NEW.deployment_id
  OR OLD.generation != NEW.generation
  OR OLD.machine_id != NEW.machine_id
  OR OLD.plan_digest != NEW.plan_digest
  OR OLD.request_digest != NEW.request_digest
  OR OLD.source_set_digest != NEW.source_set_digest
  OR OLD.deadline != NEW.deadline
  OR OLD.requested_at != NEW.requested_at
  OR OLD.requested_by != NEW.requested_by
  OR OLD.idempotency_key != NEW.idempotency_key
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'deployment identity is immutable');
END;

CREATE TRIGGER deployment_sources_no_update
BEFORE UPDATE ON deployment_sources BEGIN
  SELECT RAISE(ABORT, 'deployment sources are append-only');
END;
CREATE TRIGGER deployment_sources_no_delete
BEFORE DELETE ON deployment_sources BEGIN
  SELECT RAISE(ABORT, 'deployment sources are append-only');
END;

CREATE TRIGGER deployments_terminal_immutable
BEFORE UPDATE ON deployments WHEN OLD.terminal = 1 BEGIN
  SELECT RAISE(ABORT, 'terminal deployment is immutable');
END;

CREATE TRIGGER deployments_sequence_cas
BEFORE UPDATE ON deployments WHEN NEW.state_sequence != OLD.state_sequence + 1 BEGIN
  SELECT RAISE(ABORT, 'deployment sequence must increment exactly once');
END;

CREATE TRIGGER deployment_products_no_update
BEFORE UPDATE ON deployment_products BEGIN
  SELECT RAISE(ABORT, 'deployment products are append-only');
END;
CREATE TRIGGER deployment_products_no_delete
BEFORE DELETE ON deployment_products BEGIN
  SELECT RAISE(ABORT, 'deployment products are append-only');
END;

CREATE TRIGGER deployment_evidence_no_update
BEFORE UPDATE ON deployment_evidence BEGIN
  SELECT RAISE(ABORT, 'deployment evidence is append-only');
END;
CREATE TRIGGER deployment_evidence_no_delete
BEFORE DELETE ON deployment_evidence BEGIN
  SELECT RAISE(ABORT, 'deployment evidence is append-only');
END;

CREATE TRIGGER deployment_transitions_no_update
BEFORE UPDATE ON deployment_transitions BEGIN
  SELECT RAISE(ABORT, 'deployment transitions are append-only');
END;
CREATE TRIGGER deployment_transitions_no_delete
BEFORE DELETE ON deployment_transitions BEGIN
  SELECT RAISE(ABORT, 'deployment transitions are append-only');
END;

CREATE TRIGGER request_intents_identity_immutable
BEFORE UPDATE ON request_intents
WHEN OLD.idempotency_key != NEW.idempotency_key
  OR OLD.semantic_digest != NEW.semantic_digest
  OR OLD.operation != NEW.operation
  OR OLD.deployment_id IS NOT NEW.deployment_id
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'request intent identity is immutable');
END;
CREATE TRIGGER request_intents_no_delete
BEFORE DELETE ON request_intents BEGIN
  SELECT RAISE(ABORT, 'request intents are append-only');
END;
`;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'standalone_deployment_ledger', sql: MIGRATION_1 },
];

type SqlRow = Record<string, unknown>;

export type IntentReservation =
  | { state: 'reserved' }
  | { state: 'pending' }
  | { state: 'completed'; resultDigest: string; result: unknown }
  | { state: 'conflict'; existingSemanticDigest: string };

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new DeploymentError('deployment_invalid', `${label} is invalid`);
  }
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_PATTERN.test(value)) {
    throw new DeploymentError('deployment_invalid', 'idempotencyKey is invalid');
  }
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST_PATTERN.test(value)) {
    throw new DeploymentError('deployment_invalid', `${label} must be a lowercase SHA-256`);
  }
}

function assertGitObject(value: string, label: string): void {
  if (!GIT_OBJECT_PATTERN.test(value)) {
    throw new DeploymentError('deployment_invalid', `${label} is not a Git object ID`);
  }
}

function assertTimestamp(value: string, label: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new DeploymentError('deployment_invalid', `${label} must be canonical ISO-8601`);
  }
}

function asString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new DeploymentError('deployment_integrity_failed', `Invalid ${key} in deployment DB`);
  }
  return value;
}

function asNullableString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new DeploymentError('deployment_integrity_failed', `Invalid ${key} in deployment DB`);
  }
  return value;
}

function asNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DeploymentError('deployment_integrity_failed', `Invalid ${key} in deployment DB`);
  }
  return value;
}

function asBoolean(row: SqlRow, key: string): boolean {
  const value = asNumber(row, key);
  if (value !== 0 && value !== 1) {
    throw new DeploymentError('deployment_integrity_failed', `Invalid ${key} boolean`);
  }
  return value === 1;
}

function mapDeployment(row: SqlRow): DeploymentRecord {
  const state = asString(row, 'state');
  if (!isDeploymentState(state)) {
    throw new DeploymentError('deployment_integrity_failed', `Unknown deployment state ${state}`);
  }
  return {
    deploymentId: asString(row, 'deployment_id'),
    generation: asNumber(row, 'generation'),
    machineId: asString(row, 'machine_id'),
    planDigest: asString(row, 'plan_digest'),
    requestDigest: asString(row, 'request_digest'),
    sourceSetDigest: asString(row, 'source_set_digest'),
    deadline: asString(row, 'deadline'),
    requestedAt: asString(row, 'requested_at'),
    requestedBy: asString(row, 'requested_by'),
    idempotencyKey: asString(row, 'idempotency_key'),
    state,
    stateSequence: asNumber(row, 'state_sequence'),
    guardArmed: asBoolean(row, 'guard_armed'),
    successMarkerDigest: asNullableString(row, 'success_marker_digest'),
    terminal: asBoolean(row, 'terminal'),
    recordDigest: asString(row, 'record_digest'),
    createdAt: asString(row, 'created_at'),
    updatedAt: asString(row, 'updated_at'),
  };
}

function mapProduct(row: SqlRow): DeploymentProductRecord {
  const product = asString(row, 'product');
  if (!(DEPLOYMENT_PRODUCTS as readonly string[]).includes(product)) {
    throw new DeploymentError('deployment_integrity_failed', `Unknown product ${product}`);
  }
  return {
    deploymentId: asString(row, 'deployment_id'),
    product: product as DeploymentProduct,
    repository: asString(row, 'repository'),
    commit: asString(row, 'commit_id'),
    tree: asString(row, 'tree_id'),
    manifestDigest: asString(row, 'manifest_digest'),
    artifactDigest: asString(row, 'artifact_digest'),
    compatibilityDigest: asString(row, 'compatibility_digest'),
  };
}

function mapSource(row: SqlRow): DeploymentSourceRecord {
  const product = asString(row, 'product');
  if (!(DEPLOYMENT_PRODUCTS as readonly string[]).includes(product)) {
    throw new DeploymentError('deployment_integrity_failed', `Unknown source product ${product}`);
  }
  return {
    deploymentId: asString(row, 'deployment_id'),
    product: product as DeploymentProduct,
    repository: asString(row, 'repository'),
    commit: asString(row, 'commit_id'),
    tree: asString(row, 'tree_id'),
  };
}

function mapEvidence(row: SqlRow): DeploymentEvidenceRecord {
  return {
    deploymentId: asString(row, 'deployment_id'),
    digest: asString(row, 'digest'),
    kind: asString(row, 'kind'),
    contentLength: asNumber(row, 'content_length'),
    artifactReference: asString(row, 'artifact_reference'),
    redacted: asBoolean(row, 'redacted'),
    signatureAlgorithm: asString(row, 'signature_algorithm') as 'ed25519',
    signingKeyId: asString(row, 'signing_key_id'),
    signature: asString(row, 'signature'),
    createdAt: asString(row, 'created_at'),
  };
}

function parseEvidence(value: string): DeploymentTransitionInput['evidence'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DeploymentError('deployment_integrity_failed', 'Invalid transition evidence JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new DeploymentError('deployment_integrity_failed', 'Transition evidence is not an array');
  }
  return parsed.map((item) => {
    if (
      item === null ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>).kind !== 'string' ||
      typeof (item as Record<string, unknown>).digest !== 'string'
    ) {
      throw new DeploymentError('deployment_integrity_failed', 'Invalid transition evidence item');
    }
    return {
      kind: (item as { kind: string }).kind,
      digest: (item as { digest: string }).digest,
    };
  });
}

function mapTransition(row: SqlRow): DeploymentTransitionRecord {
  const priorState = asString(row, 'prior_state');
  const nextState = asString(row, 'next_state');
  if (!isDeploymentState(priorState) || !isDeploymentState(nextState)) {
    throw new DeploymentError('deployment_integrity_failed', 'Invalid transition state');
  }
  const guardStatus = asNullableString(row, 'guard_status');
  if (guardStatus !== undefined && guardStatus !== 'armed' && guardStatus !== 'disarmed') {
    throw new DeploymentError('deployment_integrity_failed', 'Invalid guard status');
  }
  return {
    deploymentId: asString(row, 'deployment_id'),
    generation: asNumber(row, 'generation'),
    expectedState: priorState,
    expectedSequence: asNumber(row, 'sequence') - 1,
    nextState,
    idempotencyKey: asString(row, 'idempotency_key'),
    evidence: parseEvidence(asString(row, 'evidence_json')),
    actor: asString(row, 'actor'),
    occurredAt: asString(row, 'occurred_at'),
    reason: asNullableString(row, 'reason'),
    guardStatus,
    successMarkerDigest: asNullableString(row, 'success_marker_digest'),
    signatureAlgorithm: asNullableString(row, 'signature_algorithm') as
      | 'ed25519'
      | undefined,
    signingKeyId: asNullableString(row, 'signing_key_id'),
    signature: asNullableString(row, 'signature'),
    sequence: asNumber(row, 'sequence'),
    priorState,
    intentDigest: asString(row, 'intent_digest'),
    transitionDigest: asString(row, 'transition_digest'),
    terminal: asBoolean(row, 'terminal'),
  };
}

function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql, 'utf8').digest('hex');
}

function queryParameters(values: SQLInputValue[]): SQLInputValue[] {
  return values;
}

export class DeploymentDatabase {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(readonly databasePath: string) {
    if (databasePath !== ':memory:') {
      const parent = dirname(databasePath);
      mkdirSync(parent, { recursive: true, mode: 0o750 });
      if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()) {
        throw new DeploymentError('deployment_invalid', 'Deployment database cannot be a symlink');
      }
    }

    this.database = new DatabaseSync(databasePath, {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
    });
    this.configure();
    this.migrate();
    this.assertIntegrity();

    if (databasePath !== ':memory:') {
      const directoryFd = openSync(dirname(databasePath), 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
  }

  private configure(): void {
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec('PRAGMA synchronous = FULL');
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA trusted_schema = OFF');
    this.database.exec('PRAGMA temp_store = MEMORY');
    if (this.databasePath !== ':memory:') {
      const result = this.database.prepare('PRAGMA journal_mode = WAL').get() as SqlRow;
      if (String(result.journal_mode).toLowerCase() !== 'wal') {
        throw new DeploymentError('deployment_integrity_failed', 'WAL mode is unavailable');
      }
      this.database.exec('PRAGMA wal_autocheckpoint = 1000');
    }
  }

  private transaction<T>(callback: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(): void {
    for (const migration of MIGRATIONS) {
      const checksum = migrationChecksum(migration);
      const hasMigrationTable = this.database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('schema_migrations');
      if (hasMigrationTable) {
        const applied = this.database
          .prepare('SELECT name, checksum FROM schema_migrations WHERE version = ?')
          .get(migration.version) as SqlRow | undefined;
        if (applied) {
          if (asString(applied, 'name') !== migration.name || asString(applied, 'checksum') !== checksum) {
            throw new DeploymentError(
              'deployment_integrity_failed',
              `Migration ${migration.version} identity does not match`,
            );
          }
          continue;
        }
      }

      this.transaction(() => {
        this.database.exec(migration.sql);
        this.database
          .prepare(
            'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          )
          .run(migration.version, migration.name, checksum, new Date().toISOString());
        this.database.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }

    const current = this.database.prepare('PRAGMA user_version').get() as SqlRow;
    const expected = MIGRATIONS.at(-1)?.version ?? 0;
    if (asNumber(current, 'user_version') !== expected) {
      throw new DeploymentError('deployment_integrity_failed', 'Unexpected database schema version');
    }
  }

  assertIntegrity(): void {
    const integrity = this.database.prepare('PRAGMA integrity_check').all() as SqlRow[];
    if (
      integrity.length !== 1 ||
      String(integrity[0]?.integrity_check).toLowerCase() !== 'ok'
    ) {
      throw new DeploymentError('deployment_integrity_failed', 'SQLite integrity check failed', {
        integrity,
      });
    }
    const foreignKeys = this.database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length !== 0) {
      throw new DeploymentError('deployment_integrity_failed', 'SQLite foreign key check failed');
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.databasePath !== ':memory:') {
      this.database.exec('PRAGMA wal_checkpoint(FULL)');
    }
    this.database.close();
    this.closed = true;
  }

  createDeployment(
    request: DeploymentRequestRecord,
    sources: readonly DeploymentSourceRecord[],
  ): DeploymentRecord {
    this.validateRequest(request);
    const canonicalSources = this.validateSources(request.deploymentId, sources);
    const sourceSetDigest = sha256Hex(canonicalJson(canonicalSources));
    const recordDigest = sha256Hex(
      canonicalJson({
        ...request,
        sourceSetDigest,
        state: 'requested',
        stateSequence: 0,
        guardArmed: false,
        terminal: false,
      }),
    );

    return this.transaction(() => {
      const existingByKey = this.database
        .prepare('SELECT * FROM deployments WHERE idempotency_key = ?')
        .get(request.idempotencyKey) as SqlRow | undefined;
      if (existingByKey) {
        const existing = mapDeployment(existingByKey);
        if (
          existing.requestDigest === request.requestDigest &&
          existing.sourceSetDigest === sourceSetDigest
        ) return existing;
        throw new DeploymentError('idempotency_conflict', 'Idempotency key has changed intent', {
          existingRequestDigest: existing.requestDigest,
          existingSourceSetDigest: existing.sourceSetDigest,
        });
      }
      const conflict = this.database
        .prepare('SELECT deployment_id, generation FROM deployments WHERE deployment_id = ? OR generation = ?')
        .get(request.deploymentId, request.generation) as SqlRow | undefined;
      if (conflict) {
        throw new DeploymentError('deployment_conflict', 'Deployment ID or generation already exists', {
          deploymentId: conflict.deployment_id,
          generation: conflict.generation,
        });
      }

      this.database
        .prepare(
          `INSERT INTO deployments(
            deployment_id, generation, machine_id, plan_digest, request_digest, source_set_digest,
            deadline, requested_at, requested_by, idempotency_key, state,
            state_sequence, guard_armed, success_marker_digest, terminal,
            record_digest, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', 0, 0, NULL, 0, ?, ?, ?)`,
        )
        .run(
          ...queryParameters([
            request.deploymentId,
            request.generation,
            request.machineId,
            request.planDigest,
            request.requestDigest,
            sourceSetDigest,
            request.deadline,
            request.requestedAt,
            request.requestedBy,
            request.idempotencyKey,
            recordDigest,
            request.requestedAt,
            request.requestedAt,
          ]),
        );
      const sourceStatement = this.database.prepare(
        `INSERT INTO deployment_sources(
          deployment_id, product, repository, commit_id, tree_id
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const source of canonicalSources) {
        sourceStatement.run(
          source.deploymentId,
          source.product,
          source.repository,
          source.commit,
          source.tree,
        );
      }
      return this.getDeploymentRequired(request.deploymentId);
    });
  }

  private validateSources(
    deploymentId: string,
    sources: readonly DeploymentSourceRecord[],
  ): DeploymentSourceRecord[] {
    if (sources.length !== DEPLOYMENT_PRODUCTS.length) {
      throw new DeploymentError(
        'deployment_invalid',
        'A coordinated deployment requires exactly Sez and gateway source identities',
      );
    }
    const seen = new Set<DeploymentProduct>();
    const canonical = sources.map((source) => {
      if (source.deploymentId !== deploymentId) {
        throw new DeploymentError('deployment_invalid', 'Source deployment ID does not match');
      }
      if (!(DEPLOYMENT_PRODUCTS as readonly string[]).includes(source.product)) {
        throw new DeploymentError('deployment_invalid', 'Unknown source product');
      }
      if (seen.has(source.product)) {
        throw new DeploymentError('deployment_invalid', 'Duplicate source product');
      }
      seen.add(source.product);
      const repository = `StealthEyeLLC/${source.product}`;
      if (source.repository !== repository) {
        throw new DeploymentError(
          'deployment_invalid',
          `Repository for ${source.product} must be ${repository}`,
        );
      }
      assertGitObject(source.commit, 'source commit');
      assertGitObject(source.tree, 'source tree');
      return { ...source };
    });
    return canonical.sort((left, right) => left.product.localeCompare(right.product));
  }

  private validateRequest(request: DeploymentRequestRecord): void {
    assertIdentifier(request.deploymentId, 'deploymentId');
    assertIdentifier(request.machineId, 'machineId');
    assertIdentifier(request.requestedBy, 'requestedBy');
    assertIdempotencyKey(request.idempotencyKey);
    assertDigest(request.planDigest, 'planDigest');
    assertDigest(request.requestDigest, 'requestDigest');
    assertTimestamp(request.requestedAt, 'requestedAt');
    assertTimestamp(request.deadline, 'deadline');
    if (new Date(request.deadline) <= new Date(request.requestedAt)) {
      throw new DeploymentError('deployment_invalid', 'deadline must be after requestedAt');
    }
    if (!Number.isSafeInteger(request.generation) || request.generation <= 0) {
      throw new DeploymentError('deployment_invalid', 'generation must be a positive integer');
    }
  }

  getDeployment(deploymentId: string): DeploymentRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM deployments WHERE deployment_id = ?')
      .get(deploymentId) as SqlRow | undefined;
    return row ? mapDeployment(row) : undefined;
  }

  listDeployments(offset = 0, limit = 50): DeploymentRecord[] {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new DeploymentError('deployment_invalid', 'offset must be nonnegative');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new DeploymentError('deployment_invalid', 'limit must be between 1 and 200');
    }
    return (
      this.database
        .prepare('SELECT * FROM deployments ORDER BY generation DESC, deployment_id LIMIT ? OFFSET ?')
        .all(limit, offset) as SqlRow[]
    ).map(mapDeployment);
  }

  private getDeploymentRequired(deploymentId: string): DeploymentRecord {
    const deployment = this.getDeployment(deploymentId);
    if (!deployment) {
      throw new DeploymentError('deployment_not_found', `Deployment ${deploymentId} not found`);
    }
    return deployment;
  }

  listSources(deploymentId: string): DeploymentSourceRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM deployment_sources WHERE deployment_id = ? ORDER BY product')
        .all(deploymentId) as SqlRow[]
    ).map(mapSource);
  }

  addProduct(product: DeploymentProductRecord): DeploymentProductRecord {
    assertIdentifier(product.deploymentId, 'deploymentId');
    if (!(DEPLOYMENT_PRODUCTS as readonly string[]).includes(product.product)) {
      throw new DeploymentError('deployment_invalid', 'Unknown deployment product');
    }
    const canonicalRepository = `StealthEyeLLC/${product.product}`;
    if (product.repository !== canonicalRepository) {
      throw new DeploymentError(
        'deployment_invalid',
        `Repository for ${product.product} must be ${canonicalRepository}`,
      );
    }
    assertGitObject(product.commit, 'commit');
    assertGitObject(product.tree, 'tree');
    assertDigest(product.manifestDigest, 'manifestDigest');
    assertDigest(product.artifactDigest, 'artifactDigest');
    assertDigest(product.compatibilityDigest, 'compatibilityDigest');

    return this.transaction(() => {
      const deployment = this.getDeploymentRequired(product.deploymentId);
      if (
        deployment.state !== 'requested' &&
        deployment.state !== 'artifact_verified' &&
        deployment.state !== 'compatibility_verifying'
      ) {
        throw new DeploymentError(
          'deployment_state_conflict',
          'Products may only be frozen before compatibility verification completes',
        );
      }
      const source = this.database
        .prepare('SELECT * FROM deployment_sources WHERE deployment_id = ? AND product = ?')
        .get(product.deploymentId, product.product) as SqlRow | undefined;
      if (!source) {
        throw new DeploymentError('deployment_invalid', 'Product has no frozen source identity');
      }
      const mappedSource = mapSource(source);
      if (
        mappedSource.repository !== product.repository ||
        mappedSource.commit !== product.commit ||
        mappedSource.tree !== product.tree
      ) {
        throw new DeploymentError('deployment_conflict', 'Product differs from frozen source');
      }
      const existing = this.database
        .prepare('SELECT * FROM deployment_products WHERE deployment_id = ? AND product = ?')
        .get(product.deploymentId, product.product) as SqlRow | undefined;
      if (existing) {
        const mapped = mapProduct(existing);
        if (canonicalJson(mapped) === canonicalJson(product)) return mapped;
        throw new DeploymentError('deployment_conflict', 'Product identity is immutable');
      }
      this.database
        .prepare(
          `INSERT INTO deployment_products(
            deployment_id, product, repository, commit_id, tree_id,
            manifest_digest, artifact_digest, compatibility_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          product.deploymentId,
          product.product,
          product.repository,
          product.commit,
          product.tree,
          product.manifestDigest,
          product.artifactDigest,
          product.compatibilityDigest,
        );
      return product;
    });
  }

  listProducts(deploymentId: string): DeploymentProductRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM deployment_products WHERE deployment_id = ? ORDER BY product')
        .all(deploymentId) as SqlRow[]
    ).map(mapProduct);
  }

  appendEvidence(evidence: DeploymentEvidenceRecord): DeploymentEvidenceRecord {
    assertIdentifier(evidence.deploymentId, 'deploymentId');
    assertIdentifier(evidence.kind, 'evidence kind');
    assertIdentifier(evidence.signingKeyId, 'signingKeyId');
    assertDigest(evidence.digest, 'evidence digest');
    assertTimestamp(evidence.createdAt, 'createdAt');
    if (!Number.isSafeInteger(evidence.contentLength) || evidence.contentLength < 0) {
      throw new DeploymentError('deployment_invalid', 'contentLength must be nonnegative');
    }
    if (evidence.artifactReference !== `artifact:sha256:${evidence.digest}`) {
      throw new DeploymentError(
        'deployment_invalid',
        'Evidence must use its exact content-addressed artifact reference',
      );
    }
    if (!evidence.redacted) {
      throw new DeploymentError('deployment_invalid', 'Durable public evidence must be redacted');
    }
    if (evidence.signatureAlgorithm !== 'ed25519') {
      throw new DeploymentError('deployment_invalid', 'Evidence must use Ed25519');
    }
    if (!/^[A-Za-z0-9+/]{32,}={0,2}$/.test(evidence.signature)) {
      throw new DeploymentError('deployment_invalid', 'Evidence signature is invalid');
    }

    return this.transaction(() => {
      this.getDeploymentRequired(evidence.deploymentId);
      const existing = this.database
        .prepare(
          'SELECT * FROM deployment_evidence WHERE deployment_id = ? AND digest = ? AND kind = ?',
        )
        .get(evidence.deploymentId, evidence.digest, evidence.kind) as SqlRow | undefined;
      if (existing) {
        const mapped = mapEvidence(existing);
        if (canonicalJson(mapped) === canonicalJson(evidence)) return mapped;
        throw new DeploymentError('deployment_conflict', 'Evidence identity is immutable');
      }
      this.database
        .prepare(
          `INSERT INTO deployment_evidence(
            deployment_id, digest, kind, content_length, artifact_reference,
            redacted, signature_algorithm, signing_key_id, signature, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evidence.deploymentId,
          evidence.digest,
          evidence.kind,
          evidence.contentLength,
          evidence.artifactReference,
          evidence.redacted ? 1 : 0,
          evidence.signatureAlgorithm,
          evidence.signingKeyId,
          evidence.signature,
          evidence.createdAt,
        );
      return evidence;
    });
  }

  listEvidence(deploymentId: string, kind?: string): DeploymentEvidenceRecord[] {
    const statement = kind
      ? this.database.prepare(
          'SELECT * FROM deployment_evidence WHERE deployment_id = ? AND kind = ? ORDER BY created_at, digest',
        )
      : this.database.prepare(
          'SELECT * FROM deployment_evidence WHERE deployment_id = ? ORDER BY created_at, digest',
        );
    const rows = (kind ? statement.all(deploymentId, kind) : statement.all(deploymentId)) as SqlRow[];
    return rows.map(mapEvidence);
  }

  transition(input: DeploymentTransitionInput): DeploymentTransitionRecord {
    this.validateTransitionInput(input);
    const intentDigest = sha256Hex(
      canonicalJson({
        deploymentId: input.deploymentId,
        generation: input.generation,
        expectedState: input.expectedState,
        expectedSequence: input.expectedSequence,
        nextState: input.nextState,
        evidence: [...input.evidence].sort((a, b) =>
          `${a.kind}:${a.digest}`.localeCompare(`${b.kind}:${b.digest}`),
        ),
        actor: input.actor,
        occurredAt: input.occurredAt,
        reason: input.reason ?? null,
        guardStatus: input.guardStatus ?? null,
        successMarkerDigest: input.successMarkerDigest ?? null,
        signatureAlgorithm: input.signatureAlgorithm ?? null,
      }),
    );

    return this.transaction(() => {
      const priorAttempt = this.database
        .prepare(
          'SELECT * FROM deployment_transitions WHERE deployment_id = ? AND idempotency_key = ?',
        )
        .get(input.deploymentId, input.idempotencyKey) as SqlRow | undefined;
      if (priorAttempt) {
        const mapped = mapTransition(priorAttempt);
        if (mapped.intentDigest === intentDigest) return mapped;
        throw new DeploymentError('idempotency_conflict', 'Transition idempotency key changed intent', {
          existingIntentDigest: mapped.intentDigest,
        });
      }

      const deployment = this.getDeploymentRequired(input.deploymentId);
      if (deployment.terminal) {
        throw new DeploymentError('deployment_terminal', 'Terminal deployment is immutable');
      }
      if (deployment.generation !== input.generation) {
        throw new DeploymentError(
          'deployment_generation_conflict',
          'Deployment generation compare-and-swap failed',
          { expected: input.generation, actual: deployment.generation },
        );
      }
      if (
        deployment.state !== input.expectedState ||
        deployment.stateSequence !== input.expectedSequence
      ) {
        throw new DeploymentError(
          'deployment_state_conflict',
          'Deployment state compare-and-swap failed',
          {
            expectedState: input.expectedState,
            actualState: deployment.state,
            expectedSequence: input.expectedSequence,
            actualSequence: deployment.stateSequence,
          },
        );
      }

      const rule = assertTransitionAllowed(deployment.guardArmed, input);
      if (input.nextState === 'preflight') {
        const products = this.listProducts(input.deploymentId);
        if (products.length !== DEPLOYMENT_PRODUCTS.length) {
          throw new DeploymentError(
            'deployment_transition_forbidden',
            'Preflight requires immutable manifests for both products',
          );
        }
        if (new Set(products.map((product) => product.compatibilityDigest)).size !== 1) {
          throw new DeploymentError(
            'deployment_transition_forbidden',
            'Product manifests do not bind one compatibility declaration',
          );
        }
      }
      for (const reference of input.evidence) {
        const found = this.database
          .prepare(
            'SELECT 1 AS present FROM deployment_evidence WHERE deployment_id = ? AND digest = ? AND kind = ?',
          )
          .get(input.deploymentId, reference.digest, reference.kind);
        if (!found) {
          throw new DeploymentError(
            'deployment_evidence_missing',
            `Evidence ${reference.kind}:${reference.digest} is not in the deployment ledger`,
          );
        }
      }

      const terminal = TERMINAL_STATES.has(input.nextState);
      if (
        terminal &&
        (input.signatureAlgorithm !== 'ed25519' || !input.signingKeyId || !input.signature)
      ) {
        throw new DeploymentError(
          'deployment_transition_forbidden',
          'Every terminal transition requires a signature',
        );
      }
      if (input.successMarkerDigest) assertDigest(input.successMarkerDigest, 'successMarkerDigest');
      if (
        input.nextState === 'succeeded' &&
        deployment.successMarkerDigest !== input.successMarkerDigest
      ) {
        throw new DeploymentError(
          'deployment_transition_forbidden',
          'Success marker changed after guard disarming began',
        );
      }
      const sequence = deployment.stateSequence + 1;
      const transitionDigest = sha256Hex(
        canonicalJson({
          priorRecordDigest: deployment.recordDigest,
          intentDigest,
          sequence,
          mutationClass: rule.mutationClass,
          terminalTruth: rule.terminalTruth,
        }),
      );
      const guardArmed =
        input.guardStatus === 'armed'
          ? true
          : input.guardStatus === 'disarmed'
            ? false
            : deployment.guardArmed;
      const successMarkerDigest = input.successMarkerDigest ?? deployment.successMarkerDigest;
      const recordDigest = sha256Hex(
        canonicalJson({
          priorRecordDigest: deployment.recordDigest,
          transitionDigest,
          state: input.nextState,
          stateSequence: sequence,
          guardArmed,
          successMarkerDigest: successMarkerDigest ?? null,
          terminal,
        }),
      );

      this.database
        .prepare(
          `INSERT INTO deployment_transitions(
            deployment_id, sequence, generation, prior_state, next_state,
            idempotency_key, evidence_json, actor, occurred_at, reason,
            guard_status, success_marker_digest, signing_key_id, signature,
            signature_algorithm, intent_digest, transition_digest, terminal
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.deploymentId,
          sequence,
          input.generation,
          input.expectedState,
          input.nextState,
          input.idempotencyKey,
          canonicalJson(input.evidence),
          input.actor,
          input.occurredAt,
          input.reason ?? null,
          input.guardStatus ?? null,
          input.successMarkerDigest ?? null,
          input.signingKeyId ?? null,
          input.signature ?? null,
          input.signatureAlgorithm ?? null,
          intentDigest,
          transitionDigest,
          terminal ? 1 : 0,
        );
      const updated = this.database
        .prepare(
          `UPDATE deployments SET
            state = ?, state_sequence = ?, guard_armed = ?, success_marker_digest = ?,
            terminal = ?, record_digest = ?, updated_at = ?
          WHERE deployment_id = ? AND generation = ? AND state = ? AND state_sequence = ?`,
        )
        .run(
          input.nextState,
          sequence,
          guardArmed ? 1 : 0,
          successMarkerDigest ?? null,
          terminal ? 1 : 0,
          recordDigest,
          input.occurredAt,
          input.deploymentId,
          input.generation,
          input.expectedState,
          input.expectedSequence,
        );
      if (updated.changes !== 1) {
        throw new DeploymentError('deployment_state_conflict', 'Deployment CAS update failed');
      }

      const row = this.database
        .prepare('SELECT * FROM deployment_transitions WHERE deployment_id = ? AND sequence = ?')
        .get(input.deploymentId, sequence) as SqlRow;
      return mapTransition(row);
    });
  }

  private validateTransitionInput(input: DeploymentTransitionInput): void {
    assertIdentifier(input.deploymentId, 'deploymentId');
    assertIdentifier(input.actor, 'actor');
    assertIdempotencyKey(input.idempotencyKey);
    assertTimestamp(input.occurredAt, 'occurredAt');
    if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
      throw new DeploymentError('deployment_invalid', 'generation must be positive');
    }
    if (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0) {
      throw new DeploymentError('deployment_invalid', 'expectedSequence must be nonnegative');
    }
    if (input.evidence.length === 0) {
      throw new DeploymentError('deployment_evidence_missing', 'Transition evidence is required');
    }
    const unique = new Set<string>();
    for (const evidence of input.evidence) {
      assertIdentifier(evidence.kind, 'evidence kind');
      assertDigest(evidence.digest, 'evidence digest');
      const key = `${evidence.kind}:${evidence.digest}`;
      if (unique.has(key)) {
        throw new DeploymentError('deployment_invalid', 'Duplicate transition evidence');
      }
      unique.add(key);
    }
    if (input.signingKeyId) assertIdentifier(input.signingKeyId, 'signingKeyId');
    if (input.signatureAlgorithm && input.signatureAlgorithm !== 'ed25519') {
      throw new DeploymentError('deployment_invalid', 'Transition must use Ed25519');
    }
    if (input.signature && !/^[A-Za-z0-9+/]{32,}={0,2}$/.test(input.signature)) {
      throw new DeploymentError('deployment_invalid', 'Transition signature is invalid');
    }
  }

  listTransitions(deploymentId: string): DeploymentTransitionRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM deployment_transitions WHERE deployment_id = ? ORDER BY sequence')
        .all(deploymentId) as SqlRow[]
    ).map(mapTransition);
  }

  reserveIntent(input: {
    idempotencyKey: string;
    semanticDigest: string;
    operation: string;
    deploymentId?: string;
    createdAt: string;
  }): IntentReservation {
    assertIdempotencyKey(input.idempotencyKey);
    assertDigest(input.semanticDigest, 'semanticDigest');
    assertIdentifier(input.operation, 'operation');
    assertTimestamp(input.createdAt, 'createdAt');
    if (input.deploymentId) this.getDeploymentRequired(input.deploymentId);

    return this.transaction(() => {
      const existing = this.database
        .prepare('SELECT * FROM request_intents WHERE idempotency_key = ?')
        .get(input.idempotencyKey) as SqlRow | undefined;
      if (existing) {
        const existingDigest = asString(existing, 'semantic_digest');
        if (existingDigest !== input.semanticDigest) {
          return { state: 'conflict', existingSemanticDigest: existingDigest };
        }
        if (asString(existing, 'status') === 'pending') return { state: 'pending' };
        const resultJson = asNullableString(existing, 'result_json');
        const resultDigest = asNullableString(existing, 'result_digest');
        if (!resultJson || !resultDigest) {
          throw new DeploymentError('deployment_integrity_failed', 'Completed intent has no result');
        }
        return { state: 'completed', resultDigest, result: JSON.parse(resultJson) as unknown };
      }
      this.database
        .prepare(
          `INSERT INTO request_intents(
            idempotency_key, semantic_digest, operation, deployment_id,
            status, result_digest, result_json, created_at, completed_at
          ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
        )
        .run(
          input.idempotencyKey,
          input.semanticDigest,
          input.operation,
          input.deploymentId ?? null,
          input.createdAt,
        );
      return { state: 'reserved' };
    });
  }

  completeIntent(input: {
    idempotencyKey: string;
    semanticDigest: string;
    result: unknown;
    completedAt: string;
  }): { resultDigest: string } {
    assertIdempotencyKey(input.idempotencyKey);
    assertDigest(input.semanticDigest, 'semanticDigest');
    assertTimestamp(input.completedAt, 'completedAt');
    const resultJson = canonicalJson(input.result);
    const resultDigest = sha256Hex(resultJson);
    return this.transaction(() => {
      const current = this.database
        .prepare('SELECT * FROM request_intents WHERE idempotency_key = ?')
        .get(input.idempotencyKey) as SqlRow | undefined;
      if (!current) {
        throw new DeploymentError('deployment_not_found', 'Request intent was not reserved');
      }
      if (asString(current, 'semantic_digest') !== input.semanticDigest) {
        throw new DeploymentError('idempotency_conflict', 'Request intent changed');
      }
      if (asString(current, 'status') === 'completed') {
        const existingDigest = asNullableString(current, 'result_digest');
        if (existingDigest === resultDigest) return { resultDigest };
        throw new DeploymentError('idempotency_conflict', 'Completed result changed');
      }
      const updated = this.database
        .prepare(
          `UPDATE request_intents SET
            status = 'completed', result_digest = ?, result_json = ?, completed_at = ?
          WHERE idempotency_key = ? AND status = 'pending'`,
        )
        .run(resultDigest, resultJson, input.completedAt, input.idempotencyKey);
      if (updated.changes !== 1) {
        throw new DeploymentError('deployment_conflict', 'Request intent completion raced');
      }
      return { resultDigest };
    });
  }
}
