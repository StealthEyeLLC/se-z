#!/opt/node-v24.18.0-linux-x64/bin/node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.

/** Fixed in-guest certification program. It accepts no argv and no arbitrary command. */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const PLAN_PATH = '/run/se-z-certification/input/plan.json';
const INPUT_ROOT = '/run/se-z-certification/input';
const EVIDENCE_ROOT = '/run/se-z-certification/evidence';
const WORK_ROOT = '/var/tmp/se-z-host-certification';
const UID_997_ROOT = '/var/tmp/se-z-host-certification-uid-997';
const NODE_ROOT = '/opt/node-v24.18.0-linux-x64';
const MAX_COMMAND_OUTPUT = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60 * 60 * 1000;

const commands = [];
let sequence = 0;
let fatalFailure = undefined;

function sortKeys(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function durableJson(path, value) {
  const temporary = `${path}.next-${process.pid}`;
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(EVIDENCE_ROOT, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function safeName(value) {
  return value.replace(/[^a-z0-9-]+/giu, '-').replace(/^-+|-+$/gu, '').slice(0, 80);
}

function testCounts(output) {
  const count = (label) => {
    let total = 0;
    const expression = new RegExp(`(?:ℹ|#)\\s*${label}\\s+([0-9]+)`, 'gu');
    for (const match of output.matchAll(expression)) total += Number.parseInt(match[1], 10);
    return total;
  };
  return {
    tests: count('tests'),
    passed: count('pass'),
    failed: count('fail'),
    skipped: count('skipped'),
  };
}

async function runCommand(name, file, args, options = {}) {
  sequence += 1;
  const prefix = `${String(sequence).padStart(3, '0')}-${safeName(name)}`;
  const stdoutPath = join(EVIDENCE_ROOT, 'commands', `${prefix}.stdout.log`);
  const stderrPath = join(EVIDENCE_ROOT, 'commands', `${prefix}.stderr.log`);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const stdoutFd = openSync(stdoutPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const stderrFd = openSync(stderrPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;

  const execution = await new Promise((resolve) => {
    let settled = false;
    let killTimer;
    const child = spawn(file, args, {
      cwd: options.cwd ?? '/',
      env: { ...BASE_ENVIRONMENT, ...(options.env ?? {}) },
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const terminate = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 5000);
      killTimer.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    timeout.unref();
    const collect = (chunks, fd, chunk) => {
      outputBytes += chunk.length;
      writeSync(fd, chunk);
      if (outputBytes > MAX_COMMAND_OUTPUT) {
        outputLimitExceeded = true;
        terminate();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdout, stdoutFd, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, stderrFd, chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: null, signal: null, spawnError: error.message });
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode, signal, spawnError: null });
    });
  });
  fsyncSync(stdoutFd);
  fsyncSync(stderrFd);
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const stdoutText = Buffer.concat(stdout).toString('utf8');
  const stderrText = Buffer.concat(stderr).toString('utf8');
  const counts = testCounts(`${stdoutText}\n${stderrText}`);
  const record = {
    sequence,
    name,
    file,
    args,
    cwd: options.cwd ?? '/',
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exitCode: execution.exitCode,
    signal: execution.signal,
    spawnError: execution.spawnError,
    timedOut,
    outputLimitExceeded,
    stdoutDigest: sha256File(stdoutPath),
    stderrDigest: sha256File(stderrPath),
    ...counts,
  };
  commands.push(record);
  return { ...record, stdout: stdoutText, stderr: stderrText };
}

function recordSkipped(name, reason) {
  sequence += 1;
  commands.push({
    sequence,
    name,
    file: null,
    args: [],
    cwd: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 0,
    exitCode: null,
    signal: null,
    spawnError: reason,
    timedOut: false,
    outputLimitExceeded: false,
    stdoutDigest: sha256(''),
    stderrDigest: sha256(''),
    tests: 0,
    passed: 0,
    failed: 0,
    skipped: 1,
  });
}

function succeeded(record) {
  return record.exitCode === 0 && !record.timedOut && !record.outputLimitExceeded && !record.spawnError;
}

const BASE_ENVIRONMENT = Object.freeze({
  PATH: `${NODE_ROOT}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  HOME: join(WORK_ROOT, 'home'),
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  CI: '1',
  NO_COLOR: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  npm_config_cache: join(WORK_ROOT, 'npm-cache'),
  npm_config_nodedir: NODE_ROOT,
  npm_config_offline: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
});

function readPlan() {
  if (process.argv.length !== 2 || process.env.SEZ_CERTIFICATION_PLAN !== PLAN_PATH) {
    throw new Error('host certification accepts no argv and requires its fixed plan path');
  }
  const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
  const { planDigest, ...payload } = plan;
  if (
    plan.recordVersion !== '1.0.0' ||
    plan.recordType !== 'se-z-nspawn-run-plan' ||
    plan.profile !== 'standalone-deployment-v2' ||
    !/^[a-z0-9][a-z0-9-]{7,47}$/u.test(plan.runId) ||
    !/^[a-f0-9]{64}$/u.test(planDigest) ||
    sha256(canonicalJson(payload)) !== planDigest ||
    !/^[a-f0-9]{64}$/u.test(plan.dependencyCacheDigest) ||
    plan.inputs?.sez?.repository !== 'StealthEyeLLC/se-z' ||
    plan.inputs?.gateway?.repository !== 'StealthEyeLLC/se-z-gateway'
  ) {
    throw new Error('host certification plan integrity failed');
  }
  return plan;
}

async function materializeDependencyCache(plan) {
  const archive = join(INPUT_ROOT, 'npm-cache.tar');
  if (sha256File(archive) !== plan.dependencyCacheDigest) {
    throw new Error('npm dependency cache digest mismatch');
  }
  mkdirSync(BASE_ENVIRONMENT.npm_config_cache, { mode: 0o700 });
  const extracted = await runCommand('verified npm cache extraction', '/usr/bin/tar', [
    '--extract', '--file', archive, '--directory', BASE_ENVIRONMENT.npm_config_cache,
    '--no-same-owner', '--no-same-permissions',
  ]);
  return succeeded(extracted);
}

async function materializeSource(label, inputName, destination, identity) {
  const bundle = join(INPUT_ROOT, inputName);
  if (sha256File(bundle) !== identity.bundleDigest) throw new Error(`${label} bundle digest mismatch`);
  const clone = await runCommand(`${label} isolated clone`, '/usr/bin/git', [
    'clone', '--no-checkout', '--no-local', bundle, destination,
  ]);
  if (!succeeded(clone)) return false;
  const verify = await runCommand(`${label} bundle verify`, '/usr/bin/git', [
    '-C', destination, 'bundle', 'verify', bundle,
  ]);
  if (!succeeded(verify)) return false;
  const checkout = await runCommand(`${label} exact checkout`, '/usr/bin/git', [
    '-C', destination, 'checkout', '--detach', '--force', identity.commit,
  ]);
  if (!succeeded(checkout)) return false;
  const commit = await runCommand(`${label} commit readback`, '/usr/bin/git', [
    '-C', destination, 'rev-parse', 'HEAD',
  ]);
  const tree = await runCommand(`${label} tree readback`, '/usr/bin/git', [
    '-C', destination, 'rev-parse', 'HEAD^{tree}',
  ]);
  const status = await runCommand(`${label} clean readback`, '/usr/bin/git', [
    '-C', destination, 'status', '--porcelain=v1', '--untracked-files=all',
  ]);
  return succeeded(commit) && succeeded(tree) && succeeded(status) &&
    commit.stdout.trim() === identity.commit &&
    tree.stdout.trim() === identity.tree &&
    status.stdout.trim() === '';
}

function privilegeFacts() {
  const status = readFileSync('/proc/self/status', 'utf8');
  const field = (name) => new RegExp(`^${name}:\\s+([^\\n]+)$`, 'mu').exec(status)?.[1]?.trim() ?? '';
  const uidMap = readFileSync('/proc/self/uid_map', 'utf8').trim().split(/\s+/u).map(Number);
  const capLast = Number.parseInt(readFileSync('/proc/sys/kernel/cap_last_cap', 'utf8').trim(), 10);
  const expectedCapabilities = (1n << BigInt(capLast + 1)) - 1n;
  const capabilityBounding = BigInt(`0x${field('CapBnd') || '0'}`);
  const capabilityEffective = BigInt(`0x${field('CapEff') || '0'}`);
  return {
    pid1: readFileSync('/proc/1/comm', 'utf8').trim(),
    uid: process.getuid(),
    gid: process.getgid(),
    uidMap,
    noNewPrivileges: field('NoNewPrivs'),
    seccompMode: field('Seccomp'),
    capLast,
    capabilityBounding: capabilityBounding.toString(16),
    capabilityEffective: capabilityEffective.toString(16),
    allCapabilities: capabilityBounding === expectedCapabilities && capabilityEffective === expectedCapabilities,
    noUserNamespace: uidMap[0] === 0 && uidMap[1] === 0 && uidMap[2] === 4294967295,
  };
}

async function hostAssertions() {
  const facts = privilegeFacts();
  durableJson(join(EVIDENCE_ROOT, 'privilege-facts.json'), facts);
  const nodeVersion = await runCommand('pinned Node version', `${NODE_ROOT}/bin/node`, ['--version']);

  if (existsSync(UID_997_ROOT)) throw new Error('UID 997 certification path already exists');
  const uidRoot = UID_997_ROOT;
  mkdirSync(uidRoot, { mode: 0o711 });
  chmodSync(uidRoot, 0o711);
  const uidGroup = await runCommand('provision fixed GID 997', '/usr/sbin/groupadd', [
    '--system', '--gid', '997', 'se-z-cert',
  ]);
  const uidUser = await runCommand('provision fixed UID 997', '/usr/sbin/useradd', [
    '--system', '--uid', '997', '--gid', '997', '--no-create-home',
    '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'se-z-cert',
  ]);
  const uidFile = join(uidRoot, 'owned');
  writeFileSync(uidFile, 'uid-997-ok\n', { mode: 0o600 });
  chownSync(uidFile, 997, 997);
  chmodSync(uidFile, 0o600);
  const uidRead = await runCommand('UID 997 chown and setuid', '/usr/bin/setpriv', [
    '--reuid=997', '--regid=997', '--clear-groups', '/usr/bin/cat', uidFile,
  ]);
  const lifecycle = await runCommand('systemd UID 997 transient service', '/usr/bin/systemd-run', [
    '--quiet', '--wait', '--pipe', '--collect', '--unit=se-z-cert-uid997',
    '--property=User=se-z-cert', '--property=Group=se-z-cert', '/usr/bin/id', '-u',
  ]);
  const peer = await runCommand('SO_PEERCRED UID 997 probe', '/usr/bin/python3', [
    '/usr/local/libexec/se-z-peer-cred-probe.py',
  ]);
  return {
    facts,
    nodePinned: succeeded(nodeVersion) && nodeVersion.stdout.trim() === 'v24.18.0',
    uid997: succeeded(uidGroup) && succeeded(uidUser) &&
      succeeded(uidRead) && uidRead.stdout.trim() === 'uid-997-ok' &&
      succeeded(lifecycle) && lifecycle.stdout.trim().endsWith('997'),
    systemdLifecycle: succeeded(lifecycle) && lifecycle.stdout.trim().endsWith('997'),
    soPeerCred: succeeded(peer) && peer.stdout.trim() === 'so-peercred-uid-997-ok',
  };
}

async function runSezSuite(root) {
  const npm = `${NODE_ROOT}/bin/npm`;
  const suite = [
    ['sez npm ci', npm, ['ci', '--include=dev']],
    ['sez lint', npm, ['run', 'lint']],
    ['sez native build', npm, ['run', 'build:native']],
    ['sez TypeScript build', npm, ['run', 'build']],
    ['sez unit tests', npm, ['run', 'test']],
    ['sez integration tests', npm, ['run', 'test:integration']],
    ['sez acceptance tests', npm, ['run', 'test:acceptance']],
    ['sez contract tests', npm, ['run', 'test:contracts']],
    ['sez complete test aggregate', npm, ['run', 'test:all']],
  ];
  for (const [name, file, args] of suite) await runCommand(name, file, args, { cwd: root });
}

async function runGatewaySuite(root, sezRoot) {
  const npm = `${NODE_ROOT}/bin/npm`;
  await runCommand('gateway npm ci', npm, ['ci', '--ignore-scripts'], { cwd: root });
  await runCommand('gateway syntax check', npm, ['run', 'check'], { cwd: root });
  await runCommand('gateway tests', npm, ['test'], { cwd: root });
  for (const name of readdirSync(join(root, 'scripts')).filter((entry) => entry.endsWith('.sh')).sort()) {
    await runCommand(`gateway bash syntax ${name}`, '/usr/bin/bash', ['-n', join(root, 'scripts', name)]);
  }
  for (const name of readdirSync(join(root, 'scripts')).filter((entry) => entry.endsWith('.py')).sort()) {
    await runCommand(
      `gateway python compile ${name}`,
      '/usr/bin/python3',
      ['-m', 'py_compile', join(root, 'scripts', name)],
      { env: { PYTHONPYCACHEPREFIX: join(WORK_ROOT, 'pycache') } },
    );
  }
  const gatewayArchives = [];
  for (let build = 1; build <= 2; build += 1) {
    const output = join(WORK_ROOT, `gateway-repro-output-${build}`);
    gatewayArchives.push(join(output, 'se-z-gateway-0.1.0.tar.gz'));
    await runCommand(
      `gateway isolated reproducibility build ${build}`,
      '/usr/bin/bash',
      [join(root, 'scripts/release.sh'), '0.1.0'],
      {
        cwd: root,
        env: {
          SEZ_PACKAGER_ROOT: sezRoot,
          SEZ_GATEWAY_BUILD_ROOT: join(WORK_ROOT, `gateway-repro-build-${build}`),
          SEZ_GATEWAY_OUTPUT_DIR: output,
        },
      },
    );
  }
  await runCommand(
    'gateway reproducibility byte comparison',
    '/usr/bin/cmp',
    ['--silent', gatewayArchives[0], gatewayArchives[1]],
  );
}

async function runProductionShapedCycles(plan) {
  const npm = `${NODE_ROOT}/bin/npm`;
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const cycleRoot = join(WORK_ROOT, `production-shaped-cycle-${cycle}`);
    mkdirSync(cycleRoot, { mode: 0o700 });
    const sezRoot = join(cycleRoot, 'se-z');
    const gatewayRoot = join(cycleRoot, 'se-z-gateway');
    const sezReady = await materializeSource(
      `cycle ${cycle} sez`, 'se-z.bundle', sezRoot, plan.inputs.sez,
    );
    const gatewayReady = await materializeSource(
      `cycle ${cycle} gateway`, 'se-z-gateway.bundle', gatewayRoot, plan.inputs.gateway,
    );
    if (!sezReady || !gatewayReady) {
      recordSkipped(`production-shaped cycle ${cycle}`, 'clean exact source materialization failed');
      continue;
    }
    await runCommand(`cycle ${cycle} sez npm ci`, npm, ['ci', '--include=dev'], { cwd: sezRoot });
    await runCommand(
      `cycle ${cycle} Sez success rollback reboot`,
      `${NODE_ROOT}/bin/node`,
      ['--import', 'tsx', '--test', 'test/deployment-operations.test.ts'],
      { cwd: sezRoot, env: { SEZ_DEPLOYMENT_FIXTURE_MODE: '1' } },
    );
    await runCommand(`cycle ${cycle} gateway npm ci`, npm, ['ci', '--ignore-scripts'], { cwd: gatewayRoot });
    await runCommand(
      `cycle ${cycle} gateway contract`,
      `${NODE_ROOT}/bin/node`,
      ['--test', 'test/contract.test.js', 'test/config.test.js'],
      { cwd: gatewayRoot },
    );
  }
}

async function main() {
  mkdirSync(EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
  mkdirSync(join(EVIDENCE_ROOT, 'commands'), { mode: 0o700 });
  if (existsSync(WORK_ROOT)) throw new Error('certification workspace already exists');
  mkdirSync(WORK_ROOT, { mode: 0o700 });
  mkdirSync(BASE_ENVIRONMENT.HOME, { mode: 0o700 });
  const plan = readPlan();
  const startedAt = new Date().toISOString();
  let assertions = {
    facts: { pid1: 'unknown', allCapabilities: false, noUserNamespace: false },
    nodePinned: false,
    uid997: false,
    systemdLifecycle: false,
    soPeerCred: false,
  };

  try {
    assertions = await hostAssertions();
    const dependencyCacheReady = await materializeDependencyCache(plan);
    const sezRoot = join(WORK_ROOT, 'se-z');
    const gatewayRoot = join(WORK_ROOT, 'se-z-gateway');
    const sezReady = await materializeSource(
      'sez', 'se-z.bundle', sezRoot, plan.inputs.sez,
    );
    const gatewayReady = await materializeSource(
      'gateway', 'se-z-gateway.bundle', gatewayRoot, plan.inputs.gateway,
    );
    if (sezReady && dependencyCacheReady) await runSezSuite(sezRoot);
    else recordSkipped('sez suite', 'exact source or dependency cache materialization failed');
    if (gatewayReady && dependencyCacheReady) await runGatewaySuite(gatewayRoot, sezRoot);
    else recordSkipped('gateway suite', 'exact source or dependency cache materialization failed');
    if (sezReady && gatewayReady && dependencyCacheReady) await runProductionShapedCycles(plan);
    else recordSkipped('three production-shaped cycles', 'exact sources or dependency cache materialization failed');
  } catch (error) {
    fatalFailure = error instanceof Error ? error.message : String(error);
  }

  const totals = commands.reduce(
    (sum, command) => ({
      commands: sum.commands + 1,
      tests: sum.tests + command.tests,
      passed: sum.passed + command.passed,
      failed: sum.failed + command.failed,
      skipped: sum.skipped + command.skipped,
      durationMs: sum.durationMs + command.durationMs,
    }),
    { commands: 0, tests: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
  );
  const commandFailure = commands.some((command) =>
    command.exitCode !== 0 || command.timedOut || command.outputLimitExceeded || command.spawnError,
  );
  const fullPower = assertions.facts.uid === 0 && assertions.facts.gid === 0 &&
    assertions.facts.allCapabilities === true &&
    assertions.facts.noUserNamespace === true &&
    assertions.facts.noNewPrivileges === '0';
  const privilegePassed = assertions.facts.pid1 === 'systemd' && fullPower &&
    assertions.nodePinned && assertions.uid997 && assertions.systemdLifecycle && assertions.soPeerCred;
  const passed = !fatalFailure && !commandFailure && privilegePassed && totals.passed > 0 && totals.failed === 0;
  durableJson(join(EVIDENCE_ROOT, 'commands.json'), commands);
  if (fatalFailure) durableJson(join(EVIDENCE_ROOT, 'fatal-error.json'), { error: fatalFailure });
  durableJson(join(EVIDENCE_ROOT, 'certification-result.json'), {
    recordVersion: '1.0.0',
    recordType: 'se-z-host-certification-result',
    runId: plan.runId,
    planDigest: plan.planDigest,
    outcome: passed ? 'passed' : 'failed',
    pid1: assertions.facts.pid1 === 'systemd' ? 'systemd' : 'not-systemd',
    privilegeProfile: fullPower
      ? 'root-no-userns-all-capabilities'
      : 'restricted',
    uid997: assertions.uid997 ? 'passed' : 'failed',
    soPeerCred: assertions.soPeerCred ? 'passed' : 'failed',
    systemdLifecycle: assertions.systemdLifecycle ? 'passed' : 'failed',
    productionShapedCycles: 3,
    testSummary: totals,
    completedAt: new Date().toISOString(),
  });
  durableJson(join(EVIDENCE_ROOT, 'run-timing.json'), {
    startedAt,
    completedAt: new Date().toISOString(),
  });
}

try {
  await main();
} catch (error) {
  mkdirSync(EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
  const message = error instanceof Error ? error.message : String(error);
  if (!existsSync(join(EVIDENCE_ROOT, 'certification-result.json'))) {
    durableJson(join(EVIDENCE_ROOT, 'certification-result.json'), {
      recordVersion: '1.0.0',
      recordType: 'se-z-host-certification-result',
      runId: 'invalid-run',
      planDigest: '0'.repeat(64),
      outcome: 'failed',
      pid1: 'not-systemd',
      privilegeProfile: 'restricted',
      uid997: 'failed',
      soPeerCred: 'failed',
      systemdLifecycle: 'failed',
      testSummary: { commands: 0, tests: 0, passed: 0, failed: 1, skipped: 0, durationMs: 0 },
      completedAt: new Date().toISOString(),
    });
    durableJson(join(EVIDENCE_ROOT, 'fatal-error.json'), { error: message });
  }
}

// Always exit successfully after durable result emission. The outer runner
// determines pass/fail from the bound result and then destroys the clone.
process.exitCode = 0;
