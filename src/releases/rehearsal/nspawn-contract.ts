// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Fixed records for the disposable, production-shaped systemd-nspawn lane. */

import type { KeyObject } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import { signEd25519, verifyEd25519 } from '../../protocol/signatures/signing.js';

export const NSPAWN_RECORD_VERSION = '1.0.0' as const;
export const NSPAWN_PROFILE = 'standalone-deployment-v2' as const;

const DIGEST = /^[a-f0-9]{64}$/;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,47}$/;
const ZFS_GUID = /^[1-9][0-9]{0,19}$/;
const REPOSITORIES = Object.freeze({
  sez: 'StealthEyeLLC/se-z',
  gateway: 'StealthEyeLLC/se-z-gateway',
});

export interface NspawnSourceIdentity {
  repository: string;
  commit: string;
  tree: string;
  bundleDigest: string;
}

export interface NspawnRunPlanPayload {
  recordVersion: typeof NSPAWN_RECORD_VERSION;
  recordType: 'se-z-nspawn-run-plan';
  profile: typeof NSPAWN_PROFILE;
  runId: string;
  requestedAt: string;
  deadline: string;
  baseSnapshot: string;
  baseSnapshotGuid: string;
  harnessDigest: string;
  dependencyCacheDigest: string;
  inputs: {
    sez: NspawnSourceIdentity;
    gateway: NspawnSourceIdentity;
  };
}

export interface NspawnRunPlan extends NspawnRunPlanPayload {
  planDigest: string;
}

export interface NspawnEvidenceFile {
  path: string;
  size: number;
  digest: string;
}

export type NspawnCleanupDisposition =
  | 'destroyed'
  | 'not_created'
  | 'manual_recovery_required';

export interface NspawnRunReceiptPayload {
  recordVersion: typeof NSPAWN_RECORD_VERSION;
  recordType: 'se-z-nspawn-run-receipt';
  profile: typeof NSPAWN_PROFILE;
  runId: string;
  planDigest: string;
  baseSnapshot: string;
  baseSnapshotGuid: string;
  cloneDataset: string;
  machineName: string;
  startedAt: string;
  completedAt: string;
  outcome: 'passed' | 'failed';
  errorCode: string | null;
  evidenceFiles: NspawnEvidenceFile[];
  cleanup: {
    clone: NspawnCleanupDisposition;
    machine: 'stopped' | 'not_started' | 'manual_recovery_required';
  };
  signingKeyId: string;
  signatureAlgorithm: 'ed25519';
}

export interface SignedNspawnRunReceipt extends NspawnRunReceiptPayload {
  recordDigest: string;
  signature: string;
}

const PLAN_PAYLOAD_KEYS = [
  'recordVersion',
  'recordType',
  'profile',
  'runId',
  'requestedAt',
  'deadline',
  'baseSnapshot',
  'baseSnapshotGuid',
  'harnessDigest',
  'dependencyCacheDigest',
  'inputs',
] as const;

const RECEIPT_PAYLOAD_KEYS = [
  'recordVersion',
  'recordType',
  'profile',
  'runId',
  'planDigest',
  'baseSnapshot',
  'baseSnapshotGuid',
  'cloneDataset',
  'machineName',
  'startedAt',
  'completedAt',
  'outcome',
  'errorCode',
  'evidenceFiles',
  'cleanup',
  'signingKeyId',
  'signatureAlgorithm',
] as const;

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateSource(value: unknown, repository: string): asserts value is NspawnSourceIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('nspawn source identity must be an object');
  }
  const source = value as Record<string, unknown>;
  exactKeys(source, ['repository', 'commit', 'tree', 'bundleDigest'], 'nspawn source identity');
  if (
    source.repository !== repository ||
    typeof source.commit !== 'string' ||
    !GIT_OBJECT.test(source.commit) ||
    typeof source.tree !== 'string' ||
    !GIT_OBJECT.test(source.tree) ||
    typeof source.bundleDigest !== 'string' ||
    !DIGEST.test(source.bundleDigest)
  ) {
    throw new Error('nspawn source identity is invalid');
  }
}

