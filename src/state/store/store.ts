// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Durable job and session state persistence. */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from '../../supervisor/configuration/config.js';


function writeJsonAtomically(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const directory = join(path, '..');
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    const fileFd = openSync(temporary, 'r');
    try {
      fsyncSync(fileFd);
    } finally {
      closeSync(fileFd);
    }
    renameSync(temporary, path);
    const directoryFd = openSync(directory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export type JobStatus =
  | 'pending'
  | 'running'
  | 'adopted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'detached'
  | 'lost';

export interface StreamState {
  stdoutPath: string;
  stderrPath: string;
  stdoutOffset: number;
  stderrOffset: number;
  stdoutClosed: boolean;
  stderrClosed: boolean;
}

export interface ProcessIdentityRecord {
  pid: number;
  processStartTime: string;
  executablePath: string;
  pgid: number;
  bootId: string;
}

export interface JobRecord {
  jobId: string;
  requestId: string;
  operation: string;
  status: JobStatus;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  cwd: string;
  argv?: string[];
  shell?: string;
  script?: string;
  env?: Array<{ name: string; value?: string; secretReference?: string; redacted?: boolean }>;
  detached: boolean;
  pgid?: number;
  identity?: ProcessIdentityRecord;
  streams: StreamState;
  ptySessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface PtySessionRecord {
  sessionId: string;
  jobId: string;
  pid: number;
  cols: number;
  rows: number;
  createdAt: string;
  status: 'active' | 'closed' | 'lost';
  outputPath: string;
  outputOffset: number;
  tmuxServer?: string;
  tmuxSession?: string;
  tmuxWindow?: string;
}

export class StateStore {
  private readonly jobsDir: string;
  private readonly ptyDir: string;

  constructor(private readonly config: RuntimeConfig) {
    this.jobsDir = join(config.stateRoot, 'jobs');
    this.ptyDir = join(config.stateRoot, 'pty');
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o750 });
    mkdirSync(this.ptyDir, { recursive: true, mode: 0o750 });
    mkdirSync(join(config.stateRoot, 'streams'), { recursive: true, mode: 0o750 });
    mkdirSync(join(config.stateRoot, 'artifacts'), { recursive: true, mode: 0o750 });
  }

  streamsDir(): string {
    return join(this.config.stateRoot, 'streams');
  }

  artifactsDir(): string {
    return join(this.config.stateRoot, 'artifacts');
  }

  createJob(partial: Omit<JobRecord, 'jobId' | 'createdAt' | 'streams'>): JobRecord {
    const jobId = randomUUID();
    const streams: StreamState = {
      stdoutPath: join(this.streamsDir(), `${jobId}.stdout`),
      stderrPath: join(this.streamsDir(), `${jobId}.stderr`),
      stdoutOffset: 0,
      stderrOffset: 0,
      stdoutClosed: false,
      stderrClosed: false,
    };
    const job: JobRecord = {
      ...partial,
      jobId,
      createdAt: new Date().toISOString(),
      streams,
    };
    this.saveJob(job);
    return job;
  }

  saveJob(job: JobRecord): void {
    const path = join(this.jobsDir, `${job.jobId}.json`);
    writeJsonAtomically(path, job);
  }

  getJob(jobId: string): JobRecord | undefined {
    const path = join(this.jobsDir, `${jobId}.json`);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as JobRecord;
  }

  listJobs(): JobRecord[] {
    const jobs: JobRecord[] = [];
    for (const file of readdirSync(this.jobsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        jobs.push(JSON.parse(readFileSync(join(this.jobsDir, file), 'utf8')) as JobRecord);
      } catch {
        // skip corrupt
      }
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  pruneJobs(maxRetention: number): number {
    const jobs = this.listJobs();
    const terminal = jobs.filter((j) =>
      ['completed', 'failed', 'cancelled'].includes(j.status),
    );
    if (terminal.length <= maxRetention) return 0;
    const toRemove = terminal.slice(maxRetention);
    let removed = 0;
    for (const job of toRemove) {
      try {
        unlinkSync(join(this.jobsDir, `${job.jobId}.json`));
        removed++;
      } catch {
        // continue
      }
    }
    return removed;
  }

  savePtySession(session: PtySessionRecord): void {
    const path = join(this.ptyDir, `${session.sessionId}.json`);
    writeJsonAtomically(path, session);
  }

  getPtySession(sessionId: string): PtySessionRecord | undefined {
    const path = join(this.ptyDir, `${sessionId}.json`);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as PtySessionRecord;
  }

  listPtySessions(): PtySessionRecord[] {
    const sessions: PtySessionRecord[] = [];
    for (const file of readdirSync(this.ptyDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        sessions.push(
          JSON.parse(readFileSync(join(this.ptyDir, file), 'utf8')) as PtySessionRecord,
        );
      } catch {
        // skip
      }
    }
    return sessions;
  }
}
