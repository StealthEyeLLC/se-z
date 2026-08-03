import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalJson, canonicalBytes, sha256Hex, MAX_FRAME_SIZE, ERROR_DEFINITIONS, SezError,
} from '../../../src/kernel/util.mjs';
import {
  requestDigest, semanticDigest, signDigestHex, verifyDigestHex, makeReceipt, verifyReceipt,
  catalogDigest, operationResultDigest,
} from '../../../src/kernel/crypto.mjs';
import { FrameDecoder, encodeFrame, decodeFrameJson, validateRequest, validateHello } from '../../../src/kernel/protocol.mjs';
import { ACTIVE_OPERATION_DEFINITIONS, ACTIVE_OPERATION_NAMES, CATALOG_DIGEST } from '../../../src/kernel/definitions.mjs';
import { AuthorityGenerationProvider } from '../../../src/kernel/identity.mjs';
import { KernelState } from '../../../src/kernel/state.mjs';
import { FileOperations } from '../../../src/kernel/files.mjs';
import { ArtifactOperations } from '../../../src/kernel/artifacts.mjs';
import { validateConfig } from '../../../src/kernel/config.mjs';
import { tempDirectory, testConfig, testKeys } from '../helpers.mjs';

const baseRequest = (overrides = {}) => ({
  protocol: 'SEZ1', protocolVersion: '1.0.0', requestId: crypto.randomUUID(), operation: 'sez.exec',
  payload: { argv: ['/usr/bin/printf', 'ok'] }, idempotencyKey: `unit-${crypto.randomUUID()}`,
  subject: 'stealtheye-owner', authorityClass: 'unrestricted-owner', authorityGeneration: 1,
  issuedAt: new Date().toISOString(), nonce: crypto.randomBytes(24).toString('base64url'), peerClass: 'local-peer', ...overrides,
});

test('canonical JSON is deterministic and rejects lossy values', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(canonicalJson({ a: -0 }), '{"a":0}');
  assert.equal(canonicalJson({ text: '雪\u2028é𝄞' }), '{"text":"雪 é𝄞"}');
  assert.throws(() => canonicalJson({ x: Number.NaN }), /finite/);
  assert.throws(() => canonicalJson({ x: undefined }), /Unsupported/);
  assert.throws(() => canonicalJson({ x() {} }), /Unsupported/);
  const sparse = []; sparse[1] = 1; assert.throws(() => canonicalJson(sparse), /Sparse/);
  const cycle = {}; cycle.self = cycle; assert.throws(() => canonicalJson(cycle), /Cyclic/);
});

test('request digest and semantic identity bind every authority field', () => {
  const a = baseRequest({ requestId: '01234567-89ab-4def-8123-456789abcdef', payload: { b: 2, a: 1 } });
  const reordered = { ...a, payload: { a: 1, b: 2 } };
  assert.equal(requestDigest(a), requestDigest(reordered));
  for (const changed of [
    { authorityGeneration: 2 }, { idempotencyKey: 'other-key' }, { peerClass: 'gateway-signed', gatewayId: 'g', gatewayKeyId: 'k' },
    { operation: 'sez.shell' }, { subject: 'other' }, { nonce: crypto.randomBytes(24).toString('base64url') },
  ]) assert.notEqual(requestDigest(a), requestDigest({ ...a, ...changed }));
  assert.equal(semanticDigest(a, 'host'), semanticDigest(reordered, 'host'));
  assert.notEqual(semanticDigest(a, 'host'), semanticDigest(a, 'nspawn:x'));
});

test('published request vectors and gateway signature execute against implementation', async () => {
  const doc = JSON.parse(await fsp.readFile('protocol/test-vectors/sez1-request-v1.json', 'utf8'));
  assert.ok(Object.values(doc.invariants).every(Boolean));
  for (const vector of doc.vectors) assert.equal(requestDigest(vector.request), vector.requestDigest, vector.id);
  const gateway = doc.vectors.find((entry) => entry.id === 'gateway');
  assert.ok(verifyDigestHex(gateway.requestDigest, gateway.request.signature, crypto.createPublicKey(gateway.publicKeyPem)));
  assert.equal(doc.vectors.find((entry) => entry.id === 'payload-reordered').requestDigest, doc.vectors.find((entry) => entry.id === 'local').requestDigest);
});

