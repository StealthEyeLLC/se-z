import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PROTOCOL,
  PROTOCOL_VERSION,
  PRODUCT,
  KERNEL_VERSION,
  RELEASE_MILESTONE,
  STATE_SCHEMA_VERSION,
  SUBJECT,
  AUTHORITY_CLASS,
  SezError,
  normalizeError,
  terminalState,
  canonicalBytes,
  sha256Hex,
} from './util.mjs';
import {
  requestDigest,
  semanticDigest,
  operationResultDigest,
  loadPrivateKey,
  loadPublicKeys,
  makeReceipt,
  verifyReceipt,
  signDigestHex,
  verifyDigestHex,
} from './crypto.mjs';
import { resolveCredentialPath } from './config.mjs';
import { getNativeAddonIdentity } from './identity.mjs';
import {
  ACTIVE_OPERATION_DEFINITIONS,
  ACTIVE_OPERATION_NAMES,
  ACTIVE_OPERATION_SET,
  CATALOG_DIGEST,
  EXTRACTED_INACTIVE_FAMILIES,
  FUTURE_CANONICAL_FAMILIES,
} from './definitions.mjs';
import { FileOperations } from './files.mjs';
import { PtyOperations } from './pty.mjs';
import { ArtifactOperations } from './artifacts.mjs';
import { JobManager } from './jobs.mjs';

const execFileAsync = promisify(execFile);

function streamDigests(job) {
  if (!job) return { stdoutDigest: null, stderrDigest: null };
  return {
    stdoutDigest: job.streams?.stdout?.finalSha256 ?? job.streams?.stdout?.committedSha256 ?? null,
    stderrDigest: job.streams?.stderr?.finalSha256 ?? job.streams?.stderr?.committedSha256 ?? null,
  };
}

function artifactDigests(result) {
  if (result?.artifactId && (result.actualSha256 || result.artifactSha256)) return [{ artifactId: result.artifactId, sha256: result.actualSha256 ?? result.artifactSha256, size: result.actualSize ?? result.size ?? null }];
  return [];
}

export class KernelOperations {
  constructor(config, state, authorityProvider) {
    this.config = config;
    this.state = state;
    this.authorityProvider = authorityProvider;
    this.jobs = new JobManager(config, state);
    this.files = new FileOperations(config);
    this.ptys = new PtyOperations(config, state);
    this.artifacts = new ArtifactOperations(config, state);
    this.socketStatusProvider = () => ({ local: false, gateway: false });
    this.initialized = false;
    this.finalizations = new Map();
    this.reconciliation = null;
  }

  async initialize() {
    this.receiptPrivateKey = await loadPrivateKey(resolveCredentialPath(this.config));
    this.receiptVerificationKeys = await loadPublicKeys(this.config.receiptVerificationKeys);
    this.receiptKeyId = this.config.receiptVerificationKeys[0].id;
    const probe = sha256Hex(Buffer.from('se-z-receipt-key-probe', 'utf8'));
    if (!verifyDigestHex(probe, signDigestHex(probe, this.receiptPrivateKey), this.receiptVerificationKeys.get(this.receiptKeyId))) {
      throw new SezError('internal_error', 'Receipt signing private key does not match configured current verification key');
    }
    const catalogRecord = {
      product: PRODUCT,
      releaseMilestone: RELEASE_MILESTONE,
      protocol: PROTOCOL,
      protocolVersion: PROTOCOL_VERSION,
      catalogDigest: CATALOG_DIGEST,
      definitions: ACTIVE_OPERATION_DEFINITIONS,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      sourceCommit: this.config.buildIdentity.sourceCommit,
      sourceTree: this.config.buildIdentity.sourceTree,
    };
    await this.state.initialize(catalogRecord);
    await this.ptys.initialize();
    await this.artifacts.initialize();
    const jobs = await this.jobs.reconcileAll();
    // Reconciliation discovers OS truth first. Once receipt material is loaded,
    // bind terminal job truth back into each original durable request so resume
    // returns the exact request-correlated result after a supervisor outage.
    for (const job of await this.state.listJobs({ limit: Number.MAX_SAFE_INTEGER })) {
      if (job.terminal) await this.finalizeJobRequest(await this.jobs.get(job.jobId));
    }
    const ptys = await this.ptys.reconcileAll();
    const artifacts = await this.artifacts.reconcileAll();
    const replayPruned = await this.state.pruneReplay();
    this.reconciliation = { initializedAt: new Date().toISOString(), jobs, ptys, artifacts, replayPruned };
    this.initialized = true;
  }

