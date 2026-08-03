import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { normalizeDynamic as normalize } from './index.mjs';
const source = JSON.parse(fs.readFileSync(new URL('../fixtures/source-result.json', import.meta.url), 'utf8'));
const target = JSON.parse(fs.readFileSync(new URL('../fixtures/target-result.json', import.meta.url), 'utf8'));
test('dynamic fields normalize without hiding terminal or byte semantics', () => {
  assert.deepEqual(normalize(source), normalize(target));
  const normalized = normalize(source);
  assert.equal(normalized.status, 'completed');
  assert.equal(normalized.exitCode, 0);
  assert.equal(normalized.stdout, 'AAECcm9vdAo=');
  assert.equal(normalized.stdoutOffset, 8);
  assert.equal(normalized.stdoutSha256, source.stdoutSha256);
});
