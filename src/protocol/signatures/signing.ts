// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Ed25519 and HMAC-SHA256 signature verification and signing. */

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export type SignatureAlgorithm = 'ed25519' | 'hmac-sha256';

export interface KeyPairPaths {
  publicKeyPath: string;
  privateKeyPath: string;
  keyId: string;
}

export function generateEd25519KeyPair(paths: KeyPairPaths): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  mkdirSync(dirname(paths.publicKeyPath), { recursive: true, mode: 0o750 });
  mkdirSync(dirname(paths.privateKeyPath), { recursive: true, mode: 0o700 });
  writeFileSync(paths.publicKeyPath, publicKey, { mode: 0o644 });
  writeFileSync(paths.privateKeyPath, privateKey, { mode: 0o600 });
  chmodSync(paths.publicKeyPath, 0o644);
  chmodSync(paths.privateKeyPath, 0o600);
}

export function loadPublicKey(path: string): KeyObject {
  return createPublicKey(readFileSync(path, 'utf8'));
}

export function loadPrivateKey(path: string): KeyObject {
  return createPrivateKey(readFileSync(path, 'utf8'));
}

export function signEd25519(document: string, privateKey: KeyObject): string {
  const sig = sign(null, Buffer.from(document, 'utf8'), privateKey);
  return sig.toString('base64');
}

export function verifyEd25519(
  document: string,
  signatureB64: string,
  publicKey: KeyObject,
): boolean {
  try {
    const sig = Buffer.from(signatureB64, 'base64');
    return verify(null, Buffer.from(document, 'utf8'), publicKey, sig);
  } catch {
    return false;
  }
}

export function signHmacSha256(document: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(document).digest('base64');
}

export function verifyHmacSha256(
  document: string,
  signatureB64: string,
  secret: Buffer,
): boolean {
  try {
    const expected = createHmac('sha256', secret).update(document).digest();
    const actual = Buffer.from(signatureB64, 'base64');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export interface AuthorityEnvelope {
  algorithm: SignatureAlgorithm;
  gatewayId: string;
  nonce: string;
  signature: string;
  keyId?: string;
}

export interface VerifyAuthorityOptions {
  document: string;
  authority: AuthorityEnvelope;
  expectedGatewayId: string;
  publicKey?: KeyObject;
  previousPublicKey?: KeyObject;
  hmacSecret?: Buffer;
}

export function verifyAuthority(options: VerifyAuthorityOptions): boolean {
  const { document, authority, expectedGatewayId, publicKey, previousPublicKey, hmacSecret } =
    options;

  if (authority.gatewayId !== expectedGatewayId) {
    return false;
  }

  if (authority.algorithm === 'ed25519') {
    if (publicKey && verifyEd25519(document, authority.signature, publicKey)) {
      return true;
    }
    if (previousPublicKey && verifyEd25519(document, authority.signature, previousPublicKey)) {
      return true;
    }
    return false;
  }

  if (authority.algorithm === 'hmac-sha256' && hmacSecret) {
    return verifyHmacSha256(document, authority.signature, hmacSecret);
  }

  return false;
}
