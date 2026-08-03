// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Receipt verification for schema v1 and v2. */

import { verifyEd25519 } from '../signatures/signing.js';
import type { KeyObject } from 'node:crypto';
import { canonicalJson } from '../canonical/canonical.js';
import {
  buildReceiptDigest,
  type ReceiptInputV1,
  type ReceiptInputV2,
  type SignedReceipt,
} from './receipt.js';

function verifyInput(
  input: ReceiptInputV1 | ReceiptInputV2,
  receipt: SignedReceipt,
  publicKey: KeyObject,
): boolean {
  const digest = buildReceiptDigest(input);
  const signingBody = canonicalJson({ ...input, receiptId: receipt.receiptId, digest });
  return verifyEd25519(signingBody, receipt.signature, publicKey);
}

export function verifyReceipt(receipt: SignedReceipt, publicKey: KeyObject): boolean {
  if (receipt.receiptSchemaVersion === '1.0.0') {
    const input: ReceiptInputV1 = {
      requestId: receipt.requestId,
      operation: receipt.operation,
      subject: receipt.subject,
      authorityClass: receipt.authorityClass,
      resultDigest: receipt.resultDigest,
      timestamp: receipt.timestamp,
      machineIdSha256: receipt.machineIdSha256,
      hostname: receipt.hostname,
    };
    return verifyInput(input, receipt, publicKey);
  }

  if (receipt.receiptSchemaVersion === '2.0.0') {
    const input: ReceiptInputV2 = {
      requestId: receipt.requestId,
      operation: receipt.operation,
      subject: receipt.subject,
      authorityClass: receipt.authorityClass,
      requestDigest: receipt.requestDigest,
      requestFingerprint: receipt.requestFingerprint,
      resultDigest: receipt.resultDigest,
      timestamp: receipt.timestamp,
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
      machineIdSha256: receipt.machineIdSha256,
      hostname: receipt.hostname,
      release: receipt.release,
    };
    return verifyInput(input, receipt, publicKey);
  }

  return false;
}
