// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Shell-free, bounded command execution for the fixed nspawn runner. */

import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface NspawnCommandRequest {
  file: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes?: number;
  stdoutPath?: string;
  stderrPath?: string;
}

export interface NspawnCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  durationMs: number;
}

export interface NspawnCommandExecutor {
  run(request: NspawnCommandRequest): Promise<NspawnCommandResult>;
}

const FIXED_ENVIRONMENT = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
});

function outputFd(path: string): number {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
}

export class StreamingNspawnCommandExecutor implements NspawnCommandExecutor {
  async run(request: NspawnCommandRequest): Promise<NspawnCommandResult> {
    if (!request.file.startsWith('/') || request.args.some((value) => value.includes('\0'))) {
      throw new Error('nspawn executor requires an absolute binary and NUL-free argv');
    }
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1) {
      throw new Error('nspawn executor timeout is invalid');
    }
    const maxOutputBytes = request.maxOutputBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new Error('nspawn executor output bound is invalid');
    }

    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    try {
      if (request.stdoutPath) stdoutFd = outputFd(request.stdoutPath);
      if (request.stderrPath) stderrFd = outputFd(request.stderrPath);

      return await new Promise<NspawnCommandResult>((resolve, reject) => {
        const started = Date.now();
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timedOut = false;
        let outputLimitExceeded = false;
        let killTimer: NodeJS.Timeout | undefined;

        const child = spawn(request.file, [...request.args], {
          cwd: '/',
          env: FIXED_ENVIRONMENT,
          shell: false,
          windowsHide: true,
          stdio: [
            'ignore',
            stdoutFd === undefined ? 'pipe' : stdoutFd,
            stderrFd === undefined ? 'pipe' : stderrFd,
          ],
        });

        const terminate = (): void => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          }, 5000);
          killTimer.unref();
        };

        const timeout = setTimeout(() => {
          timedOut = true;
          terminate();
        }, request.timeoutMs);
        timeout.unref();

        const collect = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
          if (stream === 'stdout') stdoutBytes += chunk.length;
          else stderrBytes += chunk.length;
          if (stdoutBytes + stderrBytes > maxOutputBytes) {
            outputLimitExceeded = true;
            terminate();
            return;
          }
          target.push(chunk);
        };

        child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk, 'stdout'));
        child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk, 'stderr'));
        child.on('error', (error) => {
          clearTimeout(timeout);
          if (killTimer) clearTimeout(killTimer);
          reject(error);
        });
        child.on('close', (exitCode, signal) => {
          clearTimeout(timeout);
          if (killTimer) clearTimeout(killTimer);
          resolve({
            exitCode,
            signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            timedOut,
            outputLimitExceeded,
            durationMs: Date.now() - started,
          });
        });
      });
    } finally {
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
    }
  }
}
