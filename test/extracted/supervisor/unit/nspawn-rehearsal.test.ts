// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/nspawn-rehearsal.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { canonicalJson, sha256Hex } from '../../../../src/protocol/canonical/canonical.js';
import {
  buildNspawnRunPlan,
  verifySignedNspawnRunReceipt,
  type NspawnRunPlan,
} from '../../../../src/releases/rehearsal/nspawn-contract.js';
import type {
  NspawnCommandExecutor,
  NspawnCommandRequest,
  NspawnCommandResult,
} from '../../../../src/releases/rehearsal/nspawn-executor.js';
import {
  FixedNspawnRehearsalRunner,
  NspawnRunnerError,
  type NspawnRunnerConfig,
} from '../../../../src/releases/rehearsal/nspawn-runner.js';

const NOW = '2026-07-22T19:00:00.000Z';
const HARNESS = 'fixed host certification harness\n';

interface Behavior {
  snapshotGuid?: string;
  cloneExitCode?: number;
  foreignClone?: boolean;
  bootExitCode?: number;
  guestOutcome?: 'passed' | 'failed';
  invalidGuestResult?: boolean;
  leaveMachineRunning?: boolean;
}

interface Fixture {
  root: string;
  config: NspawnRunnerConfig;
  plan: NspawnRunPlan;
  executor: FakeExecutor;
  runner: FixedNspawnRehearsalRunner;
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
  cleanup(): void;
}

function result(
  exitCode: number,
  stdout = '',
  stderr = '',
): NspawnCommandResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr,
    timedOut: false,
    outputLimitExceeded: false,
    durationMs: 1,
  };
}

class FakeExecutor implements NspawnCommandExecutor {
  readonly requests: NspawnCommandRequest[] = [];
  private cloneExists = false;
  private cloneMounted = false;
  private machineRunning = false;

  constructor(
    private readonly config: NspawnRunnerConfig,
    private readonly plan: NspawnRunPlan,
    private readonly behavior: Behavior,
  ) {}

  async run(request: NspawnCommandRequest): Promise<NspawnCommandResult> {
    this.requests.push(request);
    if (request.stdoutPath) writeFileSync(request.stdoutPath, 'fixture stdout\n', { mode: 0o600, flag: 'wx' });
    if (request.stderrPath) writeFileSync(request.stderrPath, '', { mode: 0o600, flag: 'wx' });

    if (request.file === this.config.binaries.ps) return result(0, 'systemd\n');
    if (request.file === this.config.binaries.stat) return result(0, 'cgroup2fs\n');
    if (request.file === this.config.binaries.zpool) return result(0, `ONLINE\t${20 * 1024 ** 3}\t${24 * 1024 ** 3}\n`);
    if (request.file === this.config.binaries.machinectl) return this.machinectl(request.args);
    if (request.file === this.config.binaries.journalctl) return result(0);
    if (request.file === this.config.binaries.systemdNspawn) {
      if (request.args.includes('--version')) return result(0, 'systemd 255 (255.4-1ubuntu8.16)\n');
      return this.nspawn(request.args);
    }
    if (request.file === this.config.binaries.zfs) return this.zfs(request.args);
    throw new Error(`unexpected fake command: ${request.file} ${request.args.join(' ')}`);
  }

  private machinectl(args: readonly string[]): NspawnCommandResult {
    if (args[0] === 'list') {
      return result(0, this.machineRunning ? `${this.machineName()} container systemd - -\n` : '');
    }
    if (args[0] === 'show') return result(0, `${this.machineRoot()}\n`);
    if (args[0] === 'terminate') {
      this.machineRunning = false;
      return result(0);
    }
    throw new Error(`unexpected machinectl args: ${args.join(' ')}`);
  }

