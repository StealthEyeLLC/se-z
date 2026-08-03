// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:acceptance/pty.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, type TestServerContext } from '../unit/helpers/server.js';
import { createTestClient, type SezTestClient } from '../unit/helpers/client.js';

describe('acceptance: PTY sessions', () => {
  let ctx: TestServerContext;
  let client: SezTestClient;

  before(async () => {
    ctx = await startTestServer();
    client = createTestClient(ctx);
  });

  after(async () => {
    await stopTestServer(ctx);
  });

  it('creates PTY, sends input, resizes, reads output, and closes', async () => {
    const created = await client.request('sez.pty.create', {
      shell: '/bin/sh',
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    });
    const session = created.result as { sessionId: string; pid: number };
    assert.ok(session.sessionId);
    assert.ok(session.pid > 0);

    await client.request('sez.pty.input', {
      sessionId: session.sessionId,
      data: 'echo pty-acceptance\n',
      encoding: 'utf8',
    });

    const binaryInput = Buffer.from("printf '\\377'\n", 'utf8');
    const binaryWrite = await client.request('sez.pty.input', {
      sessionId: session.sessionId,
      data: binaryInput.toString('base64'),
      encoding: 'base64',
    });
    assert.equal((binaryWrite.result as { bytesWritten: number }).bytesWritten, binaryInput.length);

    await client.request('sez.pty.resize', {
      sessionId: session.sessionId,
      cols: 120,
      rows: 40,
    });

    await new Promise((r) => setTimeout(r, 500));

    const read = await client.request('sez.pty.read', {
      sessionId: session.sessionId,
      offset: 0,
    });
    const rawOutput = Buffer.from((read.result as { data: string }).data, 'base64');
    const output = rawOutput.toString('utf8');
    assert.match(output, /pty-acceptance/);
    assert.ok(rawOutput.includes(Buffer.from([0xff])), 'base64 PTY input must preserve raw non-UTF-8 bytes');

    const closed = await client.request('sez.pty.close', { sessionId: session.sessionId });
    assert.equal((closed.result as { status: string }).status, 'closed');
  });
});
