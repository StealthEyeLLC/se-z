// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/**
 * Disposable ZFS clone + real systemd-nspawn host-certification runner.
 *
 * The public surface accepts a signed-by-digest fixed plan, never arbitrary
 * commands, bind mounts, datasets, machine names, or host paths.
 */

import { createHash, randomBytes, type KeyObject } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import {
  NSPAWN_PROFILE,
  NSPAWN_RECORD_VERSION,
  signNspawnRunReceipt,
  verifyNspawnRunPlan,
  type NspawnCleanupDisposition,
  type NspawnEvidenceFile,
  type NspawnRunPlan,
  type NspawnRunReceiptPayload,
  type SignedNspawnRunReceipt,
} from './nspawn-contract.js';
import type {
  NspawnCommandExecutor,
  NspawnCommandRequest,
  NspawnCommandResult,
} from './nspawn-executor.js';

const GIB = 1024 ** 3;
const MAX_RECORD_BYTES = 1024 * 1024;
const SAFE_COMPONENT = /^[a-z0-9][a-z0-9-]{7,47}$/;
const SAFE_DATASET = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,511}$/;
const CERTIFICATION_RESULT_KEYS = [
  'recordVersion',
  'recordType',
  'runId',
  'planDigest',
  'outcome',
  'pid1',
  'privilegeProfile',
  'uid997',
  'soPeerCred',
  'systemdLifecycle',
  'productionShapedCycles',
  'testSummary',
  'completedAt',
] as const;

export type NspawnRunnerErrorCode =
  | 'nspawn_invalid_plan'
  | 'nspawn_deadline_expired'
  | 'nspawn_host_unavailable'
  | 'nspawn_resource_unavailable'
  | 'nspawn_integrity_failed'
  | 'nspawn_collision'
  | 'nspawn_clone_failed'
  | 'nspawn_boot_failed'
  | 'nspawn_certification_failed'
  | 'nspawn_evidence_invalid'
  | 'nspawn_cleanup_failed'
  | 'nspawn_runner_busy';

export class NspawnRunnerError extends Error {
  constructor(
    public readonly code: NspawnRunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NspawnRunnerError';
  }
}

export interface NspawnRunnerConfig {
  pool: string;
  baseDataset: string;
  baseSnapshot: string;
  runsDataset: string;
  inputsRoot: string;
  machinesRoot: string;
  evidenceRoot: string;
  lockPath: string;
  harnessPathInImage: string;
  signingKeyId: string;
  cloneRefquotaBytes: number;
  minimumPoolFreeBytes: number;
  minimumHostAvailableBytes: number;
  minimumHostMemoryAvailableBytes: number;
  memoryMaxBytes: number;
  tasksMax: number;
  maximumInputBytes: number;
  maximumEvidenceBytes: number;
  maximumRunMs: number;
  binaries: {
    ps: string;
    stat: string;
    systemdNspawn: string;
    zpool: string;
    zfs: string;
    machinectl: string;
    journalctl: string;
  };
}

export const DEFAULT_NSPAWN_RUNNER_CONFIG: Readonly<NspawnRunnerConfig> = Object.freeze({
  pool: 'sezcert',
  baseDataset: 'sezcert/base/noble',
  baseSnapshot: 'sezcert/base/noble@golden-v1',
  runsDataset: 'sezcert/runs',
  inputsRoot: '/var/lib/se-z-nspawn/inputs',
  machinesRoot: '/var/lib/se-z-nspawn/machines',
  evidenceRoot: '/var/lib/se-z-nspawn/evidence',
  lockPath: '/var/lib/se-z-nspawn/runner.lock',
  harnessPathInImage: '/usr/local/libexec/se-z-host-certification.mjs',
  signingKeyId: 'se-z-nspawn-evidence-v1',
  cloneRefquotaBytes: 9 * GIB,
  minimumPoolFreeBytes: 2 * GIB,
  minimumHostAvailableBytes: 12 * GIB,
  minimumHostMemoryAvailableBytes: 3 * GIB,
  memoryMaxBytes: 8 * GIB,
  tasksMax: 4096,
  maximumInputBytes: 2 * GIB,
  maximumEvidenceBytes: 2 * GIB,
  maximumRunMs: 96 * 60 * 60 * 1000,
  binaries: {
    ps: '/usr/bin/ps',
    stat: '/usr/bin/stat',
    systemdNspawn: '/usr/bin/systemd-nspawn',
    zpool: '/usr/sbin/zpool',
    zfs: '/usr/sbin/zfs',
    machinectl: '/usr/bin/machinectl',
    journalctl: '/usr/bin/journalctl',
  },
});

