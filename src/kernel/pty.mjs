import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  SezError,
  ensureDir,
  randomId,
  readBootId,
  readProcStartTime,
  sha256Hex,
  fileSha256,
} from './util.mjs';

const execFileAsync = promisify(execFile);

function exact(payload, allowed) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SezError('invalid_payload', 'PTY payload must be an object');
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) throw new SezError('invalid_payload', `Unknown PTY payload field: ${key}`);
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export class PtyOperations {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.tmuxRoot = path.join(config.ptyRoot, 'tmux');
    this.outputRoot = path.join(config.ptyRoot, 'output');
  }

  async initialize() {
    await ensureDir(this.tmuxRoot, 0o700);
    await ensureDir(this.outputRoot, 0o750);
    if (!fs.existsSync('/usr/bin/tmux')) throw new SezError('internal_error', 'tmux is required by the declared persistent PTY contract');
  }

  tmuxArgs(record, ...args) { return ['-S', record.tmuxSocket, ...args]; }

  async tmux(record, ...args) {
    try { return await execFileAsync('/usr/bin/tmux', this.tmuxArgs(record, ...args), { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) { throw new SezError('operation_failed', `tmux failed: ${error.stderr || error.message}`, { sessionId: record.sessionId }); }
  }

  async alive(record) {
    try { await execFileAsync('/usr/bin/tmux', this.tmuxArgs(record, 'has-session', '-t', record.tmuxSession), { timeout: 3000 }); return true; }
    catch { return false; }
  }

  async create(requestRecord, payload) {
    exact(payload, ['shell', 'shellArgs', 'cwd', 'cols', 'rows', 'environment']);
    const shell = payload.shell ?? '/bin/bash';
    const shellArgs = payload.shellArgs ?? ['-l'];
    const cwd = payload.cwd ?? '/root';
    const cols = payload.cols ?? 80; const rows = payload.rows ?? 24;
    if (typeof shell !== 'string' || !path.isAbsolute(shell) || !Array.isArray(shellArgs) || shellArgs.some((entry) => typeof entry !== 'string')) throw new SezError('invalid_payload', 'PTY shell and shellArgs are invalid');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new SezError('invalid_payload', 'PTY cwd must be absolute');
    if (!Number.isSafeInteger(cols) || cols < 1 || cols > 1000 || !Number.isSafeInteger(rows) || rows < 1 || rows > 1000) throw new SezError('invalid_payload', 'PTY dimensions are invalid');
    const sessionId = randomId();
    const record = {
      sessionId,
      requestId: requestRecord.requestId,
      state: 'creating',
      terminal: false,
      createdAt: new Date().toISOString(),
      terminalAt: null,
      tmuxSocket: path.join(this.tmuxRoot, `${sessionId}.sock`),
      tmuxSession: `sez-${sessionId}`,
      outputPath: path.join(this.outputRoot, `${sessionId}.bin`),
      shell,
      shellArgs,
      cwd,
      cols,
      rows,
      panePid: null,
      processIdentity: null,
      outputCommittedBytes: 0,
      outputFinalSha256: null,
      ready: false,
      persistenceBoundary: 'survives-supervisor-restart; after host reboot output persists and the session reconciles lost unless an external tmux process still exists',
    };
    await this.state.savePty(record);
    const environment = {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/root', USER: 'root', LOGNAME: 'root', SHELL: shell, LANG: 'C.UTF-8', TERM: 'xterm-256color',
      ...(payload.environment ?? {}),
    };
    for (const [name, value] of Object.entries(environment)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string') throw new SezError('invalid_payload', 'Invalid PTY environment');
    try {
      await execFileAsync('/usr/bin/tmux', [
        '-S', record.tmuxSocket, 'new-session', '-d', '-s', record.tmuxSession,
        '-c', cwd, '-x', String(cols), '-y', String(rows), '--', shell, ...shellArgs,
      ], { env: environment, timeout: 10_000 });
      await this.tmux(record, 'pipe-pane', '-t', record.tmuxSession, '-o', `cat >> ${shellQuote(record.outputPath)}`);
      const { stdout } = await this.tmux(record, 'display-message', '-p', '-t', record.tmuxSession, '#{pane_pid}');
      const panePid = Number(stdout.trim());
      const identity = {
        pid: panePid,
        startTime: await readProcStartTime(panePid).catch(() => null),
        bootId: await readBootId().catch(() => null),
      };
      record.state = 'active';
      record.ready = false;
      record.panePid = panePid;
      record.processIdentity = identity;
      await this.state.savePty(record);
      return record;
    } catch (error) {
      record.state = 'lost'; record.terminal = true; record.terminalAt = new Date().toISOString();
      await this.state.savePty(record);
      throw error;
    }
  }

  async input(payload) {
    exact(payload, ['sessionId', 'data', 'encoding']);
    const record = await this.getActive(payload.sessionId);
    const encoding = payload.encoding ?? 'base64';
    if (!['base64', 'utf8'].includes(encoding) || typeof payload.data !== 'string') throw new SezError('invalid_payload', 'PTY input encoding/data invalid');
    const buffer = Buffer.from(payload.data, encoding);
    const bufferName = `sez-${process.pid}-${Date.now()}`;
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/tmux', this.tmuxArgs(record, 'load-buffer', '-b', bufferName, '-'), { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `tmux load-buffer exited ${code}`)));
      child.stdin.end(buffer);
    }).catch((error) => { throw new SezError('operation_failed', `PTY input failed: ${error.message}`); });
    await this.tmux(record, 'paste-buffer', '-b', bufferName, '-t', record.tmuxSession, '-d');
    return { sessionId: record.sessionId, bytesWritten: buffer.length };
  }

  async resize(payload) {
    exact(payload, ['sessionId', 'cols', 'rows']);
    const record = await this.getActive(payload.sessionId);
    if (!Number.isSafeInteger(payload.cols) || payload.cols < 1 || payload.cols > 1000 || !Number.isSafeInteger(payload.rows) || payload.rows < 1 || payload.rows > 1000) throw new SezError('invalid_payload', 'PTY dimensions invalid');
    await this.tmux(record, 'resize-window', '-t', record.tmuxSession, '-x', String(payload.cols), '-y', String(payload.rows));
    record.cols = payload.cols; record.rows = payload.rows;
    await this.state.savePty(record);
    return { sessionId: record.sessionId, cols: record.cols, rows: record.rows };
  }

  async read(payload) {
    exact(payload, ['sessionId', 'offset', 'length']);
    const record = await this.reconcile(payload.sessionId);
    const offset = payload.offset ?? 0; const length = payload.length ?? this.config.streamPageLimit;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > this.config.streamPageLimit) throw new SezError('invalid_payload', 'PTY offset/length invalid');
    const stat = await fsp.stat(record.outputPath).catch((error) => error.code === 'ENOENT' ? { size: 0 } : Promise.reject(error));
    if (offset > stat.size) throw new SezError('offset_out_of_range', 'PTY offset exceeds committed output', { offset, committed: stat.size });
    const bytes = Math.min(length, stat.size - offset);
    const buffer = Buffer.alloc(bytes);
    if (bytes > 0) {
      const handle = await fsp.open(record.outputPath, 'r');
      try { await handle.read(buffer, 0, bytes, offset); } finally { await handle.close(); }
    }
    record.outputCommittedBytes = stat.size;
    if (record.terminal) record.outputFinalSha256 = await this.outputDigest(record.outputPath);
    await this.state.savePty(record);
    return {
      sessionId: record.sessionId,
      state: record.state,
      terminal: record.terminal,
      ready: record.ready,
      encoding: 'base64',
      data: buffer.toString('base64'),
      bytes,
      requestedOffset: offset,
      nextOffset: offset + bytes,
      committedBytes: stat.size,
      pageSha256: sha256Hex(buffer),
      finalSha256: record.outputFinalSha256,
      endOfStream: record.terminal && offset + bytes === stat.size,
    };
  }

  async close(payload) {
    exact(payload, ['sessionId']);
    let record = await this.state.getPty(payload.sessionId);
    if (!record.terminal && await this.alive(record)) await this.tmux(record, 'kill-session', '-t', record.tmuxSession).catch(() => {});
    record.state = 'closed'; record.terminal = true; record.terminalAt = new Date().toISOString();
    const stat = await fsp.stat(record.outputPath).catch(() => ({ size: 0 }));
    record.outputCommittedBytes = stat.size;
    record.outputFinalSha256 = await this.outputDigest(record.outputPath);
    await this.state.savePty(record);
    return record;
  }

  async getActive(sessionId) {
    const record = await this.reconcile(sessionId);
    if (record.state !== 'active') throw new SezError(record.state === 'lost' ? 'job_lost' : 'conflict', `PTY session is ${record.state}`, { sessionId });
    return record;
  }

  async reconcile(sessionId) {
    const record = await this.state.getPty(sessionId);
    if (record.terminal) return record;
    if (await this.alive(record)) {
      const stat = await fsp.stat(record.outputPath).catch(() => ({ size: 0 }));
      record.outputCommittedBytes = stat.size;
      await this.state.savePty(record);
      return record;
    }
    record.state = 'lost'; record.terminal = true; record.terminalAt = new Date().toISOString(); record.ready = false;
    const stat = await fsp.stat(record.outputPath).catch(() => ({ size: 0 }));
    record.outputCommittedBytes = stat.size; record.outputFinalSha256 = await this.outputDigest(record.outputPath);
    await this.state.savePty(record);
    await this.state.recordReconciliation({ kind: 'pty', sessionId, outcome: 'lost', reason: 'tmux-session-not-found' });
    return record;
  }

  async reconcileAll() {
    const records = await this.state.listPtys();
    const output = [];
    for (const record of records) output.push({ sessionId: record.sessionId, before: record.state, after: (await this.reconcile(record.sessionId)).state });
    return output;
  }

  async outputDigest(filePath) {
    if (!fs.existsSync(filePath)) return sha256Hex(Buffer.alloc(0));
    return await fileSha256(filePath);
  }
}