function validatePlanPayload(value: unknown): asserts value is NspawnRunPlanPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('nspawn run plan must be an object');
  }
  const plan = value as Record<string, unknown>;
  exactKeys(plan, PLAN_PAYLOAD_KEYS, 'nspawn run plan payload');
  if (
    plan.recordVersion !== NSPAWN_RECORD_VERSION ||
    plan.recordType !== 'se-z-nspawn-run-plan' ||
    plan.profile !== NSPAWN_PROFILE ||
    typeof plan.runId !== 'string' ||
    !RUN_ID.test(plan.runId) ||
    typeof plan.requestedAt !== 'string' ||
    !validTimestamp(plan.requestedAt) ||
    typeof plan.deadline !== 'string' ||
    !validTimestamp(plan.deadline) ||
    Date.parse(plan.deadline) <= Date.parse(plan.requestedAt) ||
    typeof plan.baseSnapshot !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,254}@[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,254}$/.test(plan.baseSnapshot) ||
    typeof plan.baseSnapshotGuid !== 'string' ||
    !ZFS_GUID.test(plan.baseSnapshotGuid) ||
    typeof plan.harnessDigest !== 'string' ||
    !DIGEST.test(plan.harnessDigest) ||
    typeof plan.dependencyCacheDigest !== 'string' ||
    !DIGEST.test(plan.dependencyCacheDigest) ||
    plan.inputs === null ||
    typeof plan.inputs !== 'object' ||
    Array.isArray(plan.inputs)
  ) {
    throw new Error('nspawn run plan payload is invalid');
  }
  const inputs = plan.inputs as Record<string, unknown>;
  exactKeys(inputs, ['sez', 'gateway'], 'nspawn run inputs');
  validateSource(inputs.sez, REPOSITORIES.sez);
  validateSource(inputs.gateway, REPOSITORIES.gateway);
}

export function buildNspawnRunPlan(payload: NspawnRunPlanPayload): NspawnRunPlan {
  validatePlanPayload(payload);
  return { ...payload, planDigest: sha256Hex(canonicalJson(payload)) };
}

export function verifyNspawnRunPlan(value: unknown): NspawnRunPlan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('nspawn run plan must be an object');
  }
  const plan = value as Record<string, unknown>;
  exactKeys(plan, [...PLAN_PAYLOAD_KEYS, 'planDigest'], 'nspawn run plan');
  const payload = Object.fromEntries(PLAN_PAYLOAD_KEYS.map((key) => [key, plan[key]]));
  validatePlanPayload(payload);
  if (
    typeof plan.planDigest !== 'string' ||
    !DIGEST.test(plan.planDigest) ||
    plan.planDigest !== sha256Hex(canonicalJson(payload))
  ) {
    throw new Error('nspawn run plan digest mismatch');
  }
  return plan as unknown as NspawnRunPlan;
}

function validateEvidenceFiles(value: unknown): asserts value is NspawnEvidenceFile[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('invalid evidence inventory');
  let prior = '';
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('invalid evidence inventory entry');
    }
    const entry = item as Record<string, unknown>;
    exactKeys(entry, ['path', 'size', 'digest'], 'evidence inventory entry');
    if (
      typeof entry.path !== 'string' ||
      !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._/-]+$/.test(entry.path) ||
      entry.path <= prior ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.digest !== 'string' ||
      !DIGEST.test(entry.digest)
    ) {
      throw new Error('invalid or unsorted evidence inventory');
    }
    prior = entry.path;
  }
}