interface CloneIdentity {
  origin: string;
  runId: string;
  planDigest: string;
  mounted: boolean;
}

interface LockIdentity {
  pid: number;
  startTime: string;
  executable: string;
  token: string;
}

interface CertificationResult {
  outcome: 'passed' | 'failed';
}

interface RunState {
  startedAt: string;
  evidenceRoot: string;
  guestEvidenceRoot: string;
  cloneDataset: string;
  machineRoot: string;
  machineName: string;
  cloneAttempted: boolean;
  cloneOwned: boolean;
  bootAttempted: boolean;
  error?: NspawnRunnerError;
}

export interface NspawnRunnerOptions {
  config?: NspawnRunnerConfig;
  executor: NspawnCommandExecutor;
  evidencePrivateKey: KeyObject;
  now?: () => Date;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new NspawnRunnerError('nspawn_evidence_invalid', `${label} has missing or unknown fields`);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function createOnce(path: string, value: unknown): void {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  if (bytes.length > MAX_RECORD_BYTES) {
    throw new NspawnRunnerError('nspawn_evidence_invalid', 'nspawn record exceeds size limit');
  }
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readFileSync(path);
      if (existing.equals(bytes)) return;
      throw new NspawnRunnerError('nspawn_integrity_failed', `create-once record differs: ${path}`);
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
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_RECORD_BYTES) {
    throw new NspawnRunnerError('nspawn_integrity_failed', `unsafe nspawn record: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function ensureSafeExistingDirectory(path: string, requireRootOwner = true): void {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(resolved) !== resolved ||
    (stat.mode & 0o022) !== 0 ||
    (requireRootOwner && stat.uid !== 0)
  ) {
    throw new NspawnRunnerError('nspawn_integrity_failed', `unsafe nspawn directory: ${path}`);
  }
}

async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveDigest(hash.digest('hex')));
  });
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

function liveLock(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
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

function validateConfig(config: NspawnRunnerConfig): void {
  for (const dataset of [config.pool, config.baseDataset, config.runsDataset]) {
    if (!SAFE_DATASET.test(dataset)) throw new Error('unsafe nspawn ZFS configuration');
  }
  if (
    config.baseSnapshot !== `${config.baseDataset}@golden-v1` ||
    !config.harnessPathInImage.startsWith('/') ||
    basename(config.harnessPathInImage) !== 'se-z-host-certification.mjs'
  ) {
    throw new Error('invalid fixed nspawn configuration');
  }
  for (const path of [
    config.inputsRoot,
    config.machinesRoot,
    config.evidenceRoot,
    config.lockPath,
    ...Object.values(config.binaries),
  ]) {
    if (!path.startsWith('/') || path.includes('\0')) throw new Error('nspawn paths must be absolute');
  }
  for (const value of [
    config.cloneRefquotaBytes,
    config.minimumPoolFreeBytes,
    config.minimumHostAvailableBytes,
    config.minimumHostMemoryAvailableBytes,
    config.memoryMaxBytes,
    config.tasksMax,
    config.maximumInputBytes,
    config.maximumEvidenceBytes,
    config.maximumRunMs,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid nspawn resource bound');
  }
}

function commandFailure(
  result: NspawnCommandResult,
  code: NspawnRunnerErrorCode,
  label: string,
): NspawnRunnerError | undefined {
  if (result.timedOut) return new NspawnRunnerError(code, `${label} timed out`);
  if (result.outputLimitExceeded) return new NspawnRunnerError(code, `${label} exceeded output bound`);
  if (result.exitCode !== 0) return new NspawnRunnerError(code, `${label} exited nonzero`);
  return undefined;
}

function parseMemAvailable(): number {
  const match = /^MemAvailable:\s+([0-9]+)\s+kB$/mu.exec(readFileSync('/proc/meminfo', 'utf8'));
  return match ? Number.parseInt(match[1]!, 10) * 1024 : 0;
}

function machineUuid(planDigest: string): string {
  const raw = planDigest.slice(0, 32);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function errorFromUnknown(error: unknown): NspawnRunnerError {
  if (error instanceof NspawnRunnerError) return error;
  return new NspawnRunnerError(
    'nspawn_integrity_failed',
    error instanceof Error ? error.message : 'unknown nspawn runner failure',
  );
}

export class FixedNspawnRehearsalRunner {
  private readonly config: NspawnRunnerConfig;
  private readonly now: () => Date;

  constructor(private readonly options: NspawnRunnerOptions) {
    this.config = options.config ?? { ...DEFAULT_NSPAWN_RUNNER_CONFIG };
    validateConfig(this.config);
    this.now = options.now ?? (() => new Date());
  }

  async preflight(input: unknown): Promise<NspawnRunPlan> {
    let plan: NspawnRunPlan;
    try {
      plan = verifyNspawnRunPlan(input);
    } catch (error) {
      throw new NspawnRunnerError(
        'nspawn_invalid_plan',
        error instanceof Error ? error.message : 'invalid nspawn run plan',
      );
    }
    if (plan.baseSnapshot !== this.config.baseSnapshot) {
      throw new NspawnRunnerError('nspawn_invalid_plan', 'plan names an unconfigured base snapshot');
    }
    if (this.now().valueOf() >= Date.parse(plan.deadline)) {
      throw new NspawnRunnerError('nspawn_deadline_expired', 'nspawn run deadline has expired');
    }
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      throw new NspawnRunnerError('nspawn_host_unavailable', 'nspawn runner requires real host root');
    }

    for (const path of [this.config.inputsRoot, this.config.machinesRoot, this.config.evidenceRoot]) {
      ensureSafeExistingDirectory(path);
    }
    ensureSafeExistingDirectory(dirname(this.config.lockPath));
    const inputRoot = this.inputRoot(plan.runId);
    ensureSafeExistingDirectory(inputRoot);
    if (existsSync(this.evidenceRoot(plan.runId)) || existsSync(this.machineRoot(plan.runId))) {
      throw new NspawnRunnerError('nspawn_collision', 'nspawn run paths already exist');
    }
    await this.verifyInputFile(join(inputRoot, 'plan.json'), plan.planDigest, true);
    await this.verifyInputFile(
      join(inputRoot, 'se-z.bundle'),
      plan.inputs.sez.bundleDigest,
      false,
    );
    await this.verifyInputFile(
      join(inputRoot, 'se-z-gateway.bundle'),
      plan.inputs.gateway.bundleDigest,
      false,
    );
    await this.verifyInputFile(
      join(inputRoot, 'npm-cache.tar'),
      plan.dependencyCacheDigest,
      false,
    );
    await this.verifyInputFile(
      join(inputRoot, 'se-z-host-certification.mjs'),
      plan.harnessDigest,
      false,
    );

    const pid1 = await this.mustCapture(
      'host PID 1 check',
      this.config.binaries.ps,
      ['-p', '1', '-o', 'comm='],
      'nspawn_host_unavailable',
    );
    if (pid1.stdout.trim() !== 'systemd') {
      throw new NspawnRunnerError('nspawn_host_unavailable', 'host PID 1 is not systemd');
    }
    const cgroup = await this.mustCapture(
      'host cgroup check',
      this.config.binaries.stat,
      ['-fc', '%T', '/sys/fs/cgroup'],
      'nspawn_host_unavailable',
    );
    if (cgroup.stdout.trim() !== 'cgroup2fs') {
      throw new NspawnRunnerError('nspawn_host_unavailable', 'host is not using cgroup v2');
    }
    const version = await this.mustCapture(
      'systemd-nspawn version check',
      this.config.binaries.systemdNspawn,
      ['--version'],
      'nspawn_host_unavailable',
    );
    const systemdVersion = /^systemd\s+([0-9]+)/u.exec(version.stdout)?.[1];
    if (!systemdVersion || Number.parseInt(systemdVersion, 10) < 255) {
      throw new NspawnRunnerError('nspawn_host_unavailable', 'systemd-nspawn 255 or newer is required');
    }

    const pool = await this.mustCapture(
      'ZFS pool check',
      this.config.binaries.zpool,
      ['list', '-H', '-p', '-o', 'health,free,size', this.config.pool],
      'nspawn_host_unavailable',
    );
    const [health, freeText] = pool.stdout.trim().split(/\s+/u);
    const poolFree = Number.parseInt(freeText ?? '', 10);
    if (health !== 'ONLINE' || !Number.isSafeInteger(poolFree)) {
      throw new NspawnRunnerError('nspawn_host_unavailable', 'ZFS pool is not healthy');
    }
    if (poolFree < this.config.minimumPoolFreeBytes) {
      throw new NspawnRunnerError('nspawn_resource_unavailable', 'ZFS pool reserve is unavailable');
    }

    const snapshot = await this.mustCapture(
      'golden snapshot check',
      this.config.binaries.zfs,
      ['list', '-H', '-p', '-o', 'name,type,guid', this.config.baseSnapshot],
      'nspawn_host_unavailable',
    );
    const [snapshotName, snapshotType, snapshotGuid] = snapshot.stdout.trim().split(/\s+/u);
    if (
      snapshotName !== this.config.baseSnapshot ||
      snapshotType !== 'snapshot' ||
      snapshotGuid !== plan.baseSnapshotGuid
    ) {
      throw new NspawnRunnerError('nspawn_integrity_failed', 'golden snapshot identity mismatch');
    }
    const readonly = await this.mustCapture(
      'golden dataset readonly check',
      this.config.binaries.zfs,
      ['get', '-H', '-p', '-o', 'value', 'readonly', this.config.baseDataset],
      'nspawn_host_unavailable',
    );
    if (readonly.stdout.trim() !== 'on') {
      throw new NspawnRunnerError('nspawn_integrity_failed', 'golden dataset is not read-only');
    }
    const datasets = await this.listRunDatasets();
    if (!datasets.has(this.config.runsDataset) || datasets.has(this.cloneDataset(plan.runId))) {
      throw new NspawnRunnerError('nspawn_collision', 'nspawn clone dataset collision');
    }
    const machines = await this.listMachines();
    if (machines.has(this.machineName(plan.runId))) {
      throw new NspawnRunnerError('nspawn_collision', 'nspawn machine name collision');
    }

    const filesystem = statfsSync(this.config.evidenceRoot);
    const hostAvailable = filesystem.bavail * filesystem.bsize;
    if (hostAvailable < this.config.minimumHostAvailableBytes + this.config.maximumEvidenceBytes) {
      throw new NspawnRunnerError('nspawn_resource_unavailable', 'host emergency disk reserve is unavailable');
    }
    if (parseMemAvailable() < this.config.minimumHostMemoryAvailableBytes) {
      throw new NspawnRunnerError('nspawn_resource_unavailable', 'host emergency memory reserve is unavailable');
    }
    return plan;
  }

  async run(input: unknown): Promise<SignedNspawnRunReceipt> {
    return await this.withLock(async () => {
      const plan = await this.preflight(input);
      const state = this.initializeRun(plan);
      try {
        await this.clone(plan, state);
        await this.mountAndVerify(state);
        await this.boot(plan, state);
        const result = this.verifyCertificationResult(plan, state);
        if (result.outcome !== 'passed') {
          throw new NspawnRunnerError('nspawn_certification_failed', 'guest certification reported failure');
        }
      } catch (error) {
        state.error = errorFromUnknown(error);
      }

      await this.capturePostRunEvidence(state);
      const cleanup = await this.cleanup(plan, state);
      if (
        cleanup.clone === 'manual_recovery_required' ||
        cleanup.machine === 'manual_recovery_required'
      ) {
        state.error = new NspawnRunnerError(
          'nspawn_cleanup_failed',
          'nspawn resources require exact manual recovery',
        );
      }
      const receipt = await this.finalizeReceipt(plan, state, cleanup);
      return receipt;
    });
  }

  private initializeRun(plan: NspawnRunPlan): RunState {
    const evidenceRoot = this.evidenceRoot(plan.runId);
    mkdirSync(evidenceRoot, { mode: 0o700 });
    ensureSafeExistingDirectory(evidenceRoot);
    const guestEvidenceRoot = join(evidenceRoot, 'guest');
    mkdirSync(guestEvidenceRoot, { mode: 0o700 });
    ensureSafeExistingDirectory(guestEvidenceRoot);
    createOnce(join(evidenceRoot, 'plan.json'), plan);
    const startedAt = this.now().toISOString();
    createOnce(join(evidenceRoot, 'started.json'), {
      recordVersion: NSPAWN_RECORD_VERSION,
      recordType: 'se-z-nspawn-run-started',
      runId: plan.runId,
      planDigest: plan.planDigest,
      startedAt,
    });
    return {
      startedAt,
      evidenceRoot,
      guestEvidenceRoot,
      cloneDataset: this.cloneDataset(plan.runId),
      machineRoot: this.machineRoot(plan.runId),
      machineName: this.machineName(plan.runId),
      cloneAttempted: false,
      cloneOwned: false,
      bootAttempted: false,
    };
  }

  private async clone(plan: NspawnRunPlan, state: RunState): Promise<void> {
    state.cloneAttempted = true;
    const result = await this.options.executor.run({
      file: this.config.binaries.zfs,
      args: [
        'clone',
        '-o', `canmount=noauto`,
        '-o', `mountpoint=${state.machineRoot}`,
        '-o', 'readonly=off',
        '-o', `refquota=${this.config.cloneRefquotaBytes}`,
        '-o', `com.stealtheye:run-id=${plan.runId}`,
        '-o', `com.stealtheye:plan-digest=${plan.planDigest}`,
        this.config.baseSnapshot,
        state.cloneDataset,
      ],
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    });
    const identity = await this.inspectClone(state);
    state.cloneOwned = identity !== undefined && this.isOwnedClone(plan, identity);
    const failure = commandFailure(result, 'nspawn_clone_failed', 'ZFS clone');
    if (failure) throw failure;
    if (!state.cloneOwned) {
      throw new NspawnRunnerError('nspawn_integrity_failed', 'created clone identity mismatch');
    }
  }

  private async mountAndVerify(state: RunState): Promise<void> {
    await this.mustRun({
      file: this.config.binaries.zfs,
      args: ['mount', state.cloneDataset],
      timeoutMs: 60_000,
    }, 'nspawn_clone_failed', 'ZFS clone mount');
    ensureSafeExistingDirectory(state.machineRoot);
    const osRelease = join(state.machineRoot, 'usr/lib/os-release');
    const harness = join(state.machineRoot, this.config.harnessPathInImage.slice(1));
    for (const path of [osRelease, harness]) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        throw new NspawnRunnerError('nspawn_integrity_failed', `unsafe golden image file: ${path}`);
      }
    }
  }

  private async boot(plan: NspawnRunPlan, state: RunState): Promise<void> {
    state.bootAttempted = true;
    const remaining = Date.parse(plan.deadline) - this.now().valueOf();
    if (remaining < 60_000) {
      throw new NspawnRunnerError('nspawn_deadline_expired', 'insufficient run deadline remains');
    }
    const timeoutMs = Math.min(remaining, this.config.maximumRunMs);
    const inputRoot = this.inputRoot(plan.runId);
    const result = await this.options.executor.run({
      file: this.config.binaries.systemdNspawn,
      args: this.bootArgs(plan, state, inputRoot),
      timeoutMs,
      maxOutputBytes: 1024 * 1024,
      stdoutPath: join(state.evidenceRoot, 'nspawn.stdout.log'),
      stderrPath: join(state.evidenceRoot, 'nspawn.stderr.log'),
    });
    const failure = commandFailure(result, 'nspawn_boot_failed', 'systemd-nspawn');
    if (failure) throw failure;
  }

  private bootArgs(plan: NspawnRunPlan, state: RunState, inputRoot: string): string[] {
    return [
      '--quiet',
      '--boot',
      `--directory=${state.machineRoot}`,
      `--machine=${state.machineName}`,
      `--uuid=${machineUuid(plan.planDigest)}`,
      '--settings=no',
      '--register=yes',
      '--private-users=no',
      '--capability=all',
      '--no-new-privileges=no',
      '--system-call-filter=@known',
      '--private-network',
      '--resolv-conf=off',
      '--link-journal=no',
      '--console=read-only',
      '--volatile=no',
      '--property=Delegate=yes',
      '--property=DevicePolicy=auto',
      `--property=MemoryMax=${this.config.memoryMaxBytes}`,
      '--property=MemorySwapMax=0',
      `--property=TasksMax=${this.config.tasksMax}`,
      '--property=CPUWeight=100',
      `--bind-ro=${inputRoot}:/run/se-z-certification/input`,
      `--bind-ro=${join(inputRoot, 'se-z-host-certification.mjs')}:${this.config.harnessPathInImage}`,
      `--bind=${state.guestEvidenceRoot}:/run/se-z-certification/evidence`,
      '--setenv=SEZ_CERTIFICATION_PLAN=/run/se-z-certification/input/plan.json',
    ];
  }

  private verifyCertificationResult(plan: NspawnRunPlan, state: RunState): CertificationResult {
    const path = join(state.guestEvidenceRoot, 'certification-result.json');
    if (!existsSync(path)) {
      throw new NspawnRunnerError('nspawn_evidence_invalid', 'guest certification result is missing');
    }
    const value = readJson(path);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new NspawnRunnerError('nspawn_evidence_invalid', 'guest certification result is invalid');
    }
    const result = value as Record<string, unknown>;
    exactKeys(result, CERTIFICATION_RESULT_KEYS, 'guest certification result');
    if (
      result.recordVersion !== NSPAWN_RECORD_VERSION ||
      result.recordType !== 'se-z-host-certification-result' ||
      result.runId !== plan.runId ||
      result.planDigest !== plan.planDigest ||
      !['passed', 'failed'].includes(result.outcome as string) ||
      !['systemd', 'not-systemd'].includes(result.pid1 as string) ||
      !['root-no-userns-all-capabilities', 'restricted'].includes(result.privilegeProfile as string) ||
      !['passed', 'failed'].includes(result.uid997 as string) ||
      !['passed', 'failed'].includes(result.soPeerCred as string) ||
      !['passed', 'failed'].includes(result.systemdLifecycle as string) ||
      result.productionShapedCycles !== 3 ||
      typeof result.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(result.completedAt)) ||
      result.testSummary === null ||
      typeof result.testSummary !== 'object' ||
      Array.isArray(result.testSummary)
    ) {
      throw new NspawnRunnerError('nspawn_evidence_invalid', 'guest certification assertions are invalid');
    }
    const summary = result.testSummary as Record<string, unknown>;
    exactKeys(summary, ['commands', 'tests', 'passed', 'failed', 'skipped', 'durationMs'], 'test summary');
    for (const key of ['commands', 'tests', 'passed', 'failed', 'skipped', 'durationMs'] as const) {
      if (typeof summary[key] !== 'number' || !Number.isSafeInteger(summary[key]) || summary[key] < 0) {
        throw new NspawnRunnerError('nspawn_evidence_invalid', 'guest test summary is invalid');
      }
    }
    if (result.outcome === 'passed' && (summary.failed !== 0 || summary.passed === 0)) {
      throw new NspawnRunnerError('nspawn_evidence_invalid', 'passing guest result contradicts test totals');
    }
    if (
      result.outcome === 'passed' &&
      (
        result.pid1 !== 'systemd' ||
        result.privilegeProfile !== 'root-no-userns-all-capabilities' ||
        result.uid997 !== 'passed' ||
        result.soPeerCred !== 'passed' ||
        result.systemdLifecycle !== 'passed'
      )
    ) {
      throw new NspawnRunnerError('nspawn_evidence_invalid', 'passing guest result contradicts host assertions');
    }
    return { outcome: result.outcome as 'passed' | 'failed' };
  }

  private async capturePostRunEvidence(state: RunState): Promise<void> {
    if (!state.cloneOwned) return;
    try {
      await this.options.executor.run({
        file: this.config.binaries.journalctl,
        args: [
          `--directory=${join(state.machineRoot, 'var/log/journal')}`,
          '--no-pager',
          '--output=short-iso-precise',
        ],
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
        stdoutPath: join(state.evidenceRoot, 'container-journal.log'),
        stderrPath: join(state.evidenceRoot, 'container-journal.stderr.log'),
      });
      const usage = await this.options.executor.run({
        file: this.config.binaries.zfs,
        args: ['list', '-H', '-p', '-o', 'used,referenced,available,logicalused', state.cloneDataset],
        timeoutMs: 30_000,
        maxOutputBytes: 1024 * 1024,
      });
      writeFileSync(join(state.evidenceRoot, 'zfs-usage.txt'), usage.stdout, {
        mode: 0o600,
        flag: 'wx',
      });
      fsyncDirectory(state.evidenceRoot);
    } catch (error) {
      state.error ??= errorFromUnknown(error);
    }
  }

  private async cleanup(
    plan: NspawnRunPlan,
    state: RunState,
  ): Promise<NspawnRunReceiptPayload['cleanup']> {
    let machine: NspawnRunReceiptPayload['cleanup']['machine'] = state.bootAttempted
      ? 'stopped'
      : 'not_started';
    try {
      const machines = await this.listMachines();
      if (machines.has(state.machineName)) {
        const root = await this.mustCapture(
          'machine root inspection',
          this.config.binaries.machinectl,
          ['show', state.machineName, '--property=RootDirectory', '--value'],
          'nspawn_cleanup_failed',
        );
        if (resolve(root.stdout.trim()) !== resolve(state.machineRoot)) {
          machine = 'manual_recovery_required';
        } else {
          await this.mustRun({
            file: this.config.binaries.machinectl,
            args: ['terminate', state.machineName],
            timeoutMs: 60_000,
          }, 'nspawn_cleanup_failed', 'machine termination');
          if ((await this.listMachines()).has(state.machineName)) {
            machine = 'manual_recovery_required';
          }
        }
      }
    } catch {
      machine = 'manual_recovery_required';
    }

    let clone: NspawnCleanupDisposition = state.cloneAttempted ? 'destroyed' : 'not_created';
    try {
      const identity = await this.inspectClone(state);
      if (!identity) {
        clone = state.cloneAttempted ? 'destroyed' : 'not_created';
      } else if (!this.isOwnedClone(plan, identity) || machine === 'manual_recovery_required') {
        clone = 'manual_recovery_required';
      } else {
        if (identity.mounted) {
          await this.mustRun({
            file: this.config.binaries.zfs,
            args: ['unmount', state.cloneDataset],
            timeoutMs: 60_000,
          }, 'nspawn_cleanup_failed', 'ZFS clone unmount');
        }
        await this.mustRun({
          file: this.config.binaries.zfs,
          args: ['destroy', '-r', state.cloneDataset],
          timeoutMs: 120_000,
        }, 'nspawn_cleanup_failed', 'ZFS clone destroy');
        if (await this.inspectClone(state)) clone = 'manual_recovery_required';
        else clone = 'destroyed';
      }
    } catch {
      clone = 'manual_recovery_required';
    }
    return { clone, machine };
  }

  private async finalizeReceipt(
    plan: NspawnRunPlan,
    state: RunState,
    cleanup: NspawnRunReceiptPayload['cleanup'],
  ): Promise<SignedNspawnRunReceipt> {
    const evidenceFiles = await this.inventoryEvidence(state.evidenceRoot);
    const payload: NspawnRunReceiptPayload = {
      recordVersion: NSPAWN_RECORD_VERSION,
      recordType: 'se-z-nspawn-run-receipt',
      profile: NSPAWN_PROFILE,
      runId: plan.runId,
      planDigest: plan.planDigest,
      baseSnapshot: plan.baseSnapshot,
      baseSnapshotGuid: plan.baseSnapshotGuid,
      cloneDataset: state.cloneDataset,
      machineName: state.machineName,
      startedAt: state.startedAt,
      completedAt: this.now().toISOString(),
      outcome: state.error ? 'failed' : 'passed',
      errorCode: state.error?.code ?? null,
      evidenceFiles,
      cleanup,
      signingKeyId: this.config.signingKeyId,
      signatureAlgorithm: 'ed25519',
    };
    const receipt = signNspawnRunReceipt(payload, this.options.evidencePrivateKey);
    createOnce(join(state.evidenceRoot, 'receipt.json'), receipt);
    return receipt;
  }

  private async inventoryEvidence(root: string): Promise<NspawnEvidenceFile[]> {
    const entries: NspawnEvidenceFile[] = [];
    let total = 0;
    const walk = async (directory: string): Promise<void> => {
      for (const name of readdirSync(directory).sort()) {
        if (name === 'receipt.json') continue;
        const absolute = join(directory, name);
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          throw new NspawnRunnerError('nspawn_evidence_invalid', 'evidence symlink rejected');
        }
        if (stat.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!stat.isFile()) {
          throw new NspawnRunnerError('nspawn_evidence_invalid', 'evidence special file rejected');
        }
        total += stat.size;
        if (total > this.config.maximumEvidenceBytes || entries.length >= 10_000) {
          throw new NspawnRunnerError('nspawn_evidence_invalid', 'evidence bounds exceeded');
        }
        entries.push({
          path: relative(root, absolute).split(sep).join('/'),
          size: stat.size,
          digest: await sha256File(absolute),
        });
      }
    };
    await walk(root);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async verifyInputFile(path: string, expectedDigest: string, isPlan: boolean): Promise<void> {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      stat.size < 1 ||
      stat.size > this.config.maximumInputBytes
    ) {
      throw new NspawnRunnerError('nspawn_integrity_failed', `unsafe nspawn input: ${path}`);
    }
    if (isPlan) {
      const plan = verifyNspawnRunPlan(readJson(path));
      if (plan.planDigest !== expectedDigest) {
        throw new NspawnRunnerError('nspawn_integrity_failed', 'input plan identity mismatch');
      }
      return;
    }
    const digest = await sha256File(path);
    if (digest !== expectedDigest) {
      throw new NspawnRunnerError('nspawn_integrity_failed', `input digest mismatch: ${basename(path)}`);
    }
  }

  private async inspectClone(state: RunState): Promise<CloneIdentity | undefined> {
    const datasets = await this.listRunDatasets();
    if (!datasets.has(state.cloneDataset)) return undefined;
    const result = await this.mustCapture(
      'clone ownership inspection',
      this.config.binaries.zfs,
      [
        'get', '-H', '-p', '-o', 'property,value',
        'origin,com.stealtheye:run-id,com.stealtheye:plan-digest,mounted',
        state.cloneDataset,
      ],
      'nspawn_integrity_failed',
    );
    const properties = new Map<string, string>();
    for (const line of result.stdout.trim().split('\n')) {
      const [property, value] = line.split(/\s+/u);
      if (property && value) properties.set(property, value);
    }
    return {
      origin: properties.get('origin') ?? '',
      runId: properties.get('com.stealtheye:run-id') ?? '',
      planDigest: properties.get('com.stealtheye:plan-digest') ?? '',
      mounted: properties.get('mounted') === 'yes',
    };
  }

  private isOwnedClone(plan: NspawnRunPlan, identity: CloneIdentity): boolean {
    return identity.origin === this.config.baseSnapshot &&
      identity.runId === plan.runId &&
      identity.planDigest === plan.planDigest;
  }

  private async listRunDatasets(): Promise<Set<string>> {
    const result = await this.mustCapture(
      'run dataset inventory',
      this.config.binaries.zfs,
      ['list', '-H', '-o', 'name', '-r', this.config.runsDataset],
      'nspawn_host_unavailable',
    );
    return new Set(result.stdout.trim().split('\n').filter(Boolean));
  }

  private async listMachines(): Promise<Set<string>> {
    const result = await this.mustCapture(
      'machine inventory',
      this.config.binaries.machinectl,
      ['list', '--no-legend', '--no-pager'],
      'nspawn_host_unavailable',
    );
    return new Set(
      result.stdout.trim().split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/u)[0]!),
    );
  }

  private async mustCapture(
    label: string,
    file: string,
    args: string[],
    code: NspawnRunnerErrorCode,
  ): Promise<NspawnCommandResult> {
    const result = await this.options.executor.run({
      file,
      args,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
    const failure = commandFailure(result, code, label);
    if (failure) throw failure;
    return result;
  }

  private async mustRun(
    request: NspawnCommandRequest,
    code: NspawnRunnerErrorCode,
    label: string,
  ): Promise<NspawnCommandResult> {
    const result = await this.options.executor.run({ maxOutputBytes: 1024 * 1024, ...request });
    const failure = commandFailure(result, code, label);
    if (failure) throw failure;
    return result;
  }

  private inputRoot(runId: string): string {
    if (!SAFE_COMPONENT.test(runId)) throw new Error('unsafe nspawn run id');
    return join(this.config.inputsRoot, runId);
  }

  private evidenceRoot(runId: string): string {
    if (!SAFE_COMPONENT.test(runId)) throw new Error('unsafe nspawn run id');
    return join(this.config.evidenceRoot, runId);
  }

  private machineRoot(runId: string): string {
    if (!SAFE_COMPONENT.test(runId)) throw new Error('unsafe nspawn run id');
    return join(this.config.machinesRoot, runId);
  }

  private cloneDataset(runId: string): string {
    if (!SAFE_COMPONENT.test(runId)) throw new Error('unsafe nspawn run id');
    return `${this.config.runsDataset}/${runId}`;
  }

  private machineName(runId: string): string {
    return `se-z-${sha256Hex(runId).slice(0, 8)}`;
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const identity = processIdentity();
    if (!identity) {
      throw new NspawnRunnerError('nspawn_integrity_failed', 'cannot establish runner identity');
    }
    const lock: LockIdentity = { ...identity, token: randomBytes(16).toString('hex') };
    let acquired = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        createOnce(this.config.lockPath, lock);
        acquired = true;
        break;
      } catch (error) {
        if (!(error instanceof NspawnRunnerError) || !existsSync(this.config.lockPath)) throw error;
        let current: unknown;
        try {
          current = readJson(this.config.lockPath);
        } catch {
          current = undefined;
        }
        if (liveLock(current)) {
          throw new NspawnRunnerError('nspawn_runner_busy', 'another nspawn run is active');
        }
        const stale = `${this.config.lockPath}.stale-${lock.token}`;
        renameSync(this.config.lockPath, stale);
        unlinkSync(stale);
        fsyncDirectory(dirname(this.config.lockPath));
      }
    }
    if (!acquired) throw new NspawnRunnerError('nspawn_runner_busy', 'cannot acquire nspawn runner lock');
    try {
      return await action();
    } finally {
      try {
        const current = readJson(this.config.lockPath) as Partial<LockIdentity>;
        if (current.token === lock.token) {
          unlinkSync(this.config.lockPath);
          fsyncDirectory(dirname(this.config.lockPath));
        }
      } catch {
        // Never remove a substituted lock.
      }
    }
  }
}
