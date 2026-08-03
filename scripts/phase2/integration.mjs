#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SezClient } from '../../src/kernel/client.mjs';
import { loadPublicKey, verifyReceipt } from '../../src/kernel/crypto.mjs';
import { atomicWriteJson, sha256Hex, sleep } from '../../src/kernel/util.mjs';
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
async function writePeerHelper(root) {
  const file = path.join(root, 'peer-client.mjs');
  const clientUrl = new URL('../../src/kernel/client.mjs', import.meta.url).href;
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
  const helper = await writePeerHelper(root);
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
      const stats = await Promise.all([config.localSocket, config.gatewaySocket].map((file) => fsp.stat(file).catch(() => null)));
      return stats.every((stat) => stat?.isSocket());
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
async function run() {
  let h;
  try {
    h = await createHarness();
    const statLocal = await fsp.stat(h.config.localSocket);
    const statGateway = await fsp.stat(h.config.gatewaySocket);
    assert.equal(statLocal.mode & 0o777, 0o660);
    assert.equal(statGateway.mode & 0o777, 0o660);
    assert.equal(statLocal.gid, h.identity.gid);
    assert.equal(statGateway.gid, 65534);
    record('dual socket modes and groups', { localGid: statLocal.gid, gatewayGid: statGateway.gid });

    const describe = await h.call('sez.describe');
    const catalogDigest = describe.catalogDigest;
    assert.equal(describe.result.product, 'se-z');
    assert.equal(describe.result.activeOperations.length, 41);
    assert.deepEqual(describe.result.supportedTargets, ['host']);
    assert.equal(describe.result.activeOperations.some((entry) => /^(sez\.(github|machine|skill|release|recovery|backup|evidence|selfhost))\./.test(entry.name)), false);
    await h.call('sez.health');
    await h.call('sez.version');
    await h.call('sez.doctor');
    record('core discovery health version doctor', { catalogDigest, operationCount: 41 });

    const groupResult = await runAs(
      { uid: h.identity.uid, gid: h.identity.gid, initGroups: true },
      [process.execPath, h.helper, 'local', h.config.localSocket, 'sez.health', '{}'],
    );
    const groupResponse = JSON.parse(groupResult.stdout);
    assertOperationResponse(groupResponse, 'sez.health');
    record('genuine non-root local group peer accepted', { uid: h.identity.uid, gid: h.identity.gid });

    let unrelatedRejected = false;
    try {
      await runAs({ uid: 65534, gid: 65534 }, [process.execPath, h.helper, 'local', h.config.localSocket, 'sez.health', '{}']);
    } catch (error) {
      unrelatedRejected = ['EACCES', 19].includes(error.code) || error.stderr;
    }
    assert.ok(unrelatedRejected);
    record('unrelated local user rejected');

    const gatewayResult = await runAs(
      { uid: 65534, gid: 65534 },
      [process.execPath, h.helper, 'gateway', h.config.gatewaySocket, 'sez.health', '{}', h.keys.gateway.privatePath, 'gateway-test-v1', 'se-z-gateway'],
    );
    const gatewayResponse = JSON.parse(gatewayResult.stdout);
    assertOperationResponse(gatewayResponse, 'sez.health');
    record('expected gateway UID/GID executable and Ed25519 signature accepted');

    const wrongUid = assertOperationResponse((await h.gateway.call('sez.health')).response, 'sez.health', { errorCode: 'unauthorized_peer' });
    assert.equal(wrongUid.error.code, 'unauthorized_peer');
    record('wrong gateway UID rejected');
    let badSignature;
    try {
      const value = await runAs(
        { uid: 65534, gid: 65534 },
        [process.execPath, h.helper, 'gateway', h.config.gatewaySocket, 'sez.health', '{}', h.wrongPrivatePath, 'gateway-test-v1', 'se-z-gateway'],
      );
      badSignature = JSON.parse(value.stdout);
    } catch (error) {
      badSignature = error.stdout ? JSON.parse(error.stdout) : null;
    }
    assertOperationResponse(badSignature, 'sez.health', { errorCode: 'invalid_signature' });
    record('invalid gateway signature rejected');

    let crossRejected = false;
    try {
      const cross = await SezClient.gateway({
        socketPath: h.config.localSocket,
        privateKeyPath: h.keys.gateway.privatePath,
        gatewayKeyId: 'gateway-test-v1',
        gatewayId: 'se-z-gateway',
      });
      await cross.call('sez.health');
    } catch (error) { crossRejected = error.code === 'peer_class_mismatch'; }
    assert.equal(crossRejected, true);
    record('valid gateway class rejected on local socket');

    const exact = await h.call('sez.exec', {
      argv: ['/usr/bin/python3', '-c', "import os;os.write(1,b'\\x00A\\xffB');os.write(2,b'E\\x00R')"],
      cwd: '/root',
    });
    const exactDone = await waitJob(h, exact.jobId);
    assert.equal(exactDone.state, 'completed');
    assert.equal(exactDone.result.job.exitCode, 0);
    const exactOut = await readAllStream(h, exact.jobId, 'stdout', 2);
    const exactErr = await readAllStream(h, exact.jobId, 'stderr', 2);
    assert.deepEqual(exactOut.bytes, Buffer.from([0, 65, 255, 66]));
    assert.deepEqual(exactErr.bytes, Buffer.from([69, 0, 82]));
    assert.equal(exactOut.final.finalSha256, sha256Hex(exactOut.bytes));
    const receiptKey = await loadPublicKey(h.keys.receipt.publicPath);
    const receiptVerification = verifyReceipt(exactDone.receipt, new Map([['receipt-test-v1', receiptKey]]));
    assert.equal(receiptVerification.valid, true);
    record('exact argv and binary-safe separate streams', { jobId: exact.jobId, receiptId: exactDone.receipt.receiptId });

    const shell = await h.call('sez.shell', { command: "printf 'shell-ok'; printf 'shell-err' >&2" });
    const shellDone = await waitJob(h, shell.jobId);
    assert.equal(shellDone.state, 'completed');
    assert.equal((await readAllStream(h, shell.jobId, 'stdout')).bytes.toString(), 'shell-ok');
    assert.equal((await readAllStream(h, shell.jobId, 'stderr')).bytes.toString(), 'shell-err');
    record('arbitrary shell exact default invocation', { jobId: shell.jobId });

    const nonroot = await h.call('sez.exec', { argv: ['/usr/bin/id', '-u'], cwd: '/tmp', user: 'nobody', group: 'nogroup' });
    const nonrootDone = await waitJob(h, nonroot.jobId);
    assert.equal(nonrootDone.state, 'completed');
    assert.equal((await readAllStream(h, nonroot.jobId, 'stdout')).bytes.toString().trim(), '65534');
    record('explicit user and group execution');

    await h.expectError('sez.exec', { argv: ['/usr/bin/true'], target: 'nspawn:not-active' }, 'target_not_supported');
    await h.expectError('sez.exec', { argv: ['/usr/bin/true'], target: 'kvm:not-active' }, 'target_not_supported');
    record('unsupported targets fail without host fallback');

    const listed = await h.call('sez.job.list', { limit: 100 });
    assert.ok(listed.result.jobs.some((job) => job.jobId === exact.jobId));
    const got = await h.call('sez.job.get', { jobId: exact.jobId });
    assert.equal(got.result.job.state, 'completed');
    record('durable job get and list');

    const cancel = await h.call('sez.shell', { command: 'sleep 60; echo should-not-run', detached: true });
    const cancelled = await h.call('sez.job.cancel', { jobId: cancel.jobId, signal: 'SIGTERM', waitMs: 10000 });
    assert.ok(['cancelled', 'failed'].includes(cancelled.state), JSON.stringify(cancelled));
    assert.equal(cancelled.terminal, true);
    record('exact durable job cancellation', { jobId: cancel.jobId, state: cancelled.state });

    const idemPayload = { argv: ['/bin/bash', '-lc', "sleep .2; printf once"], detached: true };
    const idemKey = `integration-concurrent-${crypto.randomUUID()}`;
    const [i1, i2] = await Promise.all([
      h.local.call('sez.exec', idemPayload, { idempotencyKey: idemKey }),
      h.local.call('sez.exec', { detached: true, argv: idemPayload.argv }, { idempotencyKey: idemKey }),
    ]);
    assertOperationResponse(i1.response, 'sez.exec');
    assertOperationResponse(i2.response, 'sez.exec');
    assert.equal(i1.response.jobId, i2.response.jobId);
    await waitJob(h, i1.response.jobId);
    await h.expectError('sez.exec', { argv: ['/usr/bin/printf', 'changed'] }, 'idempotency_conflict', { idempotencyKey: idemKey });
    record('concurrent semantic idempotency launches once', { jobId: i1.response.jobId });

    const responseLossKey = `integration-response-loss-${crypto.randomUUID()}`;
    const lost = await h.local.call('sez.shell', { command: "sleep .2; printf response-loss" }, { idempotencyKey: responseLossKey, disconnectAfterSend: true });
    assert.equal(lost.response, null);
    await sleep(400);
    const recovered = assertOperationResponse((await h.local.call('sez.shell', { command: "sleep .2; printf response-loss" }, { idempotencyKey: responseLossKey })).response, 'sez.shell');
    const recoveredDone = await waitJob(h, recovered.jobId);
    const resumed = await h.call('sez.request.resume', { requestId: recovered.requestId });
    assert.equal(resumed.result.originalRequestId, recovered.requestId);
    assert.equal(resumed.result.originalResponse.jobId, recovered.jobId);
    assert.equal((await readAllStream(h, recovered.jobId, 'stdout')).bytes.toString(), 'response-loss');
    record('response loss retry and deterministic resume', { requestId: recovered.requestId, jobId: recovered.jobId, state: recoveredDone.state });

    const replayRequestId = crypto.randomUUID();
    const replayNonce = crypto.randomBytes(24).toString('base64url');
    const replayKey = `integration-replay-${crypto.randomUUID()}`;
    const r1 = await h.local.call('sez.health', {}, { requestId: replayRequestId, nonce: replayNonce, idempotencyKey: replayKey });
    const r2 = await h.local.call('sez.health', {}, { requestId: replayRequestId, nonce: replayNonce, idempotencyKey: replayKey });
    assert.equal(r1.response.requestId, r2.response.requestId);
    const changedReplay = await h.local.call('sez.version', {}, { nonce: replayNonce, idempotencyKey: `other-${crypto.randomUUID()}` });
    assertOperationResponse(changedReplay.response, 'sez.version', { errorCode: 'replay_detected' });
    record('exact replay resumes and changed-content nonce replay rejects');

    const fileRoot = path.join(h.root, 'raw-files');
    const fileA = path.join(fileRoot, 'a.bin');
    const fileB = path.join(fileRoot, 'b.bin');
    const fileC = path.join(fileRoot, 'c.bin');
    const hard = path.join(fileRoot, 'hard.bin');
    const sym = path.join(fileRoot, 'sym.bin');
    await h.call('sez.file.mkdir', { path: fileRoot, recursive: true, mode: '0750' });
    const binary = Buffer.concat([Buffer.from([0, 255, 1, 2]), crypto.randomBytes(1024 * 1024 + 17)]);
    const wrote = await h.call('sez.file.write', { path: fileA, data: binary.toString('base64'), encoding: 'base64', mode: '0600', flush: true });
    assert.equal(wrote.result.sha256, sha256Hex(binary));
    const statA = await h.call('sez.file.stat', { path: fileA, followSymlinks: false });
    assert.equal(statA.result.size, binary.length);
    let offset = 0; const fileChunks = [];
    while (offset < binary.length) {
      const page = await h.call('sez.file.read', { path: fileA, offset, length: Math.min(333333, binary.length - offset), encoding: 'base64', followSymlinks: false });
      fileChunks.push(Buffer.from(page.result.data, 'base64')); offset = page.result.nextOffset;
    }
    assert.deepEqual(Buffer.concat(fileChunks), binary);
    await h.call('sez.file.chmod', { path: fileA, mode: '0640', followSymlinks: false });
    await h.call('sez.file.chown', { path: fileA, uid: 0, gid: h.identity.gid, followSymlinks: false });
    const replacement = Buffer.from('abcdef');
    await h.call('sez.file.replace', { path: fileA, data: replacement.toString('base64'), encoding: 'base64', expectedSha256: sha256Hex(binary), preserveMetadata: true });
    const patched = await h.call('sez.file.patch', { path: fileA, expectedSha256: sha256Hex(replacement), patches: [{ offset: 2, removeLength: 2, data: Buffer.from('ZZ').toString('base64'), encoding: 'base64' }] });
    assert.equal(patched.result.sha256, sha256Hex(Buffer.from('abZZef')));
    await h.call('sez.file.copy', { source: fileA, destination: fileB, overwrite: false, preserveTimestamps: true });
    await h.call('sez.file.link', { existingPath: fileA, newPath: hard });
    await h.call('sez.file.symlink', { target: fileA, path: sym });
    const symStat = await h.call('sez.file.stat', { path: sym, followSymlinks: false });
    assert.equal(symStat.result.type, 'symlink');
    const list = await h.call('sez.file.list', { path: fileRoot, includeHidden: true, followSymlinks: false });
    assert.ok(list.result.entries.length >= 4);
    await h.call('sez.file.truncate', { path: fileB, length: 5 * 1024 * 1024, followSymlinks: false });
    await h.call('sez.file.move', { source: fileB, destination: fileC, overwrite: false, crossFilesystem: false });
    await h.call('sez.file.remove', { path: sym });
    await h.call('sez.file.remove', { path: hard });
    record('complete paged binary file lifecycle and metadata');

    const artifactData = Buffer.concat([Buffer.from([0, 1, 2, 255]), crypto.randomBytes(1500000)]);
    const artifactDigest = sha256Hex(artifactData);
    const begun = await h.call('sez.artifact.begin', { name: 'integration.bin', mediaType: 'application/octet-stream', size: artifactData.length, sha256: artifactDigest, metadata: { phase: 2 } });
    const artifactId = begun.result.artifactId;
    const firstChunk = artifactData.subarray(0, 700000);
    const secondChunk = artifactData.subarray(700000);
    await h.call('sez.artifact.upload', { artifactId, offset: 0, data: firstChunk.toString('base64'), encoding: 'base64' });
    const duplicate = await h.call('sez.artifact.upload', { artifactId, offset: 0, data: firstChunk.toString('base64'), encoding: 'base64' });
    assert.equal(duplicate.result.duplicate, true);
    await h.restart('SIGKILL');
    await h.call('sez.artifact.upload', { artifactId, offset: firstChunk.length, data: secondChunk.toString('base64'), encoding: 'base64' });
    const finalized = await h.call('sez.artifact.finalize', { artifactId });
    assert.equal(finalized.result.actualSha256, artifactDigest);
    assert.equal(finalized.result.immutable, true);
    const finalizedTwice = await h.call('sez.artifact.finalize', { artifactId });
    assert.equal(finalizedTwice.result.actualSha256, artifactDigest);
    let artifactOffset = 0; const artifactChunks = [];
    while (artifactOffset < artifactData.length) {
      const page = await h.call('sez.artifact.download', { artifactId, offset: artifactOffset, length: Math.min(500000, artifactData.length - artifactOffset) });
      artifactChunks.push(Buffer.from(page.result.data, page.result.encoding)); artifactOffset = page.result.nextOffset;
    }
    assert.deepEqual(Buffer.concat(artifactChunks), artifactData);
    await h.call('sez.artifact.get', { artifactId });
    const artifacts = await h.call('sez.artifact.list', { limit: 100 });
    assert.ok(artifacts.result.artifacts.some((entry) => entry.artifactId === artifactId));
    await h.expectError('sez.artifact.upload', { artifactId, offset: artifactData.length, data: '', encoding: 'base64' }, 'conflict');
    const abortBegin = await h.call('sez.artifact.begin', { size: 3, sha256: sha256Hex(Buffer.from('abc')) });
    await h.call('sez.artifact.abort', { artifactId: abortBegin.result.artifactId });
    const sourceArtifact = await h.call('sez.artifact.create', { sourcePath: fileA, name: 'from-file.bin' });
    assert.equal(sourceArtifact.result.state, 'finalized');
    await h.call('sez.artifact.remove', { artifactId: sourceArtifact.result.artifactId });
    record('resumable immutable artifact lifecycle across restart', { artifactId, digest: artifactDigest });

    const pty = await h.call('sez.pty.create', { shell: '/bin/bash', shellArgs: ['--noprofile', '--norc'], cwd: '/tmp', environment: { TERM: 'xterm-256color' }, cols: 80, rows: 24 });
    const sessionId = pty.result.sessionId;
    await h.call('sez.pty.resize', { sessionId, cols: 100, rows: 40 });
    await h.call('sez.pty.input', { sessionId, data: "printf 'phase2-pty-☃\\n'\n", encoding: 'utf8' });
    await sleep(300);
    const ptyPage1 = await h.call('sez.pty.read', { sessionId, offset: 0, length: 65536 });
    assert.match(Buffer.from(ptyPage1.result.data, ptyPage1.result.encoding).toString('utf8'), /phase2-pty-☃/);
    await h.restart('SIGKILL');
    await h.call('sez.pty.input', { sessionId, data: "printf 'after-supervisor-restart\\n'\n", encoding: 'utf8' });
    await sleep(300);
    const ptyPage2 = await h.call('sez.pty.read', { sessionId, offset: 0, length: 65536 });
    const ptyText = Buffer.from(ptyPage2.result.data, ptyPage2.result.encoding).toString('utf8');
    assert.match(ptyText, /after-supervisor-restart/);
    await h.call('sez.pty.close', { sessionId, signal: 'SIGTERM' });
    record('persistent PTY input resize read close and restart rediscovery', { sessionId });

    const survive = await h.call('sez.shell', { command: "sleep 1; printf 'survived-supervisor-down'", detached: true });
    const surviveJob = survive.jobId;
    await h.restart('SIGKILL');
    await sleep(1200);
    const survived = await waitJob(h, surviveJob);
    assert.equal(survived.state, 'completed');
    assert.equal((await readAllStream(h, surviveJob, 'stdout')).bytes.toString(), 'survived-supervisor-down');
    const surviveResume = await h.call('sez.request.resume', { requestId: survive.requestId });
    assert.equal(surviveResume.result.originalResponse.jobId, surviveJob);
    assert.equal(surviveResume.result.originalResponse.state, 'completed');
    record('job completes during supervisor outage and reconciles', { jobId: surviveJob, requestId: survive.requestId });

    const mutationPath = path.join(h.root, 'generation-must-not-mutate');
    await atomicWriteJson(h.keys.generationPath, { schemaVersion: 1, authorityGeneration: 2, owner: 'se-z-recovery', initializedAt: new Date().toISOString(), bootstrapRole: 'test-only' });
    const idemBefore = (await fsp.readdir(path.join(h.config.stateRoot, 'idempotency'))).length;
    await h.expectError('sez.file.write', { path: mutationPath, data: Buffer.from('bad').toString('base64'), encoding: 'base64' }, 'stale_generation', { authorityGeneration: 1, idempotencyKey: `stale-${crypto.randomUUID()}` });
    await h.expectError('sez.file.write', { path: mutationPath, data: Buffer.from('bad').toString('base64'), encoding: 'base64' }, 'future_generation', { authorityGeneration: 3, idempotencyKey: `future-${crypto.randomUUID()}` });
    assert.equal(await fsp.stat(mutationPath).then(() => true).catch(() => false), false);
    const idemAfter = (await fsp.readdir(path.join(h.config.stateRoot, 'idempotency'))).length;
    assert.equal(idemAfter, idemBefore);
    record('stale and future authority generation rejected before mutation/reservation');

    await h.call('sez.artifact.remove', { artifactId });
    await h.call('sez.file.remove', { path: fileRoot, recursive: true });
    const finalHealth = await h.call('sez.health');
    assert.equal(finalHealth.result.healthy, true);

    const active = new Set(describe.result.activeOperations.map((entry) => entry.name));
    for (const operation of active) assert.ok(covered.has(operation), `active operation not covered by real integration: ${operation}`);
    record('all active 0.1A operations exercised through real Unix sockets', { covered: covered.size });

    const summary = {
      schemaVersion: 1,
      kind: 'phase2-integration',
      startedAt,
      completedAt: new Date().toISOString(),
      passed: true,
      checks,
      checkCount: checks.length,
      operationCoverage: [...covered].sort(),
      operationCoverageCount: covered.size,
      catalogDigest,
      nativeAddonPath: h.nativeAddonPath,
      root: h.root,
      supervisorStdoutSha256: sha256Hex(await fsp.readFile(h.stdoutPath).catch(() => Buffer.alloc(0))),
      supervisorStderrSha256: sha256Hex(await fsp.readFile(h.stderrPath).catch(() => Buffer.alloc(0))),
    };
    if (evidencePath) {
      await fsp.mkdir(path.dirname(evidencePath), { recursive: true });
      await fsp.writeFile(evidencePath, `${JSON.stringify(summary, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    failure('integration harness', error);
    const summary = { schemaVersion: 1, kind: 'phase2-integration', startedAt, completedAt: new Date().toISOString(), passed: false, checks };
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
        if (unit) await execFileAsync('/usr/bin/systemctl', ['reset-failed', unit]).catch(() => {});
      }
    }
    await removeLinuxIdentities();
  }
}
await run();
