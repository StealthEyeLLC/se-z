// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Strong process identity helpers for durable job recovery. */

import { readFileSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface ProcessIdentity {
  pid: number;
  processStartTime: string;
  executablePath: string;
  pgid: number;
  bootId: string;
}

export function readBootId(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

export function readProcessStartTime(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close === -1) return '0';
    const rest = stat.slice(close + 2).split(' ');
    return rest[19] ?? '0';
  } catch {
    return '0';
  }
}

export function readExecutablePath(pid: number): string {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return '';
  }
}

export function captureProcessIdentity(pid: number, pgid?: number): ProcessIdentity {
  return {
    pid,
    processStartTime: readProcessStartTime(pid),
    executablePath: readExecutablePath(pid),
    pgid: pgid ?? pid,
    bootId: readBootId(),
  };
}

export function processAlive(identity: ProcessIdentity): boolean {
  try {
    const currentBoot = readBootId();
    if (identity.bootId !== 'unknown' && currentBoot !== identity.bootId) {
      return false;
    }
    const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close === -1) return false;
    const rest = stat.slice(close + 2).split(' ');
    const startTime = rest[19] ?? '';
    const exe = readExecutablePath(identity.pid);
    return startTime === identity.processStartTime && (!identity.executablePath || exe === identity.executablePath);
  } catch {
    return false;
  }
}

export function readProcessGroup(pid: number): number {
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || pid;
  } catch {
    return pid;
  }
}
