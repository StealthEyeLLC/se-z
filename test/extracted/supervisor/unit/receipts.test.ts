// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/receipts.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../../../../src/protocol/canonical/canonical.js';
import { signEd25519 } from '../../../../src/protocol/signatures/signing.js';
import {
  buildReceiptDigest,
  signReceipt,
  type ReceiptInputV1,
  type ReceiptInputV2,
  type SignedReceiptV1,
  type SignedReceiptV2,
} from '../../../../src/protocol/receipts/receipt.js';
import { verifyReceipt } from '../../../../src/protocol/receipts/verify.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

function inputV2(): ReceiptInputV2 {
  return {
    requestId: '00000000-0000-4000-8000-000000000001',
    operation: 'sez.file.replace',
    subject: 'stealtheye-owner',
    authorityClass: 'unrestricted-owner',
    requestDigest: '1'.repeat(64),
    requestFingerprint: '2'.repeat(64),
    resultDigest: '3'.repeat(64),
    timestamp: '2026-07-21T13:00:01.000Z',
    startedAt: '2026-07-21T13:00:00.000Z',
    completedAt: '2026-07-21T13:00:01.000Z',
    machineIdSha256: '4'.repeat(64),
    hostname: 'vps-c9f04f5e',
    release: {
      status: 'installed',
      manifestPath: '/opt/se-z/current/manifest.json',
      manifestSha256: '5'.repeat(64),
      version: '0.2.0',
      commit: '6'.repeat(40),
      tree: '7'.repeat(40),
      sourceDateEpoch: 1784638800,
    },
  };
}

function signLegacyV1(input: ReceiptInputV1): SignedReceiptV1 {
  const receiptId = sha256Hex(`${input.requestId}:${input.operation}:${input.timestamp}`).slice(0, 32);
  const digest = buildReceiptDigest(input);
  const signature = signEd25519(
    canonicalJson({ ...input, receiptId, digest }),
    privateKey,
  );
  return {
    receiptSchemaVersion: '1.0.0',
    protocolVersion: '1.0.0',
    receiptId,
    ...input,
    signature,
    keyId: 'legacy-key',
  };
}

describe('receipt verification', () => {
  it('signs and verifies receipt schema v2', () => {
    const receipt = signReceipt(inputV2(), privateKey, 'receipt-key-v2');
    assert.equal(receipt.receiptSchemaVersion, '2.0.0');
    assert.equal(verifyReceipt(receipt, publicKey), true);
  });

  it('binds exact request, result, timing, and release identity', () => {
    const receipt = signReceipt(inputV2(), privateKey, 'receipt-key-v2');
    const mutations: Array<(copy: SignedReceiptV2) => void> = [
      (copy) => { copy.requestDigest = 'a'.repeat(64); },
      (copy) => { copy.requestFingerprint = 'b'.repeat(64); },
      (copy) => { copy.resultDigest = 'c'.repeat(64); },
      (copy) => { copy.startedAt = '2026-07-21T12:59:59.000Z'; },
      (copy) => { copy.release = { ...copy.release, commit: 'd'.repeat(40) }; },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(receipt);
      mutate(copy);
      assert.equal(verifyReceipt(copy, publicKey), false);
    }
  });

  it('continues verifying correctly signed legacy v1 receipts', () => {
    const input: ReceiptInputV1 = {
      requestId: '00000000-0000-4000-8000-000000000002',
      operation: 'sez.health',
      subject: 'stealtheye-owner',
      authorityClass: 'unrestricted-owner',
      resultDigest: '8'.repeat(64),
      timestamp: '2026-07-21T13:00:00.000Z',
      machineIdSha256: '9'.repeat(64),
      hostname: 'vps-c9f04f5e',
    };
    const receipt = signLegacyV1(input);
    assert.equal(verifyReceipt(receipt, publicKey), true);
    receipt.resultDigest = '0'.repeat(64);
    assert.equal(verifyReceipt(receipt, publicKey), false);
  });

  it('rejects unsupported receipt schema versions', () => {
    const receipt = signReceipt(inputV2(), privateKey, 'receipt-key-v2') as SignedReceiptV2 & {
      receiptSchemaVersion: string;
    };
    receipt.receiptSchemaVersion = '99.0.0';
    assert.equal(verifyReceipt(receipt as never, publicKey), false);
  });
});
