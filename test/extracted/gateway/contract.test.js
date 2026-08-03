// Derived test fixture: StealthEyeLLC/baby-quirt-mcp@0bfcd99757afe198151e96b18771626388914205:test/contract.test.js; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SEZ_CAPABILITIES,
  CANONICAL_SEZ_ACTION_DESCRIPTION,
  LEGACY_SEZ_CAPABILITIES,
  describeSez,
} from '../../../src/gateway/mcp/catalog.js';
import { canonicalJson, semanticRequestFingerprint } from '../../../src/gateway/signing/canonical.js';
import { createFrameReader, decodeJson, encodeFrame, encodeJson, feedFrames, FrameType } from '../../../src/gateway/transport/protocol.js';
import { handleRpc } from '../../../src/gateway/mcp/server.js';
import { idempotencyRequestId, PUBLIC_TOOL_NAME, TOOL_DEFINITION, validateArguments } from '../../../src/gateway/mcp/tool.js';

const config = { version: 'test' };

function runtimeDescription() {
  return {
    product: 'se-z',
    protocolVersion: '1.0.0',
    contractVersion: '1.2.0',
    release: { version: '0.2.0', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    operations: SEZ_CAPABILITIES,
  };
}

describe('se-z gateway contract', () => {
  it('publishes exactly one public tool with canonical stable wording', async () => {
    assert.equal(PUBLIC_TOOL_NAME, 'call_sez');
    const listed = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { config, client: {} });
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['call_sez']);
    assert.equal(TOOL_DEFINITION.name, 'call_sez');
    assert.equal(TOOL_DEFINITION.description, CANONICAL_SEZ_ACTION_DESCRIPTION);
    assert.equal(
      TOOL_DEFINITION.description,
      'Run one authorized se-z operation through the single authenticated se-z interface and return its durable result with verified signed evidence.',
    );
    assert.deepEqual(TOOL_DEFINITION.annotations, { idempotentHint: true });
    assert.deepEqual(TOOL_DEFINITION._meta.securitySchemes[0].scopes, ['sez.root']);
    assert.deepEqual(TOOL_DEFINITION.inputSchema.required, ['operation', 'payload', 'idempotencyKey']);
  });

  it('defines 42 unique source operations and 26 explicit legacy fallback operations', () => {
    assert.equal(SEZ_CAPABILITIES.length, 42);
    assert.equal(new Set(SEZ_CAPABILITIES.map((item) => item.operation)).size, 42);
    assert.equal(SEZ_CAPABILITIES.filter((item) => item.operation.startsWith('sez.release.')).length, 8);
    assert.equal(SEZ_CAPABILITIES.filter((item) => item.operation.startsWith('sez.selfhost.')).length, 3);
    assert.equal(LEGACY_SEZ_CAPABILITIES.length, 26);
    assert.equal(describeSez().skills.available, false);
    assert.equal(describeSez().discoverySource, 'gateway_legacy_fallback');
  });

  it('accepts only se-z nested operations', () => {
    assert.deepEqual(validateArguments({ operation: 'sez.health', payload: {}, idempotencyKey: 'health-001' }), { operation: 'sez.health', payload: {}, idempotencyKey: 'health-001' });
    assert.deepEqual(validateArguments({ operation: 'sez.exec', payload: {}, idempotencyKey: 'health-001' }), { operation: 'sez.exec', payload: {}, idempotencyKey: 'health-001' });
    assert.throws(() => validateArguments({ operation: 'baby.exec', payload: {}, idempotencyKey: 'health-001' }), /operation is invalid/u);
  });

  it('derives stable collision-resistant request UUIDs from idempotency keys', () => {
    const first = idempotencyRequestId('same-prefix-aaaaaaaa');
    assert.equal(first, idempotencyRequestId('same-prefix-aaaaaaaa'));
    assert.notEqual(first, idempotencyRequestId('same-prefix-bbbbbbbb'));
    assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  });

  it('canonicalizes and fingerprints logical requests deterministically', () => {
    assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
    const input = {
      protocolVersion: '1.0.0',
      operation: 'sez.health',
      principal: { subject: 'stealtheye-owner' },
      targetHost: 'test-host',
      payload: {},
      binaryLength: 0,
    };
    assert.equal(semanticRequestFingerprint(input), semanticRequestFingerprint({ ...input }));
    assert.notEqual(semanticRequestFingerprint(input), semanticRequestFingerprint({ ...input, payload: { changed: true } }));
  });

  it('rejects malformed request IDs before encoding a frame', () => {
    assert.throws(() => encodeFrame(FrameType.Request, encodeJson({ ok: true }), '00000000000000000000000000000001'), /canonical UUID/u);
    assert.throws(() => encodeFrame(FrameType.Request, encodeJson({ ok: true }), 'not-a-uuid'), /canonical UUID/u);
  });

  it('decodes SEZ1 frames fragmented at arbitrary boundaries', () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const frame = encodeFrame(FrameType.Request, encodeJson({ ok: true }), id);
    const reader = createFrameReader();
    assert.deepEqual(feedFrames(reader, frame.subarray(0, 9), 1024), []);
    const values = feedFrames(reader, frame.subarray(9), 1024);
    assert.equal(values[0].header.requestId, id);
    assert.deepEqual(decodeJson(values[0].payload), { ok: true });
  });

  it('serves signed runtime sez.describe through call_sez', async () => {
    let called = 0;
    const value = await handleRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'call_sez', arguments: { operation: 'sez.describe', payload: {}, idempotencyKey: 'describe-001' } } },
      { config, client: { call: async (operation, payload, requestId) => {
        called += 1;
        assert.equal(operation, 'sez.describe');
        assert.deepEqual(payload, {});
        assert.equal(requestId, idempotencyRequestId('describe-001'));
        return { requestId, operation, result: runtimeDescription(), receipt: { receiptId: 'runtime' }, evidence: { verified: true } };
      } } },
    );
    assert.equal(called, 1);
    assert.equal(value.result.structuredContent.publicTool, 'call_sez');
    assert.equal(value.result.structuredContent.capabilities.length, 42);
    assert.equal(value.result.structuredContent.discoverySource, 'signed_runtime');
    assert.equal(value.result.structuredContent.connection.evidence.verified, true);
  });

  it('uses an explicit 26-operation fallback only for legacy runtime unknown-operation evidence', async () => {
    const value = await handleRpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'call_sez', arguments: { operation: 'sez.describe', payload: {}, idempotencyKey: 'describe-legacy-001' } } },
      { config, client: { call: async (operation, _payload, requestId) => ({
        requestId,
        operation,
        result: { error: { code: 'unknown_operation', message: 'Unknown operation: sez.describe' } },
        receipt: { receiptId: 'legacy-probe' },
        evidence: { verified: true },
      }) } },
    );
    assert.equal(value.result.structuredContent.capabilities.length, 26);
    assert.equal(value.result.structuredContent.discoverySource, 'gateway_legacy_fallback');
    assert.match(value.result.structuredContent.warning, /does not expose sez\.describe/u);
    assert.equal(value.result.structuredContent.connection.evidence.verified, true);
  });
});
