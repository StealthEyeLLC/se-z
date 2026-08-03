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
import { FrameDecoder, decodeFrameJson } from '../../src/kernel/protocol.mjs';
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

async function hashStreamByPages(h, jobId, stream, pageSize) {
  const hash = crypto.createHash('sha256');
  let offset = 0;
  let pages = 0;
  let terminalPage = null;
  while (true) {
    const response = await h.call('sez.job.stream.read', { jobId, stream, offset, length: pageSize });
    assert.equal(response.error, null);
    const page = response.result;
    assert.equal(page.requestedOffset, offset);
    assert.ok(page.bytes <= pageSize);
    const bytes = Buffer.from(page.data, page.encoding);
    assert.equal(bytes.length, page.bytes);
    assert.equal(sha256Hex(bytes), page.pageSha256);
    hash.update(bytes);
    offset = page.nextOffset;
    pages += 1;
    terminalPage = page;
    if (page.endOfStream) break;
    assert.ok(page.bytes > 0, `nonterminal zero-byte page for ${stream} at ${offset}`);
  }
  return { bytes: offset, pages, sha256: hash.digest('hex'), terminalPage };
}

async function runLargeOutput() {
  let h;
  try {
    h = await createHarness();
    const chunkBytes = 1024 * 1024;
    const fullChunks = 80;
    const tailBytes = 123;
    const stdoutBytes = fullChunks * chunkBytes + tailBytes;
    const stderrText = 'phase2-large-stderr-marker\n';
    const python = [
      'import os',
      `chunk=bytes(range(256))*${Math.floor(chunkBytes / 256)}`,
      `[(os.write(1,chunk)) for _ in range(${fullChunks})]`,
      `os.write(1,chunk[:${tailBytes}])`,
      `os.write(2,${JSON.stringify(stderrText)}.encode())`,
    ].join(';');
    const launch = await h.call('sez.exec', { argv: ['/usr/bin/python3', '-c', python], detached: true });
    const jobId = launch.jobId;
    const terminal = await waitJob(h, jobId, 120_000);
    assert.equal(terminal.state, 'completed');
    assert.equal(terminal.result.job.exitCode, 0);
    assert.equal(terminal.result.job.streams.stdout.committedBytes, stdoutBytes);
    assert.equal(terminal.result.job.streams.stderr.committedBytes, Buffer.byteLength(stderrText));

    const expectedChunk = Buffer.allocUnsafe(chunkBytes);
    for (let index = 0; index < expectedChunk.length; index += 1) expectedChunk[index] = index & 0xff;
    const expectedStdout = crypto.createHash('sha256');
    for (let index = 0; index < fullChunks; index += 1) expectedStdout.update(expectedChunk);
    expectedStdout.update(expectedChunk.subarray(0, tailBytes));
    const expectedStdoutSha256 = expectedStdout.digest('hex');
    const expectedStderrSha256 = sha256Hex(Buffer.from(stderrText));

    await h.restart('SIGKILL');
    const stdout = await hashStreamByPages(h, jobId, 'stdout', chunkBytes);
    const stderr = await hashStreamByPages(h, jobId, 'stderr', 4096);
    assert.equal(stdout.bytes, stdoutBytes);
    assert.equal(stdout.sha256, expectedStdoutSha256);
    assert.equal(stdout.terminalPage.finalSha256, expectedStdoutSha256);
    assert.equal(stdout.terminalPage.committedSha256, expectedStdoutSha256);
    assert.equal(stderr.bytes, Buffer.byteLength(stderrText));
    assert.equal(stderr.sha256, expectedStderrSha256);
    assert.equal(stderr.terminalPage.finalSha256, expectedStderrSha256);
    assert.ok(stdout.bytes >= 80 * 1024 * 1024);
    assert.ok(stdout.pages >= 81);

    const resumed = await h.call('sez.request.resume', { requestId: launch.requestId });
    assert.equal(resumed.result.originalResponse.state, 'completed');
    assert.equal(resumed.result.originalResponse.jobId, jobId);
    assert.equal(resumed.result.originalResponse.receipt.stdoutDigest, expectedStdoutSha256);
    assert.equal(resumed.result.originalResponse.receipt.stderrDigest, expectedStderrSha256);

    record('at least 80 MiB stdout plus stderr retrieved after restart through bounded deterministic pages', {
      jobId,
      requestId: launch.requestId,
      stdoutBytes,
      stderrBytes: stderr.bytes,
      stdoutPages: stdout.pages,
      stderrPages: stderr.pages,
      stdoutSha256: stdout.sha256,
      stderrSha256: stderr.sha256,
      receiptId: resumed.result.originalResponse.receipt.receiptId,
    });
    const summary = {
      schemaVersion: 1,
      kind: 'phase2-large-output',
      startedAt,
      completedAt: new Date().toISOString(),
      passed: true,
      checks,
      checkCount: checks.length,
      jobId,
      requestId: launch.requestId,
      stdoutBytes,
      stderrBytes: stderr.bytes,
      stdoutPages: stdout.pages,
      stderrPages: stderr.pages,
      stdoutSha256: stdout.sha256,
      stderrSha256: stderr.sha256,
      catalogDigest: resumed.catalogDigest,
      root: h.root,
    };
    if (evidencePath) {
      await fsp.mkdir(path.dirname(evidencePath), { recursive: true });
      await fsp.writeFile(evidencePath, `${JSON.stringify(summary, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    failure('large output harness', error);
    const summary = { schemaVersion: 1, kind: 'phase2-large-output', startedAt, completedAt: new Date().toISOString(), passed: false, checks };
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

await runLargeOutput();
