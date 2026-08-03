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
    component: 'supervisor',
    identity: identities.babySupervisor,
    env: 'SEZ_PHASE1_SUPERVISOR_SOURCE',
    localCandidates: [path.resolve(root, '../sources/baby-quirt'), '/root/se-z-phase1-work/sources/baby-quirt']
  },
  {
    component: 'gateway',
    identity: identities.babyGateway,
    env: 'SEZ_PHASE1_GATEWAY_SOURCE',
    localCandidates: [path.resolve(root, '../sources/baby-quirt-mcp'), '/root/se-z-phase1-work/sources/baby-quirt-mcp']
  }
];

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options }).trim();
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function archiveDigest(cwd) {
  return sha256(execFileSync('git', ['-C', cwd, 'archive', '--format=tar', 'HEAD'], { maxBuffer: 128 * 1024 * 1024 }));
}
function isExactRepo(candidate, identity) {
  try {
    return fs.existsSync(path.join(candidate, '.git')) && git(candidate, ['cat-file', '-e', `${identity.commit}^{commit}`]) === '';
  } catch { return false; }
}
function sourceFor(spec) {
  const explicit = process.env[spec.env];
  const candidates = [explicit, ...spec.localCandidates].filter(Boolean);
  return candidates.find((candidate) => isExactRepo(candidate, spec.identity)) ?? `https://github.com/${spec.identity.repository}.git`;
}
function materialize(spec) {
  const destination = path.join(materializedRoot, spec.component);
  const source = sourceFor(spec);
  const alreadyExact = fs.existsSync(path.join(destination, '.git')) && (() => {
    try { return git(destination, ['rev-parse', 'HEAD']) === spec.identity.commit; } catch { return false; }
  })();
  if (!alreadyExact && checkOnly) throw new Error(`${spec.component} is not materialized at ${destination}`);
  if (!alreadyExact) {
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    execFileSync('git', ['clone', '--no-checkout', '--no-hardlinks', source, destination], { stdio: 'inherit' });
    try { execFileSync('git', ['-C', destination, 'checkout', '--detach', spec.identity.commit], { stdio: 'inherit' }); }
    catch {
      execFileSync('git', ['-C', destination, 'fetch', 'origin', spec.identity.commit], { stdio: 'inherit' });
      execFileSync('git', ['-C', destination, 'checkout', '--detach', spec.identity.commit], { stdio: 'inherit' });
    }
  }
  const commit = git(destination, ['rev-parse', 'HEAD']);
  const tree = git(destination, ['rev-parse', 'HEAD^{tree}']);
  const status = git(destination, ['status', '--porcelain=v1']);
  const tracked = git(destination, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  const records = sourceMap.records.filter((record) => record.sourceRepository === spec.identity.repository);
  const mismatches = [];
  for (const record of records) {
    const full = path.join(destination, record.sourcePath);
    if (!fs.existsSync(full)) { mismatches.push({ path: record.sourcePath, reason: 'missing' }); continue; }
    const stat = fs.lstatSync(full);
    const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
    const actual = sha256(bytes);
    if (actual !== record.sourceDigest) mismatches.push({ path: record.sourcePath, expected: record.sourceDigest, actual });
  }
  const result = {
    component: spec.component,
    repository: spec.identity.repository,
    source: source.startsWith('/') ? 'verified-local-git-object-store' : source,
    destination: path.relative(root, destination),
    commit, expectedCommit: spec.identity.commit,
    tree, expectedTree: spec.identity.tree,
    archiveSha256: archiveDigest(destination),
    expectedArchiveSha256: spec.identity.archiveSha256,
    trackedFileCount: tracked.length,
    expectedTrackedFileCount: spec.identity.trackedFileCount,
    inventoryRecordCount: records.length,
    sourceDigestMismatchCount: mismatches.length,
    sourceDigestMismatches: mismatches,
    clean: status.length === 0
  };
  result.passed = result.commit === result.expectedCommit && result.tree === result.expectedTree &&
    result.archiveSha256 === result.expectedArchiveSha256 && result.trackedFileCount === result.expectedTrackedFileCount &&
    result.sourceDigestMismatchCount === 0 && result.clean;
  return result;
}

fs.mkdirSync(materializedRoot, { recursive: true });
const components = specs.map(materialize);
const result = {
  schemaVersion: '1.0.0',
  capturedAt: new Date().toISOString(),
  materializedRoot: path.relative(root, materializedRoot),
  components,
  passed: components.every((component) => component.passed)
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
