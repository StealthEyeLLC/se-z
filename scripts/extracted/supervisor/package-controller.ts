#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Package one exact fixed-controller candidate with deterministic metadata. */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { canonicalJson, sha256Hex } from '../../../src/protocol/canonical/canonical.js';
import { inventoryControllerCandidate } from '../../../src/selfhost/controller/bootstrap.js';
import type { ControllerCandidateBuildRecord } from '../../../src/selfhost/controller/package.js';
import { PINNED_NODE_VERSION, assertReleaseVersion } from '../../../src/releases/archive-contract.js';
import { createDeterministicTarGz } from '../../../src/releases/deterministic-archive.js';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const git = (root: string, args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const sourceRoot = resolve(option('--source-root'));
const releaseRoot = resolve(option('--release-root'));
const outputRoot = resolve(option('--output-directory'));
const releaseVersion = option('--version');
assertReleaseVersion(releaseVersion);
if (process.versions.node !== PINNED_NODE_VERSION) throw new Error(`Node ${PINNED_NODE_VERSION} is required`);
const packageJson = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')) as { version: string };
if (
  releaseVersion !== packageJson.version &&
  process.env.SEZ_CONTROLLER_ALLOW_FIXTURE_VERSION !== '1'
) throw new Error('Controller version must come from package.json');
const commit = git(sourceRoot, ['rev-parse', 'HEAD']);
const tree = git(sourceRoot, ['rev-parse', 'HEAD^{tree}']);
if (
  commit !== (process.env.SEZ_SOURCE_COMMIT ?? commit) ||
  tree !== (process.env.SEZ_SOURCE_TREE ?? tree)
) throw new Error('Controller source identity mismatch');
const dirty = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
if (dirty) throw new Error(`Controller source checkout is not clean:\n${dirty}`);
const sourceDateEpoch = Number(git(sourceRoot, ['show', '-s', '--format=%ct', commit]));
const controllerFiles = inventoryControllerCandidate(releaseRoot);
const candidateDigest = sha256Hex(canonicalJson(controllerFiles));
const prefix = `se-z-controller-${releaseVersion}`;
const archivePath = join(outputRoot, `${prefix}.tar.gz`);
const packaged = await createDeterministicTarGz({
  releaseRoot,
  topLevelPrefix: prefix,
  archivePath,
  sourceDateEpoch,
});
const os = readFileSync('/etc/os-release', 'utf8')
  .split('\n')
  .find((line) => line.startsWith('PRETTY_NAME='))
  ?.slice('PRETTY_NAME='.length)
  .replace(/^"|"$/gu, '') ?? 'linux-unknown';
const toolchain = {
  node: process.versions.node,
  nodeAbi: process.versions.modules,
  npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
  architecture: process.arch,
  os,
};
const testEvidenceIndexDigest = process.env.SEZ_CONTROLLER_TEST_EVIDENCE_INDEX_DIGEST ??
  sha256Hex(canonicalJson({ status: 'not_attested_by_packager', commit, tree }));
if (!/^[a-f0-9]{64}$/u.test(testEvidenceIndexDigest)) {
  throw new Error('Controller test evidence digest is invalid');
}
const record: ControllerCandidateBuildRecord = {
  recordVersion: '2.0.0',
  schemaVersion: '2.0.0',
  product: 'se-z-controller',
  repository: 'StealthEyeLLC/se-z',
  releaseVersion,
  commit,
  tree,
  sourceDateEpoch,
  lockfileDigest: sha256Hex(readFileSync(join(sourceRoot, 'package-lock.json'))),
  nodeVersion: PINNED_NODE_VERSION,
  buildCommandDigest: sha256Hex(readFileSync(join(sourceRoot, 'scripts', 'build-controller-bundle.sh'))),
  environmentIdentity: {
    os,
    architecture: process.arch,
    locale: 'C.UTF-8',
    timezone: 'UTC',
    umask: '0022',
    toolchainDigest: sha256Hex(canonicalJson(toolchain)),
  },
  archive: packaged.archive,
  files: packaged.files,
  controllerFiles,
  candidateDigest,
  testEvidenceIndexDigest,
};
const buildPath = join(outputRoot, `${prefix}.build.json`);
writeFileSync(buildPath, `${canonicalJson(record)}\n`, { mode: 0o600, flag: 'wx' });
writeFileSync(
  join(outputRoot, `${prefix}.sha256`),
  `${record.archive.digest}  ${basename(archivePath)}\n`,
  { mode: 0o600, flag: 'wx' },
);
process.stdout.write(`${JSON.stringify({
  commit,
  tree,
  archiveDigest: record.archive.digest,
  candidateDigest,
  evidenceComplete: process.env.SEZ_CONTROLLER_TEST_EVIDENCE_INDEX_DIGEST !== undefined,
})}\n`);
