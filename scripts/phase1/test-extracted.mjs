#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const worktree = path.join(root, '.phase1-sources', 'target-reference');
const logRoot = path.join(root, '.phase1-logs', 'extracted');
const evidencePath = path.join(root, 'evidence', 'phase1', 'extracted-test-results.json');
fs.mkdirSync(path.dirname(worktree), { recursive: true });
fs.mkdirSync(logRoot, { recursive: true });
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const runRaw = (command, args, options = {}) => spawnSync(command, args, {
  cwd: options.cwd ?? root,
  env: { ...process.env, CI: '1', NO_COLOR: '1', ...(options.env ?? {}) },
  encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
});
const git = (args, options = {}) => runRaw('git', ['-C', options.cwd ?? root, ...args], options);
const parseTap = (text) => {
  const summary = {};
  for (const match of text.matchAll(/^(?:#|ℹ)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gmu)) summary[match[1]] = Number(match[2]);
  const duration = [...text.matchAll(/^(?:#|ℹ)\s+duration_ms\s+([0-9.]+)\s*$/gmu)].at(-1)?.[1];
  if (duration) summary.durationMs = Number(duration);
  return summary;
};
const capture = (name, command, args, kind) => {
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
    logPaths: [path.relative(root, stdoutPath), path.relative(root, stderrPath)],
  };
};

git(['worktree', 'remove', '--force', worktree]);
fs.rmSync(worktree, { recursive: true, force: true });
git(['worktree', 'prune']);
let result = git(['worktree', 'add', '--detach', '--force', worktree, 'HEAD']);
if (result.status !== 0) throw new Error(result.stderr || result.stdout);
const commit = git(['rev-parse', 'HEAD'], { cwd: worktree }).stdout.trim();
const tree = git(['rev-parse', 'HEAD^{tree}'], { cwd: worktree }).stdout.trim();
const initialStatus = git(['status', '--porcelain=v1'], { cwd: worktree }).stdout;
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
];
const finalStatus = git(['status', '--porcelain=v1'], { cwd: worktree }).stdout;
const evidence = {
  schemaVersion: '1.0.0', capturedAt: new Date().toISOString(), nodeVersion: process.version,
  commit, tree, cleanDetachedWorktree: initialStatus === '', worktreeStatusAfterTests: finalStatus,
  testFileCounts: {
    supervisor: fs.readdirSync(path.join(worktree, 'test', 'extracted', 'supervisor'), { recursive: true }).filter((entry) => String(entry).endsWith('.test.ts')).length,
    gateway: fs.readdirSync(path.join(worktree, 'test', 'extracted', 'gateway'), { recursive: true }).filter((entry) => String(entry).endsWith('.test.js')).length,
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
  passed: commands.every((entry) => entry.passed),
};
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.passed) process.exitCode = 1;
