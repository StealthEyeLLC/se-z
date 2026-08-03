// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Content-addressed artifact storage with explicit immutable finalization. */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { StateStore } from '../state/store/store.js';
import { DEFAULTS } from '../supervisor/configuration/config.js';
import { OperationError } from '../operations/errors.js';

export interface ArtifactCreatePayload {
  name: string;
  sourcePath: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactBeginPayload {
  name: string;
  metadata?: Record<string, unknown>;
  expectedSize?: number;
  expectedSha256?: string;
}

export interface ArtifactUploadPayload {
  artifactId: string;
  offset: number;
  data: string;
  encoding?: 'base64';
  /** Legacy compatibility. Prefer sez.artifact.finalize. */
  finalize?: boolean;
}

export interface ArtifactFinalizePayload {
  artifactId: string;
  expectedSize: number;
  expectedSha256: string;
}

export interface ArtifactAbortPayload {
  artifactId: string;
}

export interface ArtifactDownloadPayload {
  artifactId: string;
  offset?: number;
  limit?: number;
}

export interface ArtifactRecord {
  artifactId: string;
  name: string;
  status: 'uploading' | 'finalized' | 'aborted';
  sha256: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
  abortedAt?: string;
  expectedSize?: number;
  expectedSha256?: string;
  metadata?: Record<string, unknown>;
  path: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

function identityFromStat(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function hashFile(path: string, maximumBytes: number): { sha256: string; size: number; identity: FileIdentity } {
  const initial = statSync(path);
  if (!initial.isFile()) {
    throw new OperationError('artifact_source_invalid', 'Artifact source must be a regular file');
  }
  if (initial.size > maximumBytes) {
    throw new OperationError('artifact_too_large', 'Artifact source exceeds the configured hard bound', false, {
      size: initial.size,
      maximumBytes,
    });
  }
  const identity = identityFromStat(initial);
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(64 * 1024);
  let pos = 0;
  try {
    let bytesRead = 0;
    while ((bytesRead = readSync(fd, buf, 0, Math.min(buf.length, maximumBytes - pos + 1), pos)) > 0) {
      pos += bytesRead;
      if (pos > maximumBytes) {
        throw new OperationError('artifact_too_large', 'Artifact source exceeds the configured hard bound', false, {
          size: pos,
          maximumBytes,
        });
      }
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  const final = identityFromStat(statSync(path));
  if (!identitiesEqual(identity, final) || pos !== identity.size) {
    throw new OperationError('artifact_source_changed', 'Artifact source changed while it was being hashed');
  }
  return { sha256: hash.digest('hex'), size: pos, identity };
}

export class ArtifactManager {
  private readonly manifestPath: string;
  private readonly uploadRoot: string;
  private readonly objectRoot: string;
  private readonly maximumArtifactBytes: number;

  constructor(store: StateStore, maximumArtifactBytes = DEFAULTS.maxArchiveFileBytes) {
    this.manifestPath = join(store.artifactsDir(), 'manifest.json');
    this.uploadRoot = join(store.artifactsDir(), 'uploads');
    this.objectRoot = join(store.artifactsDir(), 'sha256');
    if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes < 1) {
      throw new Error('maximumArtifactBytes must be a positive safe integer');
    }
    this.maximumArtifactBytes = maximumArtifactBytes;
    mkdirSync(this.uploadRoot, { recursive: true, mode: 0o750 });
    mkdirSync(this.objectRoot, { recursive: true, mode: 0o750 });
  }

  private migrateRecord(record: Partial<ArtifactRecord> & { artifactId: string; name: string; path: string }): ArtifactRecord {
    const createdAt = record.createdAt ?? new Date(0).toISOString();
    const status = record.status ?? 'finalized';
    return {
      artifactId: record.artifactId,
      name: record.name,
      status,
      sha256: record.sha256 ?? '',
      size: record.size ?? 0,
      createdAt,
      updatedAt: record.updatedAt ?? record.finalizedAt ?? createdAt,
      ...(record.finalizedAt ? { finalizedAt: record.finalizedAt } : status === 'finalized' ? { finalizedAt: createdAt } : {}),
      ...(record.abortedAt ? { abortedAt: record.abortedAt } : {}),
      ...(record.expectedSize !== undefined ? { expectedSize: record.expectedSize } : {}),
      ...(record.expectedSha256 ? { expectedSha256: record.expectedSha256 } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      path: record.path,
    };
  }

  private loadManifest(): ArtifactRecord[] {
    if (!existsSync(this.manifestPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as Array<
        Partial<ArtifactRecord> & { artifactId: string; name: string; path: string }
      >;
      return Array.isArray(parsed) ? parsed.map((record) => this.migrateRecord(record)) : [];
    } catch {
      throw new OperationError('artifact_manifest_corrupt', 'Artifact manifest is not valid JSON');
    }
  }

  private saveManifest(records: ArtifactRecord[]): void {
    mkdirSync(dirname(this.manifestPath), { recursive: true, mode: 0o750 });
    const temporary = `${this.manifestPath}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, JSON.stringify(records, null, 2), { mode: 0o600 });
      const fileFd = openSync(temporary, 'r');
      try {
        fsyncSync(fileFd);
      } finally {
        closeSync(fileFd);
      }
      renameSync(temporary, this.manifestPath);
      const directoryFd = openSync(dirname(this.manifestPath), 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private objectPath(sha256: string): string {
    return join(this.objectRoot, sha256);
  }

  private persistObject(
    sourcePath: string,
    sha256: string,
    expectedSize: number,
    expectedIdentity: FileIdentity,
  ): string {
    const destination = this.objectPath(sha256);
    if (existsSync(destination)) return destination;

    const sourceFd = openSync(sourcePath, 'r');
    let destinationFd: number | undefined;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    try {
      destinationFd = openSync(destination, 'wx', 0o600);
      let bytesRead = 0;
      while ((bytesRead = readSync(sourceFd, buffer, 0, Math.min(buffer.length, this.maximumArtifactBytes - position + 1), position)) > 0) {
        position += bytesRead;
        if (position > this.maximumArtifactBytes) {
          throw new OperationError('artifact_too_large', 'Artifact source exceeds the configured hard bound', false, {
            size: position,
            maximumBytes: this.maximumArtifactBytes,
          });
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let written = 0;
        while (written < chunk.length) {
          written += writeSync(destinationFd, chunk, written, chunk.length - written, null);
        }
      }
      fsyncSync(destinationFd);
    } catch (error) {
      if (existsSync(destination)) unlinkSync(destination);
      throw error;
    } finally {
      closeSync(sourceFd);
      if (destinationFd !== undefined) closeSync(destinationFd);
    }

    const finalIdentity = identityFromStat(statSync(sourcePath));
    const copiedDigest = hash.digest('hex');
    if (
      !identitiesEqual(expectedIdentity, finalIdentity) ||
      position !== expectedSize ||
      copiedDigest !== sha256
    ) {
      if (existsSync(destination)) unlinkSync(destination);
      throw new OperationError('artifact_source_changed', 'Artifact source changed while it was being captured');
    }
    const directoryFd = openSync(this.objectRoot, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    return destination;
  }

  createFromFile(payload: ArtifactCreatePayload): ArtifactRecord {
    if (!payload.name || !payload.sourcePath) {
      throw new OperationError('invalid_request', 'name and sourcePath are required');
    }
    const digest = hashFile(payload.sourcePath, this.maximumArtifactBytes);
    const destPath = this.persistObject(payload.sourcePath, digest.sha256, digest.size, digest.identity);
    const now = new Date().toISOString();
    const record: ArtifactRecord = {
      artifactId: randomUUID(),
      name: payload.name,
      status: 'finalized',
      sha256: digest.sha256,
      size: digest.size,
      createdAt: now,
      updatedAt: now,
      finalizedAt: now,
      metadata: payload.metadata,
      path: destPath,
    };

    const manifest = this.loadManifest();
    manifest.push(record);
    this.saveManifest(manifest);
    return record;
  }

  beginUpload(payload: ArtifactBeginPayload): ArtifactRecord {
    if (!payload.name) throw new OperationError('invalid_request', 'name is required');
    if (payload.expectedSize !== undefined && payload.expectedSize < 0) {
      throw new OperationError('invalid_request', 'expectedSize must be non-negative');
    }
    if (payload.expectedSha256 && !/^[a-f0-9]{64}$/u.test(payload.expectedSha256)) {
      throw new OperationError('invalid_request', 'expectedSha256 must be a lowercase SHA-256');
    }

    const artifactId = randomUUID();
    const destPath = join(this.uploadRoot, `${artifactId}.upload`);
    writeFileSync(destPath, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
    const now = new Date().toISOString();
    const record: ArtifactRecord = {
      artifactId,
      name: payload.name,
      status: 'uploading',
      sha256: '',
      size: 0,
      createdAt: now,
      updatedAt: now,
      ...(payload.expectedSize !== undefined ? { expectedSize: payload.expectedSize } : {}),
      ...(payload.expectedSha256 ? { expectedSha256: payload.expectedSha256 } : {}),
      metadata: payload.metadata,
      path: destPath,
    };

    const manifest = this.loadManifest();
    manifest.push(record);
    this.saveManifest(manifest);
    return record;
  }

  uploadChunk(payload: ArtifactUploadPayload): ArtifactRecord {
    const manifest = this.loadManifest();
    const record = manifest.find((candidate) => candidate.artifactId === payload.artifactId);
    if (!record) throw new OperationError('artifact_not_found', `Artifact not found: ${payload.artifactId}`);
    if (record.status !== 'uploading') {
      throw new OperationError('artifact_immutable', 'Only uploading artifacts accept chunks', false, {
        artifactId: record.artifactId,
        status: record.status,
      });
    }
    if (payload.offset !== record.size) {
      throw new OperationError('artifact_offset_mismatch', 'Artifact chunks must be contiguous', false, {
        expectedOffset: record.size,
        receivedOffset: payload.offset,
      });
    }

    const data = Buffer.from(payload.data, payload.encoding ?? 'base64');
    const fd = openSync(record.path, 'r+');
    try {
      writeSync(fd, data, 0, data.length, payload.offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    record.size += data.length;
    record.updatedAt = new Date().toISOString();
    this.saveManifest(manifest);

    if (payload.finalize) {
      const digest = hashFile(record.path, this.maximumArtifactBytes);
      return this.finalize({
        artifactId: record.artifactId,
        expectedSize: record.expectedSize ?? digest.size,
        expectedSha256: record.expectedSha256 ?? digest.sha256,
      });
    }
    return record;
  }

  finalize(payload: ArtifactFinalizePayload): ArtifactRecord {
    if (!/^[a-f0-9]{64}$/u.test(payload.expectedSha256)) {
      throw new OperationError('invalid_request', 'expectedSha256 must be a lowercase SHA-256');
    }
    const manifest = this.loadManifest();
    const record = manifest.find((candidate) => candidate.artifactId === payload.artifactId);
    if (!record) throw new OperationError('artifact_not_found', `Artifact not found: ${payload.artifactId}`);
    if (record.status !== 'uploading') {
      throw new OperationError('artifact_immutable', 'Only uploading artifacts can be finalized', false, {
        artifactId: record.artifactId,
        status: record.status,
      });
    }

    const digest = hashFile(record.path, this.maximumArtifactBytes);
    if (digest.size !== payload.expectedSize) {
      throw new OperationError('artifact_size_mismatch', 'Artifact size does not match', false, {
        expectedSize: payload.expectedSize,
        actualSize: digest.size,
      });
    }
    if (digest.sha256 !== payload.expectedSha256) {
      throw new OperationError('artifact_digest_mismatch', 'Artifact SHA-256 does not match', false, {
        expectedSha256: payload.expectedSha256,
        actualSha256: digest.sha256,
      });
    }
    if (record.expectedSize !== undefined && record.expectedSize !== digest.size) {
      throw new OperationError('artifact_size_mismatch', 'Artifact size differs from begin metadata');
    }
    if (record.expectedSha256 && record.expectedSha256 !== digest.sha256) {
      throw new OperationError('artifact_digest_mismatch', 'Artifact digest differs from begin metadata');
    }

    const destination = this.objectPath(digest.sha256);
    if (existsSync(destination)) {
      unlinkSync(record.path);
    } else {
      renameSync(record.path, destination);
      const directoryFd = openSync(this.objectRoot, 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }

    const now = new Date().toISOString();
    record.status = 'finalized';
    record.sha256 = digest.sha256;
    record.size = digest.size;
    record.updatedAt = now;
    record.finalizedAt = now;
    record.path = destination;
    this.saveManifest(manifest);
    return record;
  }

  abort(payload: ArtifactAbortPayload): ArtifactRecord {
    const manifest = this.loadManifest();
    const record = manifest.find((candidate) => candidate.artifactId === payload.artifactId);
    if (!record) throw new OperationError('artifact_not_found', `Artifact not found: ${payload.artifactId}`);
    if (record.status !== 'uploading') {
      throw new OperationError('artifact_immutable', 'Only uploading artifacts can be aborted', false, {
        artifactId: record.artifactId,
        status: record.status,
      });
    }
    if (existsSync(record.path)) unlinkSync(record.path);
    const now = new Date().toISOString();
    record.status = 'aborted';
    record.updatedAt = now;
    record.abortedAt = now;
    record.path = '';
    this.saveManifest(manifest);
    return record;
  }

  download(payload: ArtifactDownloadPayload): {
    artifactId: string;
    data: string;
    offset: number;
    eof: boolean;
    sha256: string;
    size: number;
  } {
    const manifest = this.loadManifest();
    const record = manifest.find((candidate) => candidate.artifactId === payload.artifactId);
    if (!record) throw new OperationError('artifact_not_found', `Artifact not found: ${payload.artifactId}`);
    if (record.status !== 'finalized') {
      throw new OperationError('artifact_not_finalized', 'Artifact is not finalized', false, {
        artifactId: record.artifactId,
        status: record.status,
      });
    }

    const offset = payload.offset ?? 0;
    const limit = Math.min(payload.limit ?? 64 * 1024, 64 * 1024);
    const stat = statSync(record.path);
    const fd = openSync(record.path, 'r');
    try {
      const available = Math.max(0, stat.size - offset);
      const toRead = Math.min(limit, available);
      const buf = Buffer.alloc(toRead);
      if (toRead > 0) readSync(fd, buf, 0, toRead, offset);
      return {
        artifactId: record.artifactId,
        data: buf.toString('base64'),
        offset: offset + toRead,
        eof: offset + toRead >= stat.size,
        sha256: record.sha256,
        size: record.size,
      };
    } finally {
      closeSync(fd);
    }
  }

  list(): ArtifactRecord[] {
    return this.loadManifest();
  }

  get(artifactId: string): ArtifactRecord | undefined {
    return this.loadManifest().find((record) => record.artifactId === artifactId);
  }
}
