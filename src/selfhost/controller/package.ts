// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Reproducible fixed-controller candidate record and strict verifier. */

import { type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import {
  PINNED_NODE_VERSION,
  validateExtractableManifest,
  type ExtractableReleaseManifest,
  type ReleaseFileEntry,
  type StrictArchiveDeclaration,
} from '../../releases/archive-contract.js';
import { strictExtractRelease } from '../../releases/strict-extractor.js';
import {
  buildSignedControllerRelease,
  inventoryControllerCandidate,
  verifySignedControllerRelease,
  type ControllerReleaseFile,
  type ControllerReleasePayload,
  type SignedControllerRelease,
} from './bootstrap.js';

const DIGEST = /^[a-f0-9]{64}$/;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface ControllerCandidateBuildRecord extends ExtractableReleaseManifest {
  recordVersion: '2.0.0';
  product: 'se-z-controller';
  repository: 'StealthEyeLLC/se-z';
  commit: string;
  tree: string;
  lockfileDigest: string;
  buildCommandDigest: string;
  environmentIdentity: {
    os: string;
    architecture: string;
    locale: 'C.UTF-8';
    timezone: 'UTC';
    umask: '0022';
    toolchainDigest: string;
  };
  files: ReleaseFileEntry[];
  controllerFiles: ControllerReleaseFile[];
  candidateDigest: string;
  testEvidenceIndexDigest: string;
}

export interface FinalizedControllerRelease {
  firstBuildDigest: string;
  secondBuildDigest: string;
  byteIdentical: true;
  release: SignedControllerRelease;
}

export function validateControllerBuildRecord(record: ControllerCandidateBuildRecord): void {
  validateExtractableManifest(record);
  if (
    record.recordVersion !== '2.0.0' ||
    record.product !== 'se-z-controller' ||
    record.repository !== 'StealthEyeLLC/se-z' ||
    record.nodeVersion !== PINNED_NODE_VERSION ||
    !GIT_OBJECT.test(record.commit) ||
    !GIT_OBJECT.test(record.tree)
  ) throw new Error('Controller build source identity is invalid');
  for (const value of [
    record.lockfileDigest,
    record.buildCommandDigest,
    record.environmentIdentity.toolchainDigest,
    record.candidateDigest,
    record.testEvidenceIndexDigest,
  ]) if (!DIGEST.test(value)) throw new Error('Controller build digest is invalid');
  if (
    record.environmentIdentity.locale !== 'C.UTF-8' ||
    record.environmentIdentity.timezone !== 'UTC' ||
    record.environmentIdentity.umask !== '0022'
  ) throw new Error('Controller build environment is not normalized');
  if (record.controllerFiles.length === 0) throw new Error('Controller file inventory is empty');
  if (
    sha256Hex(canonicalJson([...record.controllerFiles].sort((a, b) => a.path.localeCompare(b.path)))) !==
    record.candidateDigest
  ) throw new Error('Controller candidate digest mismatch');
}

export async function verifyControllerCandidate(input: {
  archivePath: string;
  buildRecord: ControllerCandidateBuildRecord;
}): Promise<{ archiveDigest: string; candidateDigest: string; fileCount: number }> {
  validateControllerBuildRecord(input.buildRecord);
  const workspace = mkdtempSync(join(tmpdir(), 'se-z-controller-verify-'));
  try {
    const extracted = await strictExtractRelease({
      archivePath: input.archivePath,
      destination: workspace,
      manifest: input.buildRecord,
    });
    const inventory = inventoryControllerCandidate(extracted.releaseRoot);
    if (canonicalJson(inventory) !== canonicalJson(input.buildRecord.controllerFiles)) {
      throw new Error('Extracted controller bytes or modes differ from build record');
    }
    return {
      archiveDigest: extracted.archiveDigest,
      candidateDigest: input.buildRecord.candidateDigest,
      fileCount: inventory.length,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function finalizeControllerRelease(input: {
  first: ControllerCandidateBuildRecord;
  second: ControllerCandidateBuildRecord;
  targetSlot: 'a' | 'b';
  expectedCurrentReleaseId: string | null;
  fallbackReleaseId: string | null;
  signingKeyId: string;
  privateKey: KeyObject;
}): FinalizedControllerRelease {
  validateControllerBuildRecord(input.first);
  validateControllerBuildRecord(input.second);
  const firstCanonical = canonicalJson(input.first);
  const secondCanonical = canonicalJson(input.second);
  if (firstCanonical !== secondCanonical || input.first.archive.digest !== input.second.archive.digest) {
    throw new Error('Controller builds are not byte-identical');
  }
  const payload: ControllerReleasePayload = {
    recordVersion: '2.0.0',
    recordType: 'se-z-controller-release',
    releaseId: `controller-${input.first.releaseVersion}`,
    repository: 'StealthEyeLLC/se-z',
    sourceCommit: input.first.commit,
    sourceTree: input.first.tree,
    sourceDateEpoch: input.first.sourceDateEpoch,
    archiveDigest: input.first.archive.digest,
    nodeVersion: PINNED_NODE_VERSION,
    buildCommandDigest: input.first.buildCommandDigest,
    candidateDigest: input.first.candidateDigest,
    files: input.first.controllerFiles,
    targetSlot: input.targetSlot,
    expectedCurrentReleaseId: input.expectedCurrentReleaseId,
    fallbackReleaseId: input.fallbackReleaseId,
    signingKeyId: input.signingKeyId,
    signatureAlgorithm: 'ed25519',
  };
  const release = buildSignedControllerRelease(payload, input.privateKey);
  return {
    firstBuildDigest: sha256Hex(firstCanonical),
    secondBuildDigest: sha256Hex(secondCanonical),
    byteIdentical: true,
    release,
  };
}

export function verifyFinalizedControllerRelease(
  finalized: FinalizedControllerRelease,
  publicKey: KeyObject,
): boolean {
  if (
    finalized.byteIdentical !== true ||
    finalized.firstBuildDigest !== finalized.secondBuildDigest ||
    !DIGEST.test(finalized.firstBuildDigest)
  ) return false;
  try {
    verifySignedControllerRelease(finalized.release, publicKey);
    return true;
  } catch {
    return false;
  }
}

export function loadControllerBuildRecord(path: string): ControllerCandidateBuildRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as ControllerCandidateBuildRecord;
}

export type { StrictArchiveDeclaration };