  setSocketStatusProvider(provider) { this.socketStatusProvider = provider; }

  activeOperations() { return ACTIVE_OPERATION_SET; }

  resolveTarget(payload) { return payload?.target ?? 'host'; }

  async reserve(request) {
    const generation = await this.authorityProvider.assertCurrent(request.authorityGeneration);
    this.assertRequestAge(request);
    const digest = requestDigest(request);
    const target = this.resolveTarget(request.payload);
    if (target !== 'host' && /^(?:nspawn|kvm):/.test(target)) {
      throw new SezError('target_not_supported', `Target is not supported by 0.1A: ${target}`, { target, supportedTargets: ['host'] });
    }
    const semantic = semanticDigest(request, target);
    return await this.state.reserveRequest({ request, requestDigest: digest, semanticDigest: semantic, resolvedTarget: target, catalogDigest: CATALOG_DIGEST, authorityGeneration: generation });
  }

  assertRequestAge(request, now = Date.now()) {
    const issued = Date.parse(request.issuedAt);
    if (now - issued > this.config.requestMaximumAgeMs) throw new SezError('request_expired', 'Request is older than the configured maximum age', { issuedAt: request.issuedAt });
    if (issued - now > this.config.requestFutureSkewMs) throw new SezError('request_expired', 'Request is too far in the future', { issuedAt: request.issuedAt });
  }

  async dispatch(request, reservation, authContext) {
    if (reservation.kind !== 'new') return await this.responseForExisting(reservation.request, { reuseKind: reservation.kind });
    const requestRecord = reservation.request;
    try {
      const execution = await this.execute(requestRecord, request.operation, request.payload);
      if (execution.job?.terminal && execution.job.requestId === requestRecord.requestId) {
        return await this.finalizeJobRequest(execution.job);
      }
      const response = await this.buildResponse({
        requestRecord,
        state: execution.state ?? 'completed',
        terminal: execution.terminal ?? true,
        result: execution.result,
        error: null,
        job: execution.job,
        acceptedAt: requestRecord.acceptedAt,
        terminalAt: execution.terminal === false ? null : new Date().toISOString(),
      });
      await this.state.storeRequestResponse(requestRecord.requestId, response);
      return response;
    } catch (error) {
      const normalized = normalizeError(error);
      const response = await this.buildResponse({
        requestRecord,
        state: normalized.code === 'cancelled' ? 'cancelled' : normalized.code === 'job_lost' ? 'lost' : normalized.code === 'job_ambiguous' ? 'ambiguous' : 'failed',
        terminal: normalized.terminal !== false,
        result: null,
        error: { code: normalized.code, retryable: normalized.retryable, message: normalized.message, ...(normalized.details ? { details: normalized.details } : {}) },
        acceptedAt: requestRecord.acceptedAt,
        terminalAt: new Date().toISOString(),
      });
      await this.state.storeRequestResponse(requestRecord.requestId, response);
      return response;
    }
  }

  async errorResponseForUnreserved(request, error) {
    const normalized = normalizeError(error, 'invalid_request');
    const now = new Date().toISOString();
    const synthetic = {
      requestId: request.requestId,
      operation: request.operation,
      subject: request.subject ?? SUBJECT,
      authorityClass: request.authorityClass ?? AUTHORITY_CLASS,
      authorityGeneration: Number.isSafeInteger(request.authorityGeneration) ? request.authorityGeneration : await this.authorityProvider.read(),
      catalogDigest: CATALOG_DIGEST,
      requestDigest: requestDigest(request),
      acceptedAt: now,
    };
    return await this.buildResponse({
      requestRecord: synthetic,
      state: normalized.code === 'stale_generation' || normalized.code === 'future_generation' ? 'failed' : 'failed',
      terminal: true,
      result: null,
      error: { code: normalized.code, retryable: normalized.retryable, message: normalized.message, ...(normalized.details ? { details: normalized.details } : {}) },
      acceptedAt: now,
      terminalAt: now,
      persistReceipt: true,
    });
  }

