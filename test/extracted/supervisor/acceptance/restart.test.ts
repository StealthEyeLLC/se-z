// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:acceptance/restart.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, type TestServerContext } from '../unit/helpers/server.js';
import { createTestClient, type SezTestClient } from '../unit/helpers/client.js';
import { SezServer } from '../../../../src/supervisor/server/server.js';
import { loadRuntimeConfig } from '../../../../src/supervisor/configuration/config.js';

describe('acceptance: restart recovery', () => {
  let ctx: TestServerContext;
  let client: SezTestClient;

  before(async () => {
    ctx = await startTestServer();
    client = createTestClient(ctx);
  });

  after(async () => {
    await stopTestServer(ctx);
  });

  it('recovers health after server restart with same state', async () => {
    await client.request('sez.exec', {
      argv: ['echo', 'before-restart'],
      cwd: ctx.dir,
    });

    await ctx.server.stop();

    const config = loadRuntimeConfig({
      socketPath: ctx.socketPath,
      stateRoot: ctx.stateRoot,
      configRoot: ctx.configRoot,
      expectedMachineIdSha256: 'test',
      ownerPrincipalFingerprint: ctx.ownerPrincipalFingerprint,
      skipPeerCredCheck: true,
    });
    const server2 = new SezServer(config);
    await server2.start();
    ctx.server = server2;

    const health = await client.request('sez.health');
    const result = health.result as { status: string };
    assert.equal(result.status, 'healthy');

    const jobs = await client.request('sez.job.list', { limit: 10 });
    const list = jobs.result as unknown[];
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 1);
  });
});
