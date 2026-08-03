// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Interactive PTY session management via durable tmux substrate. */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  openSync,
  readSync,
  closeSync,
  fstatSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StateStore, PtySessionRecord } from '../state/store/store.js';
import { DEFAULTS } from '../supervisor/configuration/config.js';

export interface PtyCreatePayload {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface PtyInputPayload {
  sessionId: string;
  data: string;
  encoding?: 'base64' | 'utf8';
}

export interface PtyResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface PtyReadPayload {
  sessionId: string;
  offset?: number;
  limit?: number;
}

export interface PtyClosePayload {
  sessionId: string;
  signal?: string;
}

function tmuxAvailable(): boolean {
  const result = spawnSync('which', ['tmux'], { encoding: 'utf8' });
  return result.status === 0;
}

function tmuxArgs(server: string, ...args: string[]): string[] {
  return ['-L', server, ...args];
}

export class PtyManager {
  constructor(
    private readonly store: StateStore,
  ) {}

  create(requestId: string, payload: PtyCreatePayload): PtySessionRecord {
    if (!tmuxAvailable()) {
      throw new Error('tmux is required for durable PTY sessions');
    }

    const sessionId = randomUUID();
    const shell = payload.shell ?? process.env.SHELL ?? '/bin/bash';
    const cwd = payload.cwd ?? process.cwd();
    const cols = payload.cols ?? 80;
    const rows = payload.rows ?? 24;
    const outputPath = join(this.store.streamsDir(), `pty-${sessionId}.out`);
    const tmuxServer = `se-z-${sessionId}`;
    const tmuxSession = 'shell';

    execFileSync(
      'tmux',
      tmuxArgs(
        tmuxServer,
        'new-session',
        '-d',
        '-s',
        tmuxSession,
        '-c',
        cwd,
        '-x',
        String(cols),
        '-y',
        String(rows),
        shell,
      ),
      { env: payload.env ? { ...process.env, ...payload.env } : process.env },
    );

    execFileSync(
      'tmux',
      tmuxArgs(
        tmuxServer,
        'pipe-pane',
        '-t',
        `${tmuxSession}`,
        `-o`,
        `cat >> ${outputPath}`,
      ),
    );

    const pidOut = execFileSync(
      'tmux',
      tmuxArgs(tmuxServer, 'display-message', '-p', '#{pane_pid}'),
      { encoding: 'utf8' },
    ).trim();
    const pid = parseInt(pidOut, 10);

    const session: PtySessionRecord = {
      sessionId,
      jobId: requestId,
      pid,
      cols,
      rows,
      createdAt: new Date().toISOString(),
      status: 'active',
      outputPath,
      outputOffset: 0,
      tmuxServer,
      tmuxSession,
      tmuxWindow: '0',
    };

    this.store.savePtySession(session);
    return session;
  }

  private ensureActive(session: PtySessionRecord): void {
    if (session.status !== 'active') {
      throw new Error('PTY session is not active');
    }
    if (!session.tmuxServer || !session.tmuxSession) {
      throw new Error('PTY session missing tmux metadata');
    }
    const result = spawnSync(
      'tmux',
      tmuxArgs(session.tmuxServer, 'has-session', '-t', session.tmuxSession),
    );
    if (result.status !== 0) {
      session.status = 'lost';
      this.store.savePtySession(session);
      throw new Error('PTY session lost');
    }
  }

  input(payload: PtyInputPayload): { sessionId: string; bytesWritten: number } {
    const session = this.store.getPtySession(payload.sessionId);
    if (!session) throw new Error(`PTY session not found: ${payload.sessionId}`);
    this.ensureActive(session);

    const data =
      payload.encoding === 'base64'
        ? Buffer.from(payload.data, 'base64')
        : Buffer.from(payload.data, 'utf8');
    const bufferName = `se-z-input-${process.pid}-${Date.now()}`;
    execFileSync('tmux', tmuxArgs(session.tmuxServer!, 'load-buffer', '-b', bufferName, '-'), {
      input: data,
      maxBuffer: Math.max(data.length + 1024, 1024 * 1024),
    });
    execFileSync(
      'tmux',
      tmuxArgs(
        session.tmuxServer!,
        'paste-buffer',
        '-b',
        bufferName,
        '-t',
        session.tmuxSession!,
        '-d',
      ),
    );

    return { sessionId: payload.sessionId, bytesWritten: data.length };
  }

