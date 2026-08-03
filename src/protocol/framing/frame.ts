// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** SEZ1 binary wire protocol framing. */

import { randomUUID } from 'node:crypto';

export const FRAME_MAGIC_BYTES = Buffer.from('SEZ1', 'ascii');
export const HEADER_SIZE = 32;

export enum FrameType {
  Hello = 1,
  Welcome = 2,
  Request = 3,
  Response = 4,
  Error = 5,
  Event = 6,
  Cancel = 7,
  Ping = 8,
  Pong = 9,
}

export interface FrameHeader {
  magic: string;
  protocolVersion: number;
  frameType: FrameType;
  requestId: string;
  payloadLength: number;
  flags: number;
}

export interface DecodedFrame {
  header: FrameHeader;
  payload: Buffer;
}

export class ProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function encodeFrame(
  frameType: FrameType,
  payload: Buffer,
  requestId?: string,
  flags = 0,
  protocolVersion = 1,
): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  FRAME_MAGIC_BYTES.copy(header, 0);
  header.writeUInt16BE(protocolVersion, 4);
  header.writeUInt16BE(frameType, 6);
  const id = requestId ?? randomUUID();
  const idBuf = Buffer.from(id.replace(/-/g, ''), 'hex');
  if (idBuf.length === 16) {
    idBuf.copy(header, 8);
  }
  header.writeUInt32BE(payload.length, 24);
  header.writeUInt32BE(flags, 28);
  return Buffer.concat([header, payload]);
}

export function decodeHeader(buf: Buffer): FrameHeader {
  if (buf.length < HEADER_SIZE) {
    throw new ProtocolError('truncated_frame', 'Frame header truncated', false);
  }
  const magic = buf.subarray(0, 4).toString('ascii');
  if (magic !== 'SEZ1') {
    throw new ProtocolError('invalid_magic', 'Invalid frame magic', false);
  }
  const protocolVersion = buf.readUInt16BE(4);
  const frameType = buf.readUInt16BE(6) as FrameType;
  const requestId = formatUuid(buf.subarray(8, 24));
  const payloadLength = buf.readUInt32BE(24);
  const flags = buf.readUInt32BE(28);
  return { magic, protocolVersion, frameType, requestId, payloadLength, flags };
}

function formatUuid(buf: Buffer): string {
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface FrameReaderState {
  buffer: Buffer;
}

export function createFrameReader(): FrameReaderState {
  return { buffer: Buffer.alloc(0) };
}

export function feedFrames(
  state: FrameReaderState,
  chunk: Buffer,
  maxFrameSize: number,
): DecodedFrame[] {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  const frames: DecodedFrame[] = [];

  while (state.buffer.length >= HEADER_SIZE) {
    const header = decodeHeader(state.buffer);
    const totalSize = HEADER_SIZE + header.payloadLength;
    if (header.payloadLength > maxFrameSize) {
      throw new ProtocolError('frame_too_large', 'Frame payload exceeds maximum size', false);
    }
    if (state.buffer.length < totalSize) {
      break;
    }
    const payload = state.buffer.subarray(HEADER_SIZE, totalSize);
    state.buffer = state.buffer.subarray(totalSize);
    frames.push({ header, payload });
  }

  return frames;
}

export interface HelloPayload {
  clientId: string;
  supportedFeatures: string[];
  supportedAlgorithms: string[];
}

export interface WelcomePayload {
  serverId: string;
  protocolVersion: string;
  selectedFeatures: string[];
  selectedAlgorithm: string;
  machineIdSha256: string;
  hostname: string;
}

export interface RequestPayload {
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

export interface ResponsePayload {
  requestId: string;
  operation: string;
  result: unknown;
  receipt?: Record<string, unknown>;
}

export interface ErrorPayload {
  requestId: string;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export function encodeJsonPayload<T>(obj: T): Buffer {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

export function decodeJsonPayload<T>(buf: Buffer): T {
  return JSON.parse(buf.toString('utf8')) as T;
}
