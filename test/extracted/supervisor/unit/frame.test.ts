// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/frame.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFrame,
  decodeHeader,
  feedFrames,
  createFrameReader,
  FrameType,
  encodeJsonPayload,
  ProtocolError,
} from '../../../../src/protocol/framing/frame.js';

describe('frame protocol', () => {
  it('encodes and decodes frame headers', () => {
    const payload = Buffer.from('{"test":true}');
    const frame = encodeFrame(FrameType.Request, payload, '00000000-0000-0000-0000-000000000042');
    const header = decodeHeader(frame);
    assert.equal(header.magic, 'SEZ1');
    assert.equal(header.frameType, FrameType.Request);
    assert.equal(header.requestId, '00000000-0000-0000-0000-000000000042');
    assert.equal(header.payloadLength, payload.length);
  });

  it('feeds partial frames across chunks', () => {
    const reader = createFrameReader();
    const payload = encodeJsonPayload({ hello: 'world' });
    const frame = encodeFrame(FrameType.Hello, payload);

    const mid = Math.floor(frame.length / 2);
    const frames1 = feedFrames(reader, frame.subarray(0, mid), 1024 * 1024);
    assert.equal(frames1.length, 0);

    const frames2 = feedFrames(reader, frame.subarray(mid), 1024 * 1024);
    assert.equal(frames2.length, 1);
    assert.equal(frames2[0].header.frameType, FrameType.Hello);
  });

  it('rejects oversized frames', () => {
    const reader = createFrameReader();
    const bigPayload = Buffer.alloc(100);
    const frame = encodeFrame(FrameType.Request, bigPayload);
    assert.throws(
      () => feedFrames(reader, frame, 50),
      (err: Error) => err instanceof ProtocolError && err.code === 'frame_too_large',
    );
  });

  it('rejects invalid magic', () => {
    const buf = Buffer.alloc(32);
    buf.write('BAD!', 0);
    assert.throws(
      () => decodeHeader(buf),
      (err: Error) => err instanceof ProtocolError && err.code === 'invalid_magic',
    );
  });
});
