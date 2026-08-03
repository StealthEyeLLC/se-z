// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/jobs.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntimeConfig } from '../../../../src/supervisor/configuration/config.js';
import { StateStore } from '../../../../src/state/store/store.js';
import { ReplayStore } from '../../../../src/state/replay/store.js';
import { JobManager } from '../../../../src/jobs/manager.js';

describe('job manager', () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-z-jobs-'));
  const config = loadRuntimeConfig({ stateRoot: dir, expectedMachineIdSha256: 'test' });
  const store = new StateStore(config);
  const jobs = new JobManager(config, store);

  it('executes a simple command', async () => {
    const job = await jobs.exec('req-1', { argv: ['echo', 'hello'], cwd: dir });
    assert.ok(job.jobId);
    assert.equal(job.operation, 'sez.exec');

    const completed = await jobs.waitForJob({ jobId: job.jobId, timeoutMs: 10_000 });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.exitCode, 0);

    const stream = jobs.readStream({ jobId: job.jobId, stream: 'stdout' });
    const output = Buffer.from(stream.data, 'base64').toString('utf8').trim();
    assert.equal(output, 'hello');
  });

  it('executes shell command', async () => {
    const job = await jobs.shell('req-2', { command: 'echo shell-test', cwd: dir });
    const completed = await jobs.waitForJob({ jobId: job.jobId, timeoutMs: 10_000 });
    assert.equal(completed.status, 'completed');
  });

  it('lists jobs', () => {
    const list = jobs.listJobs({ limit: 10 });
    assert.ok(list.length >= 2);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('replay store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-z-replay-'));
  const config = loadRuntimeConfig({ stateRoot: dir });
  const replay = new ReplayStore(config);

  it('records and rejects duplicate nonces', () => {
    assert.ok(replay.checkAndRecordNonce('nonce-1'));
    assert.ok(!replay.checkAndRecordNonce('nonce-1'));
  });

  it('stores idempotent responses', () => {
    replay.storeIdempotentResponse('hash-1', { result: 'ok' });
    assert.deepEqual(replay.getIdempotentResponse('hash-1'), { result: 'ok' });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