test('framing handles byte delivery, coalesced frames, exact limit and failures', () => {
  const value = { x: 'hello', n: 3 }; const encoded = encodeFrame(value); const decoder = new FrameDecoder(); let frames = [];
  for (const byte of encoded) frames.push(...decoder.feed(Buffer.from([byte])));
  assert.deepEqual(decodeFrameJson(frames[0]), value); decoder.finish();
  const two = new FrameDecoder(); const results = two.feed(Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]));
  assert.deepEqual(results.map(decodeFrameJson), [{ a: 1 }, { b: 2 }]);
  const maxDecoder = new FrameDecoder(MAX_FRAME_SIZE); const header = Buffer.alloc(4); header.writeUInt32BE(MAX_FRAME_SIZE); maxDecoder.feed(header); assert.equal(maxDecoder.expectedLength, MAX_FRAME_SIZE);
  const tooLarge = Buffer.alloc(4); tooLarge.writeUInt32BE(MAX_FRAME_SIZE + 1); assert.throws(() => new FrameDecoder().feed(tooLarge), (error) => error.code === 'frame_too_large');
  assert.throws(() => new FrameDecoder().feed(Buffer.alloc(4)), (error) => error.code === 'invalid_frame');
  const truncated = new FrameDecoder(); truncated.feed(Buffer.from([0, 0, 0, 5, 1])); assert.throws(() => truncated.finish(), (error) => error.code === 'invalid_frame');
  assert.throws(() => decodeFrameJson(Buffer.from([0xff])), (error) => error.code === 'invalid_utf8');
  assert.throws(() => decodeFrameJson(Buffer.from('{', 'utf8')), (error) => error.code === 'invalid_json');
});

test('strict request and handshake validation reject unknowns and peer mismatch', () => {
  const active = new Set(ACTIVE_OPERATION_NAMES); const request = baseRequest();
  assert.equal(validateRequest(request, active), request);
  assert.throws(() => validateRequest({ ...request, unknown: true }, active), (error) => error.code === 'invalid_request');
  assert.throws(() => validateRequest({ ...request, protocolVersion: '9.0.0' }, active), (error) => error.code === 'unsupported_version');
  assert.throws(() => validateRequest({ ...request, operation: 'sez.github.api' }, active), (error) => error.code === 'unknown_operation');
  assert.throws(() => validateRequest({ ...request, gatewayId: 'g' }, active), (error) => error.code === 'invalid_request');
  assert.doesNotThrow(() => validateHello({ type: 'hello', protocol: 'SEZ1', protocolVersion: '1.0.0', clientId: 'test', peerClass: 'local-peer' }, 'local-peer'));
  assert.throws(() => validateHello({ type: 'hello', protocol: 'SEZ1', protocolVersion: '1.0.0', clientId: 'test', peerClass: 'gateway-signed' }, 'local-peer'), (error) => error.code === 'peer_class_mismatch');
});

test('catalog is complete, deterministic, and excludes later-phase operations', async () => {
  assert.equal(ACTIVE_OPERATION_NAMES.length, 41);
  assert.equal(new Set(ACTIVE_OPERATION_NAMES).size, 41);
  assert.equal(catalogDigest(ACTIVE_OPERATION_DEFINITIONS), CATALOG_DIGEST);
  const reordered = ACTIVE_OPERATION_DEFINITIONS.map((entry) => Object.fromEntries(Object.entries(entry).reverse()));
  assert.equal(catalogDigest(reordered), CATALOG_DIGEST);
  assert.ok(ACTIVE_OPERATION_DEFINITIONS.every((entry) => ['name','operationVersion','description','inputSchema','outputSchema','mutating','durableJobBehavior','supportedTargets','defaultTarget','defaultLane','idempotencySemantics','requiredPeerAuthority','streamBehavior','typedErrors','implementationStatus'].every((key) => Object.hasOwn(entry, key))));
  assert.ok(ACTIVE_OPERATION_NAMES.every((name) => !/^sez\.(?:github|machine|skill|release|recovery|backup|evidence|selfhost)\./.test(name)));
  const contract = JSON.parse(await fsp.readFile('contracts/operations-0.1a.json', 'utf8'));
  assert.equal(contract.catalogDigest, CATALOG_DIGEST); assert.equal(contract.operationCount, 41);
});

test('all stable error definitions are machine-readable and local-protocol scoped', async () => {
  const contract = JSON.parse(await fsp.readFile('contracts/errors-0.1a.json', 'utf8'));
  assert.deepEqual(new Set(contract.errors.map((entry) => entry.code)), new Set(Object.keys(ERROR_DEFINITIONS)));
  assert.ok(contract.errors.every((entry) => typeof entry.retryable === 'boolean' && typeof entry.terminal === 'boolean' && entry.httpLayer === 'irrelevant-local-SEZ1'));
});

