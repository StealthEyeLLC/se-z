#!/usr/bin/env node
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVE_OPERATION_DEFINITIONS, CATALOG_DIGEST } from '../../src/kernel/definitions.mjs';
import { ERROR_DEFINITIONS, STATE_SCHEMA_VERSION, canonicalJson, sha256Hex } from '../../src/kernel/util.mjs';
import { requestDigest, semanticDigest, signDigestHex, makeReceipt, operationResultDigest } from '../../src/kernel/crypto.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const writeJson = async (relative, value) => {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
};

const errors = Object.entries(ERROR_DEFINITIONS).map(([code, definition]) => ({
  code,
  retryable: definition.retryable,
  terminal: definition.terminal,
  requestCorrelatedReceipt: definition.receipt,
  httpLayer: 'irrelevant-local-SEZ1',
  safeDiagnosticDetails: 'bounded structured metadata with managed credential fields omitted; raw command stderr remains operation output',
}));
await writeJson('contracts/operations-0.1a.json', {
  product: 'se-z', releaseMilestone: '0.1A', protocol: 'SEZ1', protocolVersion: '1.0.0',
  catalogDigest: CATALOG_DIGEST, operationCount: ACTIVE_OPERATION_DEFINITIONS.length,
  activeOperations: ACTIVE_OPERATION_DEFINITIONS,
  excludedActiveFamilies: ['sez.github.*', 'sez.machine.*', 'sez.skill.*', 'sez.release.*', 'sez.recovery.*', 'sez.backup.*', 'sez.evidence.*', 'sez.selfhost.*'],
});
await writeJson('contracts/errors-0.1a.json', { product: 'se-z', releaseMilestone: '0.1A', errorCount: errors.length, errors });

