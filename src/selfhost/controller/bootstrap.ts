// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Separate immutable bootstrap/A-B upgrade path for the fixed controller. */

import { type KeyObject } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import { signEd25519, verifyEd25519 } from '../../protocol/signatures/signing.js';
import { CONTROLLER_RECORD_VERSION, ControllerError } from './types.js';

const DIGEST = /^[a-f0-9]{64}$/;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._/-]+$/;
const MAX_CONTROLLER_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CONTROLLER_FILES = 4096;

export interface ControllerReleaseFile {
  path: string;
  mode: '0644' | '0755';
  size: number;
  digest: string;
}

export interface ControllerReleasePayload {
  recordVersion: typeof CONTROLLER_RECORD_VERSION;
  recordType: 'se-z-controller-release';
  releaseId: string;
  repository: 'StealthEyeLLC/se-z';
  sourceCommit: string;
  sourceTree: string;
  sourceDateEpoch: number;
  archiveDigest: string;
  nodeVersion: '24.18.0';
  buildCommandDigest: string;
  candidateDigest: string;
  files: ControllerReleaseFile[];
  targetSlot: 'a' | 'b';
  expectedCurrentReleaseId: string | null;
  fallbackReleaseId: string | null;
  signingKeyId: string;
  signatureAlgorithm: 'ed25519';
}

export interface SignedControllerRelease extends ControllerReleasePayload {
  recordDigest: string;
  signature: string;
}

export type ControllerInstallTransaction =
  | 'controller_bootstrap'
  | 'controller_upgrade'
  | 'product_deployment';

const PAYLOAD_KEYS = [
  'recordVersion', 'recordType', 'releaseId', 'repository', 'sourceCommit',
  'sourceTree', 'sourceDateEpoch', 'archiveDigest', 'nodeVersion', 'buildCommandDigest',
  'candidateDigest', 'files', 'targetSlot',
  'expectedCurrentReleaseId', 'fallbackReleaseId', 'signingKeyId',
  'signatureAlgorithm',
] as const;

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function validatePayload(value: ControllerReleasePayload): void {
  if (value.recordVersion !== CONTROLLER_RECORD_VERSION) throw new Error('unsupported version');
  if (value.recordType !== 'se-z-controller-release') throw new Error('wrong record type');
  if (!IDENTIFIER.test(value.releaseId) || basename(value.releaseId) !== value.releaseId) {
    throw new Error('invalid releaseId');
  }
  if (value.repository !== 'StealthEyeLLC/se-z') throw new Error('wrong repository');
  if (!GIT_OBJECT.test(value.sourceCommit) || !GIT_OBJECT.test(value.sourceTree)) {
    throw new Error('invalid source identity');
  }
  if (!Number.isSafeInteger(value.sourceDateEpoch) || value.sourceDateEpoch < 0) {
    throw new Error('invalid sourceDateEpoch');
  }
  if (!DIGEST.test(value.archiveDigest) || !DIGEST.test(value.buildCommandDigest)) {
    throw new Error('invalid controller package identity');
  }
  if (value.nodeVersion !== '24.18.0') throw new Error('controller Node version is not pinned');
  if (!DIGEST.test(value.candidateDigest)) throw new Error('invalid candidateDigest');
  if (!['a', 'b'].includes(value.targetSlot)) throw new Error('invalid targetSlot');
  for (const id of [value.expectedCurrentReleaseId, value.fallbackReleaseId]) {
    if (id !== null && (!IDENTIFIER.test(id) || basename(id) !== id)) throw new Error('invalid release fence');
  }
  if (!IDENTIFIER.test(value.signingKeyId) || value.signatureAlgorithm !== 'ed25519') {
    throw new Error('invalid signing metadata');
  }
  if (value.files.length < 1 || value.files.length > MAX_CONTROLLER_FILES) {
    throw new Error('invalid controller file count');
  }
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!RELATIVE_PATH.test(file.path) || file.path.includes('//') || paths.has(file.path)) {
      throw new Error('invalid or duplicate controller file path');
    }
    paths.add(file.path);
    if (!['0644', '0755'].includes(file.mode)) throw new Error('invalid controller file mode');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_CONTROLLER_FILE_BYTES) {
      throw new Error('invalid controller file size');
    }
    if (!DIGEST.test(file.digest)) throw new Error('invalid controller file digest');
  }
  if (!paths.has('bin/se-z-deploy-guard')) throw new Error('fixed controller entrypoint missing');
  const calculated = sha256Hex(canonicalJson([...value.files].sort((a, b) => a.path.localeCompare(b.path))));
  if (calculated !== value.candidateDigest) throw new Error('candidateDigest mismatch');
}

export function buildSignedControllerRelease(
  payload: ControllerReleasePayload,
  privateKey: KeyObject,
): SignedControllerRelease {
  validatePayload(payload);
  const recordDigest = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    recordDigest,
    signature: signEd25519(canonicalJson({ ...payload, recordDigest }), privateKey),
  };
}

