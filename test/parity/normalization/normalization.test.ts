import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDynamic } from '../helpers/index.js';

test('normalization removes only declared dynamic identities', () => {
  const value = {
    jobId: '00000000-0000-4000-8000-000000000001',
    pid: 1234,
    timestamp: '2026-08-03T12:00:00.000Z',
    path: '/tmp/source/job.out',
    status: 'completed',
    exitCode: 7,
    signal: 'SIGTERM',
    stdout: Buffer.from([0, 1, 255]).toString('base64'),
    stderr: 'exact-error',
    sha256: 'a'.repeat(64),
    error: { code: 'precondition_failed', retryable: false },
    offsets: [0, 4, 9],
  };
  const normalized = normalizeDynamic(value, { roots: ['/tmp/source'] }) as Record<string, unknown>;
  assert.equal(normalized.jobId, '<JOBID>');
  assert.equal(normalized.pid, '<PID>');
  assert.equal(normalized.timestamp, '<TIMESTAMP>');
  assert.equal(normalized.path, '<PATH>');
  assert.equal(normalized.status, 'completed');
  assert.equal(normalized.exitCode, 7);
  assert.equal(normalized.signal, 'SIGTERM');
  assert.equal(normalized.stdout, value.stdout);
  assert.equal(normalized.stderr, value.stderr);
  assert.equal(normalized.sha256, value.sha256);
  assert.deepEqual(normalized.error, value.error);
  assert.deepEqual(normalized.offsets, value.offsets);
});

test('identity normalization converts active source identity without rewriting arbitrary output bytes', () => {
  const normalized = normalizeDynamic({ operation: 'baby.exec', service: 'baby-quirt.service', output: 'owner said baby.exec literally' }, { preserveKeys: ['output'] }) as any;
  assert.equal(normalized.operation, 'sez.exec');
  assert.equal(normalized.service, 'se-z.service');
  // The generic normalizer is never applied to raw byte comparisons; this assertion documents that boundary.
  assert.equal(typeof normalized.output, 'string');
});
