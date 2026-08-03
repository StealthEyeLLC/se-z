#!/usr/bin/env node
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { ACTIVE_OPERATION_NAMES, CATALOG_DIGEST } from '../../src/kernel/definitions.mjs';
import { AUTHORITY_CLASS, PRODUCT, PROTOCOL, PROTOCOL_VERSION, RELEASE_MILESTONE, SUBJECT, canonicalJson, sha256Hex } from '../../src/kernel/util.mjs';

const args = process.argv.slice(2);
let packagePath = null;
let evidenceDirectory = path.resolve('evidence/phase2');
let candidateCommit = null;
let requireEvidence = true;
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === '--package') packagePath = path.resolve(args[++index]);
  else if (value === '--evidence-dir') evidenceDirectory = path.resolve(args[++index]);
  else if (value === '--candidate-commit') candidateCommit = args[++index];
  else if (value === '--skip-evidence') requireEvidence = false;
  else throw new Error(`unknown argument: ${value}`);
}
if (!packagePath) throw new Error('--package is required');

async function command(file, argv, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd: process.cwd(), ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}
async function must(file, argv, options = {}) {
  const result = await command(file, argv, options);
  if (result.code !== 0 || result.signal !== null) throw new Error(`${file} exited ${result.code ?? result.signal}: ${result.stderr.toString()}`);
  return result.stdout.toString('utf8').trim();
}
async function git(...argv) { return await must('/usr/bin/git', argv); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
async function listFiles(root) {
  const output = [];
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  }
  await visit(root);
  return output;
}
function audit(kind) {
  const checks = [];
  return {
    checks,
    check(name, passed, detail = {}) { checks.push({ name, passed: Boolean(passed), detail }); },
    result(extra = {}) { return { schemaVersion: 1, kind, capturedAt: new Date().toISOString(), passed: checks.every((entry) => entry.passed), checks, checkCount: checks.length, ...extra }; },
  };
}
async function write(name, value) {
  await fsp.mkdir(evidenceDirectory, { recursive: true });
  await fsp.writeFile(path.join(evidenceDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

candidateCommit = candidateCommit ?? await git('rev-parse', 'HEAD');
const candidateTree = await git('rev-parse', `${candidateCommit}^{tree}`);
const packageBytes = await fsp.readFile(packagePath);
const packageSha256 = digest(packageBytes);
const extraction = await fsp.mkdtemp(path.join(os.tmpdir(), 'se-z-phase2-audit-'));
try {
  const tar = await command('/usr/bin/tar', ['-xzf', packagePath, '-C', extraction]);
  if (tar.code !== 0) throw new Error(`cannot extract package: ${tar.stderr.toString()}`);
  const manifest = JSON.parse(await fsp.readFile(path.join(extraction, 'manifest.json'), 'utf8'));
  const packageFiles = (await listFiles(extraction)).map((file) => path.relative(extraction, file).split(path.sep).join('/'));

  const dependency = audit('phase2-dependency-audit');
  const candidatePackage = JSON.parse(await git('show', `${candidateCommit}:package.json`));
  dependency.check('production npm dependency set is empty', Object.keys(candidatePackage.dependencies ?? {}).length === 0, { dependencies: candidatePackage.dependencies ?? {} });
  dependency.check('node-addon-api is build-only', Boolean(candidatePackage.devDependencies?.['node-addon-api']), { version: candidatePackage.devDependencies?.['node-addon-api'] ?? null });
  const sourceRuntimeFiles = [
    ...(await listFiles(path.resolve('src/kernel'))).filter((file) => file.endsWith('.mjs')),
    ...(await listFiles(path.resolve('src/bin'))).filter((file) => /se-z.*\.mjs$/.test(file)),
  ];
  const bareImports = [];
  for (const file of sourceRuntimeFiles) {
    const text = await fsp.readFile(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!(specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/'))) bareImports.push({ path: path.relative(process.cwd(), file), specifier });
    }
  }
  dependency.check('runtime imports are builtin or relative', bareImports.length === 0, { bareImports });
  dependency.check('immutable package contains no node_modules', !packageFiles.some((file) => file.split('/').includes('node_modules')));
  dependency.check('Node and project licenses are included', packageFiles.includes('payload/runtime/LICENSE') && packageFiles.includes('payload/LICENSE') && packageFiles.includes('payload/NOTICE'));
  const packagedNode = path.join(extraction, 'payload/runtime/bin/node');
  const packagedAddon = path.join(extraction, 'payload/libexec/native/peer_cred.node');
  const nodeVersionResult = await command(packagedNode, ['--version']);
  dependency.check('bundled Node is exact v24.18.0', nodeVersionResult.code === 0 && nodeVersionResult.stdout.toString().trim() === 'v24.18.0', { actual: nodeVersionResult.stdout.toString().trim() });
  const nodeLdd = await command('/usr/bin/ldd', [packagedNode]);
  const addonLdd = await command('/usr/bin/ldd', [packagedAddon]);
  dependency.check('bundled Node dynamic dependencies resolve', nodeLdd.code === 0 && !/not found/i.test(`${nodeLdd.stdout}${nodeLdd.stderr}`), { sha256: digest(nodeLdd.stdout) });
  dependency.check('native SO_PEERCRED addon dynamic dependencies resolve', addonLdd.code === 0 && !/not found/i.test(`${addonLdd.stdout}${addonLdd.stderr}`), { sha256: digest(addonLdd.stdout) });
  dependency.check('manifest binds Node and native addon bytes', manifest.nodeSha256 === sha256Hex(await fsp.readFile(packagedNode)) && manifest.nativeAddonSha256 === sha256Hex(await fsp.readFile(packagedAddon)), { nodeSha256: manifest.nodeSha256, nativeAddonSha256: manifest.nativeAddonSha256 });
  const dependencyResult = dependency.result({ candidateCommit, candidateTree, packageSha256, releaseId: manifest.releaseId, runtimeFileCount: sourceRuntimeFiles.length });
  await write('dependency-audit.json', dependencyResult);

  const identity = audit('phase2-identity-audit');
  const { releaseId, ...releaseIdentity } = manifest;
  identity.check('release ID is canonical manifest identity digest', releaseId === sha256Hex(Buffer.from(canonicalJson(releaseIdentity))), { releaseId });
  identity.check('package source commit matches candidate', manifest.sourceCommit === candidateCommit, { expected: candidateCommit, actual: manifest.sourceCommit });
  identity.check('package source tree matches candidate', manifest.sourceTree === candidateTree, { expected: candidateTree, actual: manifest.sourceTree });
  identity.check('package was built from a clean tree', manifest.sourceDirty === false, { sourceDirty: manifest.sourceDirty });
  identity.check('product and release identity are exact', manifest.product === PRODUCT && manifest.releaseMilestone === RELEASE_MILESTONE && manifest.protocol === PROTOCOL && manifest.protocolVersion === PROTOCOL_VERSION, { product: manifest.product, releaseMilestone: manifest.releaseMilestone, protocol: manifest.protocol, protocolVersion: manifest.protocolVersion });
  identity.check('catalog digest and active operation count are exact', manifest.catalogDigest === CATALOG_DIGEST && ACTIVE_OPERATION_NAMES.length === 41, { catalogDigest: manifest.catalogDigest, operationCount: ACTIVE_OPERATION_NAMES.length });
  let recordFailures = [];
  for (const record of manifest.files ?? []) {
    const absolute = path.join(extraction, record.path);
    try {
      const stat = await fsp.stat(absolute);
      const actual = { bytes: stat.size, mode: (stat.mode & 0o777).toString(8).padStart(4, '0'), sha256: sha256Hex(await fsp.readFile(absolute)) };
      if (actual.bytes !== record.bytes || actual.mode !== record.mode || actual.sha256 !== record.sha256) recordFailures.push({ path: record.path, expected: record, actual });
    } catch (error) { recordFailures.push({ path: record.path, error: error.message }); }
  }
  identity.check('every payload byte, size and mode is manifest-bound', recordFailures.length === 0 && manifest.files.length > 0, { recordCount: manifest.files?.length ?? 0, failures: recordFailures });
  const checksum = await command('/usr/bin/sha256sum', ['-c', 'SHA256SUMS'], { cwd: extraction });
  identity.check('package checksum manifest verifies', checksum.code === 0, { outputSha256: digest(Buffer.concat([checksum.stdout, checksum.stderr])) });
  identity.check('owner authority identity is exact', SUBJECT === 'stealtheye-owner' && AUTHORITY_CLASS === 'unrestricted-owner', { subject: SUBJECT, authorityClass: AUTHORITY_CLASS });
  const identityResult = identity.result({ candidateCommit, candidateTree, packageSha256, releaseId, packageBytes: packageBytes.length, catalogDigest: CATALOG_DIGEST, activeOperationCount: ACTIVE_OPERATION_NAMES.length });
  await write('identity-audit.json', identityResult);

  const secret = audit('phase2-secret-audit');
  const secretScan = await command(process.execPath, ['scripts/phase1/secret-scan.mjs', '--no-write']);
  let secretScanJson = null;
  try { secretScanJson = JSON.parse(secretScan.stdout.toString()); } catch {}
  secret.check('tracked-source secret scanner passes', secretScan.code === 0 && secretScanJson?.passed === true && secretScanJson?.findingCount === 0, { findingCount: secretScanJson?.findingCount ?? null, outputSha256: digest(Buffer.concat([secretScan.stdout, secretScan.stderr])) });
  const forbiddenPackagePaths = packageFiles.filter((file) => /(?:^|\/)(?:\.env(?:\..*)?|[^/]*private\.pem|credentials?|secrets?)(?:$|\/)/i.test(file));
  secret.check('package contains no live environment, private key or credential paths', forbiddenPackagePaths.length === 0, { forbiddenPackagePaths });
  const packageSecretFindings = [];
  const textExtensions = new Set(['.mjs', '.js', '.json', '.md', '.conf', '.socket', '.service', '.sh', '.yaml', '.yml', '.txt']);
  for (const relative of packageFiles) {
    const absolute = path.join(extraction, relative);
    const stat = await fsp.stat(absolute);
    const extension = path.extname(relative);
    if (stat.size > 2 * 1024 * 1024 || (!textExtensions.has(extension) && extension !== '')) continue;
    const text = await fsp.readFile(absolute, 'utf8').catch(() => null);
    if (text === null) continue;
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text)) packageSecretFindings.push({ path: relative, pattern: 'private-key-block' });
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text)) packageSecretFindings.push({ path: relative, pattern: 'github-token' });
    if (/\bBearer\s+[A-Za-z0-9._~+\/-]{40,}={0,2}\b/.test(text)) packageSecretFindings.push({ path: relative, pattern: 'bearer-token' });
  }
  secret.check('package text contains no credential material', packageSecretFindings.length === 0, { findings: packageSecretFindings });
  secret.check('package creates keys only at installation time', packageFiles.includes('install/install-package') && !packageFiles.some((file) => /gateway\.private\.pem$|receipt\.private\.pem$/.test(file)));
  const secretResult = secret.result({ candidateCommit, candidateTree, packageSha256, releaseId, packageFileCount: packageFiles.length });
  await write('secret-audit.json', secretResult);

  const theater = audit('phase2-no-theater-audit');
  const markerFiles = [];
  const markerRoots = ['src/kernel', 'src/bin', 'packaging/phase2'];
  const markerExplicit = ['scripts/phase2/build-package.mjs', 'scripts/phase2/package-reproducibility.mjs', 'scripts/phase2/nspawn-acceptance.sh', 'scripts/phase2/host-candidate.sh', 'scripts/phase2/verify.mjs'];
  for (const root of markerRoots) if (fs.existsSync(root)) markerFiles.push(...await listFiles(path.resolve(root)));
  for (const file of markerExplicit) if (fs.existsSync(file)) markerFiles.push(path.resolve(file));
  const theaterMarkers = [];
  for (const file of [...new Set(markerFiles)]) {
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) if (/\b(?:TODO|FIXME|XXX|HACK|placeholder|stub|not implemented)\b/i.test(lines[index])) theaterMarkers.push({ path: path.relative(process.cwd(), file), line: index + 1, lineSha256: digest(Buffer.from(lines[index])) });
  }
  theater.check('production and acceptance paths contain no placeholder markers', theaterMarkers.length === 0, { findings: theaterMarkers });
  theater.check('package is clean-source and immutable-identity bound', manifest.sourceDirty === false && releaseId === sha256Hex(Buffer.from(canonicalJson(releaseIdentity))), { releaseId, sourceDirty: manifest.sourceDirty });
  theater.check('package exposes real executable runtime, native addon and production units', ['payload/runtime/bin/node', 'payload/libexec/native/peer_cred.node', 'payload/share/systemd/se-z.service', 'payload/share/systemd/se-z-local.socket', 'payload/share/systemd/se-z-gateway.socket'].every((file) => packageFiles.includes(file)));
  const requiredEvidence = ['unit.json', 'integration.json', 'failure-injection.json', 'large-output.json', 'package-reproducibility.json', 'nspawn-acceptance.json', 'host-candidate.json', 'baby-protected-readback.json'];
  const evidenceStatus = [];
  if (requireEvidence) {
    for (const name of requiredEvidence) {
      try {
        const value = JSON.parse(await fsp.readFile(path.join(evidenceDirectory, name), 'utf8'));
        evidenceStatus.push({ name, exists: true, passed: value.passed === true, kind: value.kind ?? null });
      } catch (error) { evidenceStatus.push({ name, exists: false, passed: false, error: error.message }); }
    }
    theater.check('all mandatory machine-readable acceptance evidence exists and passes', evidenceStatus.every((entry) => entry.exists && entry.passed), { evidenceStatus });
  } else {
    theater.check('mandatory evidence check explicitly skipped for development-only audit', true, { requireEvidence: false });
  }
  theater.check('active operation catalog has no invented or inactive entries', ACTIVE_OPERATION_NAMES.length === 41 && new Set(ACTIVE_OPERATION_NAMES).size === 41, { operationCount: ACTIVE_OPERATION_NAMES.length });
  const theaterResult = theater.result({ candidateCommit, candidateTree, packageSha256, releaseId, evidenceRequired: requireEvidence, evidenceStatus });
  await write('no-theater-audit.json', theaterResult);

  const results = { dependency: dependencyResult, identity: identityResult, secret: secretResult, noTheater: theaterResult };
  const summary = {
    schemaVersion: 1,
    kind: 'phase2-audit-summary',
    capturedAt: new Date().toISOString(),
    passed: Object.values(results).every((entry) => entry.passed),
    candidateCommit,
    candidateTree,
    packageSha256,
    releaseId,
    audits: Object.fromEntries(Object.entries(results).map(([name, value]) => [name, { passed: value.passed, checkCount: value.checkCount }])),
  };
  await write('audit-summary.json', summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!summary.passed) process.exitCode = 1;
} finally {
  await fsp.rm(extraction, { recursive: true, force: true });
}