test('authority generation provider accepts current and rejects stale/future', async () => {
  const root = await tempDirectory(); const file = path.join(root, 'generation.json');
  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 1, authorityGeneration: 5, owner: 'se-z-recovery', initializedAt: new Date().toISOString(), bootstrapRole: 'test' }));
  const provider = new AuthorityGenerationProvider(file); assert.equal(await provider.assertCurrent(5), 5);
  await assert.rejects(() => provider.assertCurrent(4), (error) => error.code === 'stale_generation');
  await assert.rejects(() => provider.assertCurrent(6), (error) => error.code === 'future_generation');
  await fsp.writeFile(file, '{bad'); await assert.rejects(() => provider.read(), (error) => error.code === 'state_corrupt');
});

test('strict configuration fails closed on unknown and security-critical values', async () => {
  const root = await tempDirectory(); const keys = await testKeys(root); const native = path.join(root, 'peer.node'); await fsp.writeFile(native, 'x');
  const raw = testConfig(root, keys, { nativeAddonPath: native });
  const valid = await validateConfig(raw); assert.equal(valid.maximumFrameSize, MAX_FRAME_SIZE);
  await assert.rejects(() => validateConfig({ ...raw, unknownField: 1 }), (error) => error.code === 'invalid_request');
  await assert.rejects(() => validateConfig({ ...raw, localSocket: raw.gatewaySocket }), (error) => error.code === 'invalid_request');
  await assert.rejects(() => validateConfig({ ...raw, testMode: false, faultInjection: { diskFull: true } }), (error) => error.code === 'invalid_request');
});

test('request reservation is durable, concurrent, replay-aware, and semantically idempotent', async () => {
  const root = await tempDirectory(); const keys = await testKeys(root); const config = testConfig(root, keys); const state = new KernelState(config);
  await state.initialize({ product: 'se-z', catalogDigest: CATALOG_DIGEST, definitions: ACTIVE_OPERATION_DEFINITIONS });
  const request = baseRequest({ requestId: crypto.randomUUID(), idempotencyKey: 'same-key', nonce: crypto.randomBytes(24).toString('base64url') });
  const fields = { request, requestDigest: requestDigest(request), semanticDigest: semanticDigest(request), resolvedTarget: 'host', catalogDigest: CATALOG_DIGEST, authorityGeneration: 1 };
  const [a, b] = await Promise.all([state.reserveRequest(fields), state.reserveRequest(fields)]);
  assert.deepEqual(new Set([a.kind, b.kind]), new Set(['new', 'idempotent-reuse']));
  const changedRequest = { ...request, requestId: crypto.randomUUID(), payload: { argv: ['/bin/false'] }, nonce: crypto.randomBytes(24).toString('base64url') };
  await assert.rejects(() => state.reserveRequest({ ...fields, request: changedRequest, requestDigest: requestDigest(changedRequest), semanticDigest: semanticDigest(changedRequest) }), (error) => error.code === 'idempotency_conflict');
  const nonceConflict = { ...request, requestId: crypto.randomUUID(), idempotencyKey: 'different', operation: 'sez.shell', payload: { command: 'true' } };
  await assert.rejects(() => state.reserveRequest({ ...fields, request: nonceConflict, requestDigest: requestDigest(nonceConflict), semanticDigest: semanticDigest(nonceConflict) }), (error) => error.code === 'replay_detected');
  assert.ok(fs.existsSync(state.requestPath(request.requestId)));
});

test('file operations are binary-safe, paged, atomic and digest-bound', async () => {
  const root = await tempDirectory(); const operations = new FileOperations({ streamPageLimit: 1024 * 1024, testMode: true, faultInjection: {} });
  const file = path.join(root, 'data.bin'); const bytes = crypto.randomBytes(256 * 1024);
  await operations.write({ path: file, data: bytes.toString('base64'), encoding: 'base64', create: true, truncate: true, flush: true, mode: '0640' });
  const first = await operations.read({ path: file, offset: 0, length: 1000, encoding: 'base64' }); assert.deepEqual(Buffer.from(first.data, 'base64'), bytes.subarray(0, 1000));
  const digest = sha256Hex(bytes); const replacement = Buffer.from('replacement');
  await operations.replace({ path: file, data: replacement.toString('base64'), encoding: 'base64', expectedSha256: digest, preserveMetadata: true });
  await assert.rejects(() => operations.replace({ path: file, data: 'eA==', encoding: 'base64', expectedSha256: digest }), (error) => error.code === 'digest_mismatch');
  const currentDigest = sha256Hex(replacement);
  const patched = await operations.patch({ path: file, expectedSha256: currentDigest, patches: [{ offset: 0, removeLength: 3, data: Buffer.from('REP').toString('base64'), encoding: 'base64' }] });
  assert.equal(patched.sha256, sha256Hex(Buffer.from('REPlacement')));
  const symlink = path.join(root, 'link'); await operations.symlink({ target: file, path: symlink }); const stat = await operations.stat({ path: symlink, followSymlinks: false }); assert.equal(stat.type, 'symlink');
  const hard = path.join(root, 'hard'); await operations.link({ existingPath: file, newPath: hard }); assert.equal((await operations.stat({ path: hard })).inode, (await operations.stat({ path: file })).inode);
});

