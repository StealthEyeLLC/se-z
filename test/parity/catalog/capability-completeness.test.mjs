import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const capability = JSON.parse(fs.readFileSync(new URL('../../../contracts/phase1-capability-map.json', import.meta.url), 'utf8'));
const delta = JSON.parse(fs.readFileSync(new URL('../../../contracts/phase1-canonical-delta.json', import.meta.url), 'utf8'));
test('every installed operation is mapped and every discrepancy is classified', () => {
  assert.equal(capability.installedOperationCount, 49);
  assert.equal(capability.operations.length, 49);
  assert.equal(capability.completeness.everyInstalledOperationMapped, true);
  assert.deepEqual(capability.completeness.silentDisappearances, []);
  assert.ok(delta.entries.length >= 20);
  assert.ok(delta.entries.every((entry) => entry.classification && entry.phaseResponsible && entry.parityExpectation));
});
