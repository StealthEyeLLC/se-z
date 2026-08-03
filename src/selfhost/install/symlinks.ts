// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Atomic compare-and-swap release pointer management. */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

export class PointerCasError extends Error {
  constructor(
    message: string,
    public readonly expected: string | null,
    public readonly actual: string | null,
  ) {
    super(message);
    this.name = 'PointerCasError';
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readSymlinkTarget(linkPath: string): string | null {
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) throw new Error(`Pointer is not a symlink: ${linkPath}`);
    return readlinkSync(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function symlinkExists(linkPath: string): boolean {
  return readSymlinkTarget(linkPath) !== null;
}

/**
 * Publish one symlink with rename(2), fenced by an exact prior readback. The
 * pointer is never removed first, so readers see either the old or new target.
 */
export function atomicCompareAndSwapSymlink(
  linkPath: string,
  expectedTarget: string | null,
  newTarget: string,
): { previous: string | null; current: string } {
  const actual = readSymlinkTarget(linkPath);
  if (actual !== expectedTarget) {
    throw new PointerCasError(`Stale pointer compare-and-swap: ${linkPath}`, expectedTarget, actual);
  }
  const temporary = `${linkPath}.next-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    symlinkSync(newTarget, temporary);
    if (readlinkSync(temporary) !== newTarget) throw new Error('Temporary pointer readback failed');
    renameSync(temporary, linkPath);
    fsyncDirectory(dirname(linkPath));
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  const readback = readSymlinkTarget(linkPath);
  if (readback !== newTarget) throw new Error(`Pointer publication readback failed: ${linkPath}`);
  return { previous: actual, current: readback };
}

/** Remove an optional pointer only after exact target readback. */
export function atomicCompareAndRemoveSymlink(
  linkPath: string,
  expectedTarget: string,
): { previous: string; current: null } {
  const actual = readSymlinkTarget(linkPath);
  if (actual !== expectedTarget) {
    throw new PointerCasError(`Stale pointer removal: ${linkPath}`, expectedTarget, actual);
  }
  unlinkSync(linkPath);
  fsyncDirectory(dirname(linkPath));
  if (readSymlinkTarget(linkPath) !== null) throw new Error(`Pointer removal readback failed: ${linkPath}`);
  return { previous: expectedTarget, current: null };
}

export function atomicSwapSymlinks(
  currentLink: string,
  previousLink: string,
  newCurrentTarget: string,
  fences?: { expectedCurrent: string | null; expectedPrevious: string | null },
): { previous: string | null; current: string } {
  const oldCurrent = readSymlinkTarget(currentLink);
  const oldPrevious = readSymlinkTarget(previousLink);
  if (fences && (oldCurrent !== fences.expectedCurrent || oldPrevious !== fences.expectedPrevious)) {
    throw new PointerCasError(
      'Release pointer set differs from the signed activation intent',
      fences.expectedCurrent,
      oldCurrent,
    );
  }
  if (oldCurrent) {
    atomicCompareAndSwapSymlink(previousLink, oldPrevious, oldCurrent);
  }
  atomicCompareAndSwapSymlink(currentLink, oldCurrent, newCurrentTarget);
  return { previous: oldCurrent, current: newCurrentTarget };
}

export function rollbackSymlinks(
  currentLink: string,
  previousLink: string,
  fences?: { expectedCurrent: string | null; expectedPrevious: string | null },
): { current: string; previous: string | null } {
  const previousTarget = readSymlinkTarget(previousLink);
  if (!previousTarget) throw new Error('No previous release to roll back to');
  const currentTarget = readSymlinkTarget(currentLink);
  if (fences && (currentTarget !== fences.expectedCurrent || previousTarget !== fences.expectedPrevious)) {
    throw new PointerCasError(
      'Release pointer set differs from the signed rollback intent',
      fences.expectedCurrent,
      currentTarget,
    );
  }
  atomicCompareAndSwapSymlink(currentLink, currentTarget, previousTarget);
  if (currentTarget) atomicCompareAndSwapSymlink(previousLink, previousTarget, currentTarget);
  return { current: previousTarget, previous: currentTarget };
}
