// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Deterministic identity binding for one offline nspawn certification input set. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { canonicalJson } from '../../protocol/canonical/canonical.js';
import {
  buildNspawnRunPlan,
  type NspawnRunPlan,
  type NspawnSourceIdentity,
} from './nspawn-contract.js';

const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,47}$/;
const DIGEST = /^[a-f0-9]{64}$/;

interface BootstrapRecord {
  recordVersion: '1.0.0';
  recordType: 'se-z-nspawn-bootstrap';
  pool: 'sezcert';
  snapshot: 'sezcert/base/noble@golden-v1';
  snapshotGuid: string;
  harnessDigest: string;
  runnerDigest: string;
  nodeVersion: '24.18.0';
  poolBytes: number;
}

export interface PrepareNspawnInputOptions {
  runId: string;
  requestedAt: string;
  deadline: string;
  sezRepositoryPath: string;
  sezCommit: string;
  gatewayRepositoryPath: string;
  gatewayCommit: string;
  dependencyCachePath: string;
  bootstrapRecordPath: string;
  harnessPath: string;
  outputRoot: string;
}

function git(root: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
    },
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function sha256File(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 2 * 1024 ** 3) {
    throw new Error(`unsafe nspawn input file: ${path}`);
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    let length: number;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function validateBootstrapRecord(value: unknown): BootstrapRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('nspawn bootstrap record must be an object');
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'recordVersion', 'recordType', 'pool', 'snapshot', 'snapshotGuid',
    'harnessDigest', 'runnerDigest', 'nodeVersion', 'poolBytes',
  ].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('nspawn bootstrap record has missing or unknown fields');
  }
  if (
    record.recordVersion !== '1.0.0' ||
    record.recordType !== 'se-z-nspawn-bootstrap' ||
    record.pool !== 'sezcert' ||
    record.snapshot !== 'sezcert/base/noble@golden-v1' ||
    typeof record.snapshotGuid !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(record.snapshotGuid) ||
    typeof record.harnessDigest !== 'string' ||
    !DIGEST.test(record.harnessDigest) ||
    typeof record.runnerDigest !== 'string' ||
    !DIGEST.test(record.runnerDigest) ||
    record.nodeVersion !== '24.18.0' ||
    record.poolBytes !== 12 * 1024 ** 3
  ) {
    throw new Error('nspawn bootstrap record is invalid');
  }
  return record as unknown as BootstrapRecord;
}

function sourceIdentity(
  repositoryPath: string,
  repository: string,
  expectedCommit: string,
  bundlePath: string,
): NspawnSourceIdentity {
  const root = resolve(repositoryPath);
  if (!GIT_OBJECT.test(expectedCommit)) throw new Error(`invalid ${repository} commit`);
  const head = git(root, ['rev-parse', 'HEAD']);
  if (head !== expectedCommit) throw new Error(`${repository} HEAD differs from the authorized commit`);
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
  if (!GIT_OBJECT.test(tree)) throw new Error(`${repository} tree is invalid`);
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all']) !== '') {
    throw new Error(`${repository} worktree is not clean`);
  }
  execFileSync('/usr/bin/git', ['-C', root, 'bundle', 'create', bundlePath, 'HEAD'], {
    env: {
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
      GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent',
    },
    stdio: 'pipe',
  });
  execFileSync('/usr/bin/git', ['-C', root, 'bundle', 'verify', bundlePath], {
    env: {
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
      GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent',
    },
    stdio: 'pipe',
  });
  return { repository, commit: head, tree, bundleDigest: sha256File(bundlePath) };
}

export function prepareNspawnInput(options: PrepareNspawnInputOptions): NspawnRunPlan {
  if (!RUN_ID.test(options.runId)) throw new Error('invalid nspawn run ID');
  for (const timestamp of [options.requestedAt, options.deadline]) {
    if (new Date(timestamp).toISOString() !== timestamp) throw new Error('nspawn timestamps must be canonical');
  }
  if (Date.parse(options.deadline) <= Date.parse(options.requestedAt)) {
    throw new Error('nspawn deadline must follow requestedAt');
  }
  const outputRoot = resolve(options.outputRoot);
  mkdirSync(outputRoot, { mode: 0o700 });
  chmodSync(outputRoot, 0o700);
  const bootstrap = validateBootstrapRecord(
    JSON.parse(readFileSync(options.bootstrapRecordPath, 'utf8')) as unknown,
  );
  const sezBundle = join(outputRoot, 'se-z.bundle');
  const gatewayBundle = join(outputRoot, 'se-z-gateway.bundle');
  const sez = sourceIdentity(
    options.sezRepositoryPath,
    'StealthEyeLLC/se-z',
    options.sezCommit,
    sezBundle,
  );
  const gateway = sourceIdentity(
    options.gatewayRepositoryPath,
    'StealthEyeLLC/se-z-gateway',
    options.gatewayCommit,
    gatewayBundle,
  );
  const harnessSource = resolve(options.harnessPath);
  const expectedHarnessSource = join(
    resolve(options.sezRepositoryPath),
    'ops',
    'rehearsal',
    'se-z-host-certification.mjs',
  );
  if (harnessSource !== expectedHarnessSource) {
    throw new Error('certification harness must come from the exact Sez source');
  }
  const harnessTarget = join(outputRoot, 'se-z-host-certification.mjs');
  copyFileSync(harnessSource, harnessTarget);
  chmodSync(harnessTarget, 0o600);
  if (sha256File(harnessTarget) !== bootstrap.harnessDigest) {
    throw new Error('certification harness differs from the reconciled bootstrap record');
  }
  const cacheTarget = join(outputRoot, 'npm-cache.tar');
  if (basename(options.dependencyCachePath) !== 'npm-cache.tar') {
    throw new Error('dependency cache must use its fixed filename');
  }
  copyFileSync(options.dependencyCachePath, cacheTarget);
  chmodSync(sezBundle, 0o600);
  chmodSync(gatewayBundle, 0o600);
  chmodSync(cacheTarget, 0o600);
  const plan = buildNspawnRunPlan({
    recordVersion: '1.0.0',
    recordType: 'se-z-nspawn-run-plan',
    profile: 'standalone-deployment-v2',
    runId: options.runId,
    requestedAt: options.requestedAt,
    deadline: options.deadline,
    baseSnapshot: bootstrap.snapshot,
    baseSnapshotGuid: bootstrap.snapshotGuid,
    harnessDigest: bootstrap.harnessDigest,
    dependencyCacheDigest: sha256File(cacheTarget),
    inputs: { sez, gateway },
  });
  writeFileSync(join(outputRoot, 'plan.json'), `${canonicalJson(plan)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  return plan;
}
