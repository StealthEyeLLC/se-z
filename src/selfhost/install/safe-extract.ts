// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Compatibility wrapper around the one strict v2 release extractor. */

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  DEFAULT_STRICT_ARCHIVE_LIMITS,
  assertReleaseVersion,
  type ExtractableReleaseManifest,
} from '../../releases/archive-contract.js';
import { strictExtractRelease } from '../../releases/strict-extractor.js';

export const assertSafeVersion = assertReleaseVersion;

export interface SafeExtractOptions {
  manifest: ExtractableReleaseManifest;
  maxArchiveBytes?: number;
  maxDecompressedBytes?: number;
  maxFileBytes?: number;
  maxMembers?: number;
}

export async function safeExtractTarGz(
  archivePath: string,
  destinationRelease: string,
  expectedPrefix: string,
  options: SafeExtractOptions,
): Promise<void> {
  if (options.manifest.archive.topLevelPrefix !== `${expectedPrefix}/`) {
    throw new Error('Expected prefix differs from signed release manifest');
  }
  if (existsSync(destinationRelease)) {
    throw new Error('Inactive release destination already exists');
  }
  const parent = dirname(destinationRelease);
  const temporary = `${destinationRelease}.extract-${process.pid}-${randomUUID()}`;
  try {
    const result = await strictExtractRelease({
      archivePath,
      destination: temporary,
      manifest: options.manifest,
      limits: {
        maxCompressedBytes:
          options.maxArchiveBytes ?? DEFAULT_STRICT_ARCHIVE_LIMITS.maxCompressedBytes,
        maxDecompressedBytes:
          options.maxDecompressedBytes ?? DEFAULT_STRICT_ARCHIVE_LIMITS.maxDecompressedBytes,
        maxFileBytes: options.maxFileBytes ?? DEFAULT_STRICT_ARCHIVE_LIMITS.maxFileBytes,
        maxMembers: options.maxMembers ?? DEFAULT_STRICT_ARCHIVE_LIMITS.maxMembers,
      },
    });
    renameSync(result.releaseRoot, destinationRelease);
    rmdirSync(temporary);
    const parentFd = openSync(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
