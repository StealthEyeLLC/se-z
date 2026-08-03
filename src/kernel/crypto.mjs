import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { canonicalBytes, canonicalJson, sha256Hex, SezError } from './util.mjs';

export function requestDigest(request) {
  const bound = [
    request.protocol,
    request.protocolVersion,
    request.requestId,
    request.operation,
    request.payload,
    request.idempotencyKey,
    request.subject,
    request.authorityClass,
    request.authorityGeneration,
    request.issuedAt,
    request.nonce,
    request.peerClass,
    request.gatewayId ?? '',
    request.gatewayKeyId ?? '',
  ];
  return sha256Hex(canonicalBytes(bound));
}

export function semanticDigest(request, resolvedTarget = 'host') {
  return sha256Hex(canonicalBytes({
    subject: request.subject,
    operation: request.operation,
    payload: request.payload,
    target: resolvedTarget,
    authorityGeneration: request.authorityGeneration,
    idempotencyKey: request.idempotencyKey,
  }));
}

export function operationResultDigest(responseWithoutDigestOrReceipt) {
  return sha256Hex(canonicalBytes(responseWithoutDigestOrReceipt));
}

export function catalogDigest(definitions) {
  return sha256Hex(canonicalBytes(definitions));
}

export function signDigestHex(digestHex, privateKey) {
  const signature = crypto.sign(null, Buffer.from(digestHex, 'hex'), privateKey);
  return signature.toString('base64url');
}

export function verifyDigestHex(digestHex, signature, publicKey) {
  try {
    return crypto.verify(null, Buffer.from(digestHex, 'hex'), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

export async function loadPrivateKey(filePath) {
  const pem = await fsp.readFile(filePath, 'utf8');
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new SezError('invalid_request', 'Receipt signing key must be Ed25519');
  return key;
}

export async function loadPublicKey(filePath) {
  const pem = await fsp.readFile(filePath, 'utf8');
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new SezError('invalid_request', 'Verification key must be Ed25519');
  return key;
}

export async function loadPublicKeys(keyDefinitions) {
  const keys = new Map();
  for (const definition of keyDefinitions) {
    if (!definition || typeof definition.id !== 'string' || typeof definition.path !== 'string') {
      throw new SezError('invalid_request', 'Invalid public key definition');
    }
    if (keys.has(definition.id)) throw new SezError('invalid_request', `Duplicate public key ID: ${definition.id}`);
    keys.set(definition.id, await loadPublicKey(definition.path));
  }
  return keys;
}

export function makeReceipt(body, privateKey) {
  const unsigned = { receiptFormatVersion: '1.0.0', ...body };
  const bodyDigest = sha256Hex(canonicalBytes(unsigned));
  const signature = signDigestHex(bodyDigest, privateKey);
  const receiptId = sha256Hex(canonicalBytes({ bodyDigest, signature }));
  return { ...unsigned, receiptId, signature };
}

export function verifyReceipt(receipt, keySet) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { valid: false, code: 'invalid_request', message: 'Receipt must be an object' };
  }
  const key = keySet.get(receipt.receiptKeyId);
  if (!key) return { valid: false, code: 'unknown_key', message: `Unknown receipt key: ${receipt.receiptKeyId}` };
  const { signature, receiptId, ...unsigned } = receipt;
  if (typeof signature !== 'string' || typeof receiptId !== 'string') {
    return { valid: false, code: 'invalid_request', message: 'Receipt signature or ID missing' };
  }
  const bodyDigest = sha256Hex(canonicalBytes(unsigned));
  const expectedId = sha256Hex(canonicalBytes({ bodyDigest, signature }));
  if (expectedId !== receiptId) return { valid: false, code: 'digest_mismatch', message: 'Receipt ID mismatch' };
  if (!verifyDigestHex(bodyDigest, signature, key)) return { valid: false, code: 'invalid_signature', message: 'Receipt signature invalid' };
  return { valid: true, receiptId, bodyDigest, keyId: receipt.receiptKeyId };
}

export function generateEd25519PemPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function canonicalSignatureInput(request) {
  return canonicalJson([
    request.protocol,
    request.protocolVersion,
    request.requestId,
    request.operation,
    request.payload,
    request.idempotencyKey,
    request.subject,
    request.authorityClass,
    request.authorityGeneration,
    request.issuedAt,
    request.nonce,
    request.peerClass,
    request.gatewayId ?? '',
    request.gatewayKeyId ?? '',
  ]);
}
