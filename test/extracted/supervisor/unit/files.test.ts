// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/files.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileManager } from '../../../../src/files/manager.js';
import { OperationError } from '../../../../src/operations/errors.js';

describe('file manager', () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-z-files-'));
  const fm = new FileManager();
  const testFile = join(dir, 'test.txt');

  before(() => {
    writeFileSync(testFile, 'hello world');
  });

  it('stats existing file', () => {
    const stat = fm.stat({ path: testFile });
    assert.equal(stat.exists, true);
    assert.equal(stat.type, 'file');
    assert.equal(stat.size, 11);
    assert.ok(stat.sha256);
  });

  it('reads file with offset', () => {
    const result = fm.read({ path: testFile, offset: 6, encoding: 'utf8' });
    assert.equal(result.data, 'world');
    assert.equal(result.eof, true);
  });

  it('writes and patches file', () => {
    const newFile = join(dir, 'write.txt');
    fm.write({ path: newFile, data: 'AAAA', encoding: 'utf8' });
    fm.patch({
      path: newFile,
      patches: [{ offset: 2, data: 'BB', encoding: 'utf8' }],
    });
    assert.equal(readFileSync(newFile, 'utf8'), 'AABB');
  });

  it('atomically replaces a file with a matching digest and preserves mode', () => {
    const path = join(dir, 'replace.txt');
    writeFileSync(path, 'before');
    chmodSync(path, 0o640);
    const expectedSha256 = fm.stat({ path }).sha256!;
    const result = fm.replace({
      root: dir,
      path,
      data: 'after',
      encoding: 'utf8',
      expectedSha256,
    });
    assert.equal(readFileSync(path, 'utf8'), 'after');
    assert.equal(result.previousSha256, expectedSha256);
    assert.equal(result.sha256, fm.stat({ path }).sha256);
    assert.equal(result.created, false);
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.equal(
      readdirSync(dir).some((name) => name.includes('.se-z-') && name.endsWith('.tmp')),
      false,
    );
  });

  it('rejects a stale compare-and-swap digest', () => {
    const path = join(dir, 'stale.txt');
    writeFileSync(path, 'current');
    assert.throws(
      () => fm.replace({
        root: dir,
        path,
        data: 'new',
        encoding: 'utf8',
        expectedSha256: '0'.repeat(64),
      }),
      (error: unknown) =>
        error instanceof OperationError && error.code === 'precondition_failed',
    );
    assert.equal(readFileSync(path, 'utf8'), 'current');
  });

  it('creates only when expectedAbsent is true', () => {
    const path = join(dir, 'absent.txt');
    const result = fm.replace({
      root: dir,
      path,
      data: 'created',
      encoding: 'utf8',
      expectedAbsent: true,
    });
    assert.equal(result.created, true);
    assert.equal(readFileSync(path, 'utf8'), 'created');
    assert.throws(
      () => fm.replace({
        root: dir,
        path,
        data: 'again',
        encoding: 'utf8',
        expectedAbsent: true,
      }),
      (error: unknown) =>
        error instanceof OperationError && error.code === 'precondition_failed',
    );
  });

  it('rejects paths outside the explicit root', () => {
    assert.throws(
      () => fm.replace({
        root: dir,
        path: join(dir, '..', 'escape.txt'),
        data: 'escape',
        encoding: 'utf8',
        expectedAbsent: true,
      }),
      (error: unknown) =>
        error instanceof OperationError && error.code === 'path_outside_root',
    );
  });

  it('rejects a symlinked parent component', () => {
    const outside = mkdtempSync(join(tmpdir(), 'se-z-files-outside-'));
    const link = join(dir, 'linked-parent');
    symlinkSync(outside, link, 'dir');
    try {
      assert.throws(
        () => fm.replace({
          root: dir,
          path: join(link, 'file.txt'),
          data: 'unsafe',
          encoding: 'utf8',
          expectedAbsent: true,
        }),
        (error: unknown) =>
          error instanceof OperationError && error.code === 'unsafe_path',
      );
      assert.equal(existsSync(join(outside, 'file.txt')), false);
    } finally {
      rmSync(link, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('creates real parent directories only when explicitly allowed', () => {
    const path = join(dir, 'new', 'nested', 'file.txt');
    assert.throws(
      () => fm.replace({
        root: dir,
        path,
        data: 'no',
        encoding: 'utf8',
        expectedAbsent: true,
      }),
      (error: unknown) =>
        error instanceof OperationError && error.code === 'parent_not_found',
    );
    const result = fm.replace({
      root: dir,
      path,
      data: 'yes',
      encoding: 'utf8',
      expectedAbsent: true,
      createParents: true,
    });
    assert.equal(result.created, true);
    assert.equal(readFileSync(path, 'utf8'), 'yes');
  });

  it('lists directory', () => {
    const result = fm.list({ path: dir });
    assert.ok(result.entries.length >= 2);
  });

  it('copies and removes file', () => {
    const src = join(dir, 'copy-src.txt');
    const dst = join(dir, 'copy-dst.txt');
    writeFileSync(src, 'copy me');
    fm.copy({ source: src, destination: dst });
    assert.equal(readFileSync(dst, 'utf8'), 'copy me');
    fm.remove({ path: dst });
    assert.ok(!existsSync(dst));
  });

  it('removes a recursive directory only when explicitly requested', () => {
    const nested = join(dir, 'remove-tree');
    mkdirSync(nested);
    writeFileSync(join(nested, 'file'), 'x');
    assert.throws(() => fm.remove({ path: nested }));
    assert.equal(fm.remove({ path: nested, recursive: true }).removed, true);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
