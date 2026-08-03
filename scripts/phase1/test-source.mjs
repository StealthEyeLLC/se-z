#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const skipInstall = process.argv.includes('--skip-install');
const materialized = spawnSync(process.execPath, ['scripts/phase1/materialize-source.mjs'], {
  cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
if (materialized.status !== 0) {
  process.stderr.write(materialized.stderr || materialized.stdout || 'source materialization failed\n');
  process.exit(materialized.status ?? 1);
}
const materialization = JSON.parse(fs.readFileSync(path.join(root, 'evidence/phase1/source-materialization.json'), 'utf8'));
if (!materialization.passed) throw new Error('exact pinned source materialization did not pass');
const byComponent = new Map(materialization.components.map((component) => [component.component, component]));
const supervisor = path.resolve(root, byComponent.get('supervisor').destination);
const gateway = path.resolve(root, byComponent.get('gateway').destination);
const evidencePath = path.join(root, 'evidence/phase1/source-test-results.json');
const logRoot = path.join(root, '.phase1-logs/source');
fs.rmSync(logRoot, { recursive: true, force: true });
fs.mkdirSync(logRoot, { recursive: true });

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function parseTap(text) {
  const result = {};
  for (const match of text.matchAll(/^(?:#|ℹ)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gmu)) result[match[1]] = Number(match[2]);
  const duration = [...text.matchAll(/^(?:#|ℹ)\s+duration_ms\s+([0-9.]+)\s*$/gmu)].at(-1)?.[1];
  if (duration !== undefined) result.durationMs = Number(duration);
  return result;
}
function capture(name, cwd, command, args, kind) {
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, NODE_ENV: 'development', CI: '1', NO_COLOR: '1', NPM_CONFIG_PRODUCTION: 'false' },
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 20 * 60 * 1000,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const stdoutPath = path.join(logRoot, `${name}.stdout.log`);
  const stderrPath = path.join(logRoot, `${name}.stderr.log`);
  fs.writeFileSync(stdoutPath, stdout, { mode: 0o600 });
  fs.writeFileSync(stderrPath, stderr, { mode: 0o600 });
  return {
    name, kind, command: [command, ...args], cwd: path.relative(root, cwd),
    startedAt, completedAt: new Date().toISOString(),
    durationMs: Number(process.hrtime.bigint() - start) / 1_000_000,
    exitStatus: result.status, signal: result.signal ?? null,
    stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr),
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    tap: parseTap(`${stdout}\n${stderr}`), passed: result.status === 0,
    localLogPaths: [path.relative(root, stdoutPath), path.relative(root, stderrPath)],
  };
}
function countFiles(directory, suffix) {
  return fs.readdirSync(directory, { recursive: true }).filter((entry) => String(entry).endsWith(suffix)).length;
}

const commands = [];
const npmCi = ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
if (!skipInstall) commands.push(capture('supervisor-install', supervisor, 'npm', npmCi, 'dependency-install'));
commands.push(capture('supervisor-contracts', supervisor, 'npm', ['run', 'test:contracts'], 'contracts'));
commands.push(capture('supervisor-native-build', supervisor, 'npm', ['run', 'build:native'], 'native-build'));
commands.push(capture('supervisor-build', supervisor, 'npm', ['run', 'build'], 'build'));
commands.push(capture('supervisor-unit', supervisor, 'npm', ['test'], 'unit'));
commands.push(capture('supervisor-integration', supervisor, 'npm', ['run', 'test:integration'], 'integration'));
commands.push(capture('supervisor-acceptance', supervisor, 'npm', ['run', 'test:acceptance'], 'acceptance'));
if (!skipInstall) commands.push(capture('gateway-install', gateway, 'npm', npmCi, 'dependency-install'));
commands.push(capture('gateway-check', gateway, 'npm', ['run', 'check'], 'check'));
commands.push(capture('gateway-unit', gateway, 'npm', ['test'], 'unit'));

const evidence = {
  schemaVersion: '1.0.0', capturedAt: new Date().toISOString(),
  nodeVersion: process.version,
  npmVersion: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(),
  materialization: materialization.components.map(({ component, repository, commit, tree, archiveSha256, destination }) => ({ component, repository, commit, tree, archiveSha256, destination })),
  sourceTestFiles: {
    supervisorUnit: countFiles(path.join(supervisor, 'test'), '.test.ts'),
    supervisorIntegration: countFiles(path.join(supervisor, 'integration'), '.test.ts'),
    supervisorAcceptance: countFiles(path.join(supervisor, 'acceptance'), '.test.ts'),
    gatewayUnit: countFiles(path.join(gateway, 'test'), '.test.js'),
  },
  commands,
  summary: {
    commandCount: commands.length,
    passedCommands: commands.filter((entry) => entry.passed).length,
    failedCommands: commands.filter((entry) => !entry.passed).length,
    unitTests: commands.filter((entry) => entry.kind === 'unit').reduce((sum, entry) => sum + (entry.tap.tests ?? 0), 0),
    integrationTests: commands.filter((entry) => entry.kind === 'integration').reduce((sum, entry) => sum + (entry.tap.tests ?? 0), 0),
    acceptanceTests: commands.filter((entry) => entry.kind === 'acceptance').reduce((sum, entry) => sum + (entry.tap.tests ?? 0), 0),
    skippedTests: commands.reduce((sum, entry) => sum + (entry.tap.skipped ?? 0), 0),
  },
  rawLogsCommitted: false,
  passed: commands.every((entry) => entry.passed),
};
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ passed: evidence.passed, summary: evidence.summary, commands: commands.map(({ name, exitStatus, tap, stdoutSha256, stderrSha256 }) => ({ name, exitStatus, tap, stdoutSha256, stderrSha256 })) }, null, 2));
if (!evidence.passed) process.exitCode = 1;
