import { TextDecoder } from 'node:util';
import {
  PROTOCOL,
  PROTOCOL_VERSION,
  SUBJECT,
  AUTHORITY_CLASS,
  MAX_FRAME_SIZE,
  SezError,
  assertExactKeys,
  isUuid,
} from './util.mjs';
import { requestDigest } from './crypto.mjs';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export class FrameDecoder {
  constructor(maxFrameSize = MAX_FRAME_SIZE) {
    this.maxFrameSize = maxFrameSize;
    this.header = Buffer.allocUnsafe(4);
    this.headerOffset = 0;
    this.payload = undefined;
    this.payloadOffset = 0;
    this.expectedLength = 0;
  }

  feed(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    const frames = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.payload === undefined) {
        const need = 4 - this.headerOffset;
        const take = Math.min(need, chunk.length - offset);
        chunk.copy(this.header, this.headerOffset, offset, offset + take);
        this.headerOffset += take;
        offset += take;
        if (this.headerOffset < 4) continue;
        const length = this.header.readUInt32BE(0);
        this.headerOffset = 0;
        if (length === 0) throw new SezError('invalid_frame', 'Zero-length SEZ1 frame is not defined', undefined, { receipt: false });
        if (length > this.maxFrameSize) throw new SezError('frame_too_large', `SEZ1 frame exceeds ${this.maxFrameSize} bytes`, { length, maximum: this.maxFrameSize }, { receipt: false });
        this.expectedLength = length;
        this.payload = Buffer.allocUnsafe(length);
        this.payloadOffset = 0;
      }
      const need = this.expectedLength - this.payloadOffset;
      const take = Math.min(need, chunk.length - offset);
      chunk.copy(this.payload, this.payloadOffset, offset, offset + take);
      this.payloadOffset += take;
      offset += take;
      if (this.payloadOffset === this.expectedLength) {
        frames.push(this.payload);
        this.payload = undefined;
        this.payloadOffset = 0;
        this.expectedLength = 0;
      }
    }
    return frames;
  }

  finish() {
    if (this.headerOffset !== 0 || this.payload !== undefined) {
      throw new SezError('invalid_frame', 'Connection ended with a truncated SEZ1 frame', {
        headerBytes: this.headerOffset,
        expectedPayloadBytes: this.expectedLength,
        payloadBytes: this.payloadOffset,
      }, { receipt: false });
    }
  }
}

export function encodeFrame(value, maxFrameSize = MAX_FRAME_SIZE) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length === 0) throw new SezError('invalid_frame', 'Zero-length frame is not defined', undefined, { receipt: false });
  if (payload.length > maxFrameSize) throw new SezError('frame_too_large', 'Encoded frame exceeds maximum', { length: payload.length, maximum: maxFrameSize }, { receipt: false });
  const output = Buffer.allocUnsafe(payload.length + 4);
  output.writeUInt32BE(payload.length, 0);
  payload.copy(output, 4);
  return output;
}

export function decodeFrameJson(payload) {
  let text;
  try {
    text = utf8Decoder.decode(payload);
  } catch {
    throw new SezError('invalid_utf8', 'SEZ1 frame payload is not valid UTF-8', undefined, { receipt: false });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SezError('invalid_json', 'SEZ1 frame payload is not valid JSON', { cause: error.message }, { receipt: false });
  }
}

export function validateHello(value, expectedPeerClass) {
  assertExactKeys(value, ['type', 'protocol', 'protocolVersion', 'clientId', 'peerClass'], [], 'hello');
  if (value.type !== 'hello') throw new SezError('handshake_required', 'Expected SEZ1 hello', undefined, { receipt: false });
  if (value.protocol !== PROTOCOL) throw new SezError('unsupported_protocol', 'Unsupported protocol', undefined, { receipt: false });
  if (value.protocolVersion !== PROTOCOL_VERSION) throw new SezError('unsupported_version', 'Unsupported protocol version', undefined, { receipt: false });
  if (typeof value.clientId !== 'string' || value.clientId.length < 1 || value.clientId.length > 128) throw new SezError('invalid_request', 'Invalid hello clientId', undefined, { receipt: false });
  if (value.peerClass !== expectedPeerClass) throw new SezError('peer_class_mismatch', 'Hello peer class does not match receiving socket', undefined, { receipt: false });
  return value;
}

