// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Canonical Ed25519 controller record construction and verification. */

import { type KeyObject } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import { signEd25519, verifyEd25519 } from '../../protocol/signatures/signing.js';
import {
  CONTROLLER_RECORD_VERSION,
  ControllerError,
  type CandidateManifestDigests,
  type CandidatePointerTargets,
  type ControllerEvidencePayload,
  type DeploymentGuardPayload,
  type ExpectedPointers,
  type SignedControllerEvidence,
  type SignedDeploymentGuardRecord,
  type SignedSuccessMarker,
  type SuccessMarkerPayload,
} from './types.js';

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/?)+$/;

function fail(message: string): never {
  throw new ControllerError('controller_invalid_record', message);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unknown or missing fields`);
  }
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(`${label} is invalid`);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`${label} must be a SHA-256`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') fail(`${label} must be a timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail(`${label} must be canonical ISO-8601`);
  }
}

function assertManifestDigests(value: unknown): asserts value is CandidateManifestDigests {
  assertObject(value, 'candidateManifestDigests');
  assertExactKeys(value, ['sez', 'gateway'], 'candidateManifestDigests');
  assertDigest(value.sez, 'candidateManifestDigests.sez');
  assertDigest(value.gateway, 'candidateManifestDigests.gateway');
}

function assertPointer(value: unknown, label: string): void {
  assertObject(value, label);
  assertExactKeys(value, ['link', 'target'], label);
  if (typeof value.link !== 'string' || !ABSOLUTE_PATH.test(value.link) || value.link.includes('..')) {
    fail(`${label}.link must be a normalized absolute path`);
  }
  if (
    value.target !== null &&
    (typeof value.target !== 'string' || !ABSOLUTE_PATH.test(value.target) || value.target.includes('..'))
  ) {
    fail(`${label}.target must be null or a normalized absolute path`);
  }
}

export function assertExpectedPointers(value: unknown): asserts value is ExpectedPointers {
  assertObject(value, 'expectedPointers');
  assertExactKeys(value, ['sez', 'gateway'], 'expectedPointers');
  for (const product of ['sez', 'gateway'] as const) {
    const pointers = value[product];
    assertObject(pointers, `expectedPointers.${product}`);
    assertExactKeys(pointers, ['current', 'previous'], `expectedPointers.${product}`);
    assertPointer(pointers.current, `expectedPointers.${product}.current`);
    assertPointer(pointers.previous, `expectedPointers.${product}.previous`);
  }
  const exactLinks = {
    sez: {
      current: '/opt/se-z/current',
      previous: '/opt/se-z/previous',
    },
    gateway: {
      current: '/opt/se-z/gateway/current',
      previous: '/opt/se-z/gateway/previous',
    },
  } as const;
  const typed = value as unknown as ExpectedPointers;
  for (const product of ['sez', 'gateway'] as const) {
    if (
      typed[product].current.link !== exactLinks[product].current ||
      typed[product].previous.link !== exactLinks[product].previous
    ) fail(`expectedPointers.${product} uses a noncanonical link`);
    const releasePrefix = product === 'sez'
      ? '/opt/se-z/releases/'
      : '/opt/se-z/gateway/releases/';
    if (!typed[product].current.target?.startsWith(releasePrefix)) {
      fail(`expectedPointers.${product}.current must bind a known-good immutable release`);
    }
    if (
      typed[product].previous.target !== null &&
      !typed[product].previous.target.startsWith(releasePrefix)
    ) fail(`expectedPointers.${product}.previous must bind an immutable release`);
  }
}

function assertCandidatePointerTargets(value: unknown): asserts value is CandidatePointerTargets {
  assertObject(value, 'candidatePointerTargets');
  assertExactKeys(value, ['sez', 'gateway'], 'candidatePointerTargets');
  const expected = {
    sez: /^\/opt\/se-z\/releases\/(?!0\.2\.[12]$)[A-Za-z0-9._-]+$/,
    gateway: /^\/opt\/se-z\/gateway\/releases\/(?!0\.2\.[12]$)[A-Za-z0-9._-]+$/,
  } as const;
  for (const product of ['sez', 'gateway'] as const) {
    if (typeof value[product] !== 'string' || !expected[product].test(value[product])) {
      fail(`candidatePointerTargets.${product} is invalid or reserved`);
    }
  }
}