function validateReceiptPayload(value: unknown): asserts value is NspawnRunReceiptPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('nspawn run receipt must be an object');
  }
  const receipt = value as Record<string, unknown>;
  exactKeys(receipt, RECEIPT_PAYLOAD_KEYS, 'nspawn run receipt payload');
  if (
    receipt.recordVersion !== NSPAWN_RECORD_VERSION ||
    receipt.recordType !== 'se-z-nspawn-run-receipt' ||
    receipt.profile !== NSPAWN_PROFILE ||
    typeof receipt.runId !== 'string' ||
    !RUN_ID.test(receipt.runId) ||
    typeof receipt.planDigest !== 'string' ||
    !DIGEST.test(receipt.planDigest) ||
    typeof receipt.baseSnapshot !== 'string' ||
    !receipt.baseSnapshot.includes('@') ||
    typeof receipt.baseSnapshotGuid !== 'string' ||
    !ZFS_GUID.test(receipt.baseSnapshotGuid) ||
    typeof receipt.cloneDataset !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,511}$/.test(receipt.cloneDataset) ||
    typeof receipt.machineName !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{1,14}$/.test(receipt.machineName) ||
    typeof receipt.startedAt !== 'string' ||
    !validTimestamp(receipt.startedAt) ||
    typeof receipt.completedAt !== 'string' ||
    !validTimestamp(receipt.completedAt) ||
    Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt) ||
    !['passed', 'failed'].includes(receipt.outcome as string) ||
    !(receipt.errorCode === null || (
      typeof receipt.errorCode === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(receipt.errorCode)
    )) ||
    receipt.cleanup === null ||
    typeof receipt.cleanup !== 'object' ||
    Array.isArray(receipt.cleanup) ||
    typeof receipt.signingKeyId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.signingKeyId) ||
    receipt.signatureAlgorithm !== 'ed25519'
  ) {
    throw new Error('nspawn run receipt payload is invalid');
  }
  if (receipt.outcome === 'passed' && receipt.errorCode !== null) {
    throw new Error('passing nspawn receipt cannot contain an error');
  }
  if (receipt.outcome === 'failed' && receipt.errorCode === null) {
    throw new Error('failed nspawn receipt must contain an error');
  }
  const cleanup = receipt.cleanup as Record<string, unknown>;
  exactKeys(cleanup, ['clone', 'machine'], 'nspawn cleanup disposition');
  if (
    !['destroyed', 'not_created', 'manual_recovery_required'].includes(cleanup.clone as string) ||
    !['stopped', 'not_started', 'manual_recovery_required'].includes(cleanup.machine as string)
  ) {
    throw new Error('invalid nspawn cleanup disposition');
  }
  validateEvidenceFiles(receipt.evidenceFiles);
}

export function signNspawnRunReceipt(
  payload: NspawnRunReceiptPayload,
  privateKey: KeyObject,
): SignedNspawnRunReceipt {
  validateReceiptPayload(payload);
  const recordDigest = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    recordDigest,
    signature: signEd25519(canonicalJson({ ...payload, recordDigest }), privateKey),
  };
}

export function verifySignedNspawnRunReceipt(
  value: unknown,
  publicKey: KeyObject,
): SignedNspawnRunReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('signed nspawn run receipt must be an object');
  }
  const receipt = value as Record<string, unknown>;
  exactKeys(
    receipt,
    [...RECEIPT_PAYLOAD_KEYS, 'recordDigest', 'signature'],
    'signed nspawn run receipt',
  );
  const payload = Object.fromEntries(RECEIPT_PAYLOAD_KEYS.map((key) => [key, receipt[key]]));
  validateReceiptPayload(payload);
  if (
    typeof receipt.recordDigest !== 'string' ||
    !DIGEST.test(receipt.recordDigest) ||
    receipt.recordDigest !== sha256Hex(canonicalJson(payload)) ||
    typeof receipt.signature !== 'string' ||
    !verifyEd25519(
      canonicalJson({ ...payload, recordDigest: receipt.recordDigest }),
      receipt.signature,
      publicKey,
    )
  ) {
    throw new Error('nspawn run receipt integrity verification failed');
  }
  return receipt as unknown as SignedNspawnRunReceipt;
}
