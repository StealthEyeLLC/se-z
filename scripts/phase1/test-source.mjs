#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const allowUnavailable = process.argv.includes('--allow-unavailable');
const skipInstall = process.argv.includes('--skip-install');
const materializeArgs = ['scripts/phase1/materialize-source.mjs'];
if (allowUnavailable) materializeArgs.push('--allow-unavailable');
const materialized = spawnSync(process.execPath, materializeArgs, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (materialized.status !== 0) {
  process.stderr.write(materialized.stderr || materialized.stdout);
  process.exit(materialized.status ?? 1);
}
const materialization = JSON.parse(fs.readFileSync(path.join(root, 'evidence/phase1/source-materialization.json'), 'utf8'));
const evidencePath = path.join(root, 'evidence/phase1/source-test-results.json');
if (!materialization.passed) {
  const result = {
    schemaVersion: '1.0.0', capturedAt: new Date().toISOString(),
    status: 'SKIPPED_SOURCE_UNAVAILABLE', passed: false, skipped: true,
    skipReason: materialization.unavailable,
    falsePassPrevented: true,
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!allowUnavailable) process.exitCode = 1;
  process.exit();
}

const logRoot = path.join(root, '.phase1-logs/source');
fs.rmSync(logRoot, { recursive: true, force: true });
fs.mkdirSync(logRoot, { recursive: true });
const supervisor = path.join(root, '.phase1-sources/baby-quirt');
const gateway = path.join(root, '.phase1-sources/baby-quirt-mcp');

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function parseTap(text) {
  const last = (regex) => [...text.matchAll(regex)].at(-1)?.[1];
  return {
    tests: Number(last(/(?:^|\n)(?:#\s*|ℹ\s*)tests\s+(\d+)/gu) ?? 0),
    suites: Number(last(/(?:^|\n)(?:#\s*|ℹ\s*)suites\s+(\d+)/gu) ?? 0),
    pass: Number(last(/(?:^|\n)(?:#\s*|ℹ\s*)pass\s+(\d+)/gu) ?? 0),
    fail: Number(last(/(?:^|\n)(?:#\s*|ℹ\s*)fail\s+(\d+)/gu) ?? 0),
    skipped: Number(last(/(?:^|\n)(?:#\s*|ℹ\s*)skipped\s+(\d+)/gu) ?? 0),
    cancelled: Number(last(/(?:^|\n)(?:#\s*|ℹ\s*)cancelled\s+(\d+)/gu) ?? 0),
  };
}
function run(name, cwd, command, values, kind) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, values, {
    cwd,
    env: { ...process.env, NODE_ENV: 'development', CI: '1' },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  const completedAt = new Date().toISOString();
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const log = `COMMAND: ${command} ${values.join(' ')}\nCWD: ${cwd}\nEXIT: ${result.status}\n\nSTDOUT\n${stdout}\nSTDERR\n${stderr}`;
  const logPath = path.join(logRoot, `${name}.log`);
  fs.writeFileSync(logPath, log);
  return {
    name, kind, command: [command, ...values], cwd,
    startedAt, completedAt,
    exitStatus: result.status,
    signal: result.signal,
    stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr), logSha256: sha256(log),
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    tap: parseTap(`${stdout}\n${stderr}`),
    passed: result.status === 0,
    localLogPath: path.relative(root, logPath),
  };
}

const commands = [];
const npmCi = ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
if (!skipInstall) commands.push(run('supervisor-install', supervisor, 'npm', npmCi, 'dependency-install'));
commands.push(run('supervisor-contracts', supervisor, 'npm', ['run', 'test:contracts'], 'contracts'));
commands.push(run('supervisor-native-build', supervisor, 'npm', ['run', 'build:native'], 'native-build'));
commands.push(run('supervisor-build', supervisor, 'npm', ['run', 'build'], 'build'));
commands.push(run('supervisor-unit', supervisor, 'npm', ['test'], 'unit'));
commands.push(run('supervisor-integration', supervisor, 'npm', ['run', 'test:integration'], 'integration'));
commands.push(run('supervisor-acceptance', supervisor, 'npm', ['run', 'test:acceptance'], 'acceptance'));
if (!skipInstall) commands.push(run('gateway-install', gateway, 'npm', npmCi, 'dependency-install'));
commands.push(run('gateway-check', gateway, 'npm', ['run', 'check'], 'check'));
commands.push(run('gateway-unit', gateway, 'npm', ['test'], 'unit'));

const sourceFiles = {
  supervisorUnit: fs.readdirSync(path.join(supervisor, 'test')).filter((name) => name.endsWith('.test.ts')).length,
  supervisorIntegration: fs.readdirSync(path.join(supervisor, 'integration')).filter((name) => name.endsWith('.test.ts')).length,
  supervisorAcceptance: fs.readdirSync(path.join(supervisor, 'acceptance')).filter((name) => name.endsWith('.test.ts')).length,
  gatewayUnit: fs.readdirSync(path.join(gateway, 'test')).filter((name) => name.endsWith('.test.js')).length,
};
const result = {
  schemaVersion: '1.0.0', capturedAt: new Date().toISOString(),
  nodeVersion: process.version,
  npmVersion: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(),
  materialization: materialization.components.map(({ component, repository, commit, tree, archiveSha256, checkout }) => ({ component, repository, commit, tree, archiveSha256, checkout })),
  sourceTestFiles: sourceFiles,
  commands,
  summary: {
    commandCount: commands.length,
    passedCommands: commands.filter((item) => item.passed).length,
    failedCommands: commands.filter((item) => !item.passed).length,
    unitTests: commands.filter((item) => item.kind === 'unit').reduce((sum, item) => sum + item.tap.tests, 0),
    integrationTests: commands.filter((item) => item.kind === 'integration').reduce((sum, item) => sum + item.tap.tests, 0),
    acceptanceTests: commands.filter((item) => item.kind === 'acceptance').reduce((sum, item) => sum + item.tap.tests, 0),
    skippedTests: commands.reduce((sum, item) => sum + item.tap.skipped, 0),
  },
  fullLogsCommitted: false,
  passed: commands.every((item) => item.passed),
};
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ passed: result.passed, summary: result.summary, commands: commands.map(({ name, exitStatus, logSha256, tap }) => ({ name, exitStatus, logSha256, tap })) }, null, 2));
if (!result.passed) process.exitCode = 1;
