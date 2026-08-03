import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import {
  STATE_SCHEMA_VERSION,
  SezError,
  atomicWriteJson,
  ensureDir,
  listJsonRecords,
  readJsonIfExists,
  readJsonStrict,
  sha256Hex,
  canonicalBytes,
  withDirectoryLock,
  terminalState,
} from './util.mjs';

const STATE_DIRECTORIES = [
  'requests', 'idempotency', 'replay', 'jobs', 'streams', 'ptys', 'artifacts',
  'receipts', 'catalog', 'reconciliation', 'locks',
];

export class KernelState {
  constructor(config) {
    this.config = config;
    this.root = config.stateRoot;
    for (const name of STATE_DIRECTORIES) this[name] = path.join(this.root, name);
    this.sequencePath = path.join(this.root, 'sequence.json');
    this.schemaPath = path.join(this.root, 'state-schema.json');
  }

  async initialize(catalogRecord) {
    await ensureDir(this.root, 0o750);
    for (const name of STATE_DIRECTORIES) await ensureDir(this[name], name === 'locks' ? 0o700 : 0o750);
    const existingSchema = await readJsonIfExists(this.schemaPath, 'state schema');
    if (existingSchema && existingSchema.stateSchemaVersion !== STATE_SCHEMA_VERSION) {
      throw new SezError('repair_required', 'Unsupported se-z state schema', { existing: existingSchema.stateSchemaVersion, expected: STATE_SCHEMA_VERSION });
    }
    if (!existingSchema) {
      await atomicWriteJson(this.schemaPath, {
        product: 'se-z',
        stateSchemaVersion: STATE_SCHEMA_VERSION,
        owner: 'se-z-supervisor',
        createdAt: new Date().toISOString(),
      });
    }
    if (!(await readJsonIfExists(this.sequencePath, 'state sequence'))) {
      await atomicWriteJson(this.sequencePath, { stateSchemaVersion: STATE_SCHEMA_VERSION, sequence: 0 });
    }
    await atomicWriteJson(path.join(this.catalog, `${catalogRecord.catalogDigest}.json`), catalogRecord, { mode: 0o640 });
  }

  requestPath(requestId) { return path.join(this.requests, `${requestId}.json`); }
  jobPath(jobId) { return path.join(this.jobs, `${jobId}.json`); }
  ptyPath(sessionId) { return path.join(this.ptys, `${sessionId}.json`); }
  artifactPath(artifactId) { return path.join(this.artifacts, `${artifactId}.json`); }
  receiptPath(receiptId) { return path.join(this.receipts, `${receiptId}.json`); }
  streamPath(jobId, stream) { return path.join(this.streams, `${jobId}.${stream}.bin`); }
  streamStatePath(jobId, stream) { return path.join(this.streams, `${jobId}.${stream}.json`); }
  runnerResultPath(jobId) { return path.join(this.jobs, `${jobId}.runner-result.json`); }
  runnerSpecPath(jobId) { return path.join(this.jobs, `${jobId}.runner-spec.json`); }

  async nextSequence() {
    return await withDirectoryLock(path.join(this.locks, 'sequence.lock'), async () => {
      const record = await readJsonStrict(this.sequencePath, 'state sequence');
      if (record.stateSchemaVersion !== STATE_SCHEMA_VERSION || !Number.isSafeInteger(record.sequence) || record.sequence < 0) {
        throw new SezError('state_corrupt', 'State sequence is invalid');
      }
      const sequence = record.sequence + 1;
      await atomicWriteJson(this.sequencePath, { ...record, sequence });
      return sequence;
    });
  }

