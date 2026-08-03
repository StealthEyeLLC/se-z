#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const identities = JSON.parse(fs.readFileSync(path.join(root, 'vendor/baby-provenance/source-identities.json'), 'utf8'));
const sourceMap = JSON.parse(fs.readFileSync(path.join(root, 'vendor/baby-provenance/source-map.json'), 'utf8'));
const materializedRoot = path.resolve(process.env.SEZ_PHASE1_SOURCE_ROOT ?? path.join(root, '.phase1-sources'));
const outputPath = path.join(root, 'evidence/phase1/source-materialization.json');
const checkOnly = process.argv.includes('--check');

const specs = [
  {
    component: 'supervisor', directory: 'baby-quirt', identity: identities.babySupervisor,
    env: 'SEZ_PHASE1_SUPERVISOR_SOURCE',
    localCandidates: [path.resolve(root, '../sources/baby-quirt'), '/root/se-z-phase1-work/sources/baby-quirt'],
  },
  {
    component: 'gateway', directory: 'baby-quirt-mcp', identity: identities.babyGateway,
    env: 'SEZ_PHASE1_GATEWAY_SOURCE',
    localCandidates: [path.resolve(root, '../sources/baby-quirt-mcp'), '/root/se-z-phase1-work/sources/baby-quirt-mcp'],
  },
];

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}
function text(cwd, args) { return String(git(cwd, args)).trim(); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function archiveDigest(cwd, commit) { return sha256(git(cwd, ['archive', '--format=tar', commit], { encoding: null })); }
function isRepository(candidate) {
  try { return fs.existsSync(candidate) && text(candidate, ['rev-parse', '--git-dir']).length > 0; }
  catch { return false; }
}
function hasCommit(candidate, commit) {
  if (!isRepository(candidate)) return false;
  try { execFileSync('git', ['-C', candidate, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function sourceFor(spec) {
  const candidates = [process.env[spec.env], ...spec.localCandidates].filter(Boolean).map((value) => path.resolve(value));
  const local = candidates.find((candidate) => hasCommit(candidate, spec.identity.commit));
  return local === undefined
    ? { value: `https://github.com/${spec.identity.repository}.git`, method: 'github-exact-commit' }
    : { value: local, method: 'verified-local-git-object-store' };
}
function fileBytes(checkout, relative) {
  const full = path.join(checkout, relative);
  const stat = fs.lstatSync(full);
  return stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
}
function materialize(spec) {
  const destination = path.join(materializedRoot, spec.directory);
  const source = sourceFor(spec);
  let exact = false;
  if (isRepository(destination)) {
    try { exact = text(destination, ['rev-parse', 'HEAD']) === spec.identity.commit; }
    catch { exact = false; }
  }
  if (!exact && checkOnly) throw new Error(`${spec.component} exact source is not materialized at ${destination}`);
  if (!exact) {
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    execFileSync('git', ['clone', '--no-checkout', '--no-hardlinks', source.value, destination], { stdio: 'inherit' });
    if (!hasCommit(destination, spec.identity.commit)) {
      execFileSync('git', ['-C', destination, 'fetch', '--depth=1', 'origin', spec.identity.commit], { stdio: 'inherit' });
    }
    execFileSync('git', ['-C', destination, 'checkout', '--detach', spec.identity.commit], { stdio: 'inherit' });
  }

  const commit = text(destination, ['rev-parse', 'HEAD']);
  const tree = text(destination, ['rev-parse', 'HEAD^{tree}']);
  const trackedFiles = text(destination, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  const trackedStatus = text(destination, ['status', '--porcelain=v1', '--untracked-files=no']);
  const records = sourceMap.records.filter((record) => record.sourceRepository === spec.identity.repository);
  const mismatches = [];
  for (const record of records) {
    const full = path.join(destination, record.sourcePath);
    if (!fs.existsSync(full)) { mismatches.push({ path: record.sourcePath, reason: 'missing' }); continue; }
    const actual = sha256(fileBytes(destination, record.sourcePath));
    if (actual !== record.sourceDigest) mismatches.push({ path: record.sourcePath, expected: record.sourceDigest, actual });
  }
  const result = {
    component: spec.component,
    repository: spec.identity.repository,
    sourceMethod: source.method,
    destination: path.relative(root, destination),
    checkout: path.relative(root, destination),
    commit, expectedCommit: spec.identity.commit,
    tree, expectedTree: spec.identity.tree,
    archiveSha256: archiveDigest(destination, commit), expectedArchiveSha256: spec.identity.archiveSha256,
    trackedFileCount: trackedFiles.length, expectedTrackedFileCount: spec.identity.trackedFileCount,
    inventoryRecordCount: records.length,
    sourceDigestMismatchCount: mismatches.length,
    sourceDigestMismatches: mismatches,
    trackedFilesClean: trackedStatus === '',
  };
  result.passed = result.commit === result.expectedCommit && result.tree === result.expectedTree
    && result.archiveSha256 === result.expectedArchiveSha256
    && result.trackedFileCount === result.expectedTrackedFileCount
    && result.sourceDigestMismatchCount === 0 && result.trackedFilesClean;
  return result;
}

fs.mkdirSync(materializedRoot, { recursive: true });
const components = specs.map(materialize);
const result = {
  schemaVersion: '1.0.0', capturedAt: new Date().toISOString(),
  materializedRoot: path.relative(root, materializedRoot), components,
  passed: components.every((component) => component.passed),
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
