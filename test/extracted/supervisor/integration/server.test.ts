// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:integration/server.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, stopTestServer, type TestServerContext } from '../unit/helpers/server.js';
import { createTestClient, type SezTestClient } from '../unit/helpers/client.js';

describe('integration: server round-trip', () => {
  let ctx: TestServerContext;
  let client: SezTestClient;

  before(async () => {
    ctx = await startTestServer();
    client = createTestClient(ctx);
  });

  after(async () => {
    await stopTestServer(ctx);
  });

  it('responds to sez.health', async () => {
    const response = await client.request('sez.health');
    assert.equal(response.operation, 'sez.health');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.status, 'healthy');
    assert.ok(response.receipt);
  });

  it('executes sez.exec', async () => {
    const response = await client.request('sez.exec', {
      argv: ['echo', 'integration-test'],
      cwd: ctx.dir,
    });
    const result = response.result as Record<string, unknown>;
    assert.ok(result.jobId);
    assert.equal(result.operation, 'sez.exec');
  });

  it('handles file operations', async () => {
    const testPath = `${ctx.dir}/integ-file.txt`;
    await client.request('sez.file.write', {
      path: testPath,
      data: Buffer.from('integration').toString('base64'),
      encoding: 'base64',
    });

    const stat = await client.request('sez.file.stat', { path: testPath });
    const statResult = stat.result as Record<string, unknown>;
    assert.equal(statResult.exists, true);
    assert.equal(statResult.type, 'file');
  });

  it('rejects replayed nonce', async () => {
    const nonce = 'fixed-replay-nonce-integration';
    await client.request('sez.health', {}, { nonce });
    await client.expectError('sez.health', {}, 'replay_detected', { nonce });
  });

  it('returns idempotent response on exact retry', async () => {
    const requestId = randomUUID();
    const nonce = randomUUID();
    const timestamp = new Date().toISOString();
    const first = await client.request('sez.health', {}, { requestId, nonce, timestamp });
    const second = await client.request('sez.health', {}, { requestId, nonce, timestamp });
    assert.deepEqual(first.result, second.result);
  });
});
