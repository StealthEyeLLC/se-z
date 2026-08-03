// New se-z Phase 1 differential parity test. It uses fake supervisor clients only.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { identityNormalize, sourceGateway, target } from '../helpers/index.js';

let sourceTool: any;
let targetTool: any;
before(async () => {
  sourceTool = await sourceGateway('src/tool.js');
  targetTool = await target('src/gateway/mcp/tool.js');
});

test('the public catalog remains exactly one tool with the permanent three-field non-enumerating schema', () => {
  assert.equal(sourceTool.PUBLIC_TOOL_NAME, 'call_quirt');
  assert.equal(targetTool.PUBLIC_TOOL_NAME, 'call_sez');
  assert.deepEqual(identityNormalize(sourceTool.TOOL_DEFINITION), targetTool.TOOL_DEFINITION);
  assert.deepEqual(Object.keys(targetTool.TOOL_DEFINITION.inputSchema.properties).sort(), ['idempotencyKey', 'operation', 'payload']);
  assert.equal(targetTool.TOOL_DEFINITION.inputSchema.additionalProperties, false);
  assert.equal('enum' in targetTool.TOOL_DEFINITION.inputSchema.properties.operation, false);
  assert.equal(targetTool.TOOL_DEFINITION.inputSchema.properties.operation.pattern, '^sez\\.[a-z0-9._-]+$');
});

test('validation, request correlation, fake forwarding, and invalid argument errors retain semantics', async () => {
  const sourceArgs = { operation: 'baby.health', payload: { exact: true }, idempotencyKey: 'parity-key-0001' };
  const targetArgs = identityNormalize(sourceArgs);
  assert.deepEqual(identityNormalize(sourceTool.validateArguments(sourceArgs)), targetTool.validateArguments(targetArgs));
  const sourceCalls: any[] = [];
  const targetCalls: any[] = [];
  const sourceResponse = await sourceTool.callQuirt(sourceArgs, { call: async (...args: any[]) => { sourceCalls.push(args); return { requestId: args[2], result: { status: 'healthy', product: 'baby-quirt' } }; } });
  const targetResponse = await targetTool.callSez(targetArgs, { call: async (...args: any[]) => { targetCalls.push(args); return { requestId: args[2], result: { status: 'healthy', product: 'se-z' } }; } });
  assert.deepEqual(identityNormalize(sourceResponse.structuredContent.result), targetResponse.structuredContent.result);
  assert.deepEqual(identityNormalize(sourceCalls[0].slice(0, 2)), targetCalls[0].slice(0, 2));
  assert.match(sourceCalls[0][2], /^[0-9a-f-]{36}$/u);
  assert.match(targetCalls[0][2], /^[0-9a-f-]{36}$/u);
  assert.equal(sourceTool.idempotencyRequestId(sourceArgs.idempotencyKey), sourceTool.idempotencyRequestId(sourceArgs.idempotencyKey));
  assert.equal(targetTool.idempotencyRequestId(targetArgs.idempotencyKey), targetTool.idempotencyRequestId(targetArgs.idempotencyKey));
  assert.notEqual(sourceTool.idempotencyRequestId(sourceArgs.idempotencyKey), targetTool.idempotencyRequestId(targetArgs.idempotencyKey), 'active gateway identity is intentionally bound into request correlation');
  const sourceInvalid = await sourceTool.callQuirt({ ...sourceArgs, extra: true }, { call: async () => assert.fail('unexpected call') });
  const targetInvalid = await targetTool.callSez({ ...targetArgs, extra: true }, { call: async () => assert.fail('unexpected call') });
  assert.equal(sourceInvalid.isError, true);
  assert.equal(targetInvalid.isError, true);
  assert.equal(identityNormalize(sourceInvalid.structuredContent.code), targetInvalid.structuredContent.code);
});
