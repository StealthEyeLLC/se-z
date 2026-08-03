// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Durable, create-once controller records outside active product releases. */

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalJson } from '../../protocol/canonical/canonical.js';
import {
  ControllerError,
  type SignedControllerEvidence,
  type SignedDeploymentGuardRecord,
  type SignedSuccessMarker,
} from './types.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_RECORD_BYTES = 1024 * 1024;

interface LockIdentity {
  token: string;
  pid: number;
  startTime: string;
  executable: string;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureDirectory(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ControllerError('controller_integrity_failed', `Unsafe controller directory: ${path}`);
  }
}

function exactJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
}

function createOnce(path: string, value: unknown, mode = 0o600): void {
  const bytes = exactJsonBytes(value);
  if (bytes.length > MAX_RECORD_BYTES) {
    throw new ControllerError('controller_invalid_record', 'Controller record exceeds size limit');
  }
  ensureDirectory(dirname(path));
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readFileSync(path);
      if (existing.equals(bytes)) return;
      throw new ControllerError('controller_integrity_failed', `Create-once record differs: ${path}`);
    }
    throw error;
  }
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function readJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) {
    throw new ControllerError('controller_integrity_failed', `Unsafe controller record: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function processIdentity(pid = process.pid): Omit<LockIdentity, 'token'> | undefined {
  try {
    const procRoot = pid === process.pid ? '/proc/self' : `/proc/${pid}`;
    const stat = readFileSync(`${procRoot}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const startTime = fields[19];
    if (!startTime) return undefined;
    return { pid, startTime, executable: readlinkSync(`${procRoot}/exe`) };
  } catch {
    return undefined;
  }
}

function isLiveLock(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const lock = value as Partial<LockIdentity>;
  if (
    typeof lock.pid !== 'number' ||
    typeof lock.startTime !== 'string' ||
    typeof lock.executable !== 'string'
  ) return false;
  const current = processIdentity(lock.pid);
  return current !== undefined &&
    current.startTime === lock.startTime &&
    current.executable === lock.executable;
}

export interface ControllerStoreOptions {
  root: string;
  lockPath: string;
}

export class ControllerStore {
  constructor(private readonly options: ControllerStoreOptions) {
    ensureDirectory(options.root);
    ensureDirectory(join(options.root, 'deployments'));
    ensureDirectory(join(options.root, 'generations'));
    ensureDirectory(dirname(options.lockPath), 0o750);
  }

