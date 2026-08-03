#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Freeze the exact Sez source, toolchain, dependency, and evidence inputs. */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, sha256Hex } from '../../../src/protocol/canonical/canonical.js';
import { PINNED_NODE_VERSION, assertReleaseVersion } from '../../../src/releases/archive-contract.js';
import type { PackageReleaseSpec } from '../../../src/releases/release-manifest.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function digestEnvironment(name: string, fallback: unknown): string {
  const value = process.env[name];
  if (value) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256`);
    return value;
  }
  return sha256Hex(canonicalJson(fallback));
}

const root = resolve(option('--root') ?? join(import.meta.dirname, '..'));
const output = resolve(requiredOption('--output'));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  license?: string;
};
const version = option('--version') ?? packageJson.version;
assertReleaseVersion(version);
if (version !== packageJson.version && process.env.SEZ_ALLOW_FIXTURE_VERSION !== '1') {
  throw new Error('Release version must come from package.json');
}
if (process.versions.node !== PINNED_NODE_VERSION) {
  throw new Error(`Node ${PINNED_NODE_VERSION} is required`);
}

const commit = git(root, ['rev-parse', 'HEAD']);
const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
const expectedCommit = process.env.SEZ_SOURCE_COMMIT ?? commit;
const expectedTree = process.env.SEZ_SOURCE_TREE ?? tree;
if (commit !== expectedCommit || tree !== expectedTree) {
  throw new Error(`Source identity mismatch: ${commit}/${tree}`);
}
const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
if (dirty) throw new Error(`Source checkout is not clean:\n${dirty}`);
const sourceDateEpoch = Number(git(root, ['show', '-s', '--format=%ct', commit]));
if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
  throw new Error('Git source-date epoch is invalid');
}

const lockPath = join(root, 'package-lock.json');
const lockBytes = readFileSync(lockPath);
const lock = JSON.parse(lockBytes.toString('utf8')) as {
  packages?: Record<string, { name?: string; version?: string; license?: string; integrity?: string }>;
};
const npmVersion = execFileSync('npm', ['--version'], { cwd: root, encoding: 'utf8' }).trim();
const tscVersion = execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['--version'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const nodeGypVersion = execFileSync(join(root, 'node_modules', '.bin', 'node-gyp'), ['--version'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const osRelease = readFileSync('/etc/os-release', 'utf8')
  .split('\n')
  .find((line) => line.startsWith('PRETTY_NAME='))
  ?.slice('PRETTY_NAME='.length)
  .replace(/^"|"$/g, '') ?? 'linux-unknown';
const toolchain = {
  node: process.versions.node,
  nodeAbi: process.versions.modules,
  v8: process.versions.v8,
  zlib: process.versions.zlib,
  npm: npmVersion,
  typescript: tscVersion,
  nodeGyp: nodeGypVersion,
  os: osRelease,
  architecture: process.arch,
};
const unavailable = { status: 'not_attested_by_packager', commit, tree };
const testEvidenceIndexDigest = digestEnvironment(
  'SEZ_TEST_EVIDENCE_INDEX_DIGEST',
  { ...unavailable, kind: 'test_evidence' },
);
const compatibilityDigest = digestEnvironment(
  'SEZ_COMPATIBILITY_DIGEST',
  { ...unavailable, kind: 'compatibility' },
);
const stateMigrationEvidence = digestEnvironment(
  'SEZ_STATE_MIGRATION_EVIDENCE_DIGEST',
  { ...unavailable, kind: 'state_migration' },
);
const rollbackEvidence = digestEnvironment(
  'SEZ_ROLLBACK_EVIDENCE_DIGEST',
  { ...unavailable, kind: 'rollback' },
);
const nativeLoadEvidence = digestEnvironment(
  'SEZ_NATIVE_LOAD_EVIDENCE_DIGEST',
  { ...unavailable, kind: 'native_load' },
);
const evidenceComplete = [
  'SEZ_TEST_EVIDENCE_INDEX_DIGEST',
  'SEZ_COMPATIBILITY_DIGEST',
  'SEZ_STATE_MIGRATION_EVIDENCE_DIGEST',
  'SEZ_ROLLBACK_EVIDENCE_DIGEST',
  'SEZ_NATIVE_LOAD_EVIDENCE_DIGEST',
].every((name) => process.env[name] !== undefined);

const spec: PackageReleaseSpec = {
  schemaVersion: '2.0.0',
  product: 'se-z',
  repository: 'StealthEyeLLC/se-z',
  releaseVersion: version,
  commit,
  tree,
  sourceDateEpoch,
  lockfileDigest: sha256Hex(lockBytes),
  buildCommandDigest: sha256Hex(readFileSync(join(root, 'scripts', 'extracted', 'supervisor', 'build-bundle.sh'))),
  environmentIdentity: {
    os: osRelease,
    architecture: process.arch,
    locale: 'C.UTF-8',
    timezone: 'UTC',
    umask: '0022',
    toolchainDigest: sha256Hex(canonicalJson(toolchain)),
  },
  testEvidenceIndexDigest,
  compatibilityDigest,
  stateMigration: {
    supported: evidenceComplete,
    strategy: evidenceComplete ? 'declared-transactional-migration' : 'not-attested',
    evidenceDigest: stateMigrationEvidence,
  },
  rollback: {
    supported: evidenceComplete,
    strategy: evidenceComplete ? 'standalone-snapshot-restore' : 'not-attested',
    evidenceDigest: rollbackEvidence,
  },
  peerCompatibility: {
    minimumRelease: '0.1.3',
    maximumRelease: '0.x',
    protocolVersions: ['1.0.0'],
    receiptVersions: ['1.0.0', '2.0.0'],
    catalogVersions: ['1.0.0', '2.0.0'],
  },
  requiredEntrypoints: [
    'bin/se-z',
    'bin/se-z-daemon',
    'lib/dist/supervisor/server/index.js',
    'lib/dist/supervisor/cli/install.js',
    'lib/dist/supervisor/cli/repair.js',
    'lib/dist/supervisor/cli/rollback.js',
    'lib/dist/supervisor/cli/verify.js',
    'lib/build/Release/peer_cred.node',
  ],
  sbomPackages: Object.entries(lock.packages ?? {})
    .filter(([path]) => path === '' || path.startsWith('node_modules/'))
    .map(([path, item]) => ({
      name: item.name ?? (path === '' ? packageJson.name : path.slice('node_modules/'.length)),
      version: item.version ?? (path === '' ? version : 'unknown'),
      license: item.license ?? (path === '' ? packageJson.license ?? 'UNLICENSED' : 'NOASSERTION'),
      ...(item.integrity ? { integrity: item.integrity } : {}),
    })),
  nativeAddon: {
    path: 'lib/build/Release/peer_cred.node',
    nodeAbi: process.versions.modules,
    loadEvidenceDigest: nativeLoadEvidence,
  },
};
writeFileSync(output, `${canonicalJson(spec)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ commit, tree, sourceDateEpoch, evidenceComplete }));