  async responseForExisting(record, metadata = {}) {
    // A concurrent identical caller may observe the durable reservation in the
    // narrow interval before the winning caller binds its job.  Wait for that
    // durable progress rather than returning an accepted response with no
    // resumable job identity.  The wait is bounded so a crashed pre-launch
    // reservation remains diagnosable instead of hanging a caller forever.
    if (!record.response && !record.jobId && !record.terminal) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const refreshed = await this.state.getRequest(record.requestId);
        record = refreshed;
        if (record.response || record.jobId || record.terminal) break;
      }
    }
    if (record.response?.terminal) return record.response;
    if (record.jobId) {
      const job = await this.jobs.get(record.jobId);
      if (job.terminal) return await this.finalizeJobRequest(job);
      return await this.buildResponse({
        requestRecord: record,
        state: job.state,
        terminal: false,
        result: { reused: true, reuseKind: metadata.reuseKind, originalRequestId: record.requestId, job: this.publicJob(job) },
        error: job.error,
        job,
        acceptedAt: record.acceptedAt,
        terminalAt: null,
      });
    }
    if (record.response) return record.response;
    return await this.buildResponse({ requestRecord: record, state: record.state, terminal: record.terminal, result: { reused: true, reuseKind: metadata.reuseKind, originalRequestId: record.requestId }, error: null, acceptedAt: record.acceptedAt, terminalAt: record.completedAt ?? null });
  }

  async finalizeJobRequest(job) {
    if (!job?.terminal) return null;
    const existing = this.finalizations.get(job.requestId);
    if (existing) return await existing;
    const finalization = this.finalizeJobRequestOnce(job).finally(() => {
      if (this.finalizations.get(job.requestId) === finalization) this.finalizations.delete(job.requestId);
    });
    this.finalizations.set(job.requestId, finalization);
    return await finalization;
  }

  async finalizeJobRequestOnce(job) {
    const requestRecord = await this.state.getRequest(job.requestId);
    if (requestRecord.response?.terminal) return requestRecord.response;
    const response = await this.buildResponse({
      requestRecord,
      state: job.state,
      terminal: true,
      result: { job: this.publicJob(job) },
      error: job.error,
      job,
      acceptedAt: requestRecord.acceptedAt,
      terminalAt: job.terminalAt,
    });
    const stored = await this.state.storeRequestResponse(requestRecord.requestId, response);
    return stored.response ?? response;
  }

  async buildResponse({ requestRecord, state, terminal, result, error, job = null, acceptedAt, terminalAt, persistReceipt = true }) {
    const jobId = job?.jobId ?? requestRecord.jobId ?? null;
    const stdout = job ? await this.jobs.streamDescriptor(job, 'stdout', true) : null;
    const stderr = job ? await this.jobs.streamDescriptor(job, 'stderr', true) : null;
    const base = {
      requestId: requestRecord.requestId,
      operation: requestRecord.operation,
      state,
      terminal: Boolean(terminal),
      authorityGeneration: requestRecord.authorityGeneration,
      catalogDigest: requestRecord.catalogDigest ?? CATALOG_DIGEST,
      result: error ? null : result ?? null,
      error: error ?? null,
      jobId,
      stdout,
      stderr,
    };
    const resultDigest = operationResultDigest(base);
    const digests = streamDigests(job);
    const receipt = makeReceipt({
      requestDigest: requestRecord.requestDigest,
      resultDigest,
      requestId: requestRecord.requestId,
      operation: requestRecord.operation,
      subject: requestRecord.subject,
      authorityClass: requestRecord.authorityClass,
      authorityGeneration: requestRecord.authorityGeneration,
      catalogDigest: requestRecord.catalogDigest ?? CATALOG_DIGEST,
      hostIdentity: this.config.hostIdentity,
      releaseIdentity: this.config.releaseIdentity,
      acceptedAt,
      terminalAt: terminal ? terminalAt ?? new Date().toISOString() : null,
      state,
      jobId,
      stdoutDigest: digests.stdoutDigest,
      stderrDigest: digests.stderrDigest,
      artifactDigests: artifactDigests(result),
      receiptKeyId: this.receiptKeyId,
    }, this.receiptPrivateKey);
    if (persistReceipt) await this.state.saveReceipt(receipt);
    return { ...base, resultDigest, receipt };
  }

  async execute(requestRecord, operation, payload) {
    switch (operation) {
      case 'sez.describe': return { result: await this.describe() };
      case 'sez.health': return { result: await this.health() };
      case 'sez.version': return { result: await this.version() };
      case 'sez.doctor': return { result: await this.doctor() };
      case 'sez.request.resume': return await this.resume(requestRecord, payload);
      case 'sez.exec': {
        const job = await this.jobs.launch(requestRecord, this.jobs.normalizeExec(payload));
        return { state: job.state, terminal: job.terminal, job, result: { job: this.publicJob(job) } };
      }
      case 'sez.shell': {
        const job = await this.jobs.launch(requestRecord, this.jobs.normalizeShell(payload));
        return { state: job.state, terminal: job.terminal, job, result: { job: this.publicJob(job) } };
      }
      case 'sez.job.get': {
        const job = await this.jobs.get(String(payload.jobId));
        if (job.terminal) await this.finalizeJobRequest(job);
        return { state: job.state, terminal: job.terminal, job, result: { job: this.publicJob(job) } };
      }
      case 'sez.job.list': return { result: { jobs: (await this.jobs.list(payload)).map((job) => this.publicJob(job)) } };
      case 'sez.job.wait': {
        const value = await this.jobs.wait(payload);
        if (value.job.terminal) await this.finalizeJobRequest(value.job);
        return { state: value.job.state, terminal: value.job.terminal, job: value.job, result: { job: this.publicJob(value.job), waitExpired: value.waitExpired, pages: value.pages } };
      }
      case 'sez.job.cancel': {
        const job = await this.jobs.cancel(payload);
        if (job.terminal) await this.finalizeJobRequest(job);
        return { state: job.state, terminal: job.terminal, job, result: { job: this.publicJob(job) } };
      }
      case 'sez.job.stream.read': return { result: await this.jobs.readStream(payload) };
      case 'sez.file.stat': return { result: await this.files.stat(payload) };
      case 'sez.file.read': return { result: await this.files.read(payload) };
      case 'sez.file.write': return { result: await this.files.write(payload) };
      case 'sez.file.replace': return { result: await this.files.replace(payload) };
      case 'sez.file.patch': return { result: await this.files.patch(payload) };
      case 'sez.file.copy': return { result: await this.files.copy(payload) };
      case 'sez.file.move': return { result: await this.files.move(payload) };
      case 'sez.file.remove': return { result: await this.files.remove(payload) };
      case 'sez.file.list': return { result: await this.files.list(payload) };
      case 'sez.file.mkdir': return { result: await this.files.mkdir(payload) };
      case 'sez.file.chmod': return { result: await this.files.chmod(payload) };
      case 'sez.file.chown': return { result: await this.files.chown(payload) };
      case 'sez.file.link': return { result: await this.files.link(payload) };
      case 'sez.file.symlink': return { result: await this.files.symlink(payload) };
      case 'sez.file.truncate': return { result: await this.files.truncate(payload) };
      case 'sez.pty.create': return { result: await this.ptys.create(requestRecord, payload) };
      case 'sez.pty.input': return { result: await this.ptys.input(payload) };
      case 'sez.pty.resize': return { result: await this.ptys.resize(payload) };
      case 'sez.pty.read': return { result: await this.ptys.read(payload) };
      case 'sez.pty.close': return { result: await this.ptys.close(payload) };
      case 'sez.artifact.create': return { result: await this.artifacts.create(requestRecord, payload) };
      case 'sez.artifact.begin': return { result: await this.artifacts.begin(requestRecord, payload) };
      case 'sez.artifact.upload': return { result: await this.artifacts.upload(payload) };
      case 'sez.artifact.finalize': return { result: await this.artifacts.finalize(payload) };
      case 'sez.artifact.abort': return { result: await this.artifacts.abort(payload) };
      case 'sez.artifact.download': return { result: await this.artifacts.download(payload) };
      case 'sez.artifact.get': return { result: await this.artifacts.get(payload) };
      case 'sez.artifact.list': return { result: await this.artifacts.list(payload) };
      case 'sez.artifact.remove': return { result: await this.artifacts.remove(payload) };
      default: throw new SezError('unknown_operation', `Unknown operation: ${operation}`);
    }
  }

  async resume(resumeRequestRecord, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SezError('invalid_payload', 'Resume payload must be an object');
    for (const key of Object.keys(payload)) if (!['requestId', 'operation', 'idempotencyKey', 'payload', 'target'].includes(key)) throw new SezError('invalid_payload', `Unknown resume field: ${key}`);
    let original;
    if (payload.requestId) original = await this.state.getRequest(payload.requestId);
    else {
      if (typeof payload.operation !== 'string' || typeof payload.idempotencyKey !== 'string' || !payload.payload || typeof payload.payload !== 'object') throw new SezError('invalid_payload', 'Resume requires requestId or exact operation/idempotencyKey/payload identity');
      const synthetic = {
        subject: SUBJECT,
        operation: payload.operation,
        payload: payload.payload,
        idempotencyKey: payload.idempotencyKey,
        authorityGeneration: resumeRequestRecord.authorityGeneration,
      };
      const semantic = semanticDigest(synthetic, payload.target ?? payload.payload.target ?? 'host');
      original = await this.state.findRequestByIdempotency({ subject: SUBJECT, operation: payload.operation, authorityGeneration: resumeRequestRecord.authorityGeneration, idempotencyKey: payload.idempotencyKey, semanticDigest: semantic });
    }
    let job = null;
    if (original.jobId) job = await this.jobs.get(original.jobId);
    if (job?.terminal) {
      await this.finalizeJobRequest(job);
      original = await this.state.getRequest(original.requestId);
    }
    const originalResponse = original.response ?? (job
      ? { state: job.state, terminal: job.terminal, job: this.publicJob(job), stdout: await this.jobs.streamDescriptor(job, 'stdout', true), stderr: await this.jobs.streamDescriptor(job, 'stderr', true) }
      : { state: original.state, terminal: original.terminal });
    return {
      state: job?.state ?? original.state,
      terminal: job?.terminal ?? original.terminal,
      job,
      result: {
        originalRequestId: original.requestId,
        originalOperation: original.operation,
        originalRequestDigest: original.requestDigest,
        originalCatalogDigest: original.catalogDigest,
        originalAuthorityGeneration: original.authorityGeneration,
        originalAcceptedAt: original.acceptedAt,
        originalResponse,
      },
    };
  }

  publicJob(job) {
    const { launchArgv, ...value } = job;
    return value;
  }

  async describe() {
    return {
      product: PRODUCT,
      version: KERNEL_VERSION,
      releaseMilestone: RELEASE_MILESTONE,
      protocol: PROTOCOL,
      protocolVersion: PROTOCOL_VERSION,
      activeOperations: ACTIVE_OPERATION_DEFINITIONS,
      catalogDigest: CATALOG_DIGEST,
      hostIdentity: this.config.hostIdentity,
      releaseIdentity: this.config.releaseIdentity,
      authoritySubject: SUBJECT,
      authorityClass: AUTHORITY_CLASS,
      authorityGeneration: await this.authorityProvider.read(),
      maximumFrameSize: this.config.maximumFrameSize,
      inlineOutputLimit: this.config.inlineOutputLimit,
      streamPageLimit: this.config.streamPageLimit,
      supportedTargets: ['host'],
      unsupportedTargetFamilies: ['nspawn:<id>', 'kvm:<id>'],
      socketPeerClasses: { local: 'local-peer', gateway: 'gateway-signed' },
      receiptKeyId: this.receiptKeyId,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      buildSourceCommit: this.config.buildIdentity.sourceCommit,
      buildSourceTree: this.config.buildIdentity.sourceTree,
      nativeAddonIdentity: getNativeAddonIdentity(),
      capabilityStatus: {
        activeAndTested: ACTIVE_OPERATION_NAMES,
        extractedButInactive: EXTRACTED_INACTIVE_FAMILIES,
        futureCanonical: FUTURE_CANONICAL_FAMILIES,
      },
      trustBoundary: 'A same-host supervisor receipt provides operational integrity and correlation, not independent proof against compromised host root.',
    };
  }

  async health() {
    const state = await this.state.health();
    const checks = [];
    const add = (name, healthy, detail = {}) => checks.push({ name, healthy, ...detail });
    add('state-root', state.healthy, { detail: state });
    try { add('authority-generation', true, { authorityGeneration: await this.authorityProvider.read() }); } catch (error) { add('authority-generation', false, { error: error.message }); }
    add('receipt-key', Boolean(this.receiptPrivateKey && this.receiptVerificationKeys.get(this.receiptKeyId)), { receiptKeyId: this.receiptKeyId });
    add('active-catalog', CATALOG_DIGEST === sha256Hex(canonicalBytes(ACTIVE_OPERATION_DEFINITIONS)), { catalogDigest: CATALOG_DIGEST });
    const sockets = this.socketStatusProvider();
    add('local-socket', Boolean(sockets.local), { socket: this.config.localSocket });
    add('gateway-socket', Boolean(sockets.gateway), { socket: this.config.gatewaySocket });
    add('reconciliation', Boolean(this.reconciliation), { reconciliation: this.reconciliation });
    try { await fsp.access(this.state.streams, fs.constants.R_OK | fs.constants.W_OK); add('stream-store', true, { path: this.state.streams }); } catch (error) { add('stream-store', false, { error: error.message }); }
    return { status: checks.every((check) => check.healthy) ? 'healthy' : 'unhealthy', healthy: checks.every((check) => check.healthy), checks, timestamp: new Date().toISOString() };
  }

  async version() {
    return {
      product: PRODUCT,
      kernelVersion: KERNEL_VERSION,
      releaseMilestone: RELEASE_MILESTONE,
      sourceCommit: this.config.buildIdentity.sourceCommit,
      sourceTree: this.config.buildIdentity.sourceTree,
      buildIdentity: this.config.buildIdentity,
      protocolVersion: PROTOCOL_VERSION,
      catalogDigest: CATALOG_DIGEST,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      nativeAddonIdentity: getNativeAddonIdentity(),
      nodeVersion: process.version,
    };
  }

  async doctor() {
    const health = await this.health();
    const unit = async (name) => {
      try {
        const { stdout } = await execFileAsync('/usr/bin/systemctl', ['show', name, '--property=LoadState,ActiveState,SubState,FragmentPath'], { timeout: 5000 });
        return { name, available: true, properties: Object.fromEntries(stdout.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2))) };
      } catch (error) { return { name, available: false, error: error.message }; }
    };
    const jobs = await this.state.listJobs({ limit: Number.MAX_SAFE_INTEGER });
    const lost = jobs.filter((job) => ['lost', 'ambiguous'].includes(job.state));
    return {
      mutating: false,
      health,
      socketUnits: await Promise.all(['se-z-local.socket', 'se-z-gateway.socket', 'se-z.service'].map(unit)),
      peerCredentialSupport: getNativeAddonIdentity(),
      generationProvider: { path: this.config.authorityGenerationPath, owner: 'se-z-recovery', mutableBySupervisor: false },
      stateOwnership: { supervisor: this.config.stateRoot, recoveryGeneration: this.config.authorityGenerationPath, gatewayOAuthState: 'not-owned-in-0.1A' },
      filesystemPermissions: await this.permissionSummary(),
      systemdIntegration: { jobReconciliation: this.config.jobReconciliation, jobUnitPrefix: this.config.jobUnitPrefix },
      activeJobs: jobs.filter((job) => !job.terminal).length,
      lostOrAmbiguousRecords: lost.map((job) => ({ jobId: job.jobId, state: job.state })),
      streamStore: this.state.streams,
      receiptVerification: verifyReceipt(makeReceipt({ probe: true, receiptKeyId: this.receiptKeyId }, this.receiptPrivateKey), this.receiptVerificationKeys),
      runtimeDependencies: { node: process.version, tmux: fs.existsSync('/usr/bin/tmux'), systemdRun: fs.existsSync('/usr/bin/systemd-run'), setpriv: fs.existsSync('/usr/bin/setpriv') },
      nodeVersion: process.version,
      secretsIncluded: false,
    };
  }

  async permissionSummary() {
    const paths = [this.config.stateRoot, this.config.runtimeRoot, this.config.authorityGenerationPath];
    const result = [];
    for (const item of paths) {
      try { const stat = await fsp.stat(item); result.push({ path: item, mode: (stat.mode & 0o7777).toString(8), uid: stat.uid, gid: stat.gid }); }
      catch (error) { result.push({ path: item, error: error.code }); }
    }
    return result;
  }
}
