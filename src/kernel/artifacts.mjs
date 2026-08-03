import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  SezError,
  ensureDir,
  fileSha256,
  fsyncDirectory,
  randomId,
  safeBasenameId,
  sha256Hex,
} from './util.mjs';

function exact(payload, allowed) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SezError('invalid_payload', 'Artifact payload must be an object');
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) throw new SezError('invalid_payload', `Unknown artifact payload field: ${key}`);
}

export class ArtifactOperations {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.dataRoot = path.join(config.artifactRoot, 'data');
    this.uploadRoot = path.join(config.artifactRoot, 'uploads');
  }

  async initialize() {
    await ensureDir(this.dataRoot, 0o750);
    await ensureDir(this.uploadRoot, 0o750);
  }

  uploadPath(id) { return path.join(this.uploadRoot, `${safeBasenameId(id, 'artifactId')}.part`); }
  finalPath(id) { return path.join(this.dataRoot, `${safeBasenameId(id, 'artifactId')}.bin`); }

  validateDeclared(payload) {
    if (!Number.isSafeInteger(payload.size) || payload.size < 0) throw new SezError('invalid_payload', 'Artifact declared size must be nonnegative');
    if (typeof payload.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sha256)) throw new SezError('invalid_payload', 'Artifact declared SHA-256 is invalid');
  }

  async begin(requestRecord, payload) {
    exact(payload, ['name', 'mediaType', 'size', 'sha256', 'metadata']);
    this.validateDeclared(payload);
    const artifactId = randomId();
    const sequence = await this.state.nextSequence();
    const record = {
      artifactId,
      requestId: requestRecord.requestId,
      sequence,
      state: 'uploading',
      immutable: false,
      name: payload.name ?? artifactId,
      mediaType: payload.mediaType ?? 'application/octet-stream',
      metadata: payload.metadata ?? {},
      declaredSize: payload.size,
      declaredSha256: payload.sha256,
      committedBytes: 0,
      actualSize: null,
      actualSha256: null,
      createdAt: new Date().toISOString(),
      finalizedAt: null,
      abortedAt: null,
      uploadPath: this.uploadPath(artifactId),
      dataPath: this.finalPath(artifactId),
    };
    if (typeof record.name !== 'string' || record.name.length > 256 || typeof record.mediaType !== 'string' || record.mediaType.length > 256 || !record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) throw new SezError('invalid_payload', 'Artifact metadata is invalid');
    const handle = await fsp.open(record.uploadPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    await handle.sync(); await handle.close(); await fsyncDirectory(this.uploadRoot);
    await this.state.saveArtifact(record);
    return record;
  }

  async create(requestRecord, payload) {
    exact(payload, ['sourcePath', 'name', 'mediaType', 'metadata']);
    if (typeof payload.sourcePath !== 'string' || !path.isAbsolute(payload.sourcePath)) throw new SezError('invalid_payload', 'sourcePath must be absolute');
    const stat = await fsp.stat(payload.sourcePath).catch((error) => { throw new SezError(error.code === 'ENOENT' ? 'not_found' : 'operation_failed', error.message); });
    if (!stat.isFile()) throw new SezError('conflict', 'Artifact source must be a regular file');
    const digest = await fileSha256(payload.sourcePath);
    const record = await this.begin(requestRecord, { name: payload.name, mediaType: payload.mediaType, metadata: payload.metadata, size: stat.size, sha256: digest });
    const source = await fsp.open(payload.sourcePath, 'r');
    const destination = await fsp.open(record.uploadPath, 'r+');
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        await destination.write(buffer, 0, bytesRead, position);
        position += bytesRead;
      }
      await destination.sync();
      record.committedBytes = stat.size;
      await this.state.saveArtifact(record);
    } finally { await source.close(); await destination.close(); }
    return await this.finalize({ artifactId: record.artifactId });
  }

  async upload(payload) {
    exact(payload, ['artifactId', 'offset', 'data', 'encoding']);
    const artifactId = safeBasenameId(payload.artifactId, 'artifactId');
    const record = await this.state.getArtifact(artifactId);
    if (record.state !== 'uploading') throw new SezError('conflict', `Artifact is ${record.state}, not uploading`);
    if (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || typeof payload.data !== 'string') throw new SezError('invalid_payload', 'Artifact offset/data invalid');
    const encoding = payload.encoding ?? 'base64';
    if (!['base64', 'hex'].includes(encoding)) throw new SezError('invalid_payload', 'Artifact chunks must be base64 or hex');
    const chunk = Buffer.from(payload.data, encoding);
    if (payload.offset > record.committedBytes) throw new SezError('offset_out_of_range', 'Artifact chunk offset exceeds committed bytes', { offset: payload.offset, committedBytes: record.committedBytes });
    if (payload.offset + chunk.length > record.declaredSize) throw new SezError('offset_out_of_range', 'Artifact chunk exceeds declared size');
    const handle = await fsp.open(record.uploadPath, 'r+');
    try {
      if (payload.offset < record.committedBytes) {
        if (payload.offset + chunk.length > record.committedBytes) throw new SezError('conflict', 'Chunk overlaps committed and uncommitted ranges');
        const existing = Buffer.alloc(chunk.length);
        await handle.read(existing, 0, existing.length, payload.offset);
        if (!existing.equals(chunk)) throw new SezError('conflict', 'Retried artifact chunk conflicts with committed bytes');
        return { artifactId, duplicate: true, committedBytes: record.committedBytes, chunkSha256: sha256Hex(chunk) };
      }
      if (this.config.faultInjection.artifactUploadFailAfterBytes !== undefined && record.committedBytes + chunk.length > this.config.faultInjection.artifactUploadFailAfterBytes) {
        const error = new Error('Injected artifact upload ENOSPC'); error.code = 'ENOSPC'; throw error;
      }
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(chunk, written, chunk.length - written, payload.offset + written);
        written += result.bytesWritten;
      }
      await handle.sync();
      record.committedBytes += chunk.length;
      await this.state.saveArtifact(record);
      return { artifactId, duplicate: false, committedBytes: record.committedBytes, chunkBytes: chunk.length, chunkSha256: sha256Hex(chunk) };
    } catch (error) {
      if (error instanceof SezError) throw error;
      if (error.code === 'ENOSPC') throw new SezError('disk_full', 'Artifact store is full', { artifactId });
      throw new SezError('operation_failed', error.message, { artifactId, errno: error.code });
    } finally { await handle.close(); }
  }

  async finalize(payload) {
    exact(payload, ['artifactId']);
    const artifactId = safeBasenameId(payload.artifactId, 'artifactId');
    const record = await this.state.getArtifact(artifactId);
    if (record.state === 'finalized') return record;
    if (record.state !== 'uploading') throw new SezError('conflict', `Artifact is ${record.state}`);
    const stat = await fsp.stat(record.uploadPath);
    if (stat.size !== record.declaredSize || record.committedBytes !== record.declaredSize) throw new SezError('digest_mismatch', 'Artifact size does not match declared size', { declared: record.declaredSize, committed: record.committedBytes, actual: stat.size });
    const digest = await fileSha256(record.uploadPath);
    if (digest !== record.declaredSha256) throw new SezError('digest_mismatch', 'Artifact digest does not match declaration', { declared: record.declaredSha256, actual: digest });
    const handle = await fsp.open(record.uploadPath, 'r'); await handle.sync(); await handle.close();
    await fsp.rename(record.uploadPath, record.dataPath);
    await fsp.chmod(record.dataPath, 0o440);
    await fsyncDirectory(this.dataRoot); await fsyncDirectory(this.uploadRoot);
    record.state = 'finalized'; record.immutable = true; record.actualSize = stat.size; record.actualSha256 = digest; record.finalizedAt = new Date().toISOString();
    await this.state.saveArtifact(record);
    return record;
  }

  async abort(payload) {
    exact(payload, ['artifactId']);
    const artifactId = safeBasenameId(payload.artifactId, 'artifactId');
    const record = await this.state.getArtifact(artifactId);
    if (record.state === 'aborted') return record;
    if (record.state !== 'uploading') throw new SezError('conflict', 'Only an uploading artifact may be aborted');
    await fsp.unlink(record.uploadPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await fsyncDirectory(this.uploadRoot);
    record.state = 'aborted'; record.abortedAt = new Date().toISOString(); record.immutable = false;
    await this.state.saveArtifact(record);
    return record;
  }

  async download(payload) {
    exact(payload, ['artifactId', 'offset', 'length']);
    const artifactId = safeBasenameId(payload.artifactId, 'artifactId');
    const record = await this.state.getArtifact(artifactId);
    if (record.state !== 'finalized') throw new SezError('conflict', 'Artifact is not finalized');
    const offset = payload.offset ?? 0; const length = payload.length ?? this.config.streamPageLimit;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > this.config.streamPageLimit) throw new SezError('invalid_payload', 'Artifact download offset/length invalid');
    if (offset > record.actualSize) throw new SezError('offset_out_of_range', 'Artifact offset exceeds size');
    const bytes = Math.min(length, record.actualSize - offset);
    const buffer = Buffer.alloc(bytes);
    if (bytes > 0) {
      const handle = await fsp.open(record.dataPath, 'r');
      try { await handle.read(buffer, 0, bytes, offset); } finally { await handle.close(); }
    }
    return {
      artifactId,
      encoding: 'base64',
      data: buffer.toString('base64'),
      bytes,
      requestedOffset: offset,
      nextOffset: offset + bytes,
      size: record.actualSize,
      pageSha256: sha256Hex(buffer),
      artifactSha256: record.actualSha256,
      endOfArtifact: offset + bytes === record.actualSize,
    };
  }

  async get(payload) {
    exact(payload, ['artifactId']);
    const record = await this.state.getArtifact(safeBasenameId(payload.artifactId, 'artifactId'));
    return this.publicRecord(record);
  }

  async list(payload = {}) {
    exact(payload, ['state', 'offset', 'limit']);
    const offset = payload.offset ?? 0; const limit = payload.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new SezError('invalid_payload', 'Artifact list offset/limit invalid');
    let records = await this.state.listArtifacts();
    if (payload.state) records = records.filter((record) => record.state === payload.state);
    const page = records.slice(offset, offset + limit).map((record) => this.publicRecord(record));
    return { offset, nextOffset: offset + page.length, total: records.length, complete: offset + page.length >= records.length, artifacts: page };
  }

  async remove(payload) {
    exact(payload, ['artifactId']);
    const artifactId = safeBasenameId(payload.artifactId, 'artifactId');
    const record = await this.state.getArtifact(artifactId);
    const filePath = record.state === 'finalized' ? record.dataPath : record.uploadPath;
    await fsp.chmod(filePath, 0o600).catch(() => {});
    await fsp.unlink(filePath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    record.state = 'removed'; record.immutable = false; record.removedAt = new Date().toISOString();
    await this.state.saveArtifact(record);
    return this.publicRecord(record);
  }

  publicRecord(record) {
    const { uploadPath, dataPath, ...publicRecord } = record;
    return publicRecord;
  }

  async reconcileAll() {
    const records = await this.state.listArtifacts();
    const outcomes = [];
    for (const record of records) {
      let outcome = record.state;
      if (record.state === 'uploading') {
        const stat = await fsp.stat(record.uploadPath).catch(() => null);
        if (!stat) {
          record.state = 'lost'; record.error = { code: 'state_corrupt', message: 'Upload metadata exists but partial data is missing' };
          await this.state.saveArtifact(record); outcome = 'lost';
          await this.state.recordReconciliation({ kind: 'artifact', artifactId: record.artifactId, outcome, reason: 'missing-partial-data' });
        } else if (stat.size !== record.committedBytes) {
          record.state = 'ambiguous'; record.error = { code: 'state_corrupt', message: 'Upload byte count differs from file size' };
          await this.state.saveArtifact(record); outcome = 'ambiguous';
          await this.state.recordReconciliation({ kind: 'artifact', artifactId: record.artifactId, outcome, reason: 'committed-size-mismatch' });
        }
      }
      if (record.state === 'finalized') {
        const stat = await fsp.stat(record.dataPath).catch(() => null);
        if (!stat || stat.size !== record.actualSize) {
          record.state = 'lost'; record.error = { code: 'state_corrupt', message: 'Finalized artifact data is missing or wrong size' };
          await this.state.saveArtifact(record); outcome = 'lost';
          await this.state.recordReconciliation({ kind: 'artifact', artifactId: record.artifactId, outcome, reason: 'final-data-missing-or-size-mismatch' });
        }
      }
      outcomes.push({ artifactId: record.artifactId, outcome });
    }
    return outcomes;
  }
}