  async reserveRequest({ request, requestDigest, semanticDigest, resolvedTarget, catalogDigest, authorityGeneration }) {
    const idempotencyScope = sha256Hex(canonicalBytes({
      subject: request.subject,
      operation: request.operation,
      authorityGeneration,
      idempotencyKey: request.idempotencyKey,
    }));
    const nonceScope = sha256Hex(Buffer.from(request.nonce, 'utf8'));
    const requestLock = path.join(this.locks, `idempotency-${idempotencyScope}.lock`);
    return await withDirectoryLock(requestLock, async () => {
      const idempotencyPath = path.join(this.idempotency, `${idempotencyScope}.json`);
      const existingIdempotency = await readJsonIfExists(idempotencyPath, 'idempotency record');
      if (existingIdempotency) {
        if (existingIdempotency.semanticDigest !== semanticDigest) {
          throw new SezError('idempotency_conflict', 'Idempotency key already names a different semantic request', {
            existingRequestId: existingIdempotency.requestId,
          });
        }
        const existingRequest = await this.getRequest(existingIdempotency.requestId);
        return { kind: 'idempotent-reuse', request: existingRequest };
      }

      const noncePath = path.join(this.replay, `${nonceScope}.json`);
      const existingNonce = await readJsonIfExists(noncePath, 'replay record');
      if (existingNonce) {
        if (existingNonce.requestDigest !== requestDigest) {
          throw new SezError('replay_detected', 'Nonce was already used for different request content', { existingRequestId: existingNonce.requestId });
        }
        return { kind: 'exact-replay', request: await this.getRequest(existingNonce.requestId) };
      }

      const existingRequest = await readJsonIfExists(this.requestPath(request.requestId), 'request record');
      if (existingRequest) {
        if (existingRequest.requestDigest !== requestDigest) throw new SezError('replay_detected', 'requestId already names different request content');
        return { kind: 'exact-replay', request: existingRequest };
      }

      const sequence = await this.nextSequence();
      const acceptedAt = new Date().toISOString();
      const record = {
        stateSchemaVersion: STATE_SCHEMA_VERSION,
        requestId: request.requestId,
        operation: request.operation,
        subject: request.subject,
        authorityClass: request.authorityClass,
        authorityGeneration,
        peerClass: request.peerClass,
        requestDigest,
        semanticDigest,
        idempotencyKey: request.idempotencyKey,
        nonceHash: nonceScope,
        catalogDigest,
        resolvedTarget,
        payload: request.payload,
        issuedAt: request.issuedAt,
        acceptedAt,
        sequence,
        state: 'accepted',
        terminal: false,
        jobId: null,
        response: null,
        completedAt: null,
      };
      await atomicWriteJson(this.requestPath(request.requestId), record);
      await atomicWriteJson(idempotencyPath, {
        stateSchemaVersion: STATE_SCHEMA_VERSION,
        idempotencyScope,
        semanticDigest,
        requestId: request.requestId,
        operation: request.operation,
        authorityGeneration,
        sequence,
        createdAt: acceptedAt,
      });
      await atomicWriteJson(noncePath, {
        stateSchemaVersion: STATE_SCHEMA_VERSION,
        nonceHash: nonceScope,
        requestDigest,
        requestId: request.requestId,
        sequence,
        createdAt: acceptedAt,
      });
      return { kind: 'new', request: record };
    });
  }

  async getRequest(requestId) {
    const record = await readJsonStrict(this.requestPath(requestId), 'request record');
    if (record.requestId !== requestId || record.stateSchemaVersion !== STATE_SCHEMA_VERSION) throw new SezError('state_corrupt', 'Request record identity mismatch', { requestId });
    return record;
  }

  async findRequestByIdempotency({ subject, operation, authorityGeneration, idempotencyKey, semanticDigest }) {
    const scope = sha256Hex(canonicalBytes({ subject, operation, authorityGeneration, idempotencyKey }));
    const record = await readJsonIfExists(path.join(this.idempotency, `${scope}.json`), 'idempotency record');
    if (!record) throw new SezError('not_found', 'Idempotency identity not found');
    if (semanticDigest && record.semanticDigest !== semanticDigest) throw new SezError('idempotency_conflict', 'Idempotency semantic identity does not match');
    return await this.getRequest(record.requestId);
  }

  async updateRequest(requestId, updater) {
    return await withDirectoryLock(path.join(this.locks, `request-${requestId}.lock`), async () => {
      const record = await this.getRequest(requestId);
      const next = await updater(structuredClone(record));
      if (!next || next.requestId !== requestId || next.requestDigest !== record.requestDigest || next.catalogDigest !== record.catalogDigest) {
        throw new SezError('internal_error', 'Request update attempted to alter immutable identity');
      }
      await atomicWriteJson(this.requestPath(requestId), next);
      return next;
    });
  }

  async bindRequestJob(requestId, jobId, state = 'running') {
    return await this.updateRequest(requestId, (record) => ({ ...record, jobId, state, terminal: false }));
  }

  async storeRequestResponse(requestId, response) {
    return await this.updateRequest(requestId, (record) => {
      // Request publication is monotonic. A delayed initial response or a
      // concurrent retry may never replace an already durable terminal result.
      if (record.response?.terminal) return record;
      return {
        ...record,
        state: response.state,
        terminal: response.terminal,
        response,
        completedAt: response.terminal ? (response.receipt?.terminalAt ?? new Date().toISOString()) : (record.completedAt ?? null),
      };
    });
  }

  async saveReceipt(receipt) {
    await atomicWriteJson(this.receiptPath(receipt.receiptId), receipt, { mode: 0o640 });
  }

