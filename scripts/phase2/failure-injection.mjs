#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SezClient } from '../../src/kernel/client.mjs';
import { FrameDecoder, decodeFrameJson, encodeFrame } from '../../src/kernel/protocol.mjs';
import { loadPublicKey, verifyReceipt } from '../../src/kernel/crypto.mjs';
import { atomicWriteJson, sha256Hex, sleep, MAX_FRAME_SIZE } from '../../src/kernel/util.mjs';
import { testKeys, testConfig } from '../../test/phase2/helpers.mjs';

const execFileAsync = promisify(execFile);
const repo = process.cwd();
const evidencePath = process.argv.includes('--evidence')
  ? process.argv[process.argv.indexOf('--evidence') + 1]
  : null;
const startedAt = new Date().toISOString();
const checks = [];
const covered = new Set();
const resources = { users: [], groups: [], units: [], roots: [] };

function record(name, details = {}) {
  checks.push({ name, passed: true, ...details });
  process.stdout.write(`ok - ${name}\n`);
}
function failure(name, error) {
  checks.push({ name, passed: false, error: { name: error.name, code: error.code, message: error.message, stack: error.stack } });
}
function responseOf(value) { return value?.response ?? value; }
function assertOperationResponse(response, operation, { errorCode, terminal } = {}) {
  assert.equal(response.operation, operation);
  assert.equal(typeof response.requestId, 'string');
  assert.equal(typeof response.catalogDigest, 'string');
  assert.equal(response.catalogDigest.length, 64);
  assert.equal(Number.isSafeInteger(response.authorityGeneration), true);
  assert.equal(typeof response.resultDigest, 'string');
  assert.equal(response.resultDigest.length, 64);
  assert.ok(response.receipt);
  assert.equal(response.receipt.requestId, response.requestId);
  assert.equal(response.receipt.operation, operation);
  assert.equal(response.receipt.catalogDigest, response.catalogDigest);
  assert.equal(response.receipt.authorityGeneration, response.authorityGeneration);
  if (terminal !== undefined) assert.equal(response.terminal, terminal);
  if (errorCode !== undefined) {
    assert.equal(response.state, 'failed');
    assert.equal(response.terminal, true);
    assert.equal(response.error.code, errorCode);
  }
  covered.add(operation);
  return response;
}
async function waitFor(predicate, timeoutMs = 10000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch (error) { last = error; }
    await sleep(stepMs);
  }
  throw last ?? new Error(`waitFor timed out after ${timeoutMs} ms`);
}
async function probeWelcome(socketPath, timeoutMs = 1_000) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const decoder = new FrameDecoder(MAX_FRAME_SIZE);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`SEZ1 welcome timed out for ${socketPath}`)), timeoutMs);
    socket.once('error', (error) => finish(error));
    socket.on('data', (chunk) => {
      try {
        for (const payload of decoder.feed(chunk)) {
          const value = decodeFrameJson(payload);
          if (value?.type !== 'welcome' || value.protocol !== 'SEZ1' || value.protocolVersion !== '1.0.0') {
            finish(new Error(`invalid SEZ1 welcome from ${socketPath}`));
            return;
          }
          finish(null, value);
          return;
        }
      } catch (error) { finish(error); }
    });
  });
}
async function findNativeAddon() {
  const root = path.join(repo, 'src/native/peercred/build');
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const value = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(value);
      else if (entry.name.endsWith('.node')) return value;
    }
  }
  throw new Error('native addon not found');
}
async function getent(database, name) {
  const { stdout } = await execFileAsync('/usr/bin/getent', [database, name]);
  return stdout.trim().split(':');
}
async function createLinuxIdentity() {
  const suffix = `${process.pid}`.slice(-7);
  const group = `szg${suffix}`;
  const user = `szu${suffix}`;
  await execFileAsync('/usr/sbin/groupadd', ['--system', group]);
  resources.groups.push(group);
  await execFileAsync('/usr/sbin/useradd', ['--system', '--no-create-home', '--gid', group, '--shell', '/usr/sbin/nologin', user]);
  resources.users.push(user);
  const row = await getent('passwd', user);
  const grow = await getent('group', group);
  return { user, group, uid: Number(row[2]), gid: Number(grow[2]) };
}
async function removeLinuxIdentities() {
  for (const user of resources.users.splice(0).reverse()) {
    await execFileAsync('/usr/sbin/userdel', [user]).catch(() => {});
  }
  for (const group of resources.groups.splice(0).reverse()) {
    await execFileAsync('/usr/sbin/groupdel', [group]).catch(() => {});
  }
}
async function stagePeerClient(root) {
  const directory = path.join(root, 'peer-kernel');
  await fsp.mkdir(directory, { recursive: true, mode: 0o755 });
  for (const name of ['client.mjs', 'crypto.mjs', 'protocol.mjs', 'util.mjs']) {
    const destination = path.join(directory, name);
    await fsp.copyFile(path.join(repo, 'src/kernel', name), destination);
    await fsp.chmod(destination, 0o644);
  }
  return path.join(directory, 'client.mjs');
}
async function writePeerHelper(root, clientPath) {
  const file = path.join(root, 'peer-client.mjs');
  const clientUrl = pathToFileURL(clientPath).href;
  const source = `import { SezClient } from ${JSON.stringify(clientUrl)};\n` +
`const [mode,socketPath,operation,payloadJson,privateKeyPath,keyId,gatewayId]=process.argv.slice(2);\n` +
`const payload=JSON.parse(payloadJson);\n` +
`try {\n` +
` const client=mode==='gateway' ? await SezClient.gateway({socketPath,privateKeyPath,gatewayKeyId:keyId,gatewayId}) : new SezClient({socketPath});\n` +
` const value=await client.call(operation,payload);\n` +
` process.stdout.write(JSON.stringify(value.response));\n` +
`} catch(error) { process.stderr.write(JSON.stringify({name:error.name,code:error.code,message:error.message})); process.exit(19); }\n`;
  await fsp.writeFile(file, source, { mode: 0o644 });
  return file;
}
async function runAs({ uid, gid, initGroups = false }, argv, options = {}) {
  const args = [`--reuid=${uid}`, `--regid=${gid}`, initGroups ? '--init-groups' : '--clear-groups', ...argv];
  return await execFileAsync('/usr/bin/setpriv', args, { timeout: options.timeout ?? 15000, maxBuffer: 16 * 1024 * 1024 });
}
async function createHarness() {
  const root = await fsp.mkdtemp(path.join('/var/tmp', 'se-z-p2-integration-'));
  resources.roots.push(root);
  await fsp.chmod(root, 0o755);
  const identity = await createLinuxIdentity();
  const keys = await testKeys(root);
  // Generate an independently wrong gateway key without a second generation file.
  const wrongPair = crypto.generateKeyPairSync('ed25519');
  const wrongPrivatePath = path.join(root, 'wrong-gateway.private.pem');
  await fsp.writeFile(wrongPrivatePath, wrongPair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await fsp.chown(keys.gateway.privatePath, 65534, 65534);
  await fsp.chown(wrongPrivatePath, 65534, 65534);
  await fsp.chmod(root, 0o755);
  const nativeAddonPath = await findNativeAddon();
  const jobPrefix = `se-z-p2-it-${process.pid}`;
  const config = testConfig(root, keys, {
    nativeAddonPath,
    localOperatorGroup: identity.group,
    gatewayUid: 65534,
    gatewayGid: 65534,
    gatewayExecutable: process.execPath,
    jobRunnerPath: path.join(repo, 'src/kernel/job-runner.mjs'),
    nodePath: process.execPath,
    jobUnitPrefix: jobPrefix,
    runtimeRoot: path.join(root, 'run'),
    localSocket: path.join(root, 'run', 'local.sock'),
    gatewaySocket: path.join(root, 'run', 'gateway.sock'),
    releaseIdentity: { product: 'se-z', releaseMilestone: '0.1A', sourceCommit: 'integration', sourceTree: 'integration' },
    buildIdentity: { sourceCommit: 'integration', sourceTree: 'integration' },
  });
  await fsp.mkdir(config.runtimeRoot, { recursive: true, mode: 0o755 });
  await fsp.chmod(config.runtimeRoot, 0o755);
  const configPath = path.join(root, 'config.json');
  await fsp.writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const stagedClientPath = await stagePeerClient(root);
  const helper = await writePeerHelper(root, stagedClientPath);
  let supervisor;
  const stderrPath = path.join(root, 'supervisor.stderr.log');
  const stdoutPath = path.join(root, 'supervisor.stdout.log');

  async function start() {
    await fsp.chmod(config.runtimeRoot, 0o755);
    const out = fs.openSync(stdoutPath, 'a');
    const err = fs.openSync(stderrPath, 'a');
    supervisor = spawn(process.execPath, [path.join(repo, 'src/bin/se-z-supervisor.mjs')], {
      cwd: repo,
      env: { ...process.env, SEZ_CONFIG: configPath },
      stdio: ['ignore', out, err],
    });
    resources.supervisor = supervisor;
    await waitFor(async () => {
      if (supervisor.exitCode !== null) throw new Error(`supervisor exited ${supervisor.exitCode}: ${await fsp.readFile(stderrPath, 'utf8').catch(() => '')}`);
      const welcomes = await Promise.all([config.localSocket, config.gatewaySocket].map((file) => probeWelcome(file).catch(() => null)));
      return welcomes.every((welcome) => welcome?.type === 'welcome');
    }, 15000);
    await fsp.chmod(config.runtimeRoot, 0o755);
  }
  async function stop(signal = 'SIGTERM') {
    if (!supervisor || supervisor.exitCode !== null) return;
    supervisor.kill(signal);
    await waitFor(() => supervisor.exitCode !== null, 10000).catch(() => supervisor.kill('SIGKILL'));
    await waitFor(() => supervisor.exitCode !== null, 3000).catch(() => {});
  }
  async function restart(signal = 'SIGKILL') {
    await stop(signal);
    await start();
  }
  await start();
  const local = new SezClient({ socketPath: config.localSocket });
  const gateway = await SezClient.gateway({
    socketPath: config.gatewaySocket,
    privateKeyPath: keys.gateway.privatePath,
    gatewayKeyId: 'gateway-test-v1',
    gatewayId: 'se-z-gateway',
  });
  async function call(operation, payload = {}, options = {}) {
    const value = await local.call(operation, payload, options);
    return assertOperationResponse(value.response, operation);
  }
  async function expectError(operation, payload, code, options = {}) {
    const response = await call(operation, payload, options);
    assert.equal(response.error?.code, code);
    assert.equal(response.state, 'failed');
    assert.equal(response.terminal, true);
    return response;
  }
  return { root, identity, keys, wrongPrivatePath, nativeAddonPath, config, configPath, helper, local, gateway, call, expectError, start, stop, restart, get supervisor() { return supervisor; }, stdoutPath, stderrPath };
}
async function readAllStream(h, jobId, stream, pageSize = 131071) {
  let offset = 0;
  const chunks = [];
  let final;
  while (true) {
    const response = await h.call('sez.job.stream.read', { jobId, stream, offset, length: pageSize });
    const page = response.result;
    assert.equal(page.requestedOffset, offset);
    const bytes = Buffer.from(page.data, page.encoding);
    assert.equal(bytes.length, page.bytes);
    chunks.push(bytes);
    offset = page.nextOffset;
    final = page;
    if (page.endOfStream) break;
  }
  return { bytes: Buffer.concat(chunks), final };
}
async function waitJob(h, jobId, waitMs = 30000) {
  const response = await h.call('sez.job.wait', { jobId, waitMs, stdoutOffset: 0, stderrOffset: 0, streamLength: 4096 });
  assert.equal(response.jobId, jobId);
  return response;
}

function clone(value) { return structuredClone(value); }

async function rawConnection(socketPath) {
  const socket = net.createConnection({ path: socketPath });
  const decoder = new FrameDecoder(MAX_FRAME_SIZE);
  const queue = [];
  const waiters = [];
  let terminalError = null;
  const push = (value) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value); else queue.push(value);
  };
  const fail = (error) => {
    terminalError = terminalError ?? error;
    for (const waiter of waiters.splice(0)) waiter.reject(terminalError);
  };
  socket.on('data', (chunk) => {
    try { for (const payload of decoder.feed(chunk)) push(decodeFrameJson(payload)); }
    catch (error) { fail(error); }
  });
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('raw SEZ1 connection closed')));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const read = async (timeoutMs = 5_000) => {
    if (queue.length) return queue.shift();
    if (terminalError) throw terminalError;
    return await Promise.race([
      new Promise((resolve, reject) => waiters.push({ resolve, reject })),
      new Promise((_, reject) => setTimeout(() => reject(new Error('raw frame read timeout')), timeoutMs)),
    ]);
  };
  const welcome = await read();
  return {
    socket,
    welcome,
    read,
    writeJson(value) { socket.write(encodeFrame(value, MAX_FRAME_SIZE)); },
    writePayload(payload) {
      const output = Buffer.alloc(4 + payload.length);
      output.writeUInt32BE(payload.length, 0);
      payload.copy(output, 4);
      socket.write(output);
    },
    writeLength(length) { const header = Buffer.alloc(4); header.writeUInt32BE(length, 0); socket.write(header); },
    destroy() { socket.destroy(); },
  };
}

