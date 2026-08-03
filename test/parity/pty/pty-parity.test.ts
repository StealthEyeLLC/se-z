import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sourceSupervisor, target } from '../helpers/index.js';

async function runPtyScenario(kind: 'source' | 'target') {
  const [ptyModule, configModule, stateModule] = kind === 'source'
    ? await Promise.all([sourceSupervisor('src/pty/manager.ts'), sourceSupervisor('src/config.ts'), sourceSupervisor('src/state/store.ts')])
    : await Promise.all([target('src/pty/manager.ts'), target('src/supervisor/configuration/config.ts'), target('src/state/store/store.ts')]);
  const root = mkdtempSync(join(tmpdir(), `sez-parity-${kind}-pty-`));
  const config = configModule.loadRuntimeConfig({ stateRoot: join(root, 'state'), configRoot: join(root, 'config') });
  const store = new stateModule.StateStore(config);
  const manager = new ptyModule.PtyManager(store);
  let session: any;
  try {
    session = manager.create(`${kind}-pty`, { shell: '/bin/sh', cwd: root, cols: 80, rows: 24, env: { SEZ_PTY_PARITY: 'env-exact' } });
    const discovered = store.getPtySession(session.sessionId);
    const listed = store.listPtySessions();
    const text = Buffer.from('printf "pty:%s\\n" "$SEZ_PTY_PARITY"\n', 'utf8');
    const binary = Buffer.from("printf '\\377'\n", 'utf8');
    const textWrite = manager.input({ sessionId: session.sessionId, data: text.toString('utf8'), encoding: 'utf8' });
    const binaryWrite = manager.input({ sessionId: session.sessionId, data: binary.toString('base64'), encoding: 'base64' });
    const resized = manager.resize({ sessionId: session.sessionId, cols: 120, rows: 40 });
    const recovered = new ptyModule.PtyManager(store).recoverSessions();

    let all = Buffer.alloc(0);
    let offset = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = manager.read({ sessionId: session.sessionId, offset, limit: 7 });
      const chunk = Buffer.from(result.data, 'base64');
      assert.equal(result.offset, offset + chunk.length);
      all = Buffer.concat([all, chunk]);
      offset = result.offset;
      if (all.includes(Buffer.from('pty:env-exact')) && all.includes(Buffer.from([0xff]))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const repeated = manager.read({ sessionId: session.sessionId, offset: 0, limit: Math.min(7, all.length) });
    const invalidError = (() => { try { manager.read({ sessionId: 'missing-session', offset: 0 }); return '<NO_ERROR>'; } catch (error: any) { return error.message; } })();
    const closed = manager.close({ sessionId: session.sessionId });
    const terminal = manager.read({ sessionId: session.sessionId, offset });
    const recoveredAfterClose = manager.recoverSessions();

    return {
      created: { status: session.status, cols: session.cols, rows: session.rows, pidPositive: session.pid > 0 },
      discovered: Boolean(discovered), listedCount: listed.length,
      textBytes: textWrite.bytesWritten, binaryBytes: binaryWrite.bytesWritten,
      resized: { cols: resized.cols, rows: resized.rows }, recovered,
      outputContainsText: all.includes(Buffer.from('pty:env-exact')),
      outputContainsBinary: all.includes(Buffer.from([0xff])),
      repeatedBytes: [...Buffer.from(repeated.data, 'base64')], firstBytes: [...all.subarray(0, Buffer.from(repeated.data, 'base64').length)],
      invalidError: invalidError.replace(/[0-9a-f-]{36}/giu, '<ID>'),
      closedStatus: closed.status, terminalEof: terminal.eof, terminalOffset: terminal.offset, recoveredAfterClose,
    };
  } finally {
    if (session) { try { manager.close({ sessionId: session.sessionId }); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
}

test('PTY create/discover/input/read/offset/resize/recover/invalid/close retain behavior', async () => {
  const source = await runPtyScenario('source');
  const targetResult = await runPtyScenario('target');
  assert.deepEqual(source, targetResult);
  assert.equal(source.created.status, 'active');
  assert.equal(source.created.pidPositive, true);
  assert.equal(source.discovered, true);
  assert.equal(source.listedCount, 1);
  assert.equal(source.outputContainsText, true);
  assert.equal(source.outputContainsBinary, true);
  assert.deepEqual(source.repeatedBytes, source.firstBytes);
  assert.match(source.invalidError, /PTY session not found/u);
  assert.equal(source.closedStatus, 'closed');
  assert.equal(source.terminalEof, true);
  assert.equal(source.recoveredAfterClose, 0);
});