export function verifySignedControllerRelease(
  input: unknown,
  publicKey: KeyObject,
): SignedControllerRelease {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ControllerError('controller_invalid_record', 'Controller release must be an object');
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [...PAYLOAD_KEYS, 'recordDigest', 'signature'].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ControllerError('controller_invalid_record', 'Controller release has unknown fields');
  }
  try {
    validatePayload(value as unknown as ControllerReleasePayload);
  } catch (error) {
    throw new ControllerError(
      'controller_invalid_record',
      error instanceof Error ? error.message : 'Invalid controller release',
    );
  }
  if (typeof value.recordDigest !== 'string' || !DIGEST.test(value.recordDigest)) {
    throw new ControllerError('controller_invalid_record', 'Invalid controller release digest');
  }
  if (typeof value.signature !== 'string') {
    throw new ControllerError('controller_invalid_record', 'Invalid controller release signature');
  }
  const payload = Object.fromEntries(PAYLOAD_KEYS.map((key) => [key, value[key]]));
  const digest = sha256Hex(canonicalJson(payload));
  if (digest !== value.recordDigest) {
    throw new ControllerError('controller_integrity_failed', 'Controller release digest mismatch');
  }
  if (!verifyEd25519(canonicalJson({ ...payload, recordDigest: digest }), value.signature, publicKey)) {
    throw new ControllerError('controller_signature_invalid', 'Controller release signature invalid');
  }
  return value as unknown as SignedControllerRelease;
}

export function inventoryControllerCandidate(candidateRoot: string): ControllerReleaseFile[] {
  const root = resolve(candidateRoot);
  const output: ControllerReleaseFile[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Controller candidate link rejected: ${absolute}`);
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Controller candidate special file rejected: ${absolute}`);
      if (stat.size > MAX_CONTROLLER_FILE_BYTES) throw new Error(`Controller candidate file too large: ${absolute}`);
      const path = relative(root, absolute).split(sep).join('/');
      output.push({
        path,
        mode: (stat.mode & 0o111) === 0 ? '0644' : '0755',
        size: stat.size,
        digest: sha256Hex(readFileSync(absolute)),
      });
      if (output.length > MAX_CONTROLLER_FILES) throw new Error('Controller candidate has too many files');
    }
  };
  walk(root);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

export interface ControllerBootstrapManagerOptions {
  root: string;
  releaseAuthorityPublicKey: KeyObject;
  assertNoActiveProductGuard: () => void;
}

export class ControllerBootstrapManager {
  constructor(private readonly options: ControllerBootstrapManagerOptions) {
    mkdirSync(join(options.root, 'releases'), { recursive: true, mode: 0o755 });
    mkdirSync(join(options.root, 'slots'), { recursive: true, mode: 0o755 });
  }

  install(
    transaction: ControllerInstallTransaction,
    input: unknown,
    candidateRoot: string,
  ): { current: string; previous: string | null; slot: 'a' | 'b' } {
    if (transaction === 'product_deployment') {
      throw new ControllerError(
        'controller_invalid_record',
        'A product deployment may not replace its protecting controller',
      );
    }
    this.options.assertNoActiveProductGuard();
    const record = verifySignedControllerRelease(input, this.options.releaseAuthorityPublicKey);
    if (
      (transaction === 'controller_bootstrap' && record.expectedCurrentReleaseId !== null) ||
      (transaction === 'controller_upgrade' && record.expectedCurrentReleaseId === null)
    ) {
      throw new ControllerError('controller_generation_conflict', 'Controller transaction kind is inconsistent');
    }
    const currentLink = join(this.options.root, 'current');
    const previousLink = join(this.options.root, 'previous');
    const currentTarget = existsSync(currentLink) ? readlinkSync(currentLink) : null;
    const currentId = currentTarget ? basename(currentTarget) : null;
    if (currentId !== record.expectedCurrentReleaseId) {
      throw new ControllerError('controller_generation_conflict', 'Controller current pointer CAS failed');
    }
    if (record.fallbackReleaseId !== currentId) {
      throw new ControllerError('controller_generation_conflict', 'Controller fallback does not bind current');
    }

    const inventory = inventoryControllerCandidate(candidateRoot);
    if (canonicalJson(inventory) !== canonicalJson(record.files)) {
      throw new ControllerError('controller_integrity_failed', 'Controller candidate bytes or modes differ');
    }
    const target = join(this.options.root, 'releases', record.releaseId);
    if (existsSync(target)) {
      throw new ControllerError('controller_generation_conflict', 'Immutable controller release already exists');
    }
    mkdirSync(target, { mode: 0o755 });
    for (const file of record.files) this.copyDeclaredFile(candidateRoot, target, file);
    fsyncDirectory(target);
    if (canonicalJson(inventoryControllerCandidate(target)) !== canonicalJson(record.files)) {
      throw new ControllerError('controller_integrity_failed', 'Installed controller readback failed');
    }

    this.atomicSymlink(target, join(this.options.root, 'slots', record.targetSlot));
    if (currentTarget) this.atomicSymlink(currentTarget, previousLink);
    this.atomicSymlink(target, currentLink);
    return { current: target, previous: currentTarget, slot: record.targetSlot };
  }

  private copyDeclaredFile(
    candidateRoot: string,
    targetRoot: string,
    file: ControllerReleaseFile,
  ): void {
    const source = join(resolve(candidateRoot), file.path);
    const destination = join(targetRoot, file.path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let destinationFd: number | undefined;
    try {
      const bytes = readFileSync(sourceFd);
      if (bytes.length !== file.size || sha256Hex(bytes) !== file.digest) {
        throw new ControllerError('controller_integrity_failed', `Controller source changed: ${file.path}`);
      }
      destinationFd = openSync(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        Number.parseInt(file.mode, 8),
      );
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(destinationFd, bytes, offset);
      chmodSync(destination, Number.parseInt(file.mode, 8));
      fsyncSync(destinationFd);
    } finally {
      closeSync(sourceFd);
      if (destinationFd !== undefined) closeSync(destinationFd);
    }
    fsyncDirectory(dirname(destination));
  }

  private atomicSymlink(target: string, link: string): void {
    const temporary = `${link}.next-${process.pid}`;
    symlinkSync(target, temporary);
    renameSync(temporary, link);
    fsyncDirectory(dirname(link));
  }
}