async function helloRaw(connection, peerClass = 'local-peer', overrides = {}) {
  connection.writeJson({ type: 'hello', protocol: 'SEZ1', protocolVersion: '1.0.0', clientId: 'phase2-failure-suite', peerClass, ...overrides });
  return await connection.read();
}

async function expectTransport(socketPath, action, expectedCodes) {
  const connection = await rawConnection(socketPath);
  try {
    await action(connection);
    const response = await connection.read();
    assert.equal(response.type, 'transport-error');
    assert.ok(expectedCodes.includes(response.code), JSON.stringify(response));
    return response;
  } finally { connection.destroy(); }
}

async function configure(h, faultInjection) {
  h.config.faultInjection = faultInjection;
  await fsp.writeFile(h.configPath, `${JSON.stringify(h.config)}\n`, { mode: 0o600 });
  await h.restart('SIGTERM');
}

async function runFailureSuite() {
  let h;
  try {
    h = await createHarness();

    await expectTransport(h.config.localSocket, async (c) => c.writeLength(MAX_FRAME_SIZE + 1), ['frame_too_large']);
    await expectTransport(h.config.localSocket, async (c) => c.writePayload(Buffer.from('{')), ['invalid_json']);
    await expectTransport(h.config.localSocket, async (c) => c.writePayload(Buffer.from([0xff])), ['invalid_utf8']);
    await expectTransport(h.config.localSocket, async (c) => c.writeJson({ type: 'hello', protocol: 'BAD', protocolVersion: '1.0.0', clientId: 'x', peerClass: 'local-peer' }), ['unsupported_protocol']);
    await expectTransport(h.config.localSocket, async (c) => c.writeJson({ type: 'hello', protocol: 'SEZ1', protocolVersion: '9.9.9', clientId: 'x', peerClass: 'local-peer' }), ['unsupported_version']);
    await expectTransport(h.config.localSocket, async (c) => c.writeJson({ type: 'hello', protocol: 'SEZ1', protocolVersion: '1.0.0', clientId: 'x', peerClass: 'gateway-signed' }), ['peer_class_mismatch']);
    await expectTransport(h.config.localSocket, async (c) => {
      c.writeJson(h.local.buildRequest('sez.health', {}, {}, c.welcome));
    }, ['invalid_request', 'handshake_required']);
    const stderrBefore = await fsp.readFile(h.stderrPath, 'utf8').catch(() => '');
    const truncated = await rawConnection(h.config.localSocket);
    truncated.socket.write(Buffer.from([0, 0, 0, 8, 0x7b, 0x22]));
    truncated.socket.end();
    await sleep(150);
    const stderrAfter = await fsp.readFile(h.stderrPath, 'utf8').catch(() => '');
    assert.ok(stderrAfter.slice(stderrBefore.length).includes('truncated-frame'));
    record('SEZ1 malformed frame, JSON, UTF-8, handshake, protocol, version and peer-class failures', { cases: 8 });

    {
      const c = await rawConnection(h.config.localSocket);
      try {
        const accepted = await helloRaw(c);
        assert.equal(accepted.type, 'hello-accepted');
        const unknownField = h.local.buildRequest('sez.health', {}, {}, c.welcome);
        unknownField.unexpected = true;
        c.writeJson(unknownField);
        const response = await c.read();
        assert.equal(response.error.code, 'invalid_request');
        assert.ok(response.receipt);
      } finally { c.destroy(); }
    }
    {
      const c = await rawConnection(h.config.localSocket);
      try {
        await helloRaw(c);
        const unknownOperation = h.local.buildRequest('sez.health', {}, {}, c.welcome);
        unknownOperation.operation = 'sez.not.active';
        c.writeJson(unknownOperation);
        const response = await c.read();
        assert.equal(response.error.code, 'unknown_operation');
        assert.ok(response.receipt);
      } finally { c.destroy(); }
    }
    record('strict request envelope and inactive operation failures are signed and request-correlated');

    const stagedClientPath = await stagePeerClient(h.root);
    const helper = await writePeerHelper(h.root, stagedClientPath);
    let value;
    value = await runAs({ uid: 65534, gid: 65534 }, [process.execPath, helper, 'gateway', h.config.gatewaySocket, 'sez.health', '{}', h.keys.gateway.privatePath, 'unknown-key', 'se-z-gateway']);
    assert.equal(JSON.parse(value.stdout).error.code, 'unknown_key');
    value = await runAs({ uid: 65534, gid: 65534 }, [process.execPath, helper, 'gateway', h.config.gatewaySocket, 'sez.health', '{}', h.keys.gateway.privatePath, 'gateway-test-v1', 'unknown-gateway']);
    assert.equal(JSON.parse(value.stdout).error.code, 'unknown_gateway');
    value = await runAs({ uid: 65534, gid: 65534 }, [process.execPath, helper, 'gateway', h.config.gatewaySocket, 'sez.health', '{}', h.wrongPrivatePath, 'gateway-test-v1', 'se-z-gateway']);
    assert.equal(JSON.parse(value.stdout).error.code, 'invalid_signature');
    let localOnGatewayRejected = false;
    try { await new SezClient({ socketPath: h.config.gatewaySocket }).call('sez.health'); }
    catch (error) { localOnGatewayRejected = error.code === 'peer_class_mismatch'; }
    assert.equal(localOnGatewayRejected, true);
    record('gateway unknown key, unknown ID, invalid signature and local-on-gateway class failures');

    await h.expectError('sez.health', {}, 'request_expired', { issuedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    await h.expectError('sez.health', {}, 'request_expired', { issuedAt: new Date(Date.now() + 2 * 60 * 1000).toISOString() });
    record('past and future request clock-skew failures');

    const commandNotFound = await h.call('sez.exec', { argv: ['/definitely/not/a/command'] });
    const commandNotFoundDone = await waitJob(h, commandNotFound.jobId);
    assert.equal(commandNotFoundDone.state, 'failed');
    assert.equal(commandNotFoundDone.result.job.error.code, 'operation_failed');
    assert.equal(commandNotFoundDone.result.job.exitCode, null);

    const nonzero = await h.call('sez.shell', { command: 'printf nonzero >&2; exit 23' });
    const nonzeroDone = await waitJob(h, nonzero.jobId);
    assert.equal(nonzeroDone.state, 'failed');
    assert.equal(nonzeroDone.result.job.exitCode, 23);
    assert.equal((await readAllStream(h, nonzero.jobId, 'stderr')).bytes.toString(), 'nonzero');

    const signalled = await h.call('sez.shell', { command: 'kill -TERM $$' });
    const signalledDone = await waitJob(h, signalled.jobId);
    assert.equal(signalledDone.state, 'failed');
    assert.equal(signalledDone.result.job.signal, 'SIGTERM');

    const timed = await h.call('sez.shell', { command: 'sleep 30', timeoutMs: 200 });
    const timedDone = await waitJob(h, timed.jobId, 20_000);
    assert.equal(timedDone.state, 'failed');
    assert.equal(timedDone.result.job.error.code, 'timeout');

    const cancelling = await h.call('sez.shell', { command: 'sleep 30', detached: true });
    const cancelled = await h.call('sez.job.cancel', { jobId: cancelling.jobId, signal: 'SIGTERM', waitMs: 10_000 });
    assert.equal(cancelled.terminal, true);
    assert.ok(['cancelled', 'failed'].includes(cancelled.state));
    record('command-not-found, nonzero exit, signal, timeout and cancellation terminal semantics', {
      commandNotFoundJobId: commandNotFound.jobId,
      nonzeroJobId: nonzero.jobId,
      signalledJobId: signalled.jobId,
      timedJobId: timed.jobId,
      cancelledJobId: cancelling.jobId,
    });

    const outage = await h.call('sez.shell', { command: "sleep .8; printf outage-complete", detached: true });
    await h.restart('SIGKILL');
    await sleep(1000);
    const outageDone = await waitJob(h, outage.jobId);
    assert.equal(outageDone.state, 'completed');
    assert.equal((await readAllStream(h, outage.jobId, 'stdout')).bytes.toString(), 'outage-complete');
    record('supervisor SIGKILL does not terminate durable job and restart reconciles truth', { jobId: outage.jobId });

    const missing = await h.call('sez.shell', { command: 'sleep 60', detached: true });
    let missingJob = (await h.call('sez.job.get', { jobId: missing.jobId })).result.job;
    if (missingJob.processGroup) { try { process.kill(-missingJob.processGroup, 'SIGKILL'); } catch {} }
    if (missingJob.runnerIdentity?.pid) { try { process.kill(missingJob.runnerIdentity.pid, 'SIGKILL'); } catch {} }
    if (missingJob.unit) await execFileAsync('/usr/bin/systemctl', ['stop', missingJob.unit]).catch(() => {});
    await sleep(250);
    missingJob = (await h.call('sez.job.get', { jobId: missing.jobId })).result.job;
    assert.equal(missingJob.state, 'lost');
    assert.equal(missingJob.error.code, 'job_lost');

    const stale = await h.call('sez.shell', { command: 'sleep 60', detached: true });
    const stalePath = path.join(h.config.stateRoot, 'jobs', `${stale.jobId}.json`);
    const staleRecord = JSON.parse(await fsp.readFile(stalePath, 'utf8'));
    const staleUnit = staleRecord.unit;
    const stalePgid = staleRecord.processGroup;
    staleRecord.launchMode = 'detached-runner';
    staleRecord.unit = null;
    staleRecord.runnerIdentity = { ...(staleRecord.runnerIdentity ?? {}), startTime: '0' };
    await fsp.writeFile(stalePath, `${JSON.stringify(staleRecord)}\n`);
    const staleObserved = (await h.call('sez.job.get', { jobId: stale.jobId })).result.job;
    assert.equal(staleObserved.state, 'lost');
    assert.equal(staleObserved.error.code, 'job_lost');
    if (stalePgid) { try { process.kill(-stalePgid, 'SIGKILL'); } catch {} }
    if (staleUnit) await execFileAsync('/usr/bin/systemctl', ['stop', staleUnit]).catch(() => {});
    record('missing process and stale PID/start-time identity reconcile lost without false success', { missingJobId: missing.jobId, staleJobId: stale.jobId });

    await configure(h, { artifactUploadFailAfterBytes: 8 });
    const diskData = Buffer.from('0123456789abcdef');
    const diskBegin = await h.call('sez.artifact.begin', { size: diskData.length, sha256: sha256Hex(diskData), name: 'disk-full.bin' });
    await h.expectError('sez.artifact.upload', { artifactId: diskBegin.result.artifactId, offset: 0, data: diskData.toString('base64'), encoding: 'base64' }, 'disk_full');
    await configure(h, {});
    record('injected artifact disk-full is durable and typed');

    await configure(h, { streamWriteFailAfterBytes: 128 });
    const streamFailure = await h.call('sez.shell', { command: "python3 - <<'PY'\nimport os\nos.write(1,b'x'*4096)\nPY" });
    const streamFailureDone = await waitJob(h, streamFailure.jobId);
    assert.equal(streamFailureDone.state, 'failed');
    assert.equal(streamFailureDone.result.job.error.code, 'operation_failed');
    await configure(h, {});
    record('injected durable stream write failure terminates failed without success fabrication', { jobId: streamFailure.jobId });

    const interruptedData = Buffer.from('interrupted-artifact-payload');
    const interrupted = await h.call('sez.artifact.begin', { size: interruptedData.length, sha256: sha256Hex(interruptedData), name: 'interrupted.bin' });
    const interruptedId = interrupted.result.artifactId;
    const split = 11;
    await h.call('sez.artifact.upload', { artifactId: interruptedId, offset: 0, data: interruptedData.subarray(0, split).toString('base64'), encoding: 'base64' });
    await h.restart('SIGKILL');
    const interruptedObserved = await h.call('sez.artifact.get', { artifactId: interruptedId });
    assert.equal(interruptedObserved.result.state, 'uploading');
    assert.equal(interruptedObserved.result.committedBytes, split);
    await h.call('sez.artifact.upload', { artifactId: interruptedId, offset: split, data: interruptedData.subarray(split).toString('base64'), encoding: 'base64' });
    const interruptedFinal = await h.call('sez.artifact.finalize', { artifactId: interruptedId });
    assert.equal(interruptedFinal.result.actualSha256, sha256Hex(interruptedData));
    record('interrupted artifact upload resumes at exact committed offset after supervisor loss', { artifactId: interruptedId });

    const replacePath = path.join(h.root, 'atomic-replace.txt');
    await h.call('sez.file.write', { path: replacePath, data: Buffer.from('original').toString('base64'), encoding: 'base64' });
    await configure(h, { atomicReplaceStage: 'before-rename' });
    await h.expectError('sez.file.replace', { path: replacePath, data: Buffer.from('replacement').toString('base64'), encoding: 'base64', expectedSha256: sha256Hex(Buffer.from('original')) }, 'operation_failed');
    await configure(h, {});
    const replaceRead = await h.call('sez.file.read', { path: replacePath, encoding: 'utf8' });
    assert.equal(replaceRead.result.data, 'original');
    record('atomic replace failure before rename preserves original bytes');

    const validReceiptResponse = await h.call('sez.health');
    const receiptKey = await loadPublicKey(h.keys.receipt.publicPath);
    const receiptKeys = new Map([['receipt-test-v1', receiptKey]]);
    assert.equal(verifyReceipt(validReceiptResponse.receipt, receiptKeys).valid, true);
    const tamperedDigest = clone(validReceiptResponse.receipt);
    tamperedDigest.resultDigest = '0'.repeat(64);
    assert.equal(verifyReceipt(tamperedDigest, receiptKeys).valid, false);
    const tamperedSignature = clone(validReceiptResponse.receipt);
    tamperedSignature.signature = `${tamperedSignature.signature.slice(0, -1)}${tamperedSignature.signature.endsWith('A') ? 'B' : 'A'}`;
    assert.equal(verifyReceipt(tamperedSignature, receiptKeys).valid, false);
    const tamperedId = clone(validReceiptResponse.receipt);
    tamperedId.receiptId = 'f'.repeat(64);
    assert.equal(verifyReceipt(tamperedId, receiptKeys).valid, false);
    record('receipt digest, signature and receipt-ID tampering all fail verification', { receiptId: validReceiptResponse.receipt.receiptId });

    await atomicWriteJson(h.keys.generationPath, { schemaVersion: 1, authorityGeneration: 2, owner: 'se-z-recovery', initializedAt: new Date().toISOString(), bootstrapRole: 'test-only' });
    const forbiddenMutation = path.join(h.root, 'generation-forbidden');
    const idemDirectory = path.join(h.config.stateRoot, 'idempotency');
    const beforeReservations = (await fsp.readdir(idemDirectory)).length;
    await h.expectError('sez.file.write', { path: forbiddenMutation, data: Buffer.from('x').toString('base64'), encoding: 'base64' }, 'stale_generation', { authorityGeneration: 1, idempotencyKey: `stale-${crypto.randomUUID()}` });
    await h.expectError('sez.file.write', { path: forbiddenMutation, data: Buffer.from('x').toString('base64'), encoding: 'base64' }, 'future_generation', { authorityGeneration: 3, idempotencyKey: `future-${crypto.randomUUID()}` });
    assert.equal(await fsp.stat(forbiddenMutation).then(() => true).catch(() => false), false);
    assert.equal((await fsp.readdir(idemDirectory)).length, beforeReservations);
    record('stale and future authority generations reject before mutation or reservation');

    const corruptPath = path.join(h.config.stateRoot, 'state-schema.json');
    const corruptBackup = await fsp.readFile(corruptPath);
    await h.stop('SIGTERM');
    await fsp.writeFile(corruptPath, '{not-json');
    let corruptRejected = false;
    try { await h.start(); }
    catch { corruptRejected = true; }
    assert.equal(corruptRejected, true);
    assert.equal(await fsp.stat(h.config.localSocket).then(() => true).catch(() => false), false);
    assert.equal(await fsp.stat(h.config.gatewaySocket).then(() => true).catch(() => false), false);
    const corruptLog = await fsp.readFile(h.stderrPath, 'utf8').catch(() => '');
    assert.match(corruptLog, /JSON|parse|state schema|state_corrupt/i);
    await fsp.writeFile(corruptPath, corruptBackup);
    await h.start();
    const repairedHealth = await h.call('sez.health');
    assert.equal(repairedHealth.result.healthy, true);
    record('corrupted mandatory state schema fails closed and restored state recovers cleanly', { path: corruptPath });

    const summary = {
      schemaVersion: 1,
      kind: 'phase2-failure-injection',
      startedAt,
      completedAt: new Date().toISOString(),
      passed: true,
      checks,
      checkCount: checks.length,
      catalogDigest: (await h.call('sez.describe')).catalogDigest,
      root: h.root,
    };
    if (evidencePath) {
      await fsp.mkdir(path.dirname(evidencePath), { recursive: true });
      await fsp.writeFile(evidencePath, `${JSON.stringify(summary, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    failure('failure injection harness', error);
    const summary = { schemaVersion: 1, kind: 'phase2-failure-injection', startedAt, completedAt: new Date().toISOString(), passed: false, checks };
    if (evidencePath) {
      await fsp.mkdir(path.dirname(evidencePath), { recursive: true }).catch(() => {});
      await fsp.writeFile(evidencePath, `${JSON.stringify(summary, null, 2)}\n`).catch(() => {});
    }
    throw error;
  } finally {
    if (h) {
      await h.stop('SIGTERM').catch(() => {});
      const units = await execFileAsync('/usr/bin/systemctl', ['list-units', '--all', '--no-legend', `${h.config.jobUnitPrefix}-*.service`], { encoding: 'utf8' }).catch(() => ({ stdout: '' }));
      for (const line of String(units.stdout).split('\n').filter(Boolean)) {
        const unit = line.trim().split(/\s+/)[0];
        if (unit) {
          await execFileAsync('/usr/bin/systemctl', ['stop', unit]).catch(() => {});
          await execFileAsync('/usr/bin/systemctl', ['reset-failed', unit]).catch(() => {});
        }
      }
    }
    if (h) {
      const tmuxDirectory = path.join(h.config.stateRoot, 'ptys', 'tmux');
      for (const entry of await fsp.readdir(tmuxDirectory).catch(() => [])) {
        const socket = path.join(tmuxDirectory, entry);
        await execFileAsync('/usr/bin/tmux', ['-S', socket, 'kill-server']).catch(() => {});
      }
    }
    await removeLinuxIdentities();
  }
}

await runFailureSuite();
