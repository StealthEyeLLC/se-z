// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { randomUUID } from 'node:crypto';

export const FRAME_MAGIC = Buffer.from('SEZ1', 'ascii');
export const HEADER_SIZE = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const FrameType = Object.freeze({
  Hello: 1,
  Welcome: 2,
  Request: 3,
  Response: 4,
  Error: 5,
  Event: 6,
  Cancel: 7,
  Ping: 8,
  Pong: 9,
});

export function encodeFrame(frameType, payload, requestId = randomUUID(), flags = 0, protocolVersion = 1) {
  const header = Buffer.alloc(HEADER_SIZE);
  FRAME_MAGIC.copy(header, 0);
  header.writeUInt16BE(protocolVersion, 4);
  header.writeUInt16BE(frameType, 6);
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) throw new Error('requestId must be a canonical UUID');
  const id = Buffer.from(requestId.replaceAll('-', ''), 'hex');
  id.copy(header, 8);
  header.writeUInt32BE(payload.length, 24);
  header.writeUInt32BE(flags, 28);
  return Buffer.concat([header, payload]);
}

export function createFrameReader() {
  return { buffer: Buffer.alloc(0) };
}

function uuid(bytes) {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function feedFrames(reader, chunk, maxFrameSize) {
  reader.buffer = Buffer.concat([reader.buffer, chunk]);
  const frames = [];
  while (reader.buffer.length >= HEADER_SIZE) {
    if (!reader.buffer.subarray(0, 4).equals(FRAME_MAGIC)) throw new Error('invalid SEZ1 frame magic');
    const protocolVersion = reader.buffer.readUInt16BE(4);
    if (protocolVersion !== 1) throw new Error('unsupported SEZ1 frame version');
    const frameType = reader.buffer.readUInt16BE(6);
    const payloadLength = reader.buffer.readUInt32BE(24);
    if (payloadLength > maxFrameSize) throw new Error('SEZ1 frame exceeds maximum size');
    const total = HEADER_SIZE + payloadLength;
    if (reader.buffer.length < total) break;
    frames.push({
      header: {
        protocolVersion,
        frameType,
        requestId: uuid(reader.buffer.subarray(8, 24)),
        payloadLength,
        flags: reader.buffer.readUInt32BE(28),
      },
      payload: Buffer.from(reader.buffer.subarray(HEADER_SIZE, total)),
    });
    reader.buffer = reader.buffer.subarray(total);
  }
  return frames;
}

export function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

export function decodeJson(buffer) {
  return JSON.parse(buffer.toString('utf8'));
}
