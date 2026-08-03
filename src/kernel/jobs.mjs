import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  SezError,
  atomicWriteJson,
  canonicalBytes,
  ensureDir,
  fileSha256,
  isUuid,
  randomId,
  readBootId,
  readJsonIfExists,
  readProcStartTime,
  sha256Hex,
  sleep,
  terminalState,
} from './util.mjs';

const execFileAsync = promisify(execFile);

function exactKeys(payload, allowed) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SezError('invalid_payload', 'Execution payload must be an object');
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) throw new SezError('invalid_payload', `Unknown execution payload field: ${key}`);
}

function getent(database, value) {
  try {
    return execFileSync('/usr/bin/getent', [database, String(value)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function resolveUser(user) {
  const requested = user ?? 'root';
  const row = getent('passwd', requested);
  if (!row) throw new SezError('invalid_payload', `Requested user does not exist: ${requested}`);
  const fields = row.split(':');
  const uid = Number(fields[2]);
  const primaryGid = Number(fields[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(primaryGid)) throw new SezError('state_corrupt', 'System passwd database returned invalid identity');
  return { name: fields[0], uid, primaryGid, home: fields[5] || '/', shell: fields[6] || '/bin/sh' };
}

function resolveGroup(group, defaultGid) {
  if (group === undefined) {
    const row = getent('group', defaultGid);
    if (!row) return { name: String(defaultGid), gid: defaultGid };
    const fields = row.split(':');
    return { name: fields[0], gid: Number(fields[2]) };
  }
  const row = getent('group', group);
  if (!row) throw new SezError('invalid_payload', `Requested group does not exist: ${group}`);
  const fields = row.split(':');
  const gid = Number(fields[2]);
  if (!Number.isInteger(gid)) throw new SezError('state_corrupt', 'System group database returned invalid identity');
  return { name: fields[0], gid };
}

function environmentFor(identity, explicit = {}) {
  if (!explicit || typeof explicit !== 'object' || Array.isArray(explicit)) throw new SezError('invalid_payload', 'environment must be an object');
  const env = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: identity.home,
    USER: identity.name,
    LOGNAME: identity.name,
    SHELL: identity.shell,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
  };
  for (const [name, value] of Object.entries(explicit)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0')) throw new SezError('invalid_payload', `Invalid environment entry: ${name}`);
    env[name] = value;
  }
  return env;
}

function validateTarget(target) {
  const selected = target ?? 'host';
  if (selected !== 'host') {
    if (/^(?:nspawn|kvm):/.test(selected)) throw new SezError('target_not_supported', `Target is not supported by release milestone 0.1A: ${selected}`, { target: selected, supportedTargets: ['host'] });
    throw new SezError('invalid_payload', `Unknown target: ${selected}`);
  }
  return selected;
}

function buildLaunchArgv(requestedArgv, identity, group) {
  if (identity.uid === 0 && group.gid === 0) return requestedArgv;
  if (!fs.existsSync('/usr/bin/setpriv')) throw new SezError('operation_failed', 'setpriv is required for explicit non-root execution');
  return [
    '/usr/bin/setpriv',
    `--reuid=${identity.uid}`,
    `--regid=${group.gid}`,
    '--init-groups',
    '--',
    ...requestedArgv,
  ];
}

async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const startTime = await readProcStartTime(pid).catch(() => null);
  if (!startTime) return null;
  const cgroup = await fsp.readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => null);
  const executable = await fsp.readlink(`/proc/${pid}/exe`).catch(() => null);
  return { pid, startTime, bootId: await readBootId().catch(() => null), cgroup: cgroup?.trim() ?? null, executable };
}

async function identityAlive(identity) {
  if (!identity?.pid || !identity.startTime || !identity.bootId) return false;
  const bootId = await readBootId().catch(() => null);
  if (bootId !== identity.bootId) return false;
  const start = await readProcStartTime(identity.pid).catch(() => null);
  return start === identity.startTime;
}

export class JobManager {
  constructor(config, state) {
    this.config = config;
    this.state = state;
  }

  normalizeExec(payload) {
    exactKeys(payload, ['argv', 'cwd', 'environment', 'stdin', 'user', 'group', 'umask', 'timeoutMs', 'detached', 'target', 'lane']);
    if (!Array.isArray(payload.argv) || payload.argv.length === 0 || payload.argv.some((entry) => typeof entry !== 'string' || entry.includes('\0'))) throw new SezError('invalid_payload', 'argv must be a nonempty array of NUL-free strings');
    return this.normalizeCommon(payload, [...payload.argv], 'sez.exec');
  }

  normalizeShell(payload) {
    exactKeys(payload, ['command', 'shell', 'shellArgs', 'cwd', 'environment', 'stdin', 'user', 'group', 'umask', 'timeoutMs', 'detached', 'target', 'lane']);
    if (typeof payload.command !== 'string') throw new SezError('invalid_payload', 'command must be a string');
    const shell = payload.shell ?? '/bin/bash';
    if (typeof shell !== 'string' || !path.isAbsolute(shell)) throw new SezError('invalid_payload', 'shell must be an absolute path');
    const shellArgs = payload.shellArgs ?? ['-lc'];
    if (!Array.isArray(shellArgs) || shellArgs.some((entry) => typeof entry !== 'string')) throw new SezError('invalid_payload', 'shellArgs must be an array of strings');
    return this.normalizeCommon(payload, [shell, ...shellArgs, payload.command], 'sez.shell', { shell, shellArgs, command: payload.command });
  }

  normalizeCommon(payload, requestedArgv, operation, extra = {}) {
    const target = validateTarget(payload.target);
    const lane = payload.lane ?? 'fast';
    if (lane !== 'fast') throw new SezError('invalid_payload', 'Only the canonical fast lane is supported');
    const identity = resolveUser(payload.user ?? 'root');
    const group = resolveGroup(payload.group ?? 'root', identity.primaryGid);
    const cwd = payload.cwd ?? '/root';
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new SezError('invalid_payload', 'cwd must be an absolute path');
    let stat;
    try { stat = fs.statSync(cwd); } catch (error) { throw new SezError('invalid_payload', `cwd is unavailable: ${cwd}`, { cause: error.code }); }
    if (!stat.isDirectory()) throw new SezError('invalid_payload', 'cwd is not a directory');
    const environment = environmentFor(identity, payload.environment ?? {});
    let stdin = null;
    if (payload.stdin !== undefined) {
      if (!payload.stdin || typeof payload.stdin !== 'object' || Array.isArray(payload.stdin)) throw new SezError('invalid_payload', 'stdin must be an object');
      const encoding = payload.stdin.encoding ?? 'base64';
      if (!['base64', 'utf8'].includes(encoding) || typeof payload.stdin.data !== 'string') throw new SezError('invalid_payload', 'stdin must contain data and base64 or utf8 encoding');
      const data = Buffer.from(payload.stdin.data, encoding);
      stdin = { encoding: 'base64', data: data.toString('base64'), bytes: data.length };
    }
    const timeoutMs = payload.timeoutMs === undefined ? null : Number(payload.timeoutMs);
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 7 * 24 * 60 * 60 * 1000)) throw new SezError('invalid_payload', 'timeoutMs must be a positive bounded integer');
    const umask = payload.umask === undefined ? 0o022 : typeof payload.umask === 'string' ? Number.parseInt(payload.umask, 8) : payload.umask;
    if (!Number.isInteger(umask) || umask < 0 || umask > 0o777) throw new SezError('invalid_payload', 'umask must be an octal string or integer');
    return {
      operation,
      requestedArgv,
      launchArgv: buildLaunchArgv(requestedArgv, identity, group),
      cwd,
      environment,
      stdin,
      identity,
      group,
      umask,
      timeoutMs,
      detached: Boolean(payload.detached),
      target,
      lane,
      ...extra,
    };
  }

  async launch(requestRecord, normalized) {
    const jobId = randomId();
    const launchSequence = await this.state.nextSequence();
    const stdoutPath = this.state.streamPath(jobId, 'stdout');
    const stderrPath = this.state.streamPath(jobId, 'stderr');
    await ensureDir(path.dirname(stdoutPath));
    const acceptedAt = new Date().toISOString();
    const commandDigest = sha256Hex(canonicalBytes({ argv: normalized.requestedArgv, cwd: normalized.cwd, environment: normalized.environment, uid: normalized.identity.uid, gid: normalized.group.gid, umask: normalized.umask, target: normalized.target }));
    const unit = `${this.config.jobUnitPrefix}-${jobId}.service`;
    const job = {
      jobId,
      requestId: requestRecord.requestId,
      operation: requestRecord.operation,
      sequence: launchSequence,
      state: 'accepted',
      terminal: false,
      acceptedAt,
      startedAt: null,
      terminalAt: null,
      requestedArgv: normalized.requestedArgv,
      launchArgv: normalized.launchArgv,
      commandDigest,
      cwd: normalized.cwd,
      target: normalized.target,
      lane: normalized.lane,
      requestedUser: normalized.identity.name,
      requestedUid: normalized.identity.uid,
      requestedGroup: normalized.group.name,
      requestedGid: normalized.group.gid,
      detached: normalized.detached,
      timeoutMs: normalized.timeoutMs,
      unit,
      launchMode: null,
      runnerIdentity: null,
      childIdentity: null,
      processGroup: null,
      cgroup: null,
      cancellationRequestedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      streams: {
        stdout: { handle: `stream:${jobId}:stdout`, path: stdoutPath, committedBytes: 0, finalSha256: null, complete: false },
        stderr: { handle: `stream:${jobId}:stderr`, path: stderrPath, committedBytes: 0, finalSha256: null, complete: false },
      },
    };
    await this.state.createJob(job);
    const runnerSpec = {
      runnerSpec: true,
      jobId,
      requestId: requestRecord.requestId,
      requestedArgv: normalized.requestedArgv,
      launchArgv: normalized.launchArgv,
      cwd: normalized.cwd,
      environment: normalized.environment,
      stdin: normalized.stdin,
      umask: normalized.umask,
      timeoutMs: normalized.timeoutMs,
      stdoutPath,
      stderrPath,
      streamStatePaths: {
        stdout: this.state.streamStatePath(jobId, 'stdout'),
        stderr: this.state.streamStatePath(jobId, 'stderr'),
      },
      runnerStatePath: path.join(this.state.jobs, `${jobId}.runner-state.json`),
      runnerResultPath: this.state.runnerResultPath(jobId),
    };
    await atomicWriteJson(this.state.runnerSpecPath(jobId), runnerSpec);
    await this.state.bindRequestJob(requestRecord.requestId, jobId, 'running');

    let launchMode;
    let runnerPid = null;
    if (await this.systemdAvailable()) {
      launchMode = 'systemd-transient';
      const args = [
        '--quiet', '--no-block', `--unit=${unit}`,
        '--property=Type=exec', '--property=KillMode=process', '--property=TimeoutStopSec=15s',
        '--property=Restart=no', '--property=User=root', '--property=Group=root',
        this.config.nodePath, this.config.jobRunnerPath, this.state.runnerSpecPath(jobId),
      ];
      try {
        await execFileAsync('/usr/bin/systemd-run', args, { timeout: 30_000 });
      } catch (error) {
        await this.state.updateJob(jobId, (record) => ({ ...record, state: 'failed', terminal: true, terminalAt: new Date().toISOString(), error: { code: 'operation_failed', retryable: false, message: `systemd-run failed: ${error.message}` } }));
        throw new SezError('operation_failed', `Unable to launch durable systemd job: ${error.message}`);
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const properties = await this.systemdProperties(unit).catch(() => null);
        runnerPid = properties?.MainPID > 0 ? properties.MainPID : null;
        if (runnerPid) break;
        await sleep(20);
      }
    } else {
      launchMode = 'detached-runner';
      const child = spawn(this.config.nodePath, [this.config.jobRunnerPath, this.state.runnerSpecPath(jobId)], { detached: true, stdio: 'ignore' });
      runnerPid = child.pid ?? null;
      child.unref();
    }
    const runnerIdentity = await processIdentity(runnerPid);
    const runnerState = await this.readRunnerState(jobId, 2000);
    const updated = await this.state.updateJob(jobId, (record) => ({
      ...record,
      state: 'running',
      terminal: false,
      startedAt: runnerState?.startedAt ?? new Date().toISOString(),
      launchMode,
      runnerIdentity,
      childIdentity: runnerState?.childPid ? { pid: runnerState.childPid, startTime: runnerState.childStartTime, bootId: runnerState.bootId } : null,
      processGroup: runnerState?.processGroup ?? null,
      cgroup: runnerState?.childPid ? runnerState.cgroup ?? null : null,
    }));
    return await this.refresh(updated.jobId);
  }

  async readRunnerState(jobId, waitMs = 0) {
    const runnerStatePath = path.join(this.state.jobs, `${jobId}.runner-state.json`);
    const deadline = Date.now() + waitMs;
    while (true) {
      const record = await readJsonIfExists(runnerStatePath, 'runner state');
      if (record) return record;
      if (Date.now() >= deadline) return undefined;
      await sleep(20);
    }
  }

  async systemdAvailable() {
    if (!fs.existsSync('/run/systemd/system') || !fs.existsSync('/usr/bin/systemd-run') || !fs.existsSync('/usr/bin/systemctl')) return false;
    try { await execFileAsync('/usr/bin/systemctl', ['is-system-running', '--wait'], { timeout: 2000 }); return true; }
    catch (error) { return ['running', 'degraded'].includes(String(error.stdout ?? '').trim()); }
  }

  async systemdProperties(unit) {
    const names = ['MainPID', 'ControlGroup', 'ActiveState', 'SubState', 'Result', 'ExecMainStatus', 'ExecMainCode'];
    const { stdout } = await execFileAsync('/usr/bin/systemctl', ['show', unit, `--property=${names.join(',')}`], { timeout: 5000 });
    const values = Object.fromEntries(stdout.trimEnd().split('\n').filter(Boolean).map((line) => {
      const separator = line.indexOf('=');
      return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return {
      MainPID: Number(values.MainPID) || 0,
      ControlGroup: values.ControlGroup || null,
      ActiveState: values.ActiveState || null,
      SubState: values.SubState || null,
      Result: values.Result || null,
      ExecMainStatus: Number(values.ExecMainStatus),
      ExecMainCode: values.ExecMainCode || null,
    };
  }

  async refresh(jobId) {
    let job = await this.state.getJob(jobId);
    const runnerResult = await readJsonIfExists(this.state.runnerResultPath(jobId), 'runner result');
    const streamStates = {};
    for (const stream of ['stdout', 'stderr']) {
      const state = await readJsonIfExists(this.state.streamStatePath(jobId, stream), 'stream state');
      const stat = await fsp.stat(job.streams[stream].path).catch(() => null);
      streamStates[stream] = {
        ...job.streams[stream],
        committedBytes: state?.committedBytes ?? stat?.size ?? 0,
        committedSha256: state?.committedSha256 ?? null,
        finalSha256: state?.complete ? state.committedSha256 : job.streams[stream].finalSha256,
        complete: Boolean(state?.complete),
      };
    }
    if (runnerResult) {
      job = await this.state.updateJob(jobId, (record) => ({
        ...record,
        state: runnerResult.state,
        terminal: true,
        terminalAt: runnerResult.terminalAt,
        startedAt: runnerResult.startedAt ?? record.startedAt,
        exitCode: runnerResult.exitCode,
        signal: runnerResult.signal,
        error: runnerResult.error,
        streams: {
          stdout: { ...streamStates.stdout, committedBytes: runnerResult.stdout.bytes, finalSha256: runnerResult.stdout.sha256, complete: true },
          stderr: { ...streamStates.stderr, committedBytes: runnerResult.stderr.bytes, finalSha256: runnerResult.stderr.sha256, complete: true },
        },
      }));
      return job;
    }
    if (terminalState(job.state)) return job;
    const runnerAlive = await identityAlive(job.runnerIdentity);
    let systemd = null;
    if (job.launchMode === 'systemd-transient') systemd = await this.systemdProperties(job.unit).catch(() => null);
    if (runnerAlive || ['active', 'activating'].includes(systemd?.ActiveState)) {
      if (JSON.stringify(job.streams) !== JSON.stringify(streamStates)) job = await this.state.updateJob(jobId, (record) => ({ ...record, streams: streamStates, state: 'running', terminal: false }));
      return job;
    }
    const state = job.cancellationRequestedAt ? 'ambiguous' : 'lost';
    job = await this.state.updateJob(jobId, (record) => ({
      ...record,
      state,
      terminal: true,
      terminalAt: new Date().toISOString(),
      error: { code: state === 'lost' ? 'job_lost' : 'job_ambiguous', retryable: false, message: 'Runner disappeared without a durable terminal result' },
      streams: streamStates,
    }));
    await this.state.recordReconciliation({ kind: 'job', jobId, outcome: state, reason: 'missing-runner-result-and-no-live-identity' });
    return job;
  }

  async get(jobId) {
    if (!isUuid(jobId)) throw new SezError('invalid_payload', 'jobId must be a UUID');
    return await this.refresh(jobId);
  }

  async list(payload = {}) {
    exactKeys(payload, ['state', 'limit']);
    const records = await this.state.listJobs({ state: payload.state, limit: payload.limit ?? 100 });
    const output = [];
    for (const record of records) output.push(await this.refresh(record.jobId));
    return output;
  }

  async wait(payload) {
    exactKeys(payload, ['jobId', 'waitMs', 'stdoutOffset', 'stderrOffset', 'streamLength']);
    const waitMs = payload.waitMs ?? 30_000;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120_000) throw new SezError('invalid_payload', 'waitMs must be between 0 and 120000');
    const deadline = process.hrtime.bigint() + BigInt(waitMs) * 1_000_000n;
    let job;
    while (true) {
      job = await this.refresh(payload.jobId);
      if (job.terminal || process.hrtime.bigint() >= deadline) break;
      await sleep(50);
    }
    const pages = {};
    const length = payload.streamLength ?? this.config.inlineOutputLimit;
    if (payload.stdoutOffset !== undefined) pages.stdout = await this.readStream({ jobId: payload.jobId, stream: 'stdout', offset: payload.stdoutOffset, length });
    if (payload.stderrOffset !== undefined) pages.stderr = await this.readStream({ jobId: payload.jobId, stream: 'stderr', offset: payload.stderrOffset, length });
    return { job, waitExpired: !job.terminal, pages };
  }

  async cancel(payload) {
    exactKeys(payload, ['jobId', 'signal', 'waitMs']);
    const signal = payload.signal ?? 'SIGTERM';
    if (!['SIGTERM', 'SIGINT', 'SIGHUP'].includes(signal)) throw new SezError('invalid_payload', 'Unsupported cancellation signal');
    let job = await this.refresh(payload.jobId);
    if (job.terminal) return job;
    const now = new Date().toISOString();
    job = await this.state.updateJob(job.jobId, (record) => ({ ...record, cancellationRequestedAt: now, cancellationSignal: signal }));
    if (job.launchMode === 'systemd-transient') {
      await execFileAsync('/usr/bin/systemctl', ['kill', '--kill-who=main', `--signal=${signal}`, job.unit], { timeout: 5000 }).catch(() => {});
    } else if (await identityAlive(job.runnerIdentity)) {
      process.kill(job.runnerIdentity.pid, signal);
    } else {
      return await this.refresh(job.jobId);
    }
    const waited = await this.wait({ jobId: job.jobId, waitMs: payload.waitMs ?? 15_000 });
    return waited.job;
  }

  async streamDescriptor(job, stream, inline = true) {
    const refreshed = await this.refresh(job.jobId);
    const record = refreshed.streams[stream];
    const committedBytes = record.committedBytes ?? 0;
    const length = inline ? Math.min(this.config.inlineOutputLimit, committedBytes) : 0;
    let inlineBase64 = '';
    if (length > 0) {
      const file = await fsp.open(record.path, 'r');
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, 0);
        inlineBase64 = buffer.subarray(0, bytesRead).toString('base64');
      } finally { await file.close(); }
    }
    return {
      handle: record.handle,
      stream,
      encoding: 'base64',
      inlineBase64,
      inlineBytes: length,
      startingOffset: 0,
      nextOffset: length,
      committedBytes,
      totalSize: refreshed.terminal ? committedBytes : null,
      committedSha256: record.committedSha256 ?? record.finalSha256 ?? null,
      finalSha256: refreshed.terminal ? record.finalSha256 : null,
      complete: Boolean(record.complete && refreshed.terminal),
    };
  }

  async readStream(payload) {
    exactKeys(payload, ['jobId', 'handle', 'stream', 'offset', 'length']);
    let jobId = payload.jobId;
    let stream = payload.stream;
    if (payload.handle) {
      const match = /^stream:([0-9a-f-]{36}):(stdout|stderr)$/.exec(payload.handle);
      if (!match) throw new SezError('invalid_payload', 'Invalid stream handle');
      jobId = match[1];
      stream = match[2];
    }
    if (!isUuid(jobId) || !['stdout', 'stderr'].includes(stream)) throw new SezError('invalid_payload', 'jobId and stdout/stderr stream are required');
    const offset = payload.offset ?? 0;
    const length = payload.length ?? this.config.streamPageLimit;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new SezError('invalid_payload', 'offset must be a nonnegative integer');
    if (!Number.isSafeInteger(length) || length < 0 || length > this.config.streamPageLimit) throw new SezError('invalid_payload', `length must be at most ${this.config.streamPageLimit}`);
    const job = await this.refresh(jobId);
    const record = job.streams[stream];
    const stat = await fsp.stat(record.path).catch((error) => {
      if (error.code === 'ENOENT') return { size: 0 };
      throw error;
    });
    const committed = Math.min(record.committedBytes ?? stat.size, stat.size);
    if (offset > committed) throw new SezError('offset_out_of_range', 'Stream offset exceeds committed data', { offset, committed });
    const bytes = Math.min(length, committed - offset);
    const buffer = Buffer.alloc(bytes);
    if (bytes > 0) {
      const handle = await fsp.open(record.path, 'r');
      try {
        let read = 0;
        while (read < bytes) {
          const result = await handle.read(buffer, read, bytes - read, offset + read);
          if (result.bytesRead === 0) break;
          read += result.bytesRead;
        }
      } finally { await handle.close(); }
    }
    const nextOffset = offset + bytes;
    return {
      handle: record.handle,
      jobId,
      stream,
      encoding: 'base64',
      data: buffer.toString('base64'),
      bytes,
      requestedOffset: offset,
      nextOffset,
      committedBytes: committed,
      pageSha256: sha256Hex(buffer),
      committedSha256: record.committedSha256 ?? record.finalSha256 ?? null,
      finalSha256: job.terminal ? record.finalSha256 : null,
      endOfStream: Boolean(job.terminal && nextOffset === committed),
      complete: Boolean(job.terminal && record.complete),
    };
  }

  async reconcileAll() {
    const records = await this.state.listJobs({ limit: Number.MAX_SAFE_INTEGER });
    const outcomes = [];
    for (const record of records) {
      const before = record.state;
      const after = await this.refresh(record.jobId);
      if (before !== after.state) await this.state.recordReconciliation({ kind: 'job', jobId: record.jobId, outcome: after.state, reason: `state-transition:${before}->${after.state}` });
      outcomes.push({ jobId: record.jobId, before, after: after.state });
    }
    return outcomes;
  }
}
