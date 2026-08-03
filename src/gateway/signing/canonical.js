// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = sortKeys(value[key]);
  return result;
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildSigningDocument(input) {
  return canonicalJson({
    protocolVersion: input.protocolVersion,
    requestId: input.requestId,
    operation: input.operation,
    principal: input.principal,
    authority: input.authority,
    targetHost: input.targetHost,
    timestamp: input.timestamp,
    payload: input.payload,
    binaryLength: input.binaryLength,
  });
}

export function semanticRequestFingerprint(input) {
  return sha256Hex(canonicalJson({
    protocolVersion: input.protocolVersion,
    operation: input.operation,
    principal: input.principal,
    targetHost: input.targetHost,
    payload: input.payload,
    binaryLength: input.binaryLength,
  }));
}

function resolvePublicKey(value) {
  if (typeof value !== 'string') return value;
  return createPublicKey(value.startsWith('/') ? readFileSync(value, 'utf8') : value);
}

function baseReceiptInput(receipt) {
  return {
    requestId: receipt.requestId,
    operation: receipt.operation,
    subject: receipt.subject,
    authorityClass: receipt.authorityClass,
    resultDigest: receipt.resultDigest,
    timestamp: receipt.timestamp,
    machineIdSha256: receipt.machineIdSha256,
    hostname: receipt.hostname,
  };
}

function receiptInput(receipt) {
  if (receipt.receiptSchemaVersion === '1.0.0') return baseReceiptInput(receipt);
  if (receipt.receiptSchemaVersion === '2.0.0') {
    return {
      ...baseReceiptInput(receipt),
      requestDigest: receipt.requestDigest,
      requestFingerprint: receipt.requestFingerprint,
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
      release: receipt.release,
    };
  }
  throw new Error('se-z receipt version is unsupported');
}

export function verifyReceipt(receipt, result, expected, publicKey) {
  if (!receipt || typeof receipt !== 'object') throw new Error('se-z receipt is missing');
  if (receipt.protocolVersion !== '1.0.0') throw new Error('se-z receipt protocol version is unsupported');
  const input = receiptInput(receipt);
  if (receipt.requestId !== expected.requestId || receipt.operation !== expected.operation) {
    throw new Error('se-z receipt correlation does not match');
  }
  if (receipt.subject !== expected.subject || receipt.authorityClass !== 'unrestricted-owner') {
    throw new Error('se-z receipt authority does not match');
  }
  if (receipt.hostname !== expected.hostname || receipt.machineIdSha256 !== expected.machineIdSha256) {
    throw new Error('se-z receipt host identity does not match');
  }
  if (receipt.keyId !== expected.receiptKeyId) throw new Error('se-z receipt key identity does not match');
  if (receipt.resultDigest !== sha256Hex(canonicalJson(result))) {
    throw new Error('se-z receipt result digest does not match');
  }
  if (receipt.receiptSchemaVersion === '2.0.0') {
    if (receipt.requestDigest !== expected.requestDigest) {
      throw new Error('se-z receipt request digest does not match');
    }
    if (receipt.requestFingerprint !== expected.requestFingerprint) {
      throw new Error('se-z receipt request fingerprint does not match');
    }
    if (!receipt.release || typeof receipt.release !== 'object') {
      throw new Error('se-z receipt release identity is missing');
    }
  }
  const digest = sha256Hex(canonicalJson(input));
  const signingBody = canonicalJson({ ...input, receiptId: receipt.receiptId, digest });
  const valid = verifySignature(
    null,
    Buffer.from(signingBody, 'utf8'),
    resolvePublicKey(publicKey),
    Buffer.from(String(receipt.signature ?? ''), 'base64'),
  );
  if (!valid) throw new Error('se-z receipt signature is invalid');
  return Object.freeze({
    verified: true,
    receiptId: receipt.receiptId,
    receiptSchemaVersion: receipt.receiptSchemaVersion,
    resultDigest: receipt.resultDigest,
    ...(receipt.receiptSchemaVersion === '2.0.0' ? {
      requestDigest: receipt.requestDigest,
      requestFingerprint: receipt.requestFingerprint,
      release: receipt.release,
    } : {}),
  });
}
