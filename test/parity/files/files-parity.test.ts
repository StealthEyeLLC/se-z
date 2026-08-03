import assert from 'node:assert/strict';
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync,
  rmSync, statSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { sha256, sourceSupervisor, target } from '../helpers/index.js';

function captureError(action: () => unknown): { name: string; code?: string; message: string } {
  try { action(); return { name: '<NO_ERROR>', message: '' }; }
  catch (error: any) { return { name: error.name, code: error.code, message: String(error.message).replace(/baby-quirt/gu, 'se-z') }; }
}

async function runFileScenario(kind: 'source' | 'target') {
  const module = kind === 'source' ? await sourceSupervisor('src/files/manager.ts') : await target('src/files/manager.ts');
  const root = mkdtempSync(join(tmpdir(), `sez-parity-${kind}-files-`));
  const outside = mkdtempSync(join(tmpdir(), `sez-parity-${kind}-outside-`));
  const manager = new module.FileManager();
  try {
    const text = join(root, 'text.txt');
    manager.write({ path: text, data: 'alpha-beta', encoding: 'utf8' });
    chmodSync(text, 0o640);
    const textStat = manager.stat({ path: text });
    const partial = manager.read({ path: text, offset: 6, limit: 4, encoding: 'utf8' });
    const repeat = manager.read({ path: text, offset: 6, limit: 4, encoding: 'utf8' });
    manager.patch({ path: text, patches: [{ offset: 6, data: 'BETA', encoding: 'utf8' }] });
    const patched = readFileSync(text, 'utf8');

    const expectedSha256 = manager.stat({ path: text }).sha256;
    const replaced = manager.replace({ root, path: text, data: 'replacement', encoding: 'utf8', expectedSha256 });
    const staleError = captureError(() => manager.replace({ root, path: text, data: 'wrong', encoding: 'utf8', expectedSha256: '0'.repeat(64) }));
    const replacementBytes = readFileSync(text);

    const createdPath = join(root, 'nested', 'created.bin');
    const createdBytes = Buffer.from([0, 1, 2, 127, 128, 255]);
    const created = manager.replace({ root, path: createdPath, data: createdBytes.toString('base64'), encoding: 'base64', expectedAbsent: true, createParents: true });
    const absentError = captureError(() => manager.replace({ root, path: createdPath, data: 'again', encoding: 'utf8', expectedAbsent: true }));
    const outsideError = captureError(() => manager.replace({ root, path: join(root, '..', 'escape'), data: 'x', encoding: 'utf8', expectedAbsent: true }));

    const linkedParent = join(root, 'linked-parent');
    symlinkSync(outside, linkedParent, 'dir');
    const symlinkError = captureError(() => manager.replace({ root, path: join(linkedParent, 'escape'), data: 'x', encoding: 'utf8', expectedAbsent: true }));

    const copy = join(root, 'copy.bin');
    const moved = join(root, 'moved.bin');
    manager.copy({ source: createdPath, destination: copy });
    manager.move({ source: copy, destination: moved });
    const copiedBytes = readFileSync(moved);

    const sparse = join(root, 'sparse.bin');
    const fd = openSync(sparse, 'w'); closeSync(fd); truncateSync(sparse, 1024 * 1024 + 17);
    const sparseStat = manager.stat({ path: sparse });
    const sparseTail = manager.read({ path: sparse, offset: 1024 * 1024, limit: 17, encoding: 'base64' });

    const listing = manager.list({ path: root }).entries.map((entry: any) => ({ name: entry.name, type: entry.type, mode: entry.mode })).sort((a: any, b: any) => a.name.localeCompare(b.name));
    const symlinkStat = manager.stat({ path: linkedParent });
    const removed = manager.remove({ path: moved });
    const missing = manager.stat({ path: moved });

    return {
      textStat: { exists: textStat.exists, type: textStat.type, size: textStat.size, mode: textStat.mode, sha256: textStat.sha256 },
      partial, repeat, patched,
      replaced: { previousSha256: replaced.previousSha256, sha256: replaced.sha256, bytesWritten: replaced.bytesWritten, created: replaced.created, mode: statSync(text).mode & 0o777 },
      replacementSha256: sha256(replacementBytes), staleError,
      created: { sha256: created.sha256, bytesWritten: created.bytesWritten, created: created.created, bytes: [...readFileSync(createdPath)] },
      absentError, outsideError, symlinkError, outsideMutated: existsSync(join(outside, 'escape')),
      moved: { basename: basename(moved), bytes: [...copiedBytes], mode: lstatSync(moved).mode & 0o777 },
      sparse: { exists: sparseStat.exists, type: sparseStat.type, size: sparseStat.size, tail: [...Buffer.from(sparseTail.data, 'base64')], eof: sparseTail.eof },
      listing, symlink: { exists: symlinkStat.exists, type: symlinkStat.type }, removed, missing,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

test('file stat/read/write/replace/patch/copy/move/remove/list retain bytes, modes, digests, safety, sparse and symlink behavior', async () => {
  const source = await runFileScenario('source');
  const targetResult = await runFileScenario('target');
  assert.deepEqual(source, targetResult);
  assert.deepEqual(source.partial, source.repeat);
  assert.equal(source.patched, 'alpha-BETA');
  assert.equal(source.replaced.mode, 0o640);
  assert.equal(source.staleError.code, 'precondition_failed');
  assert.equal(source.absentError.code, 'precondition_failed');
  assert.equal(source.outsideError.code, 'path_outside_root');
  assert.equal(source.symlinkError.code, 'unsafe_path');
  assert.equal(source.outsideMutated, false);
  assert.deepEqual(source.created.bytes, [0, 1, 2, 127, 128, 255]);
  assert.equal(source.sparse.size, 1024 * 1024 + 17);
  assert.deepEqual(source.sparse.tail, new Array(17).fill(0));
  assert.equal(source.removed.removed, true);
  assert.equal(source.missing.exists, false);
});
