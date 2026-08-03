#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const worktree = path.join(root, '.phase1-sources/target-reference');
const sourceSupervisor = path.resolve(process.env.SEZ_PHASE1_SUPERVISOR_SOURCE ?? path.join(root, '.phase1-sources/baby-quirt'));
const sourceGateway = path.resolve(process.env.SEZ_PHASE1_GATEWAY_SOURCE ?? path.join(root, '.phase1-sources/baby-quirt-mcp'));
for (const [name, location] of [['supervisor', sourceSupervisor], ['gateway', sourceGateway]]) {
  if (!fs.existsSync(path.join(location, '.git'))) throw new Error(`${name} source is unavailable at ${location}; run phase1:materialize-source`);
}
const logRoot = path.join(root, '.phase1-logs/extracted');
const evidencePath = path.join(root, 'evidence/phase1/extracted-test-results.json');
fs.rmSync(logRoot, { recursive: true, force: true });
fs.mkdirSync(logRoot, { recursive: true });
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function runRaw(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: {
      ...process.env, CI: '1', NO_COLOR: '1', NODE_ENV: 'development', NPM_CONFIG_PRODUCTION: 'false',
      SEZ_PHASE1_SUPERVISOR_SOURCE: sourceSupervisor,
      SEZ_PHASE1_GATEWAY_SOURCE: sourceGateway,
      ...(options.env ?? {}),
    },
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: options.timeout ?? 20 * 60 * 1000,
  });
}
function git(args, cwd = root) { return runRaw('git', ['-C', cwd, ...args], { cwd: root }); }
function parseTap(text) {
  const summary = {};
  for (const match of text.matchAll(/^(?:#|ℹ)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gmu)) summary[match[1]] = Number(match[2]);
  const duration = [...text.matchAll(/^(?:#|ℹ)\s+duration_ms\s+([0-9.]+)\s*$/gmu)].at(-1)?.[1];
  if (duration !== undefined) summary.durationMs = Number(duration);
  return summary;
}
function capture(name, command, args, kind) {
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  const result = runRaw(command, args, { cwd: worktree });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const stdoutPath = path.join(logRoot, `${name}.stdout.log`);
  const stderrPath = path.join(logRoot, `${name}.stderr.log`);
  fs.writeFileSync(stdoutPath, stdout, { mode: 0o600 });
  fs.writeFileSync(stderrPath, stderr, { mode: 0o600 });
  return {
    name, kind, command: [command, ...args], cwd: '.phase1-sources/target-reference',
    startedAt, completedAt: new Date().toISOString(),
    durationMs: Number(process.hrtime.bigint() - start) / 1_000_000,
    exitStatus: result.status, signal: result.signal ?? null,
    stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr),
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    tap: parseTap(`${stdout}\n${stderr}`), passed: result.status === 0,
    localLogPaths: [path.relative(root, stdoutPath), path.relative(root, stderrPath)],
  };
}

runRaw('git', ['-C', root, 'worktree', 'remove', '--force', worktree], { timeout: 60_000 });
fs.rmSync(worktree, { recursive: true, force: true });
runRaw('git', ['-C', root, 'worktree', 'prune'], { timeout: 60_000 });
const added = runRaw('git', ['-C', root, 'worktree', 'add', '--detach', '--force', worktree, 'HEAD'], { timeout: 60_000 });
if (added.status !== 0) throw new Error(added.stderr || added.stdout || 'unable to create detached target worktree');
const commit = git(['rev-parse', 'HEAD'], worktree).stdout.trim();
const tree = git(['rev-parse', 'HEAD^{tree}'], worktree).stdout.trim();
const initialStatus = git(['status', '--porcelain=v1'], worktree).stdout;
if (initialStatus !== '') throw new Error('detached target reference is not clean');

const commands = [
  capture('install', 'npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], 'install'),
  capture('check', 'npm', ['run', 'check'], 'check'),
  capture('build', 'npm', ['run', 'build'], 'build'),
  capture('scaffold', 'npm', ['run', 'test:scaffold'], 'unit'),
  capture('supervisor-unit', 'npm', ['run', 'test:extracted:unit'], 'unit'),
  capture('supervisor-integration', 'npm', ['run', 'test:extracted:integration'], 'integration'),
  capture('supervisor-acceptance', 'npm', ['run', 'test:extracted:acceptance'], 'acceptance'),
  capture('gateway', 'npm', ['run', 'test:extracted:gateway'], 'gateway'),
  capture('parity-static', 'npm', ['run', 'test:parity:static'], 'parity'),
  capture('parity-behavioral', 'npm', ['run', 'test:parity:behavioral'], 'parity'),
];
const finalStatus = git(['status', '--porcelain=v1'], worktree).stdout;
const countFiles = (directory, suffix) => fs.readdirSync(directory, { recursive: true }).filter((entry) => String(entry).endsWith(suffix)).length;
const evidence = {
  schemaVersion: '1.0.0', capturedAt: new Date().toISOString(), nodeVersion: process.version,
  commit, tree,
  sourceReferences: {
    supervisorCommit: git(['rev-parse', 'HEAD'], sourceSupervisor).stdout.trim(),
    gatewayCommit: git(['rev-parse', 'HEAD'], sourceGateway).stdout.trim(),
  },
  cleanDetachedWorktree: initialStatus === '', worktreeStatusAfterTests: finalStatus,
  testFileCounts: {
    supervisor: countFiles(path.join(worktree, 'test/extracted/supervisor'), '.test.ts'),
    gateway: countFiles(path.join(worktree, 'test/extracted/gateway'), '.test.js'),
    parityTypeScript: countFiles(path.join(worktree, 'test/parity'), '.test.ts'),
    parityStatic: countFiles(path.join(worktree, 'test/parity'), '.test.mjs'),
  },
  commands,
  summary: {
    commandCount: commands.length, passedCommands: commands.filter((entry) => entry.passed).length,
    failedCommands: commands.filter((entry) => !entry.passed).length,
    unitTests: commands.filter((entry) => entry.kind === 'unit').reduce((sum, entry) => sum + (entry.tap.tests ?? 0), 0),
    integrationTests: commands.filter((entry) => entry.kind === 'integration').reduce((sum, entry) => sum + (entry.tap.tests ?? 0), 0),
    acceptanceTests: commands.filter((entry) => entry.kind === 'acceptance').reduce((sum, entry) => sum + (entry.tap.tests ?? 0), 0),
    gatewayTests: commands.filter((entry) => entry.kind === 'gateway').reduce((sum, entry) => sum + (entry.tap.tests ?? 0), 0),
    parityTests: commands.filter((entry) => entry.kind === 'parity').reduce((sum, entry) => sum + (entry.tap.tests ?? 0), 0),
  },
  rawLogsCommitted: false,
  passed: commands.every((entry) => entry.passed) && finalStatus === '',
};
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ passed: evidence.passed, commit, tree, summary: evidence.summary, commands: commands.map(({ name, exitStatus, tap, stdoutSha256, stderrSha256 }) => ({ name, exitStatus, tap, stdoutSha256, stderrSha256 })) }, null, 2));
runRaw('git', ['-C', root, 'worktree', 'remove', '--force', worktree], { timeout: 60_000 });
runRaw('git', ['-C', root, 'worktree', 'prune'], { timeout: 60_000 });
if (!evidence.passed) process.exitCode = 1;