function assertIdentityPayload(value: Record<string, unknown>): void {
  if (value.recordVersion !== CONTROLLER_RECORD_VERSION) fail('recordVersion is unsupported');
  assertIdentifier(value.deploymentId, 'deploymentId');
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
    fail('generation must be a positive safe integer');
  }
  assertIdentifier(value.machineId, 'machineId');
  assertDigest(value.planDigest, 'planDigest');
  assertDigest(value.snapshotDigest, 'snapshotDigest');
  assertManifestDigests(value.candidateManifestDigests);
  assertCandidatePointerTargets(value.candidatePointerTargets);
  assertIdentifier(value.signingKeyId, 'signingKeyId');
  if (value.signatureAlgorithm !== 'ed25519') fail('signatureAlgorithm must be ed25519');
}

function assertCommonPayload(value: Record<string, unknown>): void {
  assertIdentityPayload(value);
  assertDigest(value.evidenceDigest, 'evidenceDigest');
}

const GUARD_PAYLOAD_KEYS = [
  'recordVersion', 'recordType', 'deploymentId', 'generation', 'machineId',
  'planDigest', 'snapshotDigest', 'candidateManifestDigests', 'candidatePointerTargets', 'expectedPointers',
  'deadline', 'evidenceDigest', 'signingKeyId', 'signatureAlgorithm',
] as const;

const SUCCESS_PAYLOAD_KEYS = [
  'recordVersion', 'recordType', 'deploymentId', 'generation', 'machineId',
  'planDigest', 'snapshotDigest', 'candidateManifestDigests', 'candidatePointerTargets', 'evidenceDigest',
  'acceptedAt', 'signingKeyId', 'signatureAlgorithm',
] as const;

const EVIDENCE_PAYLOAD_KEYS = [
  'recordVersion', 'recordType', 'deploymentId', 'generation', 'machineId',
  'planDigest', 'snapshotDigest', 'candidateManifestDigests', 'candidatePointerTargets', 'disposition',
  'detailsDigest', 'occurredAt', 'signingKeyId', 'signatureAlgorithm',
] as const;

function signedRecord<T extends Record<string, unknown>>(
  payload: T,
  privateKey: KeyObject,
): T & { recordDigest: string; signature: string } {
  const recordDigest = sha256Hex(canonicalJson(payload));
  const document = canonicalJson({ ...payload, recordDigest });
  return {
    ...payload,
    recordDigest,
    signature: signEd25519(document, privateKey),
  };
}

function verifyRecordSignature(
  value: Record<string, unknown>,
  payloadKeys: readonly string[],
  publicKey: KeyObject,
): void {
  assertDigest(value.recordDigest, 'recordDigest');
  if (typeof value.signature !== 'string' || value.signature.length < 32) {
    fail('signature is invalid');
  }
  const payload = Object.fromEntries(payloadKeys.map((key) => [key, value[key]]));
  const expectedDigest = sha256Hex(canonicalJson(payload));
  if (value.recordDigest !== expectedDigest) {
    throw new ControllerError('controller_integrity_failed', 'recordDigest does not match payload');
  }
  const document = canonicalJson({ ...payload, recordDigest: value.recordDigest });
  if (!verifyEd25519(document, value.signature, publicKey)) {
    throw new ControllerError('controller_signature_invalid', 'Ed25519 record signature is invalid');
  }
}

export function buildSignedGuardRecord(
  payload: DeploymentGuardPayload,
  privateKey: KeyObject,
): SignedDeploymentGuardRecord {
  assertGuardPayload(payload as unknown as Record<string, unknown>);
  return signedRecord(payload as unknown as Record<string, unknown>, privateKey) as unknown as SignedDeploymentGuardRecord;
}

function assertGuardPayload(value: Record<string, unknown>): void {
  assertExactKeys(value, GUARD_PAYLOAD_KEYS, 'guard payload');
  assertCommonPayload(value);
  if (value.recordType !== 'se-z-deployment-guard') fail('guard recordType is invalid');
  assertExpectedPointers(value.expectedPointers);
  assertTimestamp(value.deadline, 'deadline');
}