test('artifact lifecycle is resumable, exact-offset, immutable and digest verified', async () => {
  const root = await tempDirectory(); const keys = await testKeys(root); const config = testConfig(root, keys); const state = new KernelState(config);
  await state.initialize({ product: 'se-z', catalogDigest: CATALOG_DIGEST, definitions: ACTIVE_OPERATION_DEFINITIONS });
  const artifacts = new ArtifactOperations(config, state); await artifacts.initialize(); const data = crypto.randomBytes(1025); const digest = sha256Hex(data);
  const begun = await artifacts.begin({ requestId: crypto.randomUUID() }, { name: 'binary', size: data.length, sha256: digest });
  const a = data.subarray(0, 500); const b = data.subarray(500);
  await artifacts.upload({ artifactId: begun.artifactId, offset: 0, data: a.toString('base64'), encoding: 'base64' });
  const retry = await artifacts.upload({ artifactId: begun.artifactId, offset: 0, data: a.toString('base64'), encoding: 'base64' }); assert.equal(retry.duplicate, true);
  await assert.rejects(() => artifacts.upload({ artifactId: begun.artifactId, offset: 0, data: Buffer.from('x').toString('base64'), encoding: 'base64' }), (error) => error.code === 'conflict');
  await artifacts.upload({ artifactId: begun.artifactId, offset: 500, data: b.toString('base64'), encoding: 'base64' });
  const final = await artifacts.finalize({ artifactId: begun.artifactId }); assert.equal(final.actualSha256, digest);
  const page = await artifacts.download({ artifactId: begun.artifactId, offset: 0, length: data.length }); assert.deepEqual(Buffer.from(page.data, 'base64'), data);
  const again = await artifacts.finalize({ artifactId: begun.artifactId }); assert.equal(again.state, 'finalized');
  await assert.rejects(() => artifacts.upload({ artifactId: begun.artifactId, offset: data.length, data: '', encoding: 'base64' }), (error) => error.code === 'conflict');
});

test('receipt vectors verify and every bound mutation fails verification', async () => {
  const vector = JSON.parse(await fsp.readFile('protocol/test-vectors/sez1-receipt-v1.json', 'utf8'));
  const keys = new Map([['receipt-vector-v1', crypto.createPublicKey(vector.publicKeyPem)]]);
  assert.equal(verifyReceipt(vector.receipt, keys).valid, true);
  for (const field of ['requestDigest', 'resultDigest', 'stdoutDigest', 'authorityGeneration', 'catalogDigest']) {
    const changed = structuredClone(vector.receipt); changed[field] = field === 'authorityGeneration' ? changed[field] + 1 : 'f'.repeat(64);
    assert.equal(verifyReceipt(changed, keys).valid, false, field);
  }
  assert.equal(verifyReceipt({ ...vector.receipt, receiptKeyId: 'unknown' }, keys).code, 'unknown_key');
  const root = await tempDirectory(); const current = await testKeys(root); const prior = await testKeys(await tempDirectory());
  const body = { requestDigest: '0'.repeat(64), resultDigest: '1'.repeat(64), requestId: crypto.randomUUID(), operation: 'sez.health', subject: 'stealtheye-owner', authorityClass: 'unrestricted-owner', authorityGeneration: 1, catalogDigest: CATALOG_DIGEST, hostIdentity: {}, releaseIdentity: {}, acceptedAt: new Date().toISOString(), terminalAt: new Date().toISOString(), state: 'completed', jobId: null, stdoutDigest: null, stderrDigest: null, artifactDigests: [], receiptKeyId: 'prior' };
  const oldReceipt = makeReceipt(body, prior.receipt.privateKey); const overlap = new Map([['current', current.receipt.publicKey], ['prior', prior.receipt.publicKey]]); assert.equal(verifyReceipt(oldReceipt, overlap).valid, true); assert.equal(verifyReceipt(oldReceipt, new Map([['current', current.receipt.publicKey]])).valid, false);
});

test('result test vector digest matches implementation', async () => {
  const vector = JSON.parse(await fsp.readFile('protocol/test-vectors/sez1-response-v1.json', 'utf8'));
  assert.equal(operationResultDigest(vector.responseWithoutDigestOrReceipt), vector.resultDigest);
  assert.equal(sha256Hex(canonicalBytes(vector.responseWithoutDigestOrReceipt)), vector.resultDigest);
});
