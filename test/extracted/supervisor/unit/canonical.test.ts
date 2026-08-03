// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/canonical.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, buildSigningDocument, sha256Hex, requestHash } from '../../../../src/protocol/canonical/canonical.js';

describe('canonical', () => {
  it('sorts object keys recursively', () => {
    const result = canonicalJson({ z: 1, a: { c: 2, b: 3 } });
    assert.equal(result, '{"a":{"b":3,"c":2},"z":1}');
  });

  it('builds deterministic signing documents', () => {
    const doc = buildSigningDocument({
      protocolVersion: '1.0.0',
      requestId: '00000000-0000-0000-0000-000000000001',
      operation: 'sez.health',
      principal: { subject: 'stealtheye-owner', authorityClass: 'unrestricted-owner' },
      authority: { algorithm: 'ed25519', gatewayId: 'test', nonce: 'abc' },
      targetHost: 'testhost',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {},
      binaryLength: 0,
    });
    assert.ok(doc.includes('sez.health'));
    assert.ok(doc.includes('stealtheye-owner'));
  });

  it('computes sha256 hex', () => {
    assert.equal(sha256Hex('hello'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('computes request hash', () => {
    const doc = '{"test":true}';
    const hash = requestHash(doc);
    assert.equal(hash.length, 64);
  });
});
