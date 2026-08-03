// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Process and job execution engine. */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from '../supervisor/configuration/config.js';
import type { StateStore, JobRecord } from '../state/store/store.js';
import { DEFAULTS } from '../supervisor/configuration/config.js';
import {
  captureProcessIdentity,
  processAlive,
  readProcessGroup,
} from '../execution/process/identity.js';
import {
  MapSecretProvider,
  ProcessEnvSecretProvider,
  resolveEnvironment,
  type SecretProvider,
} from '../supervisor/configuration/credentials/provider.js';

export interface EnvEntry {
  name: string;
  value?: string;
  secretReference?: string;
}

export interface ExecPayload {
  argv: string[];
  cwd?: string;
  environment?: EnvEntry[];
  env?: Record<string, string>;
  detached?: boolean;
}

export interface ShellPayload {
  shell?: string;
  command?: string;
  script?: string;
  cwd?: string;
  environment?: EnvEntry[];
  env?: Record<string, string>;
  detached?: boolean;
}

export interface JobWaitPayload {
  jobId: string;
  timeoutMs?: number;
}

export interface JobCancelPayload {
  jobId: string;
  signal?: string;
}

export interface JobStreamReadPayload {
  jobId: string;
  stream: 'stdout' | 'stderr';
  offset?: number;
  limit?: number;
}

export interface JobListPayload {
  status?: string;
  limit?: number;
}

const runningProcesses = new Map<string, ChildProcess>();

