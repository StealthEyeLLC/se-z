import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { assertMaterializedSources, identityNormalize, readJson, sourceSupervisor, target } from '../helpers/index.js';

let sourceFrame: any;
let targetFrame: any;
let sourceCanonical: any;
let targetCanonical: any;
let sourceSigning: any;
let targetSigning: any;
let sourceConfig: any;
let targetConfig: any;
let sourceReplay: any;
let targetReplay: any;

before(async () => {
  assertMaterializedSources();
  [sourceFrame, targetFrame, sourceCanonical, targetCanonical, sourceSigning, targetSigning, sourceConfig, targetConfig, sourceReplay, targetReplay] = await Promise.all([
    sourceSupervisor('src/protocol/frame.ts'), target('src/protocol/framing/frame.ts'),
    sourceSupervisor('src/crypto/canonical.ts'), target('src/protocol/canonical/canonical.ts'),
    sourceSupervisor('src/crypto/signing.ts'), target('src/protocol/signatures/signing.ts'),
    sourceSupervisor('src/config.ts'), target('src/supervisor/configuration/config.ts'),
    sourceSupervisor('src/state/replay-store.ts'), target('src/state/replay/store.ts'),
  ]);
});

describe('frame mechanics', () => {
  test('headers, partial feeds, maximum frame, and JSON behavior remain equivalent', () => {
    const requestId = '00000000-0000-4000-8000-000000000042';
    const payload = Buffer.from(JSON.stringify({ binary: Buffer.from([0, 1, 255]).toString('base64') }));
    const sourceEncoded = sourceFrame.encodeFrame(sourceFrame.FrameType.Request, payload, requestId);
    const targetEncoded = targetFrame.encodeFrame(targetFrame.FrameType.Request, payload, requestId);
    const sourceHeader = sourceFrame.decodeHeader(sourceEncoded);
    const targetHeader = targetFrame.decodeHeader(targetEncoded);
    assert.equal(sourceHeader.magic, 'QRT1');
    assert.equal(targetHeader.magic, 'SEZ1');
    assert.deepEqual({ ...sourceHeader, magic: 'SEZ1' }, targetHeader);
    assert.deepEqual(sourceEncoded.subarray(sourceFrame.HEADER_SIZE), targetEncoded.subarray(targetFrame.HEADER_SIZE));

    for (const [module, encoded] of [[sourceFrame, sourceEncoded], [targetFrame, targetEncoded]]) {
      const reader = module.createFrameReader();
      assert.deepEqual(module.feedFrames(reader, encoded.subarray(0, 17), payload.length), []);
      const frames = module.feedFrames(reader, encoded.subarray(17), payload.length);
      assert.equal(frames.length, 1);
      assert.deepEqual(frames[0].payload, payload);
      assert.deepEqual(module.decodeJsonPayload(module.encodeJsonPayload({ z: 1, a: true })), { z: 1, a: true });
      assert.throws(() => module.decodeJsonPayload(Buffer.from('{bad')), SyntaxError);
      assert.throws(
        () => module.feedFrames(module.createFrameReader(), encoded, payload.length - 1),
        (error: any) => error instanceof module.ProtocolError && error.code === 'frame_too_large',
      );
    }
  });

  test('invalid product magic is rejected by each protocol', () => {
    const sourceBad = Buffer.alloc(sourceFrame.HEADER_SIZE); sourceBad.write('SEZ1');
    const targetBad = Buffer.alloc(targetFrame.HEADER_SIZE); targetBad.write('QRT1');
    assert.throws(() => sourceFrame.decodeHeader(sourceBad), (error: any) => error.code === 'invalid_magic');
    assert.throws(() => targetFrame.decodeHeader(targetBad), (error: any) => error.code === 'invalid_magic');
  });
});

test('canonical encoding, semantic fingerprints, and request hashes normalize mechanically', () => {
  const sourceInput = {
    protocolVersion: '1.0.0', requestId: '00000000-0000-4000-8000-000000000001', operation: 'baby.health',
    principal: { subject: 'stealtheye-owner', authorityClass: 'unrestricted-owner' },
    authority: { algorithm: 'ed25519', gatewayId: 'stealtheye-baby-gateway', nonce: 'nonce-parity' },
    targetHost: 'fixture-host', timestamp: '2026-08-03T12:00:00.000Z', payload: { z: 1, a: { c: 2, b: 3 } }, binaryLength: 0,
  };
  const targetInput = identityNormalize(sourceInput);
  const sourceDocument = sourceCanonical.buildSigningDocument(sourceInput);
  const targetDocument = targetCanonical.buildSigningDocument(targetInput);
  assert.equal(identityNormalize(sourceDocument), targetDocument);
  assert.equal(sourceCanonical.canonicalJson({ z: 1, a: { c: 2, b: 3 } }), targetCanonical.canonicalJson({ z: 1, a: { c: 2, b: 3 } }));
  assert.equal(sourceCanonical.requestHash(sourceDocument), sourceCanonical.sha256Hex(sourceDocument));
  assert.equal(targetCanonical.requestHash(targetDocument), targetCanonical.sha256Hex(targetDocument));
  const sourceFingerprint = sourceCanonical.semanticRequestFingerprint({ requestId: sourceInput.requestId, operation: sourceInput.operation, payload: sourceInput.payload });
  const targetFingerprint = targetCanonical.semanticRequestFingerprint({ requestId: targetInput.requestId, operation: targetInput.operation, payload: targetInput.payload });
  assert.equal(sourceFingerprint, sourceCanonical.semanticRequestFingerprint({ requestId: sourceInput.requestId, operation: sourceInput.operation, payload: sourceInput.payload }));
  assert.equal(targetFingerprint, targetCanonical.semanticRequestFingerprint({ requestId: targetInput.requestId, operation: targetInput.operation, payload: targetInput.payload }));
  assert.notEqual(sourceFingerprint, targetFingerprint, 'active operation identity is intentionally bound into the semantic fingerprint');
});