  withGlobalLock<T>(action: () => T): T {
    const identity = processIdentity();
    if (!identity) {
      throw new ControllerError('controller_integrity_failed', 'Cannot establish strong process identity');
    }
    const lock: LockIdentity = {
      ...identity,
      token: randomBytes(16).toString('hex'),
    };
    const bytes = exactJsonBytes(lock);
    let fd: number | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fd = openSync(
          this.options.lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        writeSync(fd, bytes);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        fsyncDirectory(dirname(this.options.lockPath));
        break;
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let existing: unknown;
        try {
          existing = readJson(this.options.lockPath);
        } catch {
          existing = undefined;
        }
        if (isLiveLock(existing)) {
          throw new ControllerError('controller_lock_busy', 'Another fixed controller action is active');
        }
        const stale = `${this.options.lockPath}.stale-${lock.token}`;
        renameSync(this.options.lockPath, stale);
        unlinkSync(stale);
        fsyncDirectory(dirname(this.options.lockPath));
      }
    }
    if (!existsSync(this.options.lockPath)) {
      throw new ControllerError('controller_lock_busy', 'Unable to acquire controller lock');
    }
    try {
      return action();
    } finally {
      try {
        const current = readJson(this.options.lockPath) as Partial<LockIdentity>;
        if (current.token === lock.token) {
          unlinkSync(this.options.lockPath);
          fsyncDirectory(dirname(this.options.lockPath));
        }
      } catch {
        // A lost or substituted lock is intentionally not removed.
      }
    }
  }

  writeGuard(record: SignedDeploymentGuardRecord): void {
    this.assertDeploymentId(record.deploymentId);
    const root = this.deploymentRoot(record.deploymentId);
    ensureDirectory(root);
    ensureDirectory(join(root, 'evidence'));
    createOnce(join(root, 'guard.json'), record);
    createOnce(
      join(this.options.root, 'generations', `${String(record.generation).padStart(20, '0')}.json`),
      {
        deploymentId: record.deploymentId,
        generation: record.generation,
        guardRecordDigest: record.recordDigest,
      },
    );
  }

  readGuard(deploymentId: string): unknown {
    this.assertDeploymentId(deploymentId);
    const path = join(this.deploymentRoot(deploymentId), 'guard.json');
    if (!existsSync(path)) throw new ControllerError('controller_not_found', 'Guard record not found');
    return readJson(path);
  }

  writeSuccessMarker(marker: SignedSuccessMarker): void {
    createOnce(join(this.deploymentRoot(marker.deploymentId), 'success.json'), marker);
  }

  readSuccessMarker(deploymentId: string): unknown | undefined {
    const path = join(this.deploymentRoot(deploymentId), 'success.json');
    return existsSync(path) ? readJson(path) : undefined;
  }

  writeEvidence(evidence: SignedControllerEvidence): void {
    const root = this.deploymentRoot(evidence.deploymentId);
    createOnce(join(root, 'evidence', `${evidence.recordDigest}.json`), evidence);
    if (evidence.disposition === 'disarmed') createOnce(join(root, 'disarmed.json'), evidence);
    if (evidence.disposition === 'rolled_back' || evidence.disposition === 'rollback_failed') {
      createOnce(join(root, 'rollback.json'), evidence);
    }
  }

  writeManualRecoveryEvidence(evidence: SignedControllerEvidence): void {
    const root = this.deploymentRoot(evidence.deploymentId);
    createOnce(join(root, 'evidence', `${evidence.recordDigest}.json`), evidence);
    const attempts = join(root, 'manual-recovery');
    ensureDirectory(attempts);
    const sequence = String(new Date(evidence.occurredAt).valueOf()).padStart(16, '0');
    createOnce(join(attempts, `${sequence}-${evidence.recordDigest}.json`), evidence);
  }

  readTerminalEvidence(deploymentId: string): unknown | undefined {
    const root = this.deploymentRoot(deploymentId);
    const attempts = join(root, 'manual-recovery');
    if (existsSync(attempts)) {
      const names = readdirSync(attempts).sort();
      const latest = names.at(-1);
      if (latest) return readJson(join(attempts, latest));
    }
    for (const name of ['disarmed.json', 'rollback.json']) {
      const path = join(root, name);
      if (existsSync(path)) return readJson(path);
    }
    return undefined;
  }

  latestGeneration(): number {
    const names = readdirSync(join(this.options.root, 'generations'));
    let latest = 0;
    for (const name of names) {
      if (!/^\d{20}\.json$/u.test(name)) {
        throw new ControllerError('controller_integrity_failed', `Unexpected generation record ${name}`);
      }
      latest = Math.max(latest, Number(name.slice(0, 20)));
    }
    return latest;
  }

  activeGuardIds(): string[] {
    const deploymentsRoot = join(this.options.root, 'deployments');
    return readdirSync(deploymentsRoot).filter((deploymentId) => {
      this.assertDeploymentId(deploymentId);
      const root = join(deploymentsRoot, deploymentId);
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ControllerError('controller_integrity_failed', `Unsafe deployment root ${root}`);
      }
      return existsSync(join(root, 'guard.json')) &&
        !existsSync(join(root, 'disarmed.json')) &&
        !existsSync(join(root, 'rollback.json'));
    });
  }

  private deploymentRoot(deploymentId: string): string {
    this.assertDeploymentId(deploymentId);
    return join(this.options.root, 'deployments', deploymentId);
  }

  private assertDeploymentId(deploymentId: string): void {
    if (!IDENTIFIER.test(deploymentId) || basename(deploymentId) !== deploymentId) {
      throw new ControllerError('controller_invalid_record', 'Invalid deployment identifier');
    }
  }
}
