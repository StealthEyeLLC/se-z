// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Strict create-once installation that cannot publish product pointers. */

import { type KeyObject } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import { readSymlinkTarget } from '../../selfhost/install/symlinks.js';
import { safeExtractTarGz } from '../../selfhost/install/safe-extract.js';
import {
  verifySignedReleaseManifest,
  type SignedReleaseManifest,
} from '../release-manifest.js';
import { DeploymentError, type DeploymentProduct } from './types.js';

export interface InactiveInstallResult {
  product: DeploymentProduct;
  releaseVersion: string;
  target: string;
  manifestDigest: string;
  archiveDigest: string;
  pointerReadbackDigest: string;
}

export interface InactiveInstallOptions {
  hostRoot: string;
  product: DeploymentProduct;
  archivePath: string;
  manifest: SignedReleaseManifest;
  releaseAuthorityPublicKey: KeyObject;
}

function mapped(hostRoot: string, absolutePath: string): string {
  if (!absolutePath.startsWith('/') || absolutePath.includes('..')) {
    throw new DeploymentError('deployment_invalid', 'Inactive install path is invalid');
  }
  const root = resolve(hostRoot);
  const result = root === '/' ? absolutePath : join(root, absolutePath.slice(1));
  if (root !== '/' && result !== root && !result.startsWith(`${root}/`)) {
    throw new DeploymentError('deployment_invalid', 'Inactive install escaped host root');
  }
  return result;
}

function pointerPaths(product: DeploymentProduct): { current: string; previous: string } {
  const root = product === 'se-z' ? '/opt/se-z' : '/opt/se-z/gateway';
  return { current: `${root}/current`, previous: `${root}/previous` };
}

export async function installInactiveCandidate(
  options: InactiveInstallOptions,
): Promise<InactiveInstallResult> {
  if (!verifySignedReleaseManifest(options.manifest, options.releaseAuthorityPublicKey)) {
    throw new DeploymentError('deployment_invalid', 'Candidate release signature is invalid');
  }
  if (options.manifest.product !== options.product) {
    throw new DeploymentError('deployment_invalid', 'Candidate product does not match install target');
  }
  if (['0.2.1', '0.2.2'].includes(options.manifest.releaseVersion)) {
    throw new DeploymentError('deployment_invalid', 'Reserved release version cannot be installed');
  }
  const releaseBase = options.product === 'se-z'
    ? '/opt/se-z/releases'
    : '/opt/se-z/gateway/releases';
  const target = mapped(options.hostRoot, `${releaseBase}/${options.manifest.releaseVersion}`);
  if (existsSync(target)) {
    throw new DeploymentError('deployment_conflict', 'Immutable inactive release target already exists');
  }
  const pointers = pointerPaths(options.product);
  const before = {
    current: readSymlinkTarget(mapped(options.hostRoot, pointers.current)),
    previous: readSymlinkTarget(mapped(options.hostRoot, pointers.previous)),
  };
  await safeExtractTarGz(
    options.archivePath,
    target,
    `${options.product}-${options.manifest.releaseVersion}`,
    { manifest: options.manifest },
  );
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DeploymentError('deployment_integrity_failed', 'Inactive target is not a real directory');
  }
  const after = {
    current: readSymlinkTarget(mapped(options.hostRoot, pointers.current)),
    previous: readSymlinkTarget(mapped(options.hostRoot, pointers.previous)),
  };
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new DeploymentError(
      'deployment_integrity_failed',
      'Inactive install changed a production pointer',
    );
  }
  return {
    product: options.product,
    releaseVersion: options.manifest.releaseVersion,
    target,
    manifestDigest: options.manifest.manifestDigest,
    archiveDigest: options.manifest.archive.digest,
    pointerReadbackDigest: sha256Hex(canonicalJson(after)),
  };
}
