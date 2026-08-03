// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:acceptance/secret-redaction.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { startTestServer, stopTestServer, type TestServerContext } from '../unit/helpers/server.js';
import { createTestClient } from '../unit/helpers/client.js';
import { assertNoSecretLeak, readStream } from './helpers/protocol.js';

const CANARY = 'bq-canary-secret-value-7f3a9c2d';

describe('acceptance: secret redaction', () => {
  let ctx: TestServerContext;
  let client: ReturnType<typeof createTestClient>;

  before(async () => {
    process.env.SEZ_TEST_CANARY = CANARY;
    ctx = await startTestServer();
    client = createTestClient(ctx);
  });

  after(async () => {
    delete process.env.SEZ_TEST_CANARY;
    await stopTestServer(ctx);
  });

  it('rejects secret-like literals in structured and legacy environment inputs before job creation', async () => {
    const before = readdirSync(join(ctx.stateRoot, 'jobs')).length;
    for (const input of [
      { argv: ['sh', '-c', 'true'], environment: [{ name: 'GH_TOKEN', value: CANARY }] },
      { argv: ['sh', '-c', 'true'], env: { API_KEY: CANARY } },
    ]) {
      const response = await client.request('sez.exec', input);
      const error = (response.result as { error?: { code?: string; message?: string } }).error;
      assert.equal(error?.code, 'operation_failed');
      assert.match(error?.message ?? '', /must use secretReference/u);
      assertNoSecretLeak(JSON.stringify(response), CANARY, 'secret-like literal rejection response');
    }
    assert.equal(readdirSync(join(ctx.stateRoot, 'jobs')).length, before);
  });

  it('never leaks canary secret through job APIs or persisted state', async () => {
    const exec = await client.request('sez.exec', {
      argv: ['sh', '-c', 'printf %s "$CANARY" 1>&2; echo done'],
      cwd: ctx.dir,
      environment: [{ name: 'CANARY', secretReference: 'github:SEZ_TEST_CANARY' }],
    });
    const jobId = (exec.result as { jobId: string }).jobId;
    await client.request('sez.job.wait', { jobId, timeoutMs: 15_000 });

    const stdout = await readStream(client, jobId, 'stdout');
    const stderr = await readStream(client, jobId, 'stderr');
    assert.match(stdout, /done/);
    assert.match(stderr, new RegExp(CANARY));

    const job = await client.request('sez.job.get', { jobId });
    assertNoSecretLeak(JSON.stringify(job), CANARY, 'job get response');
    if (job.receipt) {
      assertNoSecretLeak(JSON.stringify(job.receipt), CANARY, 'job receipt');
    }

    const jobsDir = join(ctx.stateRoot, 'jobs');
    for (const file of readdirSync(jobsDir)) {
      assertNoSecretLeak(readFileSync(join(jobsDir, file), 'utf8'), CANARY, `job state file ${file}`);
    }

    const list = await client.request('sez.job.list', { limit: 20 });
    assertNoSecretLeak(JSON.stringify(list), CANARY, 'job list response');

    const err = await client.expectError(
      'sez.job.get',
      { jobId: 'missing-job-id' },
      'operation_failed',
    );
    assertNoSecretLeak(JSON.stringify(err), CANARY, 'error response');

    const gitLog = execSync('git log -1 --format=%B', { cwd: join(import.meta.dirname, '..', '..', '..', '..'), encoding: 'utf8' });
    assertNoSecretLeak(gitLog, CANARY, 'git history');
  });
});