  async createJob(job) {
    const existing = await readJsonIfExists(this.jobPath(job.jobId), 'job record');
    if (existing) throw new SezError('conflict', 'Job ID already exists', { jobId: job.jobId });
    await atomicWriteJson(this.jobPath(job.jobId), { stateSchemaVersion: STATE_SCHEMA_VERSION, ...job });
    return job;
  }

  async getJob(jobId) {
    const record = await readJsonStrict(this.jobPath(jobId), 'job record');
    if (record.jobId !== jobId || record.stateSchemaVersion !== STATE_SCHEMA_VERSION) throw new SezError('state_corrupt', 'Job record identity mismatch', { jobId });
    return record;
  }

  async getJobIfExists(jobId) {
    const record = await readJsonIfExists(this.jobPath(jobId), 'job record');
    if (!record) return undefined;
    if (record.jobId !== jobId || record.stateSchemaVersion !== STATE_SCHEMA_VERSION) throw new SezError('state_corrupt', 'Job record identity mismatch', { jobId });
    return record;
  }

  async updateJob(jobId, updater) {
    return await withDirectoryLock(path.join(this.locks, `job-${jobId}.lock`), async () => {
      const record = await this.getJob(jobId);
      const next = await updater(structuredClone(record));
      if (!next || next.jobId !== jobId || next.requestId !== record.requestId) throw new SezError('internal_error', 'Job update altered immutable identity');
      await atomicWriteJson(this.jobPath(jobId), next);
      return next;
    });
  }

  async listJobs(filters = {}) {
    const names = (await fsp.readdir(this.jobs)).filter((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(name));
    let records = [];
    for (const name of names) records.push(await readJsonStrict(path.join(this.jobs, name), 'job record'));
    if (filters.state) records = records.filter((record) => record.state === filters.state);
    records.sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0));
    return records.slice(0, filters.limit ?? 100);
  }

  async savePty(record) {
    await atomicWriteJson(this.ptyPath(record.sessionId), { stateSchemaVersion: STATE_SCHEMA_VERSION, ...record });
    return record;
  }

  async getPty(sessionId) {
    const record = await readJsonStrict(this.ptyPath(sessionId), 'PTY record');
    if (record.sessionId !== sessionId) throw new SezError('state_corrupt', 'PTY record identity mismatch');
    return record;
  }

  async listPtys() { return await listJsonRecords(this.ptys, 'PTY record'); }

  async saveArtifact(record) {
    await atomicWriteJson(this.artifactPath(record.artifactId), { stateSchemaVersion: STATE_SCHEMA_VERSION, ...record });
    return record;
  }

  async getArtifact(artifactId) {
    const record = await readJsonStrict(this.artifactPath(artifactId), 'artifact record');
    if (record.artifactId !== artifactId) throw new SezError('state_corrupt', 'Artifact record identity mismatch');
    return record;
  }

  async listArtifacts() {
    const records = await listJsonRecords(this.artifacts, 'artifact record');
    return records.sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0));
  }

  async recordReconciliation(event) {
    const sequence = await this.nextSequence();
    const record = { stateSchemaVersion: STATE_SCHEMA_VERSION, sequence, timestamp: new Date().toISOString(), ...event };
    await atomicWriteJson(path.join(this.reconciliation, `${String(sequence).padStart(20, '0')}.json`), record, { mode: 0o640 });
    return record;
  }

  async health() {
    const checks = [];
    for (const name of STATE_DIRECTORIES) {
      const directory = this[name];
      try {
        await fsp.access(directory, fs.constants.R_OK | fs.constants.W_OK);
        checks.push({ name, status: 'ok', path: directory });
      } catch (error) {
        checks.push({ name, status: 'failed', path: directory, error: error.code ?? error.message });
      }
    }
    let corrupt = 0;
    try { await this.listJobs({ limit: Number.MAX_SAFE_INTEGER }); } catch { corrupt += 1; }
    return { healthy: checks.every((check) => check.status === 'ok') && corrupt === 0, checks, corruptStores: corrupt };
  }

  async pruneReplay(now = Date.now()) {
    const entries = await listJsonRecords(this.replay, 'replay record');
    let removed = 0;
    for (const entry of entries) {
      if (now - Date.parse(entry.createdAt) <= this.config.replayRetentionMs) continue;
      await fsp.unlink(path.join(this.replay, `${entry.nonceHash}.json`));
      removed += 1;
    }
    return removed;
  }

  async requestSummary(record) {
    if (record.response) return record.response;
    if (record.jobId) {
      const job = await this.getJobIfExists(record.jobId);
      return { state: job?.state ?? record.state, terminal: terminalState(job?.state ?? record.state), jobId: record.jobId };
    }
    return { state: record.state, terminal: record.terminal };
  }
}