export function verifySignedGuardRecord(
  value: unknown,
  publicKey: KeyObject,
): SignedDeploymentGuardRecord {
  assertObject(value, 'guard record');
  assertExactKeys(value, [...GUARD_PAYLOAD_KEYS, 'recordDigest', 'signature'], 'guard record');
  const payload = Object.fromEntries(GUARD_PAYLOAD_KEYS.map((key) => [key, value[key]]));
  assertGuardPayload(payload);
  verifyRecordSignature(value, GUARD_PAYLOAD_KEYS, publicKey);
  return value as unknown as SignedDeploymentGuardRecord;
}

export function buildSignedSuccessMarker(
  payload: SuccessMarkerPayload,
  privateKey: KeyObject,
): SignedSuccessMarker {
  assertSuccessPayload(payload as unknown as Record<string, unknown>);
  return signedRecord(payload as unknown as Record<string, unknown>, privateKey) as unknown as SignedSuccessMarker;
}

function assertSuccessPayload(value: Record<string, unknown>): void {
  assertExactKeys(value, SUCCESS_PAYLOAD_KEYS, 'success payload');
  assertCommonPayload(value);
  if (value.recordType !== 'se-z-deployment-success') fail('success recordType is invalid');
  assertTimestamp(value.acceptedAt, 'acceptedAt');
}

export function verifySignedSuccessMarker(
  value: unknown,
  publicKey: KeyObject,
): SignedSuccessMarker {
  assertObject(value, 'success marker');
  assertExactKeys(value, [...SUCCESS_PAYLOAD_KEYS, 'recordDigest', 'signature'], 'success marker');
  const payload = Object.fromEntries(SUCCESS_PAYLOAD_KEYS.map((key) => [key, value[key]]));
  assertSuccessPayload(payload);
  verifyRecordSignature(value, SUCCESS_PAYLOAD_KEYS, publicKey);
  return value as unknown as SignedSuccessMarker;
}

export function buildSignedControllerEvidence(
  payload: ControllerEvidencePayload,
  privateKey: KeyObject,
): SignedControllerEvidence {
  assertEvidencePayload(payload as unknown as Record<string, unknown>);
  return signedRecord(payload as unknown as Record<string, unknown>, privateKey) as unknown as SignedControllerEvidence;
}

function assertEvidencePayload(value: Record<string, unknown>): void {
  assertExactKeys(value, EVIDENCE_PAYLOAD_KEYS, 'controller evidence payload');
  assertIdentityPayload(value);
  if (value.recordType !== 'se-z-controller-evidence') fail('evidence recordType is invalid');
  if (![
    'armed', 'pending', 'success_marker_valid', 'disarmed', 'stale_generation',
    'rolled_back', 'rollback_failed',
  ].includes(String(value.disposition))) fail('controller disposition is invalid');
  assertDigest(value.detailsDigest, 'detailsDigest');
  assertTimestamp(value.occurredAt, 'occurredAt');
}

export function verifySignedControllerEvidence(
  value: unknown,
  publicKey: KeyObject,
): SignedControllerEvidence {
  assertObject(value, 'controller evidence');
  assertExactKeys(value, [...EVIDENCE_PAYLOAD_KEYS, 'recordDigest', 'signature'], 'controller evidence');
  const payload = Object.fromEntries(EVIDENCE_PAYLOAD_KEYS.map((key) => [key, value[key]]));
  assertEvidencePayload(payload);
  verifyRecordSignature(value, EVIDENCE_PAYLOAD_KEYS, publicKey);
  return value as unknown as SignedControllerEvidence;
}

export function assertMarkerMatchesGuard(
  marker: SignedSuccessMarker,
  guard: SignedDeploymentGuardRecord,
): void {
  const exact =
    marker.deploymentId === guard.deploymentId &&
    marker.generation === guard.generation &&
    marker.machineId === guard.machineId &&
    marker.planDigest === guard.planDigest &&
    marker.snapshotDigest === guard.snapshotDigest &&
    marker.candidateManifestDigests.sez === guard.candidateManifestDigests.sez &&
    marker.candidateManifestDigests.gateway === guard.candidateManifestDigests.gateway &&
    marker.candidatePointerTargets.sez === guard.candidatePointerTargets.sez &&
    marker.candidatePointerTargets.gateway === guard.candidatePointerTargets.gateway &&
    marker.evidenceDigest === guard.evidenceDigest;
  if (!exact) {
    throw new ControllerError(
      'controller_marker_mismatch',
      'Success marker does not bind the exact guard generation and evidence',
    );
  }
}
