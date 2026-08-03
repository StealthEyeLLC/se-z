#!/usr/bin/env node
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { canonicalJson, sha256Hex, STATE_SCHEMA_VERSION } from '../../src/kernel/util.mjs';
import { CATALOG_DIGEST } from '../../src/kernel/definitions.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let outputDirectory = null;
let evidencePath = null;
let allowDirty = false;
let nodeDistribution = process.env.SEZ_NODE_DISTRIBUTION ?? '/opt/node-v24.18.0-linux-x64';
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === '--output') outputDirectory = path.resolve(args[++index]);
  else if (value === '--evidence') evidencePath = path.resolve(args[++index]);
  else if (value === '--node-distribution') nodeDistribution = path.resolve(args[++index]);
  else if (value === '--allow-dirty') allowDirty = true;
  else throw new Error(`unknown argument: ${value}`);
}
if (!outputDirectory) throw new Error('--output is required');

async function command(file, argv, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd: repo, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function git(...argv) { return (await command('/usr/bin/git', argv)).stdout.toString().trim(); }
async function copyFile(source, destination, mode = null) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source, destination);
  const sourceMode = (await fsp.stat(source)).mode & 0o777;
  await fsp.chmod(destination, mode ?? sourceMode);
}
async function copyTree(source, destination, predicate = () => true) {
  const entries = await fsp.readdir(source, { withFileTypes: true });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, predicate);
    else if (entry.isFile() && predicate(from)) await copyFile(from, to);
  }
}
async function filesUnder(root) {
  const output = [];
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'));
      else throw new Error(`unsupported package entry: ${absolute}`);
    }
  }
  await visit(root);
  return output;
}
async function fileRecord(root, relative) {
  const absolute = path.join(root, relative);
  const stat = await fsp.stat(absolute);
  return { path: relative, bytes: stat.size, mode: (stat.mode & 0o777).toString(8).padStart(4, '0'), sha256: sha256Hex(await fsp.readFile(absolute)) };
}
async function writeExecutable(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, { mode: 0o755 });
}

const startedAt = new Date().toISOString();
await fsp.mkdir(outputDirectory, { recursive: true });
const status = await git('status', '--porcelain=v1');
const dirty = status.length > 0;
if (dirty && !allowDirty) throw new Error('package build requires a clean worktree');
const sourceCommit = await git('rev-parse', 'HEAD');
const sourceTree = await git('rev-parse', 'HEAD^{tree}');
const sourceDateEpoch = Number(await git('show', '-s', '--format=%ct', 'HEAD'));
if (!Number.isSafeInteger(sourceDateEpoch)) throw new Error('invalid source date epoch');
const nodePath = path.join(nodeDistribution, 'bin/node');
const nodeLicense = path.join(nodeDistribution, 'LICENSE');
if (!fs.existsSync(nodePath) || !fs.existsSync(nodeLicense)) throw new Error(`incomplete Node distribution: ${nodeDistribution}`);
const nodeVersion = (await command(nodePath, ['--version'])).stdout.toString().trim();
if (nodeVersion !== 'v24.18.0') throw new Error(`unexpected Node version: ${nodeVersion}`);
await command('/usr/bin/npm', ['run', 'build:native']);
const nativePath = path.join(repo, 'src/native/peercred/build/Release/peer_cred.node');
if (!fs.existsSync(nativePath)) throw new Error('native SO_PEERCRED addon was not built');

const stage = path.join(outputDirectory, `.stage-${process.pid}-${crypto.randomUUID()}`);
await fsp.rm(stage, { recursive: true, force: true });
await fsp.mkdir(stage, { recursive: true, mode: 0o755 });
const payload = path.join(stage, 'payload');

