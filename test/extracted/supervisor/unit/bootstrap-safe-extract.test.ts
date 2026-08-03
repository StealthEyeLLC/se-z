// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/bootstrap-safe-extract.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

describe('retired v1 bootstrap extractor', () => {
  it('fails closed without parsing or writing an archive', () => {
    const source = readFileSync('scripts/extracted/supervisor/bootstrap-safe-extract.py', 'utf8');
    assert.doesNotMatch(source, /tarfile|extractall|\.extract\(|open\(/u);
    const result = spawnSync(
      'python3',
      ['scripts/extracted/supervisor/bootstrap-safe-extract.py', '/does/not/exist.tar.gz', '/tmp/forbidden', 'prefix'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 64);
    assert.match(result.stderr, /fixed Sez deployment controller/u);
  });
});
