import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tempDirectory, testConfig, testKeys } from '../helpers.mjs';
import { KernelState } from '../../../src/kernel/state.mjs';
import { KernelOperations } from '../../../src/kernel/operations.mjs';
import { AuthorityGenerationProvider } from '../../../src/kernel/identity.mjs';
import { PROTOCOL, PROTOCOL_VERSION, SUBJECT, AUTHORITY_CLASS, sha256Hex } from '../../../src/kernel/util.mjs';

const EMPTY_SHA256 = sha256Hex(Buffer.alloc(0));

function request(operation, payload = {}) {
  return {
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    operation,
    payload,
    idempotencyKey: `publication-${crypto.randomUUID()}`,
    subject: SUBJECT,
    authorityClass: AUTHORITY_CLASS,
    authorityGeneration: 1,
    issuedAt: new Date().toISOString(),
    nonce: Buffer.from(crypto.randomBytes(24)).toString('base64url'),
    peerClass: 'local-peer',
  };
}

async function fixture() {
  const root = await tempDirectory('se-z-publication-');
  const keys = await testKeys(root);
  const config = testConfig(root, keys, {
    hostIdentity: { hostname: 'phase2-test', machineIdSha256: '1'.repeat(64) },
  });
  const state = new KernelState(config);
  const authority = new AuthorityGenerationProvider(config.authorityGenerationPath);
  const operations = new KernelOperations(config, state, authority);
  await operations.initialize();
  return { root, config, state, operations };
}

test('terminal request publication is monotonic and preserves terminal time', async (t) => {
  const { root, state, operations } = await fixture();
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));
  const value = request('sez.health');
  const reservation = await operations.reserve(value);
  const terminalAt = '2026-08-03T15:00:00.000Z';
  const terminal = {
    requestId: value.requestId,
    operation: value.operation,
    state: 'completed',
    terminal: true,
    authorityGeneration: 1,
    catalogDigest: reservation.request.catalogDigest,
    result: { status: 'healthy' },
    error: null,
    jobId: null,
    stdout: null,
    stderr: null,
    resultDigest: '2'.repeat(64),
    receipt: { terminalAt },
  };
  await state.storeRequestResponse(value.requestId, terminal);
  await state.storeRequestResponse(value.requestId, {
    ...terminal,
    state: 'running',
    terminal: false,
    resultDigest: '3'.repeat(64),
    receipt: { terminalAt: null },
  });
  const stored = await state.getRequest(value.requestId);
  assert.equal(stored.state, 'completed');
  assert.equal(stored.terminal, true);
  assert.equal(stored.completedAt, terminalAt);
  assert.equal(stored.response.resultDigest, terminal.resultDigest);
});

test('concurrent terminal finalization emits one durable receipt', async (t) => {
  const { root, state, operations } = await fixture();
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));
  const value = request('sez.exec', { argv: ['/usr/bin/true'] });
  const reservation = await operations.reserve(value);
  const jobId = crypto.randomUUID();
  const acceptedAt = new Date().toISOString();
  const terminalAt = new Date(Date.now() + 1).toISOString();
  const stdoutPath = state.streamPath(jobId, 'stdout');
  const stderrPath = state.streamPath(jobId, 'stderr');
  await fsp.writeFile(stdoutPath, Buffer.alloc(0));
  await fsp.writeFile(stderrPath, Buffer.alloc(0));
  const job = {
    jobId,
    requestId: value.requestId,
    operation: value.operation,
    sequence: await state.nextSequence(),
    state: 'completed',
    terminal: true,
    acceptedAt,
    startedAt: acceptedAt,
    terminalAt,
    requestedArgv: ['/usr/bin/true'],
    launchArgv: ['/usr/bin/true'],
    commandDigest: '4'.repeat(64),
    cwd: '/root',
    target: 'host',
    lane: 'fast',
    requestedUser: 'root',
    requestedUid: 0,
    requestedGroup: 'root',
    requestedGid: 0,
    detached: false,
    timeoutMs: null,
    unit: null,
    launchMode: 'test',
    runnerIdentity: null,
    childIdentity: null,
    processGroup: null,
    cgroup: null,
    cancellationRequestedAt: null,
    exitCode: 0,
    signal: null,
    error: null,
    streams: {
      stdout: { handle: `stream:${jobId}:stdout`, path: stdoutPath, committedBytes: 0, committedSha256: EMPTY_SHA256, finalSha256: EMPTY_SHA256, complete: true },
      stderr: { handle: `stream:${jobId}:stderr`, path: stderrPath, committedBytes: 0, committedSha256: EMPTY_SHA256, finalSha256: EMPTY_SHA256, complete: true },
    },
  };
  await state.createJob(job);
  await state.bindRequestJob(value.requestId, jobId, 'running');
  let receiptWrites = 0;
  const saveReceipt = state.saveReceipt.bind(state);
  state.saveReceipt = async (receipt) => { receiptWrites += 1; return await saveReceipt(receipt); };
  const responses = await Promise.all(Array.from({ length: 32 }, () => operations.finalizeJobRequest(job)));
  assert.equal(receiptWrites, 1);
  assert.equal(new Set(responses.map((entry) => entry.receipt.receiptId)).size, 1);
  const stored = await state.getRequest(value.requestId);
  assert.equal(stored.response.state, 'completed');
  assert.equal(stored.response.terminal, true);
  assert.equal(stored.completedAt, terminalAt);
});