  resize(payload: PtyResizePayload): { sessionId: string; cols: number; rows: number } {
    const session = this.store.getPtySession(payload.sessionId);
    if (!session) throw new Error(`PTY session not found: ${payload.sessionId}`);
    this.ensureActive(session);

    execFileSync(
      'tmux',
      tmuxArgs(
        session.tmuxServer!,
        'resize-window',
        '-t',
        session.tmuxSession!,
        '-x',
        String(payload.cols),
        '-y',
        String(payload.rows),
      ),
    );
    session.cols = payload.cols;
    session.rows = payload.rows;
    this.store.savePtySession(session);
    return { sessionId: payload.sessionId, cols: payload.cols, rows: payload.rows };
  }

  read(payload: PtyReadPayload): {
    data: string;
    offset: number;
    eof: boolean;
    encoding: string;
  } {
    const session = this.store.getPtySession(payload.sessionId);
    if (!session) throw new Error(`PTY session not found: ${payload.sessionId}`);

    const offset = payload.offset ?? 0;
    const limit = Math.min(payload.limit ?? DEFAULTS.streamChunkSize, DEFAULTS.streamChunkSize);

    if (!existsSync(session.outputPath)) {
      return { data: '', offset, eof: session.status !== 'active', encoding: 'base64' };
    }

    const fd = openSync(session.outputPath, 'r');
    try {
      const stat = fstatSync(fd);
      const available = Math.max(0, stat.size - offset);
      const toRead = Math.min(limit, available);
      const buf = Buffer.alloc(toRead);
      if (toRead > 0) {
        readSync(fd, buf, 0, toRead, offset);
      }
      const eof = session.status !== 'active' && offset + toRead >= stat.size;
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

  close(payload: PtyClosePayload): PtySessionRecord {
    const session = this.store.getPtySession(payload.sessionId);
    if (!session) throw new Error(`PTY session not found: ${payload.sessionId}`);
    if (session.tmuxServer && session.tmuxSession) {
      try {
        execFileSync(
          'tmux',
          tmuxArgs(session.tmuxServer, 'kill-session', '-t', session.tmuxSession),
        );
      } catch {
        // session may already be gone
      }
    }
    session.status = 'closed';
    this.store.savePtySession(session);
    return session;
  }

  recoverSessions(): number {
    const sessions = this.store
      .listPtySessions()
      .filter((s: PtySessionRecord) => s.status === 'active');
    let recovered = 0;
    for (const session of sessions) {
      if (!session.tmuxServer || !session.tmuxSession) {
        session.status = 'lost';
        this.store.savePtySession(session);
        continue;
      }
      const hasSession = spawnSync(
        'tmux',
        tmuxArgs(session.tmuxServer, 'has-session', '-t', session.tmuxSession),
      );
      if (hasSession.status === 0) {
        try {
          execFileSync(
            'tmux',
            tmuxArgs(session.tmuxServer, 'pipe-pane', '-t', session.tmuxSession),
          );
          execFileSync(
            'tmux',
            tmuxArgs(
              session.tmuxServer,
              'pipe-pane',
              '-t',
              session.tmuxSession,
              `-o`,
              `cat >> ${session.outputPath}`,
            ),
          );
          recovered++;
        } catch {
          session.status = 'lost';
          this.store.savePtySession(session);
        }
      } else {
        session.status = 'lost';
        this.store.savePtySession(session);
      }
    }
    return recovered;
  }
}