  private nspawn(args: readonly string[]): NspawnCommandResult {
    this.machineRunning = this.behavior.leaveMachineRunning ?? false;
    const bind = args.find((arg) => arg.startsWith('--bind=') && arg.endsWith(':/run/se-z-certification/evidence'));
    assert.ok(bind);
    const guestRoot = bind.slice('--bind='.length).split(':/run/')[0]!;
    const guestResult: Record<string, unknown> = {
      recordVersion: '1.0.0',
      recordType: 'se-z-host-certification-result',
      runId: this.plan.runId,
      planDigest: this.plan.planDigest,
      outcome: this.behavior.guestOutcome ?? 'passed',
      pid1: 'systemd',
      privilegeProfile: 'root-no-userns-all-capabilities',
      uid997: 'passed',
      soPeerCred: 'passed',
      systemdLifecycle: 'passed',
      productionShapedCycles: 3,
      testSummary: {
        commands: 12,
        tests: 140,
        passed: this.behavior.guestOutcome === 'failed' ? 139 : 140,
        failed: this.behavior.guestOutcome === 'failed' ? 1 : 0,
        skipped: 0,
        durationMs: 1234,
      },
      completedAt: '2026-07-22T19:10:00.000Z',
    };
    if (this.behavior.invalidGuestResult) guestResult.planDigest = 'f'.repeat(64);
    writeFileSync(join(guestRoot, 'certification-result.json'), `${canonicalJson(guestResult)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    return result(this.behavior.bootExitCode ?? 0);
  }

  private zfs(args: readonly string[]): NspawnCommandResult {
    if (args[0] === 'list' && args.includes(this.config.baseSnapshot)) {
      return result(
        0,
        `${this.config.baseSnapshot}\tsnapshot\t${this.behavior.snapshotGuid ?? this.plan.baseSnapshotGuid}\n`,
      );
    }
    if (args[0] === 'get' && args.includes('readonly')) return result(0, 'on\n');
    if (args[0] === 'list' && args.includes('-r')) {
      return result(
        0,
        `${this.config.runsDataset}\n${this.cloneExists ? `${this.cloneDataset()}\n` : ''}`,
      );
    }
    if (args[0] === 'clone') {
      this.cloneExists = true;
      return result(this.behavior.cloneExitCode ?? 0);
    }
    if (args[0] === 'get' && args.some((arg) => arg.includes('com.stealtheye:run-id'))) {
      assert.equal(this.cloneExists, true);
      return result(0, [
        `origin\t${this.config.baseSnapshot}`,
        `com.stealtheye:run-id\t${this.behavior.foreignClone ? 'foreign-run' : this.plan.runId}`,
        `com.stealtheye:plan-digest\t${this.behavior.foreignClone ? 'f'.repeat(64) : this.plan.planDigest}`,
        `mounted\t${this.cloneMounted ? 'yes' : 'no'}`,
      ].join('\n') + '\n');
    }
    if (args[0] === 'mount') {
      this.cloneMounted = true;
      mkdirSync(join(this.machineRoot(), 'usr/lib'), { recursive: true, mode: 0o755 });
      mkdirSync(join(this.machineRoot(), 'usr/local/libexec'), { recursive: true, mode: 0o755 });
      mkdirSync(join(this.machineRoot(), 'var/log/journal'), { recursive: true, mode: 0o755 });
      writeFileSync(join(this.machineRoot(), 'usr/lib/os-release'), 'ID=ubuntu\n', { mode: 0o644 });
      writeFileSync(join(this.machineRoot(), 'usr/local/libexec/se-z-host-certification.mjs'), HARNESS, { mode: 0o755 });
      return result(0);
    }
    if (args[0] === 'list' && args.includes('used,referenced,available,logicalused')) {
      return result(0, '1048576\t1048576\t8589934592\t1048576\n');
    }
    if (args[0] === 'unmount') {
      this.cloneMounted = false;
      return result(0);
    }
    if (args[0] === 'destroy') {
      this.cloneExists = false;
      this.cloneMounted = false;
      return result(0);
    }
    throw new Error(`unexpected zfs args: ${args.join(' ')}`);
  }

  private cloneDataset(): string {
    return `${this.config.runsDataset}/${this.plan.runId}`;
  }

  private machineRoot(): string {
    return join(this.config.machinesRoot, this.plan.runId);
  }

  private machineName(): string {
    return `se-z-${sha256Hex(this.plan.runId).slice(0, 8)}`;
  }
}

function fixture(behavior: Behavior = {}, mutateConfig?: (config: NspawnRunnerConfig) => void): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'se-z-nspawn-'));
  const inputsRoot = join(root, 'inputs');
  const machinesRoot = join(root, 'machines');
  const evidenceRoot = join(root, 'evidence');
  const runRoot = join(root, 'run');
  for (const path of [inputsRoot, machinesRoot, evidenceRoot, runRoot]) {
    mkdirSync(path, { mode: 0o700 });
  }
  const config: NspawnRunnerConfig = {
    pool: 'fixturepool',
    baseDataset: 'fixturepool/base/noble',
    baseSnapshot: 'fixturepool/base/noble@golden-v1',
    runsDataset: 'fixturepool/runs',
    inputsRoot,
    machinesRoot,
    evidenceRoot,
    lockPath: join(runRoot, 'nspawn.lock'),
    harnessPathInImage: '/usr/local/libexec/se-z-host-certification.mjs',
    signingKeyId: 'fixture-nspawn-evidence',
    cloneRefquotaBytes: 9 * 1024 ** 3,
    minimumPoolFreeBytes: 1,
    minimumHostAvailableBytes: 0,
    minimumHostMemoryAvailableBytes: 0,
    memoryMaxBytes: 8 * 1024 ** 3,
    tasksMax: 4096,
    maximumInputBytes: 1024 * 1024,
    maximumEvidenceBytes: 16 * 1024 * 1024,
    maximumRunMs: 60 * 60 * 1000,
    binaries: {
      ps: '/fixture/ps',
      stat: '/fixture/stat',
      systemdNspawn: '/fixture/systemd-nspawn',
      zpool: '/fixture/zpool',
      zfs: '/fixture/zfs',
      machinectl: '/fixture/machinectl',
      journalctl: '/fixture/journalctl',
    },
  };
  mutateConfig?.(config);
  const runId = 'cert-run-0001';
  const inputRoot = join(inputsRoot, runId);
  mkdirSync(inputRoot, { mode: 0o700 });
  const sez = Buffer.from('sez source archive');
  const gateway = Buffer.from('gateway source archive');
  const dependencyCache = Buffer.from('npm cache archive');
  writeFileSync(join(inputRoot, 'se-z.bundle'), sez, { mode: 0o600 });
  writeFileSync(join(inputRoot, 'se-z-gateway.bundle'), gateway, { mode: 0o600 });
  writeFileSync(join(inputRoot, 'npm-cache.tar'), dependencyCache, { mode: 0o600 });
  writeFileSync(join(inputRoot, 'se-z-host-certification.mjs'), HARNESS, { mode: 0o600 });
  const plan = buildNspawnRunPlan({
    recordVersion: '1.0.0',
    recordType: 'se-z-nspawn-run-plan',
    profile: 'standalone-deployment-v2',
    runId,
    requestedAt: NOW,
    deadline: '2026-07-22T20:00:00.000Z',
    baseSnapshot: config.baseSnapshot,
    baseSnapshotGuid: '1234567890123456789',
    harnessDigest: sha256Hex(HARNESS),
    dependencyCacheDigest: sha256Hex(dependencyCache),
    inputs: {
      sez: {
        repository: 'StealthEyeLLC/se-z',
        commit: '1'.repeat(40),
        tree: '2'.repeat(40),
        bundleDigest: sha256Hex(sez),
      },
      gateway: {
        repository: 'StealthEyeLLC/se-z-gateway',
        commit: '3'.repeat(40),
        tree: '4'.repeat(40),
        bundleDigest: sha256Hex(gateway),
      },
    },
  });
  writeFileSync(join(inputRoot, 'plan.json'), `${canonicalJson(plan)}\n`, { mode: 0o600 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const executor = new FakeExecutor(config, plan, behavior);
  const runner = new FixedNspawnRehearsalRunner({
    config,
    executor,
    evidencePrivateKey: privateKey,
    now: () => new Date(NOW),
  });
  return {
    root,
    config,
    plan,
    executor,
    runner,
    publicKey,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('fixed unrestricted systemd-nspawn rehearsal runner', () => {
  it('boots real root without a user namespace and preserves signed evidence after clone destruction', async () => {
    const fx = fixture();
    try {
      const receipt = await fx.runner.run(fx.plan);
      assert.equal(receipt.outcome, 'passed');
      assert.deepEqual(receipt.cleanup, { clone: 'destroyed', machine: 'stopped' });
      assert.equal(verifySignedNspawnRunReceipt(receipt, fx.publicKey).recordDigest, receipt.recordDigest);
      assert.ok(receipt.evidenceFiles.some((entry) => entry.path === 'guest/certification-result.json'));
      assert.ok(readFileSync(join(fx.config.evidenceRoot, fx.plan.runId, 'receipt.json'), 'utf8'));

      const boot = fx.executor.requests.find(
        (request) => request.file === fx.config.binaries.systemdNspawn && request.args.includes('--boot'),
      );
      assert.ok(boot);
      for (const flag of [
        '--private-users=no',
        '--capability=all',
        '--no-new-privileges=no',
        '--system-call-filter=@known',
        '--property=Delegate=yes',
        '--property=DevicePolicy=auto',
        '--private-network',
        '--resolv-conf=off',
        '--volatile=no',
      ]) assert.ok(boot.args.includes(flag), flag);
      assert.equal(boot.args.some((arg) => arg.includes('/sys/fs/cgroup')), false);
      assert.equal(boot.args.some((arg) => arg.includes('/opt/se-z/current')), false);
      assert.equal(boot.args.some((arg) => arg.includes('/opt/se-z/gateway/current')), false);
      assert.equal(
        boot.args.some((arg) =>
          arg.endsWith('se-z-host-certification.mjs:/usr/local/libexec/se-z-host-certification.mjs')
        ),
        true,
      );
      assert.equal(
        fx.executor.requests.some(
          (request) => request.file === fx.config.binaries.zfs && request.args[0] === 'destroy',
        ),
        true,
      );
    } finally {
      fx.cleanup();
    }
  });

  it('fails before cloning when the host emergency disk reserve is unavailable', async () => {
    const fx = fixture({}, (config) => { config.minimumHostAvailableBytes = Number.MAX_SAFE_INTEGER; });
    try {
      await assert.rejects(
        fx.runner.run(fx.plan),
        (error: unknown) => error instanceof NspawnRunnerError && error.code === 'nspawn_resource_unavailable',
      );
      assert.equal(fx.executor.requests.some((request) => request.args[0] === 'clone'), false);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects a different golden snapshot GUID before creating a clone', async () => {
    const fx = fixture({ snapshotGuid: '9999999999999999999' });
    try {
      await assert.rejects(
        fx.runner.run(fx.plan),
        (error: unknown) => error instanceof NspawnRunnerError && error.code === 'nspawn_integrity_failed',
      );
      assert.equal(fx.executor.requests.some((request) => request.args[0] === 'clone'), false);
    } finally {
      fx.cleanup();
    }
  });

  it('reconciles an ambiguous clone response and destroys only the exactly tagged clone', async () => {
    const fx = fixture({ cloneExitCode: 1 });
    try {
      const receipt = await fx.runner.run(fx.plan);
      assert.equal(receipt.outcome, 'failed');
      assert.equal(receipt.errorCode, 'nspawn_clone_failed');
      assert.equal(receipt.cleanup.clone, 'destroyed');
      verifySignedNspawnRunReceipt(receipt, fx.publicKey);
    } finally {
      fx.cleanup();
    }
  });

  it('never destroys a clone whose origin or ownership tags differ', async () => {
    const fx = fixture({ cloneExitCode: 1, foreignClone: true });
    try {
      const receipt = await fx.runner.run(fx.plan);
      assert.equal(receipt.outcome, 'failed');
      assert.equal(receipt.errorCode, 'nspawn_cleanup_failed');
      assert.equal(receipt.cleanup.clone, 'manual_recovery_required');
      assert.equal(
        fx.executor.requests.some(
          (request) => request.file === fx.config.binaries.zfs && request.args[0] === 'destroy',
        ),
        false,
      );
    } finally {
      fx.cleanup();
    }
  });

  it('cleans the exact clone and emits a failed signed receipt when guest certification fails', async () => {
    const fx = fixture({ guestOutcome: 'failed' });
    try {
      const receipt = await fx.runner.run(fx.plan);
      assert.equal(receipt.outcome, 'failed');
      assert.equal(receipt.errorCode, 'nspawn_certification_failed');
      assert.equal(receipt.cleanup.clone, 'destroyed');
      verifySignedNspawnRunReceipt(receipt, fx.publicKey);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects guest evidence that is not bound to the exact plan', async () => {
    const fx = fixture({ invalidGuestResult: true });
    try {
      const receipt = await fx.runner.run(fx.plan);
      assert.equal(receipt.outcome, 'failed');
      assert.equal(receipt.errorCode, 'nspawn_evidence_invalid');
      assert.equal(receipt.cleanup.clone, 'destroyed');
    } finally {
      fx.cleanup();
    }
  });
});
