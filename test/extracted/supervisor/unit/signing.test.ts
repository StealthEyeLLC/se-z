// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/signing.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateEd25519KeyPair,
  signEd25519,
  verifyEd25519,
  loadPublicKey,
  loadPrivateKey,
} from '../../../../src/protocol/signatures/signing.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('signing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-z-sign-'));
  const publicKeyPath = join(dir, 'public.pem');
  const privateKeyPath = join(dir, 'private.pem');

  generateEd25519KeyPair({ publicKeyPath, privateKeyPath, keyId: 'test' });

  it('generates and loads Ed25519 key pair', () => {
    const pub = loadPublicKey(publicKeyPath);
    const priv = loadPrivateKey(privateKeyPath);
    assert.ok(pub);
    assert.ok(priv);
  });

  it('signs and verifies documents', () => {
    const pub = loadPublicKey(publicKeyPath);
    const priv = loadPrivateKey(privateKeyPath);
    const doc = '{"operation":"sez.health"}';
    const sig = signEd25519(doc, priv);
    assert.ok(verifyEd25519(doc, sig, pub));
    assert.ok(!verifyEd25519(doc + 'x', sig, pub));
  });

  it('cleans up', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
