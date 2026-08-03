#!/usr/bin/env node
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
let outputRoot = null;
let evidencePath = null;
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === '--output-root') outputRoot = path.resolve(args[++index]);
  else if (value === '--evidence') evidencePath = path.resolve(args[++index]);
  else throw new Error(`unknown argument: ${value}`);
}
if (!outputRoot) throw new Error('--output-root is required');

async function command(file, argv, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd: process.cwd(), ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code === 0 && signal === null) resolve(result);
      else reject(Object.assign(new Error(`${file} exited ${code ?? signal}: ${result.stderr.toString()}`), result));
    });
  });
}
function parseLastJson(buffer) {
  for (const line of buffer.toString('utf8').trim().split('\n').reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  throw new Error('package builder did not emit JSON');
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

const startedAt = new Date().toISOString();
await fsp.rm(outputRoot, { recursive: true, force: true });
await fsp.mkdir(outputRoot, { recursive: true });
const firstDirectory = path.join(outputRoot, 'build-a');
const secondDirectory = path.join(outputRoot, 'build-b');
const first = parseLastJson((await command(process.execPath, ['scripts/phase2/build-package.mjs', '--output', firstDirectory])).stdout);
const second = parseLastJson((await command(process.execPath, ['scripts/phase2/build-package.mjs', '--output', secondDirectory])).stdout);
const firstBytes = await fsp.readFile(first.packagePath);
const secondBytes = await fsp.readFile(second.packagePath);
const conditions = {
  firstPassed: first.passed === true,
  secondPassed: second.passed === true,
  sourceClean: first.sourceDirty === false && second.sourceDirty === false,
  samePackageName: first.packageName === second.packageName,
  sameByteLength: firstBytes.length === secondBytes.length,
  samePackageSha256: first.packageSha256 === second.packageSha256 && sha256(firstBytes) === sha256(secondBytes),
  byteForByteIdentical: firstBytes.equals(secondBytes),
  sameReleaseId: first.releaseId === second.releaseId,
  sameSourceCommit: first.sourceCommit === second.sourceCommit,
  sameSourceTree: first.sourceTree === second.sourceTree,
  sameCatalogDigest: first.catalogDigest === second.catalogDigest,
  sameNodeIdentity: first.nodeVersion === second.nodeVersion && first.nodeSha256 === second.nodeSha256,
  sameNativeAddon: first.nativeAddonSha256 === second.nativeAddonSha256,
  sameFileCount: first.fileCount === second.fileCount,
};
const publishedDirectory = path.join(outputRoot, 'release');
await fsp.mkdir(publishedDirectory, { recursive: true });
const publishedPackagePath = path.join(publishedDirectory, first.packageName);
await fsp.copyFile(first.packagePath, publishedPackagePath);
const result = {
  schemaVersion: 1,
  kind: 'phase2-package-reproducibility',
  startedAt,
  completedAt: new Date().toISOString(),
  passed: Object.values(conditions).every(Boolean),
  conditions,
  packageName: first.packageName,
  packagePath: publishedPackagePath,
  packageBytes: firstBytes.length,
  packageSha256: first.packageSha256,
  releaseId: first.releaseId,
  sourceCommit: first.sourceCommit,
  sourceTree: first.sourceTree,
  sourceDateEpoch: first.sourceDateEpoch,
  catalogDigest: first.catalogDigest,
  nodeVersion: first.nodeVersion,
  nodeSha256: first.nodeSha256,
  nativeAddonSha256: first.nativeAddonSha256,
  fileCount: first.fileCount,
  buildA: { packageSha256: first.packageSha256, releaseId: first.releaseId, resultSha256: sha256(Buffer.from(JSON.stringify(first))) },
  buildB: { packageSha256: second.packageSha256, releaseId: second.releaseId, resultSha256: sha256(Buffer.from(JSON.stringify(second))) },
};
if (evidencePath) {
  await fsp.mkdir(path.dirname(evidencePath), { recursive: true });
  await fsp.writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.passed) process.exitCode = 1;
