import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const matrix=JSON.parse(fs.readFileSync(new URL('./fixtures/family-matrix.json',import.meta.url),'utf8'));
for(const [family,entry] of Object.entries(matrix.families)) test(`${family} parity has implementation and executable tests`,()=>{
  assert.ok(entry.implementation.length>0); assert.ok(entry.tests.length>0);
  for(const relative of [...entry.implementation,...entry.tests]) assert.ok(fs.existsSync(relative),`${family}: missing ${relative}`);
});
