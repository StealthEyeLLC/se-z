// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:acceptance/deployment.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicSwapSymlinks, rollbackSymlinks, symlinkExists } from '../../../../src/selfhost/install/symlinks.js';

describe('acceptance: deployment symlink integrity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-z-deploy-'));
  const current = join(dir, 'current');
  const previous = join(dir, 'previous');
  const releaseA = join(dir, 'releases', '0.1.0');
  const releaseB = join(dir, 'releases', '0.2.0');

  before(() => {
    mkdirSync(releaseA, { recursive: true });
    mkdirSync(releaseB, { recursive: true });
    writeFileSync(join(releaseA, 'VERSION'), '0.1.0');
    writeFileSync(join(releaseB, 'VERSION'), '0.2.0');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('atomically swaps current and preserves previous', () => {
    atomicSwapSymlinks(current, previous, releaseA);
    assert.equal(atomicSwapSymlinks(current, previous, releaseB).previous, releaseA);
    const rolled = rollbackSymlinks(current, previous);
    assert.equal(rolled.current, releaseA);
  });

  it('handles broken symlinks during swap', () => {
    rmSync(current, { force: true });
    rmSync(previous, { force: true });
    symlinkSync('/nonexistent/broken-target', current);
    atomicSwapSymlinks(current, previous, releaseB);
    assert.equal(readlinkSync(current), releaseB);
    const rolled = rollbackSymlinks(current, previous);
    assert.equal(rolled.current, '/nonexistent/broken-target');
  });
});

describe('acceptance: release version validation', () => {
  it('rejects malformed versions', async () => {
    const { assertSafeVersion } = await import('../../../../src/selfhost/install/safe-extract.js');
    assert.throws(() => assertSafeVersion('../etc/passwd'), /Invalid release version/);
    assert.throws(() => assertSafeVersion('not-a-version'), /Invalid release version/);
    assert.doesNotThrow(() => assertSafeVersion('0.1.0'));
  });
});