await copyTree(path.join(repo, 'src/kernel'), path.join(payload, 'libexec/kernel'), (file) => file.endsWith('.mjs'));
for (const name of ['se-z.mjs', 'se-z-supervisor.mjs', 'se-z-gateway.mjs']) await copyFile(path.join(repo, 'src/bin', name), path.join(payload, 'libexec/bin', name), 0o755);
await copyFile(nativePath, path.join(payload, 'libexec/native/peer_cred.node'), 0o755);
for (const name of ['render-config.mjs', 'verify-install.mjs', 'cleanup-candidate']) await copyFile(path.join(repo, 'packaging/phase2/install', name), path.join(payload, 'libexec/install', name), 0o755);
for (const name of ['se-z.service', 'se-z-local.socket', 'se-z-gateway.socket']) await copyFile(path.join(repo, 'packaging/phase2/systemd', name), path.join(payload, 'share/systemd', name), 0o644);
await copyFile(path.join(repo, 'packaging/phase2/tmpfiles/se-z.conf'), path.join(payload, 'share/tmpfiles/se-z.conf'), 0o644);
await copyTree(path.join(repo, 'contracts'), path.join(payload, 'contracts'), (file) => !file.includes('/phase1-') && !file.endsWith('.log'));
await copyTree(path.join(repo, 'protocol'), path.join(payload, 'protocol'));
await copyFile(path.join(repo, 'LICENSE'), path.join(payload, 'LICENSE'), 0o644);
await copyFile(path.join(repo, 'NOTICE'), path.join(payload, 'NOTICE'), 0o644);
await copyFile(nodePath, path.join(payload, 'runtime/bin/node'), 0o755);
await copyFile(nodeLicense, path.join(payload, 'runtime/LICENSE'), 0o644);

const wrapper = (entry) => `#!/bin/bash\nset -euo pipefail\nself=$(readlink -f "${'${BASH_SOURCE[0]}'}")\nrelease=$(cd "$(dirname "$self")/.." && pwd)\nexec "$release/runtime/bin/node" "$release/${entry}" "$@"\n`;
await writeExecutable(path.join(payload, 'bin/se-z'), wrapper('libexec/bin/se-z.mjs'));
await writeExecutable(path.join(payload, 'bin/se-z-gateway'), wrapper('libexec/bin/se-z-gateway.mjs'));
await writeExecutable(path.join(payload, 'bin/se-z-verify-install'), wrapper('libexec/install/verify-install.mjs'));
await writeExecutable(path.join(payload, 'bin/se-z-cleanup-candidate'), '#!/bin/bash\nset -euo pipefail\nself=$(readlink -f "${BASH_SOURCE[0]}")\nrelease=$(cd "$(dirname "$self")/.." && pwd)\nexec "$release/libexec/install/cleanup-candidate" "$@"\n');
await copyFile(path.join(repo, 'packaging/phase2/install/install-package'), path.join(stage, 'install/install-package'), 0o755);

for (const directory of [stage, payload]) {
  for (const relative of await filesUnder(directory)) {
    if (relative.endsWith('.mjs')) await command(nodePath, ['--check', path.join(directory, relative)]);
  }
}
const initialFiles = (await filesUnder(stage)).filter((relative) => !['manifest.json', 'SHA256SUMS'].includes(relative));
const records = [];
for (const relative of initialFiles) records.push(await fileRecord(stage, relative));

