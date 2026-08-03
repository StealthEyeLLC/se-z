#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Freeze the exact gateway source, toolchain, and evidence inputs. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const canonical = (value) => JSON.stringify(sort(value));
const sort = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sort);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const requiredOption = (name) => {
  const value = option(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const evidenceDigest = (name, fallback) => {
  const value = process.env[name];
  if (value && !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256`);
  return value ?? digest(canonical(fallback));
};

const root = resolve(option('--root') ?? join(import.meta.dirname, '..'));
const output = resolve(requiredOption('--output'));
const packageBytes = readFileSync(join(root, 'package.json'));
const packageJson = JSON.parse(packageBytes);
const lockBytes = readFileSync(join(root, 'package-lock.json'));
const version = option('--version') ?? packageJson.version;
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || ['0.2.1', '0.2.2'].includes(version)) {
  throw new Error('Invalid or reserved gateway release version');
}
if (version !== packageJson.version && process.env.SEZ_GATEWAY_ALLOW_FIXTURE_VERSION !== '1') {
  throw new Error('Gateway release version must come from package.json');
}
if (process.versions.node !== '24.18.0') throw new Error('Node 24.18.0 is required');

const commit = git(root, ['rev-parse', 'HEAD']);
const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
if (
  commit !== (process.env.SEZ_GATEWAY_SOURCE_COMMIT ?? commit) ||
  tree !== (process.env.SEZ_GATEWAY_SOURCE_TREE ?? tree)
) throw new Error('Gateway source identity mismatch');
const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
if (dirty) throw new Error(`Gateway checkout is not clean:\n${dirty}`);
const sourceDateEpoch = Number(git(root, ['show', '-s', '--format=%ct', commit]));
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
  npm: execFileSync('npm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(),
  os: osRelease,
  architecture: process.arch,
};
const unavailable = { status: 'not_attested_by_packager', commit, tree };
const variables = [
  'SEZ_GATEWAY_TEST_EVIDENCE_INDEX_DIGEST',
  'SEZ_GATEWAY_COMPATIBILITY_DIGEST',
  'SEZ_GATEWAY_STATE_MIGRATION_EVIDENCE_DIGEST',
  'SEZ_GATEWAY_ROLLBACK_EVIDENCE_DIGEST',
];
const complete = variables.every((name) => process.env[name] !== undefined);
const spec = {
  schemaVersion: '2.0.0',
  product: 'se-z-gateway',
  repository: 'StealthEyeLLC/se-z-gateway',
  releaseVersion: version,
  commit,
  tree,
  sourceDateEpoch,
  lockfileDigest: digest(lockBytes),
  buildCommandDigest: digest(readFileSync(join(root, 'scripts', 'release.sh'))),
  environmentIdentity: {
    os: osRelease,
    architecture: process.arch,
    locale: 'C.UTF-8',
    timezone: 'UTC',
    umask: '0022',
    toolchainDigest: digest(canonical(toolchain)),
  },
  testEvidenceIndexDigest: evidenceDigest(
    variables[0],
    { ...unavailable, kind: 'test_evidence' },
  ),
  compatibilityDigest: evidenceDigest(
    variables[1],
    { ...unavailable, kind: 'compatibility' },
  ),
  stateMigration: {
    supported: complete,
    strategy: complete ? 'transactional-oauth-state-migration' : 'not-attested',
    evidenceDigest: evidenceDigest(variables[2], { ...unavailable, kind: 'state_migration' }),
  },
  rollback: {
    supported: complete,
    strategy: complete ? 'standalone-snapshot-restore' : 'not-attested',
    evidenceDigest: evidenceDigest(variables[3], { ...unavailable, kind: 'rollback' }),
  },
  peerCompatibility: {
    minimumRelease: '0.1.3',
    maximumRelease: '0.x',
    protocolVersions: ['1.0.0'],
    receiptVersions: ['1.0.0', '2.0.0'],
    catalogVersions: ['legacy-26', 'runtime-native-v2'],
  },
  requiredEntrypoints: [
    'package.json',
    'bin/se-z-gateway',
    'src/main.js',
    'src/server.js',
    'ops/systemd/se-z-gateway.service',
    'ops/caddy/se-z-gateway.Caddyfile',
  ],
  sbomPackages: [
    {
      name: packageJson.name,
      version,
      license: packageJson.license ?? 'UNLICENSED',
    },
  ],
};
writeFileSync(output, `${canonical(spec)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ commit, tree, sourceDateEpoch, evidenceComplete: complete }));
