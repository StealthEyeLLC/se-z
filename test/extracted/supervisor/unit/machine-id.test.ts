// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/machine-id.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { machineIdSha256, normalizeMachineId } from '../../../../src/supervisor/configuration/config.js';

describe('machine identity', () => {
  it('normalizes LF and CRLF before hashing', () => {
    const canonical = '0123456789abcdef0123456789abcdef';
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');

    assert.equal(normalizeMachineId(`${canonical}\n`), canonical);
    assert.equal(normalizeMachineId(`${canonical}\r\n`), canonical);
    assert.equal(machineIdSha256(canonical), expected);
    assert.equal(machineIdSha256(`${canonical}\n`), expected);
    assert.equal(machineIdSha256(`${canonical}\r\n`), expected);
  });

  it('does not erase non-newline bytes', () => {
    assert.equal(normalizeMachineId('abc def\n'), 'abc def');
  });
});