const protocolSchemaPaths = [
  'protocol/schemas/request.schema.json',
  'protocol/schemas/result.schema.json',
  'protocol/schemas/receipt.schema.json',
  'protocol/schemas/handshake.schema.json',
];
const protocolSchemaDigests = {};
for (const relative of protocolSchemaPaths) protocolSchemaDigests[relative] = sha256Hex(await fsp.readFile(path.join(repo, relative)));
const operationDefinitionSha256 = sha256Hex(await fsp.readFile(path.join(repo, 'contracts/operations-0.1a.json')));
const stateSchemaSha256 = sha256Hex(await fsp.readFile(path.join(repo, 'contracts/state-schema-0.1a.json')));
const typescriptVersion = JSON.parse(await fsp.readFile(path.join(repo, 'node_modules/typescript/package.json'), 'utf8')).version;
const compilerVersion = (await command('/usr/bin/c++', ['--version'])).stdout.toString().split('\n')[0].trim();
const compilerTarget = (await command('/usr/bin/c++', ['-dumpmachine'])).stdout.toString().trim();
const systemdVersion = (await command('/usr/bin/systemd', ['--version'])).stdout.toString().split('\n')[0].trim();
const tmuxVersion = (await command('/usr/bin/tmux', ['-V'])).stdout.toString().trim();
const glibcVersion = (await command('/usr/bin/ldd', ['--version'])).stdout.toString().split('\n')[0].trim();
const architecture = (await command('/usr/bin/uname', ['-m'])).stdout.toString().trim();
const provenanceIdentities = JSON.parse(await fsp.readFile(path.join(repo, 'vendor/baby-provenance/source-identities.json'), 'utf8'));
const identity = {
  schemaVersion: 1,
  product: 'se-z',
  releaseMilestone: '0.1A',
  sourceCommit,
  sourceTree,
  sourceDateEpoch,
  sourceDirty: dirty,
  protocol: 'SEZ1',
  protocolVersion: '1.0.0',
  stateSchemaVersion: STATE_SCHEMA_VERSION,
  catalogDigest: CATALOG_DIGEST,
  protocolSchemaDigests,
  operationDefinitionSha256,
  stateSchemaSha256,
  typescriptVersion,
  nativeCompilerIdentity: { executable: '/usr/bin/c++', version: compilerVersion, target: compilerTarget },
  runtimeDependencies: {
    node: { bundled: true, version: nodeVersion, sha256: sha256Hex(await fsp.readFile(nodePath)) },
    systemd: { bundled: false, buildHostIdentity: systemdVersion, requiredFeatures: ['socket-activation', 'transient-services', 'credentials'] },
    tmux: { bundled: false, buildHostIdentity: tmuxVersion, purpose: 'test and compatibility utility; PTY broker is native forkpty' },
    glibc: { bundled: false, buildHostIdentity: glibcVersion },
    architecture,
  },
  provenanceIdentities,
  nodeVersion,
  nodeSha256: sha256Hex(await fsp.readFile(nodePath)),
  nativeAddonSha256: sha256Hex(await fsp.readFile(nativePath)),
  files: records,
};
const releaseId = sha256Hex(Buffer.from(canonicalJson(identity)));
const manifest = { ...identity, releaseId };
await fsp.writeFile(path.join(stage, 'manifest.json'), `${canonicalJson(manifest)}\n`, { mode: 0o644 });
const checksumFiles = await filesUnder(stage);
const checksumLines = [];
for (const relative of checksumFiles.filter((entry) => entry !== 'SHA256SUMS')) checksumLines.push(`${sha256Hex(await fsp.readFile(path.join(stage, relative)))}  ${relative}`);
await fsp.writeFile(path.join(stage, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, { mode: 0o644 });

for (const relative of await filesUnder(stage)) {
  const absolute = path.join(stage, relative);
  await fsp.utimes(absolute, sourceDateEpoch, sourceDateEpoch);
}
async function chmodDirectories(directory) {
  await fsp.chmod(directory, 0o755);
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await chmodDirectories(path.join(directory, entry.name));
}
await chmodDirectories(stage);
const packageName = `se-z-0.1A-${sourceCommit.slice(0, 12)}.tar.gz`;
const tarPath = path.join(outputDirectory, packageName.replace(/\.gz$/, ''));
const packagePath = path.join(outputDirectory, packageName);
await fsp.rm(tarPath, { force: true });
await fsp.rm(packagePath, { force: true });
await command('/usr/bin/tar', ['--sort=name', `--mtime=@${sourceDateEpoch}`, '--owner=0', '--group=0', '--numeric-owner', '--format=gnu', '-C', stage, '-cf', tarPath, '.']);
await command('/usr/bin/gzip', ['-n', '-9', tarPath]);
const packageBytes = await fsp.readFile(packagePath);
const result = {
  schemaVersion: 1,
  kind: 'phase2-package-build',
  startedAt,
  completedAt: new Date().toISOString(),
  passed: true,
  packagePath,
  packageName,
  packageBytes: packageBytes.length,
  packageSha256: sha256Hex(packageBytes),
  releaseId,
  sourceCommit,
  sourceTree,
  sourceDateEpoch,
  sourceDirty: dirty,
  catalogDigest: CATALOG_DIGEST,
  stateSchemaVersion: STATE_SCHEMA_VERSION,
  protocolSchemaDigests,
  operationDefinitionSha256,
  stateSchemaSha256,
  typescriptVersion,
  nativeCompilerIdentity: manifest.nativeCompilerIdentity,
  runtimeDependencies: manifest.runtimeDependencies,
  provenanceIdentities,
  nodeVersion,
  nodeSha256: manifest.nodeSha256,
  nativeAddonSha256: manifest.nativeAddonSha256,
  fileCount: records.length,
};
const resultPath = path.join(outputDirectory, `${packageName}.json`);
await fsp.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
if (evidencePath) {
  await fsp.mkdir(path.dirname(evidencePath), { recursive: true });
  await fsp.writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
}
await fsp.rm(stage, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(result)}\n`);
