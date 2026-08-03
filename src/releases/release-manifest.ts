// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Candidate build records and deterministic Ed25519 release manifests. */

import type { KeyObject } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../protocol/canonical/canonical.js';
import { signEd25519, verifyEd25519 } from '../protocol/signatures/signing.js';
import type {
  ExtractableReleaseManifest,
  ReleaseFileEntry,
  StrictArchiveDeclaration,
} from './archive-contract.js';
import { PINNED_NODE_VERSION } from './archive-contract.js';

export interface ReleaseDeclaration {
  supported: boolean;
  strategy: string;
  evidenceDigest: string;
}

export interface PeerCompatibility {
  minimumRelease: string;
  maximumRelease: string;
  protocolVersions: string[];
  receiptVersions: string[];
  catalogVersions: string[];
}

export interface CandidateBuildRecord extends ExtractableReleaseManifest {
  recordVersion: '2.0.0';
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
  internalManifestDigest: string;
  sbom: {
    digest: string;
    artifactReference: string;
    format: 'spdx-json-2.3';
  };
  testEvidenceIndexDigest: string;
  compatibilityDigest: string;
  stateMigration: ReleaseDeclaration;
  rollback: ReleaseDeclaration;
  peerCompatibility: PeerCompatibility;
  nativeAddon?: {
    path: 'lib/build/Release/peer_cred.node';
    digest: string;
    nodeAbi: string;
    loadEvidenceDigest: string;
  };
}

export interface SignedReleaseManifest extends CandidateBuildRecord {
  reproducibility: {
    firstDigest: string;
    secondDigest: string;
    byteIdentical: true;
    evidenceDigest: string;
  };
  manifestDigest: string;
  signatureAlgorithm: 'ed25519';
  signingKeyId: string;
  signature: string;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function assertDigest(digest: string, label: string): void {
  if (!DIGEST_PATTERN.test(digest)) throw new Error(`${label} is not a lowercase SHA-256`);
}

function withoutSignature(manifest: SignedReleaseManifest): Omit<SignedReleaseManifest, 'signature'> {
  const { signature: _signature, ...body } = manifest;
  return body;
}

function signingDocument(body: Omit<SignedReleaseManifest, 'signature'>): string {
  const { manifestDigest, ...digestBody } = body;
  const computed = sha256Hex(canonicalJson(digestBody));
  if (computed !== manifestDigest) throw new Error('Release manifest digest is invalid');
  return canonicalJson({ manifestDigest, manifest: digestBody });
}

export function buildSignedReleaseManifest(input: {
  first: CandidateBuildRecord;
  second: CandidateBuildRecord;
  signingKeyId: string;
  privateKey: KeyObject;
}): SignedReleaseManifest {
  const firstCanonical = canonicalJson(input.first);
  const secondCanonical = canonicalJson(input.second);
  if (firstCanonical !== secondCanonical) {
    throw new Error('Isolated build records differ; reproducibility is not proven');
  }
  if (input.first.archive.digest !== input.second.archive.digest) {
    throw new Error('Isolated archive digests differ; release is blocked');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.signingKeyId)) {
    throw new Error('Invalid release signing key ID');
  }
  const reproducibility = {
    firstDigest: input.first.archive.digest,
    secondDigest: input.second.archive.digest,
    byteIdentical: true as const,
    evidenceDigest: sha256Hex(
      canonicalJson({
        buildRecordDigest: sha256Hex(firstCanonical),
        firstDigest: input.first.archive.digest,
        secondDigest: input.second.archive.digest,
        byteIdentical: true,
      }),
    ),
  };
  const digestBody = {
    ...input.first,
    reproducibility,
    signatureAlgorithm: 'ed25519' as const,
    signingKeyId: input.signingKeyId,
  };
  const manifestDigest = sha256Hex(canonicalJson(digestBody));
  const body = { ...digestBody, manifestDigest };
  return {
    ...body,
    signature: signEd25519(signingDocument(body), input.privateKey),
  };
}

export function verifySignedReleaseManifest(
  manifest: SignedReleaseManifest,
  publicKey: KeyObject,
): boolean {
  try {
    if (
      manifest.schemaVersion !== '2.0.0' ||
      manifest.recordVersion !== '2.0.0' ||
      manifest.nodeVersion !== PINNED_NODE_VERSION ||
      manifest.signatureAlgorithm !== 'ed25519' ||
      manifest.reproducibility.byteIdentical !== true ||
      manifest.reproducibility.firstDigest !== manifest.archive.digest ||
      manifest.reproducibility.secondDigest !== manifest.archive.digest
    ) return false;
    for (const [label, digest] of Object.entries({
      archive: manifest.archive.digest,
      manifest: manifest.manifestDigest,
      internalManifest: manifest.internalManifestDigest,
      compatibility: manifest.compatibilityDigest,
      tests: manifest.testEvidenceIndexDigest,
      reproducibility: manifest.reproducibility.evidenceDigest,
    })) assertDigest(digest, label);
    return verifyEd25519(signingDocument(withoutSignature(manifest)), manifest.signature, publicKey);
  } catch {
    return false;
  }
}

export interface PackageReleaseSpec {
  schemaVersion: '2.0.0';
  product: CandidateBuildRecord['product'];
  repository: CandidateBuildRecord['repository'];
  releaseVersion: string;
  commit: string;
  tree: string;
  sourceDateEpoch: number;
  lockfileDigest: string;
  buildCommandDigest: string;
  environmentIdentity: CandidateBuildRecord['environmentIdentity'];
  testEvidenceIndexDigest: string;
  compatibilityDigest: string;
  stateMigration: ReleaseDeclaration;
  rollback: ReleaseDeclaration;
  peerCompatibility: PeerCompatibility;
  requiredEntrypoints: string[];
  sbomPackages: Array<{
    name: string;
    version: string;
    license: string;
    integrity?: string;
  }>;
  nativeAddon?: {
    path: 'lib/build/Release/peer_cred.node';
    nodeAbi: string;
    loadEvidenceDigest: string;
  };
}

export interface PackageReleaseResult {
  buildRecord: CandidateBuildRecord;
  archive: StrictArchiveDeclaration;
  files: ReleaseFileEntry[];
}
