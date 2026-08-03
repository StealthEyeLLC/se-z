// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:acceptance/cancellation.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from '../unit/helpers/server.js';
import { createTestClient } from '../unit/helpers/client.js';

describe('acceptance: process tree cancellation', () => {
  it('cancels running foreground job', async () => {
    const ctx = await startTestServer();
    const client = createTestClient(ctx);
    try {
      const started = await client.request('sez.shell', {
        command: 'sleep 30',
        cwd: ctx.dir,
      });
      const jobId = (started.result as { jobId: string }).jobId;
      await new Promise((r) => setTimeout(r, 200));
      const cancelled = await client.request('sez.job.cancel', { jobId, signal: 'SIGTERM' });
      assert.equal((cancelled.result as { status: string }).status, 'cancelled');
    } finally {
      await stopTestServer(ctx);
    }
  });
});