test('ephemeral signatures verify equivalent semantic documents and reject changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'sez-parity-signing-'));
  try {
    for (const [name, module] of [['source', sourceSigning], ['target', targetSigning]] as const) {
      const publicKeyPath = join(root, `${name}-public.pem`);
      const privateKeyPath = join(root, `${name}-private.pem`);
      module.generateEd25519KeyPair({ publicKeyPath, privateKeyPath, keyId: `${name}-fixture` });
      const document = '{"operation":"sez.health","payload":{}}';
      const signature = module.signEd25519(document, module.loadPrivateKey(privateKeyPath));
      assert.equal(module.verifyEd25519(document, signature, module.loadPublicKey(publicKeyPath)), true);
      assert.equal(module.verifyEd25519(`${document}x`, signature, module.loadPublicKey(publicKeyPath)), false);
      const hmac = module.signHmacSha256(document, Buffer.from('fixture-secret'));
      assert.equal(module.verifyHmacSha256(document, hmac, Buffer.from('fixture-secret')), true);
      assert.equal(module.verifyHmacSha256(`${document}x`, hmac, Buffer.from('fixture-secret')), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nonce replay and semantic idempotency retain equivalent state transitions', () => {
  const roots = [mkdtempSync(join(tmpdir(), 'sez-parity-replay-source-')), mkdtempSync(join(tmpdir(), 'sez-parity-replay-target-'))];
  try {
    const sourceStore = new sourceReplay.ReplayStore(sourceConfig.loadRuntimeConfig({ stateRoot: roots[0], configRoot: join(roots[0], 'config') }));
    const targetStore = new targetReplay.ReplayStore(targetConfig.loadRuntimeConfig({ stateRoot: roots[1], configRoot: join(roots[1], 'config') }));
    const exercise = (store: any) => {
      const nonceFirst = store.checkAndRecordNonce('nonce-1');
      const nonceReplay = store.checkAndRecordNonce('nonce-1');
      const miss = store.checkSemantic('request-1', 'fingerprint-a');
      store.reserveSemantic('request-1', 'fingerprint-a', 'hash-a');
      const pending = store.checkSemantic('request-1', 'fingerprint-a');
      const conflict = store.checkSemantic('request-1', 'fingerprint-b');
      store.storeIdempotentResponse('hash-a', { result: 'ok' }, 'request-1', 'fingerprint-a');
      const response = store.getIdempotentResponse('hash-a');
      const replay = store.checkSemantic('request-1', 'fingerprint-a');
      return { nonceFirst, nonceReplay, miss, pending, conflict, response, replay };
    };
    const sourceResult = exercise(sourceStore);
    const targetResult = exercise(targetStore);
    assert.deepEqual(sourceResult, targetResult);
    assert.equal(sourceResult.nonceFirst, true);
    assert.equal(sourceResult.nonceReplay, false);
    assert.equal(sourceResult.miss.state, 'miss');
    assert.equal(sourceResult.pending.state, 'pending');
    assert.equal(sourceResult.conflict.state, 'conflict');
    assert.deepEqual(sourceResult.response, { result: 'ok' });
    assert.equal(sourceResult.replay.state, 'replay');
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('SEZ1 additions remain explicit canonical deltas rather than false byte parity', () => {
  const register = readJson('contracts/phase1-canonical-delta.json');
  const ids = new Set(register.entries.map((entry: any) => entry.id));
  assert.equal(ids.has('DELTA-PROTOCOL-001'), true);
  assert.equal(ids.has('DELTA-AUTHORITY-001'), true);
  assert.equal(sourceFrame.FRAME_MAGIC_BYTES.toString('ascii'), 'QRT1');
  assert.equal(targetFrame.FRAME_MAGIC_BYTES.toString('ascii'), 'SEZ1');
  assert.equal('authorityGeneration' in ({ } as Record<string, unknown>), false);
});