// Deterministic test-only seed. It is not accepted by any production configuration and is never packaged.
const seed = Buffer.from('5c1e597ea6df321bf44f4ea938c3929b48b0f978cf2d5da3ca036b65b7e49777', 'hex');
const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const publicKey = crypto.createPublicKey(privateKey);
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const base = {
  protocol: 'SEZ1', protocolVersion: '1.0.0', requestId: '01234567-89ab-4def-8123-456789abcdef',
  operation: 'sez.exec', payload: { argv: ['/usr/bin/printf', '%s', 'hello'], cwd: '/root', target: 'host' },
  idempotencyKey: 'vector-local-001', subject: 'stealtheye-owner', authorityClass: 'unrestricted-owner',
  authorityGeneration: 7, issuedAt: '2026-08-03T12:00:00.000Z', nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX', peerClass: 'local-peer',
};
const gateway = { ...base, requestId: '11234567-89ab-4def-8123-456789abcdef', idempotencyKey: 'vector-gateway-001', nonce: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY', peerClass: 'gateway-signed', gatewayId: 'se-z-gateway', gatewayKeyId: 'gateway-test-v1' };
gateway.signature = signDigestHex(requestDigest(gateway), privateKey);
const vectors = [
  { id: 'local', request: base },
  { id: 'gateway', request: gateway, publicKeyPem },
  { id: 'nested', request: { ...base, requestId: '21234567-89ab-4def-8123-456789abcdef', idempotencyKey: 'vector-nested-001', nonce: 'AgMEBQYHCAkKCwwNDg8QERITFBUWFxgZ', payload: { z: [3, { beta: true, alpha: null }], a: { d: 4, c: 3 } } } },
  { id: 'unicode', request: { ...base, requestId: '31234567-89ab-4def-8123-456789abcdef', idempotencyKey: 'vector-unicode-001', nonce: 'AwQFBgcICQoLDA0ODxAREhMUFRYXGBka', payload: { text: '雪\u2028é𝄞', escaped: '\\"\\n' } } },
  { id: 'binary-base64', request: { ...base, requestId: '41234567-89ab-4def-8123-456789abcdef', idempotencyKey: 'vector-binary-001', nonce: 'BAUGBwgJCgsMDQ4PEBESExQVFhcYGRob', payload: { encoding: 'base64', data: 'AAECf4D//g==' } } },
  { id: 'generation-change', request: { ...base, authorityGeneration: 8 } },
  { id: 'payload-reordered', request: { ...base, payload: { target: 'host', cwd: '/root', argv: ['/usr/bin/printf', '%s', 'hello'] } } },
  { id: 'idempotency-change', request: { ...base, idempotencyKey: 'vector-local-002' } },
  { id: 'peer-class-change', request: { ...base, peerClass: 'gateway-signed', gatewayId: 'se-z-gateway', gatewayKeyId: 'gateway-test-v1' } },
  { id: 'gateway-key-change', request: { ...gateway, gatewayKeyId: 'gateway-test-v2', signature: undefined } },
].map((entry) => {
  const request = Object.fromEntries(Object.entries(entry.request).filter(([, value]) => value !== undefined));
  return { ...entry, request, canonicalSignatureInput: canonicalJson([
    request.protocol, request.protocolVersion, request.requestId, request.operation, request.payload,
    request.idempotencyKey, request.subject, request.authorityClass, request.authorityGeneration,
    request.issuedAt, request.nonce, request.peerClass, request.gatewayId ?? '', request.gatewayKeyId ?? '',
  ]), requestDigest: requestDigest(request), semanticDigest: semanticDigest(request, request.payload.target ?? 'host') };
});
await writeJson('protocol/test-vectors/sez1-request-v1.json', {
  format: 'SEZ1 request test vectors v1', signingAlgorithm: 'Ed25519', digestAlgorithm: 'SHA-256',
  canonicalization: 'UTF-8 canonical JSON with recursively sorted object keys; arrays retain order; finite JSON values only; negative zero becomes zero',
  invariants: {
    payloadReorderingMatchesLocal: vectors.find((v) => v.id === 'payload-reordered').requestDigest === vectors.find((v) => v.id === 'local').requestDigest,
    generationChangeDiffers: vectors.find((v) => v.id === 'generation-change').requestDigest !== vectors.find((v) => v.id === 'local').requestDigest,
    idempotencyChangeDiffers: vectors.find((v) => v.id === 'idempotency-change').requestDigest !== vectors.find((v) => v.id === 'local').requestDigest,
    peerClassChangeDiffers: vectors.find((v) => v.id === 'peer-class-change').requestDigest !== vectors.find((v) => v.id === 'local').requestDigest,
    gatewayKeyChangeDiffers: vectors.find((v) => v.id === 'gateway-key-change').requestDigest !== vectors.find((v) => v.id === 'gateway').requestDigest,
  }, vectors,
});
const responseWithoutDigest = {
  requestId: base.requestId, operation: base.operation, state: 'completed', terminal: true, authorityGeneration: 7,
  catalogDigest: CATALOG_DIGEST, result: { exitCode: 0 }, error: null, jobId: '51234567-89ab-4def-8123-456789abcdef',
  stdout: null, stderr: null,
};
const responseDigest = operationResultDigest(responseWithoutDigest);
await writeJson('protocol/test-vectors/sez1-response-v1.json', {
  format: 'SEZ1 response test vector v1', responseWithoutDigestOrReceipt: responseWithoutDigest, resultDigest: responseDigest,
  canonicalJson: canonicalJson(responseWithoutDigest),
});
const receipt = makeReceipt({
  requestDigest: requestDigest(base), resultDigest: responseDigest, requestId: base.requestId, operation: base.operation,
  subject: base.subject, authorityClass: base.authorityClass, authorityGeneration: base.authorityGeneration,
  catalogDigest: CATALOG_DIGEST, hostIdentity: { hostname: 'vector-host', machineIdSha256: '0'.repeat(64) },
  releaseIdentity: { product: 'se-z', releaseMilestone: '0.1A', sourceCommit: '1'.repeat(40), sourceTree: '2'.repeat(40) },
  acceptedAt: '2026-08-03T12:00:00.000Z', terminalAt: '2026-08-03T12:00:01.000Z', state: 'completed',
  jobId: responseWithoutDigest.jobId, stdoutDigest: '3'.repeat(64), stderrDigest: '4'.repeat(64), artifactDigests: [], receiptKeyId: 'receipt-vector-v1',
}, privateKey);
await writeJson('protocol/test-vectors/sez1-receipt-v1.json', {
  format: 'SEZ1 receipt test vector v1', signingAlgorithm: 'Ed25519', digestAlgorithm: 'SHA-256', publicKeyPem, receipt,
});

const schemaPath = path.join(root, 'contracts/state-schema-0.1a.json');
const stateSchema = JSON.parse(await fsp.readFile(schemaPath, 'utf8'));
if (stateSchema.stateSchemaVersion !== STATE_SCHEMA_VERSION) throw new Error('state schema version mismatch');
console.log(JSON.stringify({ operationCount: ACTIVE_OPERATION_DEFINITIONS.length, errorCount: errors.length, catalogDigest: CATALOG_DIGEST, stateSchemaVersion: STATE_SCHEMA_VERSION }));
