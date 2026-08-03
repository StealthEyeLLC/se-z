import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'test/parity/fixtures/family-matrix.json'), 'utf8'));
const sourceMap = JSON.parse(fs.readFileSync(path.join(root, 'vendor/baby-provenance/source-map.json'), 'utf8')).records;

function hasSourceLineage(relative) {
  return sourceMap.some((record) => record.destinationPath === relative
    || (record.destinationPath && relative.startsWith(`${record.destinationPath.replace(/\/$/u, '')}/`)));
}

export function assertFamily(name) {
  const entry = matrix.families[name];
  assert.ok(entry, `unknown parity family ${name}`);
  assert.ok(entry.implementation.length > 0, `${name}: no implementation paths`);
  assert.ok(entry.tests.length > 0, `${name}: no executable test paths`);
  for (const relative of [...entry.implementation, ...entry.tests]) {
    assert.ok(fs.existsSync(path.join(root, relative)), `${name}: missing ${relative}`);
  }
  for (const relative of entry.implementation) {
    assert.ok(hasSourceLineage(relative), `${name}: no pinned source lineage for ${relative}`);
  }
  for (const relative of entry.tests.filter((value) => value.startsWith('test/extracted/'))) {
    assert.ok(hasSourceLineage(relative), `${name}: no source-test lineage for ${relative}`);
  }
}
