// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Canonical JSON encoding and signing document construction. */

import { createHash, timingSafeEqual } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

export interface SigningDocumentInput {
  protocolVersion: string;
  requestId: string;
  operation: string;
  principal: Record<string, unknown>;
  authority: Record<string, unknown>;
  targetHost: string;
  timestamp: string;
  payload: unknown;
  binaryLength: number;
}

export interface SemanticRequestInput {
  protocolVersion: string;
  operation: string;
  principal: Record<string, unknown>;
  targetHost: string;
  payload: unknown;
  binaryLength: number;
}

export function buildSigningDocument(input: SigningDocumentInput): string {
  const doc = {
    protocolVersion: input.protocolVersion,
    requestId: input.requestId,
    operation: input.operation,
    principal: input.principal,
    authority: input.authority,
    targetHost: input.targetHost,
    timestamp: input.timestamp,
    payload: input.payload,
    binaryLength: input.binaryLength,
  };
  return canonicalJson(doc);
}

/**
 * Stable fingerprint for logical idempotency. It intentionally excludes the
 * request ID, timestamp, nonce, signature, and gateway key rotation metadata.
 */
export function semanticRequestFingerprint(input: SemanticRequestInput): string {
  return sha256Hex(
    canonicalJson({
      protocolVersion: input.protocolVersion,
      operation: input.operation,
      principal: input.principal,
      targetHost: input.targetHost,
      payload: input.payload,
      binaryLength: input.binaryLength,
    }),
  );
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Buffer(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function requestHash(signingDocument: string): string {
  return sha256Hex(signingDocument);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[depth_exceeded]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.includes('PRIVATE KEY') || value.includes('BEGIN RSA PRIVATE KEY')) {
      return '[REDACTED]';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|password|private|credential|signature|secretReference/i.test(k)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = redactSecrets(v, depth + 1);
      }
    }
    return result;
  }
  return value;
}
