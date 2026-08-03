import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { TOOL_DEFINITION } from '../../../src/gateway/mcp/tool.js';
const schema=JSON.parse(fs.readFileSync('contracts/tool-schema.json','utf8'));
test('call_sez retains the exact three-field public schema',()=>{
  assert.equal(TOOL_DEFINITION.name,'call_sez');
  assert.match(schema.title,/^call_sez\b/u);
  assert.deepEqual(schema.required,['operation','payload','idempotencyKey']);
  assert.deepEqual(Object.keys(schema.properties),['operation','payload','idempotencyKey']);
  assert.equal(schema.additionalProperties,false);
  assert.equal('enum' in schema.properties.operation,false);
});
test('active extracted gateway has no call_quirt tool identity',()=>{
  const text=fs.readFileSync('src/gateway/mcp/tool.js','utf8');
  assert.match(text,/call_sez/u);
  assert.doesNotMatch(text,/call_quirt/u);
});