const REQUEST_REQUIRED = [
  'protocol', 'protocolVersion', 'requestId', 'operation', 'payload', 'idempotencyKey',
  'subject', 'authorityClass', 'authorityGeneration', 'issuedAt', 'nonce', 'peerClass',
];
const REQUEST_OPTIONAL = ['gatewayId', 'gatewayKeyId', 'signature'];

export function validateRequest(value, activeOperations) {
  assertExactKeys(value, REQUEST_REQUIRED, REQUEST_OPTIONAL, 'request');
  if (value.protocol !== PROTOCOL) throw new SezError('unsupported_protocol', 'Unsupported protocol');
  if (value.protocolVersion !== PROTOCOL_VERSION) throw new SezError('unsupported_version', 'Unsupported protocol version');
  if (!isUuid(value.requestId)) throw new SezError('invalid_request', 'requestId must be a UUID');
  if (typeof value.operation !== 'string' || !/^sez\.[a-z0-9._-]+$/.test(value.operation)) throw new SezError('invalid_request', 'operation is not a valid sez.* name');
  if (!activeOperations.has(value.operation)) throw new SezError('unknown_operation', `Unknown active operation: ${value.operation}`, { operation: value.operation });
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) throw new SezError('invalid_request', 'payload must be an object');
  if (typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length < 1 || value.idempotencyKey.length > 256) throw new SezError('invalid_request', 'idempotencyKey must be nonempty and at most 256 characters');
  if (value.subject !== SUBJECT) throw new SezError('unauthorized_peer', 'Unknown request subject');
  if (value.authorityClass !== AUTHORITY_CLASS) throw new SezError('unauthorized_peer', 'Unknown authority class');
  if (!Number.isSafeInteger(value.authorityGeneration) || value.authorityGeneration < 1) throw new SezError('invalid_request', 'authorityGeneration must be a positive integer');
  const issued = Date.parse(value.issuedAt);
  if (typeof value.issuedAt !== 'string' || !Number.isFinite(issued) || !/^\d{4}-\d{2}-\d{2}T/.test(value.issuedAt)) throw new SezError('invalid_request', 'issuedAt must be RFC 3339');
  if (typeof value.nonce !== 'string' || value.nonce.length < 22 || value.nonce.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value.nonce)) throw new SezError('invalid_request', 'nonce must be high-entropy base64url');
  if (!['local-peer', 'gateway-signed'].includes(value.peerClass)) throw new SezError('invalid_request', 'Invalid peerClass');
  if (value.peerClass === 'gateway-signed') {
    for (const field of ['gatewayId', 'gatewayKeyId', 'signature']) {
      if (typeof value[field] !== 'string' || value[field].length < 1 || value[field].length > 4096) throw new SezError('invalid_request', `${field} is required for gateway-signed requests`);
    }
  } else {
    for (const field of REQUEST_OPTIONAL) {
      if (Object.hasOwn(value, field)) throw new SezError('invalid_request', `${field} is forbidden for local-peer requests`);
    }
  }
  requestDigest(value);
  return value;
}

export function makeTransportError(error) {
  return {
    type: 'transport-error',
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    code: error.code ?? 'invalid_frame',
    retryable: Boolean(error.retryable),
    message: error.message ?? 'Transport error',
  };
}

export function makeWelcome({ serverId, authorityGeneration, catalogDigest, hostIdentity, releaseIdentity, maximumFrameSize }) {
  return {
    type: 'welcome',
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    serverId,
    authorityGeneration,
    catalogDigest,
    hostIdentity,
    releaseIdentity,
    signingAlgorithm: 'Ed25519',
    maximumFrameSize,
  };
}

export function makeHelloAccepted(peerClass) {
  return {
    type: 'hello-accepted',
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    peerClass,
  };
}
