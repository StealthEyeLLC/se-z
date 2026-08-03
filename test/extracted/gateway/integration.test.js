// Derived test fixture: StealthEyeLLC/baby-quirt-mcp@0bfcd99757afe198151e96b18771626388914205:test/integration.test.js; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signValue } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { SezClient } from '../../../src/gateway/transport/client.js';
import {
  buildSigningDocument,
  canonicalJson,
  semanticRequestFingerprint,
  sha256Hex,
} from '../../../src/gateway/signing/canonical.js';
import { createFrameReader, decodeJson, encodeFrame, encodeJson, feedFrames, FrameType } from '../../../src/gateway/transport/protocol.js';

function receiptV1(input, result, privateKey) {
  const complete = { ...input, resultDigest: sha256Hex(canonicalJson(result)) };
  const receiptId = sha256Hex(`${complete.requestId}:${complete.operation}:${complete.timestamp}`).slice(0, 32);
  const digest = sha256Hex(canonicalJson(complete));
  const signingBody = canonicalJson({ ...complete, receiptId, digest });
  return { receiptSchemaVersion: '1.0.0', protocolVersion: '1.0.0', receiptId, ...complete, signature: signValue(null, Buffer.from(signingBody), privateKey).toString('base64'), keyId: 'supervisor-receipt-v1' };
}

function receiptV2(request, result, privateKey) {
  const authority = {
    algorithm: request.authority.algorithm,
    gatewayId: request.authority.gatewayId,
    keyId: request.authority.keyId,
    nonce: request.authority.nonce,
  };
  const requestCore = {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    operation: request.operation,
    principal: request.principal,
    authority,
    targetHost: request.targetHost,
    timestamp: request.timestamp,
    payload: request.payload,
    binaryLength: request.binaryLength,
  };
  const signingDocument = buildSigningDocument(requestCore);
  const completedAt = new Date().toISOString();
  const complete = {
    requestId: request.requestId,
    operation: request.operation,
    subject: 'stealtheye-owner',
    authorityClass: 'unrestricted-owner',
    resultDigest: sha256Hex(canonicalJson(result)),
    timestamp: completedAt,
    machineIdSha256: 'a'.repeat(64),
    hostname: 'test-host',
    requestDigest: sha256Hex(signingDocument),
    requestFingerprint: semanticRequestFingerprint(requestCore),
    startedAt: request.timestamp,
    completedAt,
    release: {
      status: 'installed',
      manifestPath: '/opt/se-z/current/manifest.json',
      manifestSha256: 'c'.repeat(64),
      version: '0.2.0',
      commit: 'd'.repeat(40),
      tree: 'e'.repeat(40),
      sourceDateEpoch: 1784638800,
    },
  };
  const receiptId = sha256Hex(`${complete.requestDigest}:${complete.resultDigest}:${complete.completedAt}`).slice(0, 32);
  const digest = sha256Hex(canonicalJson(complete));
  const signingBody = canonicalJson({ ...complete, receiptId, digest });
  return { receiptSchemaVersion: '2.0.0', protocolVersion: '1.0.0', receiptId, ...complete, signature: signValue(null, Buffer.from(signingBody), privateKey).toString('base64'), keyId: 'supervisor-receipt-v1' };
}

describe('se-z direct SEZ1 client', () => {
  const root = mkdtempSync(join(tmpdir(), 'se-z-gateway-'));
  const socketPath = join(root, 'sez.sock');
  const gateway = generateKeyPairSync('ed25519');
  const supervisor = generateKeyPairSync('ed25519');
  const gatewayPrivateKeyPath = join(root, 'gateway-private.pem');
  const receiptPublicKeyPath = join(root, 'receipt-public.pem');
  let server;

  before(async () => {
    writeFileSync(gatewayPrivateKeyPath, gateway.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(receiptPublicKeyPath, supervisor.publicKey.export({ type: 'spki', format: 'pem' }));
    server = createNetServer((socket) => {
      const reader = createFrameReader();
      socket.on('data', (chunk) => {
        for (const frame of feedFrames(reader, chunk, 16 * 1024 * 1024)) {
          if (frame.header.frameType === FrameType.Hello) {
            socket.write(encodeFrame(FrameType.Welcome, encodeJson({ serverId: 'se-z-supervisor', protocolVersion: '1.0.0', selectedFeatures: ['compression.none'], selectedAlgorithm: 'ed25519', machineIdSha256: 'a'.repeat(64), hostname: 'test-host' })));
          } else if (frame.header.frameType === FrameType.Request) {
            const request = decodeJson(frame.payload);
            const result = request.operation === 'sez.describe'
              ? { product: 'se-z', protocolVersion: '1.0.0', operations: [] }
              : { status: 'ok', hostname: 'test-host' };
            const signedReceipt = request.operation === 'sez.describe'
              ? receiptV2(request, result, supervisor.privateKey)
              : receiptV1({ requestId: request.requestId, operation: request.operation, subject: 'stealtheye-owner', authorityClass: 'unrestricted-owner', timestamp: new Date().toISOString(), machineIdSha256: 'a'.repeat(64), hostname: 'test-host' }, result, supervisor.privateKey);
            socket.write(encodeFrame(FrameType.Response, encodeJson({ requestId: request.requestId, operation: request.operation, result, receipt: signedReceipt }), request.requestId));
          }
        }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  function client() {
    return new SezClient({
      socketPath,
      gatewayPrivateKeyPath,
      receiptPublicKeyPath,
      expectedSubject: 'stealtheye-owner',
      ownerPrincipalFingerprint: 'b'.repeat(64),
      gatewayId: 'stealtheye-sez-gateway',
      gatewayKeyId: 'gateway-authority-v1',
      receiptKeyId: 'supervisor-receipt-v1',
      targetHost: 'test-host',
      authorityIssuer: 'https://se-z.stealtheye.io',
      authorityResource: 'https://se-z.stealtheye.io/mcp',
      expectedMachineIdSha256: 'a'.repeat(64),
      gatewayUid: process.getuid?.() ?? 0,
      enforceGatewayUid: false,
      maxFrameSize: 16 * 1024 * 1024,
      requestTimeoutMs: 5_000,
    });
  }

  it('verifies legacy Receipt v1 and request-bound Receipt v2 over the direct socket', async () => {
    const direct = client();
    unlinkSync(receiptPublicKeyPath);
    const health = await direct.call('sez.health', {}, '00000000-0000-0000-0000-000000000001');
    assert.equal(health.result.status, 'ok');
    assert.equal(health.evidence.verified, true);
    assert.equal(health.evidence.receiptSchemaVersion, '1.0.0');

    const described = await direct.call('sez.describe', {}, '00000000-0000-0000-0000-000000000002');
    assert.equal(described.result.product, 'se-z');
    assert.equal(described.evidence.verified, true);
    assert.equal(described.evidence.receiptSchemaVersion, '2.0.0');
    assert.match(described.evidence.requestDigest, /^[a-f0-9]{64}$/u);
    assert.match(described.evidence.requestFingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(described.evidence.release.commit, 'd'.repeat(40));
  });
});