export class JobManager {
  private readonly secretProvider: SecretProvider;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: StateStore,
    secretProvider?: SecretProvider,
  ) {
    this.secretProvider = secretProvider ?? new ProcessEnvSecretProvider();
  }

  async exec(requestId: string, payload: ExecPayload): Promise<JobRecord> {
    if (!payload.argv || payload.argv.length === 0) {
      throw new Error('argv must be a non-empty array');
    }
    const cwd = payload.cwd ?? process.cwd();
    const resolved = await this.resolveEnv(payload);
    const job = this.store.createJob({
      requestId,
      operation: 'sez.exec',
      status: 'pending',
      cwd,
      argv: [...payload.argv],
      env: resolved.persisted,
      detached: payload.detached ?? false,
    });

    await this.startProcess(job, payload.argv, cwd, resolved.env, payload.detached ?? false);
    return this.store.getJob(job.jobId)!;
  }

  async shell(requestId: string, payload: ShellPayload): Promise<JobRecord> {
    const cwd = payload.cwd ?? process.cwd();
    let argv: string[];
    if (payload.script) {
      const shellBin = payload.shell ?? '/bin/sh';
      argv = [shellBin, '-c', payload.script];
    } else if (payload.command) {
      const shellBin = payload.shell ?? '/bin/sh';
      argv = [shellBin, '-c', payload.command];
    } else {
      throw new Error('Either command or script is required');
    }

    const resolved = await this.resolveEnv(payload);
    const job = this.store.createJob({
      requestId,
      operation: 'sez.shell',
      status: 'pending',
      cwd,
      argv,
      shell: payload.shell,
      script: payload.script ?? payload.command,
      env: resolved.persisted,
      detached: payload.detached ?? false,
    });

    await this.startProcess(job, argv, cwd, resolved.env, payload.detached ?? false);
    return this.store.getJob(job.jobId)!;
  }

  private async resolveEnv(payload: ExecPayload | ShellPayload): Promise<{
    env: Record<string, string>;
    persisted: JobRecord['env'];
  }> {
    if (payload.environment) {
      return resolveEnvironment(payload.environment, this.secretProvider);
    }
    if (payload.env) {
      return resolveEnvironment(
        Object.entries(payload.env).map(([name, value]) => ({ name, value })),
        this.secretProvider,
      );
    }
    return { env: {}, persisted: [] };
  }

  private async startProcess(
    job: JobRecord,
    argv: string[],
    cwd: string,
    env: Record<string, string>,
    detached = false,
  ): Promise<void> {
    const spawnEnv = { ...process.env, ...env };
    let child: ChildProcess;
    let stdoutStream: ReturnType<typeof createWriteStream> | undefined;
    let stderrStream: ReturnType<typeof createWriteStream> | undefined;

    if (detached) {
      const stdoutFd = openSync(job.streams.stdoutPath, 'a');
      const stderrFd = openSync(job.streams.stderrPath, 'a');
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: spawnEnv,
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
      closeSync(stdoutFd);
      closeSync(stderrFd);
      job.streams.stdoutClosed = false;
      job.streams.stderrClosed = false;
    } else {
      stdoutStream = createWriteStream(job.streams.stdoutPath, { flags: 'a' });
      stderrStream = createWriteStream(job.streams.stderrPath, { flags: 'a' });
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: spawnEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    job.status = detached ? 'detached' : 'running';
    job.pid = child.pid;
    job.pgid = child.pid ? readProcessGroup(child.pid) : undefined;
    if (child.pid) {
      job.identity = captureProcessIdentity(child.pid, job.pgid);
    }
    job.startedAt = new Date().toISOString();
    this.store.saveJob(job);
    runningProcesses.set(job.jobId, child);

    if (!detached) {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutStream!.write(chunk);
        job.streams.stdoutOffset += chunk.length;
        if (job.streams.stdoutOffset > this.config.maxOutputBytes) {
          child.kill('SIGTERM');
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrStream!.write(chunk);
        job.streams.stderrOffset += chunk.length;
        if (job.streams.stderrOffset > this.config.maxOutputBytes) {
          child.kill('SIGTERM');
        }
      });
    }

    const finalize = (
      status: JobRecord['status'],
      exitCode?: number | null,
      signal?: string | null,
    ) => {
      stdoutStream?.end();
      stderrStream?.end();
      job.status = status;
      job.exitCode = exitCode ?? null;
      job.signal = signal ?? null;
      job.completedAt = new Date().toISOString();
      job.streams.stdoutClosed = true;
      job.streams.stderrClosed = true;
      try {
        this.store.saveJob(job);
      } catch {
        // state directory may be unavailable during shutdown
      }
      runningProcesses.delete(job.jobId);
    };

    child.on('error', () => {
      finalize('failed');
    });

    child.on('close', (code, signal) => {
      if (detached) return;
      const status = code === 0 ? 'completed' : 'failed';
      finalize(status, code, signal);
    });

    if (detached) {
      child.unref();
    }
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.store.getJob(jobId);
  }

  listJobs(payload: JobListPayload = {}): JobRecord[] {
    let jobs = this.store.listJobs();
    if (payload.status) {
      jobs = jobs.filter((j: JobRecord) => j.status === payload.status);
    }
    const limit = payload.limit ?? 100;
    return jobs.slice(0, limit);
  }

  async waitForJob(payload: JobWaitPayload): Promise<JobRecord> {
    const job = this.store.getJob(payload.jobId);
    if (!job) throw new Error(`Job not found: ${payload.jobId}`);

    if (['completed', 'failed', 'cancelled', 'lost'].includes(job.status)) {
      return job;
    }

    const timeout = payload.timeoutMs ?? 300_000;
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const check = () => {
        const current = this.store.getJob(payload.jobId);
        if (!current) {
          reject(new Error('Job disappeared'));
          return;
        }
        if (['completed', 'failed', 'cancelled', 'detached', 'adopted', 'lost'].includes(current.status)) {
          resolve(current);
          return;
        }
        if (Date.now() - start > timeout) {
          reject(new Error('Job wait timeout'));
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  cancelJob(payload: JobCancelPayload): JobRecord {
    const job = this.store.getJob(payload.jobId);
    if (!job) throw new Error(`Job not found: ${payload.jobId}`);

    const signal = payload.signal ?? 'SIGTERM';
    const pgid = job.pgid ?? job.pid;
    if (pgid) {
      try {
        process.kill(-pgid, signal as NodeJS.Signals);
      } catch {
        try {
          process.kill(pgid, signal as NodeJS.Signals);
        } catch {
          // process may have exited
        }
      }
    }

    const child = runningProcesses.get(payload.jobId);
    if (child?.pid) {
      try {
        child.kill(signal as NodeJS.Signals);
      } catch {
        // ignore
      }
    }

    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    job.streams.stdoutClosed = true;
    job.streams.stderrClosed = true;
    this.store.saveJob(job);
    runningProcesses.delete(payload.jobId);
    return job;
  }

  readStream(payload: JobStreamReadPayload): {
    data: string;
    offset: number;
    eof: boolean;
    encoding: string;
  } {
    const job = this.store.getJob(payload.jobId);
    if (!job) throw new Error(`Job not found: ${payload.jobId}`);

    const path =
      payload.stream === 'stderr' ? job.streams.stderrPath : job.streams.stdoutPath;
    if (!existsSync(path)) {
      return { data: '', offset: payload.offset ?? 0, eof: true, encoding: 'base64' };
    }

    const offset = payload.offset ?? 0;
    const limit = Math.min(payload.limit ?? DEFAULTS.streamChunkSize, DEFAULTS.streamChunkSize);

    const fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd);
      const available = Math.max(0, stat.size - offset);
      const toRead = Math.min(limit, available);
      const buf = Buffer.alloc(toRead);
      if (toRead > 0) {
        readSync(fd, buf, 0, toRead, offset);
      }
      const closed =
        payload.stream === 'stderr' ? job.streams.stderrClosed : job.streams.stdoutClosed;
      const eof = closed && offset + toRead >= stat.size;
      return {
        data: buf.toString('base64'),
        offset: offset + toRead,
        eof,
        encoding: 'base64',
      };
    } finally {
      closeSync(fd);
    }
  }

  recoverRunningJobs(): number {
    const jobs = this.store.listJobs().filter((j: JobRecord) => j.status === 'running');
    let recovered = 0;
    for (const job of jobs) {
      if (job.identity && processAlive(job.identity)) {
        job.status = 'adopted';
        this.store.saveJob(job);
        recovered++;
        continue;
      }
      if (job.pid) {
        try {
          process.kill(job.pid, 0);
          job.status = 'adopted';
          this.store.saveJob(job);
          recovered++;
          continue;
        } catch {
          // fall through
        }
      }
      job.status = 'lost';
      job.completedAt = new Date().toISOString();
      this.store.saveJob(job);
    }
    return recovered;
  }

  recoverDetachedJobs(): number {
    const jobs = this.store.listJobs().filter((j: JobRecord) => j.status === 'detached');
    let recovered = 0;
    for (const job of jobs) {
      const pid = job.pgid ?? job.pid;
      if (!pid) {
        job.status = 'failed';
        job.completedAt = new Date().toISOString();
        this.store.saveJob(job);
        continue;
      }
      if (job.identity && processAlive(job.identity)) {
        recovered++;
        continue;
      }
      try {
        process.kill(pid, 0);
        recovered++;
      } catch {
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        job.streams.stdoutClosed = true;
        job.streams.stderrClosed = true;
        this.store.saveJob(job);
      }
    }
    return recovered;
  }

  adoptDetachedJob(jobId: string): JobRecord | undefined {
    const job = this.store.getJob(jobId);
    if (!job || job.status !== 'detached') return job;
    const pid = job.pgid ?? job.pid;
    if (!pid) return job;
    if (job.identity && processAlive(job.identity)) {
      job.status = 'adopted';
      this.store.saveJob(job);
      return job;
    }
    try {
      process.kill(pid, 0);
      job.status = 'adopted';
      this.store.saveJob(job);
    } catch {
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.streams.stdoutClosed = true;
      job.streams.stderrClosed = true;
      this.store.saveJob(job);
    }
    return job;
  }
}

export function generateJobId(): string {
  return randomUUID();
}

export { MapSecretProvider };
