// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Strict release-archive contract shared by Sez and gateway candidates. */

import { DeploymentError } from './deployment/types.js';

export const STRICT_ARCHIVE_PROFILE = 'se-z-bounded-link-free-v2';
export const PINNED_NODE_VERSION = '24.18.0';

const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._@/-]+$/;
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*\/$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

export interface ReleaseFileEntry {
  path: string;
  type: 'file' | 'directory';
  mode: string;
  size: number;
  digest: string;
}

export interface StrictArchiveDeclaration {
  format: 'tar.gz';
  digest: string;
  compressedSize: number;
  decompressedSize: number;
  memberCount: number;
  topLevelPrefix: string;
  strictProfile: typeof STRICT_ARCHIVE_PROFILE;
}

export interface ExtractableReleaseManifest {
  schemaVersion: '2.0.0';
  product: 'se-z' | 'se-z-gateway' | 'se-z-controller';
  repository: 'StealthEyeLLC/se-z' | 'StealthEyeLLC/se-z-gateway';
  releaseVersion: string;
  sourceDateEpoch: number;
  nodeVersion: typeof PINNED_NODE_VERSION;
  archive: StrictArchiveDeclaration;
  files: ReleaseFileEntry[];
}

export interface StrictArchiveLimits {
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  maxFileBytes: number;
  maxMembers: number;
}

export const DEFAULT_STRICT_ARCHIVE_LIMITS: Readonly<StrictArchiveLimits> = Object.freeze({
  maxCompressedBytes: 512 * 1024 * 1024,
  maxDecompressedBytes: 1024 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxMembers: 20_000,
});

export function assertReleaseVersion(version: string): void {
  if (!VERSION.test(version) || version === '0.2.1' || version === '0.2.2') {
    throw new DeploymentError(
      'deployment_invalid',
      `Invalid release version ${version}: malformed or explicitly reserved`,
    );
  }
}

export function parseMode(mode: string): number {
  if (!/^0[0-7]{3}$/.test(mode)) {
    throw new DeploymentError('deployment_invalid', `Invalid release mode ${mode}`);
  }
  const parsed = Number.parseInt(mode, 8);
  if ((parsed & 0o7000) !== 0) {
    throw new DeploymentError('deployment_invalid', `Special mode bits are forbidden: ${mode}`);
  }
  return parsed;
}

export function formatMode(mode: number): string {
  if (!Number.isInteger(mode) || mode < 0 || (mode & ~0o777) !== 0) {
    throw new DeploymentError('deployment_invalid', `Invalid numeric release mode ${mode}`);
  }
  return `0${mode.toString(8).padStart(3, '0')}`;
}

export function assertReleaseFileEntry(entry: ReleaseFileEntry): void {
  if (
    !SAFE_RELATIVE_PATH.test(entry.path) ||
    entry.path.startsWith('/') ||
    entry.path.endsWith('/') ||
    entry.path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new DeploymentError('deployment_invalid', `Unsafe manifest path ${entry.path}`);
  }
  parseMode(entry.mode);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new DeploymentError('deployment_invalid', `Invalid size for ${entry.path}`);
  }
  if (!DIGEST.test(entry.digest)) {
    throw new DeploymentError('deployment_invalid', `Invalid digest for ${entry.path}`);
  }
  if (entry.type === 'directory' && entry.size !== 0) {
    throw new DeploymentError('deployment_invalid', `Directory ${entry.path} has nonzero size`);
  }
}

export function validateExtractableManifest(
  manifest: ExtractableReleaseManifest,
  limits: StrictArchiveLimits = DEFAULT_STRICT_ARCHIVE_LIMITS,
): Map<string, ReleaseFileEntry> {
  if (manifest.schemaVersion !== '2.0.0') {
    throw new DeploymentError('deployment_invalid', 'Unsupported release manifest version');
  }
  const expectedRepository = manifest.product === 'se-z-controller'
    ? 'StealthEyeLLC/se-z'
    : `StealthEyeLLC/${manifest.product}`;
  if (manifest.repository !== expectedRepository) {
    throw new DeploymentError('deployment_invalid', 'Release repository/product mismatch');
  }
  assertReleaseVersion(manifest.releaseVersion);
  if (manifest.nodeVersion !== PINNED_NODE_VERSION) {
    throw new DeploymentError('deployment_invalid', 'Release Node version is not pinned');
  }
  if (!Number.isSafeInteger(manifest.sourceDateEpoch) || manifest.sourceDateEpoch < 0) {
    throw new DeploymentError('deployment_invalid', 'Invalid source-date epoch');
  }
  if (
    manifest.archive.format !== 'tar.gz' ||
    manifest.archive.strictProfile !== STRICT_ARCHIVE_PROFILE ||
    !DIGEST.test(manifest.archive.digest) ||
    !SAFE_PREFIX.test(manifest.archive.topLevelPrefix)
  ) {
    throw new DeploymentError('deployment_invalid', 'Invalid strict archive declaration');
  }
  if (
    !Number.isSafeInteger(manifest.archive.compressedSize) ||
    manifest.archive.compressedSize <= 0 ||
    manifest.archive.compressedSize > limits.maxCompressedBytes ||
    !Number.isSafeInteger(manifest.archive.decompressedSize) ||
    manifest.archive.decompressedSize <= 0 ||
    manifest.archive.decompressedSize > limits.maxDecompressedBytes ||
    !Number.isSafeInteger(manifest.archive.memberCount) ||
    manifest.archive.memberCount <= 0 ||
    manifest.archive.memberCount > limits.maxMembers
  ) {
    throw new DeploymentError('deployment_invalid', 'Archive declaration exceeds strict bounds');
  }
  const expected = new Map<string, ReleaseFileEntry>();
  for (const entry of manifest.files) {
    assertReleaseFileEntry(entry);
    if (entry.size > limits.maxFileBytes) {
      throw new DeploymentError('deployment_invalid', `Manifest file exceeds limit: ${entry.path}`);
    }
    if (expected.has(entry.path)) {
      throw new DeploymentError('deployment_invalid', `Duplicate manifest path ${entry.path}`);
    }
    expected.set(entry.path, Object.freeze({ ...entry }));
  }
  if (manifest.archive.memberCount !== expected.size + 1) {
    throw new DeploymentError(
      'deployment_invalid',
      'Archive member count must include one top-level root plus every manifest entry',
    );
  }
  return expected;
}
