import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJobHarness } from '../helpers/jobs.js';
import { sha256, streamBytes } from '../helpers/index.js';

async function runStreamScenario(kind: 'source' | 'target') {
  const harness = await createJobHarness(kind);
  try {
    const job = await harness.jobs.exec(`${kind}-streams`, {
      argv: ['/usr/bin/python3', '-c', [
        'import sys',
        'sys.stdout.buffer.write(bytes(range(256))*2048)',
        'sys.stderr.buffer.write(bytes(reversed(range(256)))*1024)',
      ].join(';')],
      cwd: harness.root,
    });
    const completed = await harness.jobs.waitForJob({ jobId: job.jobId, timeoutMs: 10_000 });
    assert.equal(completed.status, 'completed');
    const first = harness.jobs.readStream({ jobId: job.jobId, stream: 'stdout', offset: 0, limit: 13 });
    const repeat = harness.jobs.readStream({ jobId: job.jobId, stream: 'stdout', offset: 0, limit: 13 });
    const second = harness.jobs.readStream({ jobId: job.jobId, stream: 'stdout', offset: first.offset, limit: 17 });
    const stdout = streamBytes(harness.jobs, job.jobId, 'stdout', 4096);
    const stderr = streamBytes(harness.jobs, job.jobId, 'stderr', 3072);
    const end = harness.jobs.readStream({ jobId: job.jobId, stream: 'stdout', offset: stdout.length, limit: 10 });
    return {
      first, repeat, second,
      stdoutLength: stdout.length, stderrLength: stderr.length,
      stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr),
      stdoutHead: [...stdout.subarray(0, 32)], stderrHead: [...stderr.subarray(0, 32)],
      end,
    };
  } finally {
    harness.close();
  }
}

test('separate binary streams preserve exact offsets, repeatability, partial reads, completion, and large output', async () => {
  const source = await runStreamScenario('source');
  const target = await runStreamScenario('target');
  assert.deepEqual(source, target);
  assert.deepEqual(source.first, source.repeat);
  assert.equal(source.first.offset, 13);
  assert.equal(source.second.offset, 30);
  assert.equal(source.stdoutLength, 256 * 2048);
  assert.equal(source.stderrLength, 256 * 1024);
  assert.equal(source.end.eof, true);
  assert.equal(Buffer.from(source.end.data, 'base64').length, 0);
  assert.notEqual(source.stdoutSha256, source.stderrSha256);
});
