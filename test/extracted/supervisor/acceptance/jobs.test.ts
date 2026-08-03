// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:acceptance/jobs.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTestServer, stopTestServer, type TestServerContext } from '../unit/helpers/server.js';
import { createTestClient, type SezTestClient } from '../unit/helpers/client.js';
import { JobManager } from '../../../../src/jobs/manager.js';
import { StateStore } from '../../../../src/state/store/store.js';
import { loadRuntimeConfig } from '../../../../src/supervisor/configuration/config.js';

describe('acceptance: detached jobs', () => {
  let ctx: TestServerContext;
  let client: SezTestClient;

  before(async () => {
    ctx = await startTestServer();
    client = createTestClient(ctx);
  });

  after(async () => {
    await stopTestServer(ctx);
  });

  it('runs detached job and survives manager restart', async () => {
    const response = await client.request('sez.exec', {
      argv: ['/bin/sh', '-c', 'sleep 1; echo detached-ok'],
      cwd: ctx.dir,
      detached: true,
    });
    const job = response.result as { jobId: string; status: string };
    assert.equal(job.status, 'detached');

    const config = loadRuntimeConfig({
      stateRoot: ctx.stateRoot,
      expectedMachineIdSha256: 'test',
    });
    const store = new StateStore(config);
    const jobs = new JobManager(config, store);
    const recovered = jobs.recoverDetachedJobs();
    assert.ok(recovered >= 1);

    await new Promise((r) => setTimeout(r, 2500));
    const adopted = jobs.adoptDetachedJob(job.jobId);
    assert.ok(adopted);

    const stream = await client.request('sez.job.stream.read', {
      jobId: job.jobId,
      stream: 'stdout',
    });
    const output = Buffer.from((stream.result as { data: string }).data, 'base64').toString('utf8');
    assert.match(output, /detached-ok/);

    await client.request('sez.job.cancel', { jobId: job.jobId, signal: 'SIGKILL' });
    await new Promise((r) => setTimeout(r, 300));
  });
});
