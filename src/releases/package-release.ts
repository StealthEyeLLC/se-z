// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Assemble deterministic internal metadata and package a prepared release tree. */

import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { canonicalJson, sha256Hex } from '../protocol/canonical/canonical.js';
import {
  PINNED_NODE_VERSION,
  assertReleaseVersion,
} from './archive-contract.js';
import { createDeterministicTarGz } from './deterministic-archive.js';
import type {
  CandidateBuildRecord,
  PackageReleaseResult,
  PackageReleaseSpec,
} from './release-manifest.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function assertDigest(value: string, label: string): void {
  if (!DIGEST_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function validateSpec(spec: PackageReleaseSpec): void {
  if (spec.schemaVersion !== '2.0.0') throw new Error('Unsupported release package spec');
  const expectedRepository = spec.product === 'se-z-controller'
    ? 'StealthEyeLLC/se-z'
    : `StealthEyeLLC/${spec.product}`;
  if (spec.repository !== expectedRepository) {
    throw new Error('Release product/repository mismatch');
  }
  assertReleaseVersion(spec.releaseVersion);
  if (!GIT_OBJECT_PATTERN.test(spec.commit) || !GIT_OBJECT_PATTERN.test(spec.tree)) {
    throw new Error('Release source identity is invalid');
  }
  if (!Number.isSafeInteger(spec.sourceDateEpoch) || spec.sourceDateEpoch < 0) {
    throw new Error('Release source-date epoch is invalid');
  }
  for (const [label, value] of Object.entries({
    lockfileDigest: spec.lockfileDigest,
    buildCommandDigest: spec.buildCommandDigest,
    toolchainDigest: spec.environmentIdentity.toolchainDigest,
    testEvidenceIndexDigest: spec.testEvidenceIndexDigest,
    compatibilityDigest: spec.compatibilityDigest,
    stateMigrationEvidence: spec.stateMigration.evidenceDigest,
    rollbackEvidence: spec.rollback.evidenceDigest,
    nativeLoadEvidence: spec.nativeAddon?.loadEvidenceDigest,
  })) {
    if (value !== undefined) assertDigest(value, label);
  }
  if (
    spec.environmentIdentity.locale !== 'C.UTF-8' ||
    spec.environmentIdentity.timezone !== 'UTC' ||
    spec.environmentIdentity.umask !== '0022'
  ) throw new Error('Release environment is not normalized');
  if (spec.requiredEntrypoints.length === 0 || new Set(spec.requiredEntrypoints).size !== spec.requiredEntrypoints.length) {
    throw new Error('Required release entrypoints are invalid');
  }
  if (spec.product === 'se-z' && !spec.nativeAddon) {
    throw new Error('Sez release must declare its native addon');
  }
}

function writeCanonical(path: string, value: unknown): string {
  const bytes = `${canonicalJson(value)}\n`;
  writeFileSync(path, bytes, { mode: 0o644, flag: 'wx' });
  chmodSync(path, 0o644);
  return sha256Hex(bytes);
}

export async function packagePreparedRelease(input: {
  releaseRoot: string;
  outputDirectory: string;
  spec: PackageReleaseSpec;
}): Promise<PackageReleaseResult> {
  validateSpec(input.spec);
  for (const entrypoint of input.spec.requiredEntrypoints) {
    if (!existsSync(join(input.releaseRoot, entrypoint))) {
      throw new Error(`Prepared release is missing required entrypoint ${entrypoint}`);
    }
  }

  const sbom = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${input.spec.product}-${input.spec.releaseVersion}`,
    documentNamespace: `https://se-z.stealtheye.io/spdx/${input.spec.product}/${input.spec.commit}`,
    creationInfo: {
      created: new Date(input.spec.sourceDateEpoch * 1000).toISOString(),
      creators: ['Tool: se-z-release-packager-2.0.0'],
    },
    packages: [...input.spec.sbomPackages]
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      .map((item, index) => ({
        SPDXID: `SPDXRef-Package-${index + 1}`,
        name: item.name,
        versionInfo: item.version,
        licenseConcluded: item.license,
        licenseDeclared: item.license,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        ...(item.integrity ? { externalRefs: [{ referenceType: 'purl', referenceLocator: item.integrity }] } : {}),
      })),
  };
  const sbomPath = join(input.releaseRoot, 'sbom.spdx.json');
  const sbomDigest = writeCanonical(sbomPath, sbom);

  const internalManifest = {
    schemaVersion: '2.0.0',
    product: input.spec.product,
    repository: input.spec.repository,
    releaseVersion: input.spec.releaseVersion,
    commit: input.spec.commit,
    tree: input.spec.tree,
    sourceDateEpoch: input.spec.sourceDateEpoch,
    lockfileDigest: input.spec.lockfileDigest,
    nodeVersion: PINNED_NODE_VERSION,
    buildCommandDigest: input.spec.buildCommandDigest,
    environmentIdentity: input.spec.environmentIdentity,
    compatibilityDigest: input.spec.compatibilityDigest,
    requiredEntrypoints: [...input.spec.requiredEntrypoints].sort(),
  };
  const internalManifestDigest = writeCanonical(
    join(input.releaseRoot, 'release.json'),
    internalManifest,
  );

  const prefix = `${input.spec.product}-${input.spec.releaseVersion}`;
  const archivePath = join(input.outputDirectory, `${prefix}.tar.gz`);
  const packaged = await createDeterministicTarGz({
    releaseRoot: input.releaseRoot,
    topLevelPrefix: prefix,
    archivePath,
    sourceDateEpoch: input.spec.sourceDateEpoch,
  });
  const nativeEntry = input.spec.nativeAddon
    ? packaged.files.find((entry) => entry.path === input.spec.nativeAddon?.path)
    : undefined;
  if (input.spec.nativeAddon && (!nativeEntry || nativeEntry.type !== 'file')) {
    throw new Error(`Native addon is absent at ${input.spec.nativeAddon.path}`);
  }
  const buildRecord: CandidateBuildRecord = {
    recordVersion: '2.0.0',
    schemaVersion: '2.0.0',
    product: input.spec.product,
    repository: input.spec.repository,
    releaseVersion: input.spec.releaseVersion,
    commit: input.spec.commit,
    tree: input.spec.tree,
    sourceDateEpoch: input.spec.sourceDateEpoch,
    lockfileDigest: input.spec.lockfileDigest,
    nodeVersion: PINNED_NODE_VERSION,
    buildCommandDigest: input.spec.buildCommandDigest,
    environmentIdentity: input.spec.environmentIdentity,
    archive: packaged.archive,
    internalManifestDigest,
    files: packaged.files,
    sbom: {
      digest: sbomDigest,
      artifactReference: `artifact:sha256:${sbomDigest}`,
      format: 'spdx-json-2.3',
    },
    testEvidenceIndexDigest: input.spec.testEvidenceIndexDigest,
    compatibilityDigest: input.spec.compatibilityDigest,
    stateMigration: input.spec.stateMigration,
    rollback: input.spec.rollback,
    peerCompatibility: input.spec.peerCompatibility,
    ...(input.spec.nativeAddon && nativeEntry
      ? {
          nativeAddon: {
            ...input.spec.nativeAddon,
            digest: nativeEntry.digest,
          },
        }
      : {}),
  };
  const buildPath = join(input.outputDirectory, `${prefix}.build.json`);
  writeFileSync(buildPath, `${canonicalJson(buildRecord)}\n`, { mode: 0o600, flag: 'wx' });
  const digestLine = `${packaged.archive.digest}  ${basename(archivePath)}\n`;
  writeFileSync(join(input.outputDirectory, `${prefix}.sha256`), digestLine, {
    mode: 0o600,
    flag: 'wx',
  });
  return { buildRecord, archive: packaged.archive, files: packaged.files };
}

export function loadPackageReleaseSpec(path: string): PackageReleaseSpec {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageReleaseSpec;
}
