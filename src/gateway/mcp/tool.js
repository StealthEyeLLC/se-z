// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { createHash } from 'node:crypto';
import {
  CANONICAL_SEZ_ACTION_DESCRIPTION,
  describeSez,
} from './catalog.js';
import { SezError } from '../transport/client.js';

export const PUBLIC_TOOL_NAME = 'call_sez';
export const TOOL_DEFINITION = Object.freeze({
  name: PUBLIC_TOOL_NAME,
  title: 'Call se-z',
  description: CANONICAL_SEZ_ACTION_DESCRIPTION,
  annotations: Object.freeze({ idempotentHint: true }),
  _meta: Object.freeze({ securitySchemes: [Object.freeze({ type: 'oauth2', scopes: ['sez.root'] })] }),
  inputSchema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'payload', 'idempotencyKey'],
    properties: Object.freeze({
      operation: Object.freeze({ type: 'string', minLength: 1, maxLength: 256, pattern: '^sez\\.[a-z0-9._-]+$' }),
      payload: Object.freeze({ type: 'object', additionalProperties: true }),
      idempotencyKey: Object.freeze({ type: 'string', minLength: 8, maxLength: 256, pattern: '^[A-Za-z0-9._:-]+$' }),
    }),
  }),
});

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateArguments(value) {
  if (!plainObject(value)) throw new Error('call_sez arguments must be an object');
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((key) => ['operation', 'payload', 'idempotencyKey'].includes(key))) throw new Error('call_sez arguments contain unexpected fields');
  if (typeof value.operation !== 'string' || !/^sez\.[a-z0-9._-]{1,240}$/u.test(value.operation)) throw new Error('call_sez operation is invalid');
  if (!plainObject(value.payload)) throw new Error('call_sez payload must be an object');
  if (typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length < 8 || value.idempotencyKey.length > 256 || !/^[A-Za-z0-9._:-]+$/u.test(value.idempotencyKey)) throw new Error('call_sez idempotencyKey is invalid');
  return Object.freeze({ operation: value.operation, payload: value.payload, idempotencyKey: value.idempotencyKey });
}

function result(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError };
}

function isUnknownDescribeResponse(value) {
  return value?.result?.error?.code === 'unknown_operation';
}

export async function callSez(argumentsValue, client) {
  try {
    const input = validateArguments(argumentsValue);
    const requestId = idempotencyRequestId(input.idempotencyKey);
    const value = await client.call(input.operation, input.payload, requestId);
    if (input.operation === 'sez.describe') {
      if (isUnknownDescribeResponse(value)) {
        return result(describeSez(undefined, {
          requestId: value.requestId,
          receipt: value.receipt,
          evidence: value.evidence,
        }));
      }
      return result(describeSez(value.result, {
        requestId: value.requestId,
        receipt: value.receipt,
        evidence: value.evidence,
      }));
    }
    return result(value);
  } catch (error) {
    if (argumentsValue?.operation === 'sez.describe' && error instanceof SezError && error.code === 'unknown_operation') {
      return result(describeSez());
    }
    const normalized = error instanceof SezError
      ? { code: error.code, message: error.message, retryable: error.retryable, details: error.details }
      : { code: 'invalid_sez_call', message: error instanceof Error ? error.message : 'se-z call failed', retryable: false };
    return result(normalized, true);
  }
}

export function idempotencyRequestId(value) {
  const bytes = createHash('sha256').update(`se-z-gateway\0${value}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
