import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJobHarness, jobSemantics } from '../helpers/jobs.js';
import { streamBytes } from '../helpers/index.js';

async function runExecutionScenario(kind: 'source' | 'target') {
  const harness = await createJobHarness(kind);
  try {
    const idJob = await harness.jobs.exec(`${kind}-id`, { argv: ['/usr/bin/id', '-u'], cwd: harness.root });
    const idCompleted = await harness.jobs.waitForJob({ jobId: idJob.jobId, timeoutMs: 10_000 });
    const idStdout = streamBytes(harness.jobs, idJob.jobId, 'stdout');
    const idStderr = streamBytes(harness.jobs, idJob.jobId, 'stderr');

    const printfJob = await harness.jobs.exec(`${kind}-printf`, { argv: ['/bin/printf', '%s', 'exact argv ✓'], cwd: harness.root });
    const printfCompleted = await harness.jobs.waitForJob({ jobId: printfJob.jobId, timeoutMs: 10_000 });
    const printfStdout = streamBytes(harness.jobs, printfJob.jobId, 'stdout');

    const shellJob = await harness.jobs.shell(`${kind}-shell`, {
      command: 'printf "%s" "$SEZ_PARITY"; printf "stderr-exact" >&2; exit 7',
      cwd: harness.root,
      env: { SEZ_PARITY: 'environment-exact' },
    });
    const shellCompleted = await harness.jobs.waitForJob({ jobId: shellJob.jobId, timeoutMs: 10_000 });
    const shellStdout = streamBytes(harness.jobs, shellJob.jobId, 'stdout');
    const shellStderr = streamBytes(harness.jobs, shellJob.jobId, 'stderr');

    const binaryJob = await harness.jobs.exec(`${kind}-binary`, {
      argv: ['/usr/bin/python3', '-c', 'import sys; sys.stdout.buffer.write(bytes([0,1,2,127,128,255])); sys.stderr.buffer.write(bytes([255,0,3]))'],
      cwd: harness.root,
    });
    const binaryCompleted = await harness.jobs.waitForJob({ jobId: binaryJob.jobId, timeoutMs: 10_000 });
    const binaryStdout = streamBytes(harness.jobs, binaryJob.jobId, 'stdout');
    const binaryStderr = streamBytes(harness.jobs, binaryJob.jobId, 'stderr');

    const detachedJob = await harness.jobs.exec(`${kind}-detached`, {
      argv: ['/bin/sh', '-c', 'printf detached-exact; sleep 0.1'], cwd: harness.root, detached: true,
    });
    assert.equal(detachedJob.status, 'detached');
    await new Promise((resolve) => setTimeout(resolve, 250));
    harness.jobs.recoverDetachedJobs();
    const detachedCompleted = harness.jobs.getJob(detachedJob.jobId);
    const detachedStdout = streamBytes(harness.jobs, detachedJob.jobId, 'stdout');

    return {
      id: { job: jobSemantics(idCompleted, harness.root), stdout: idStdout, stderr: idStderr },
      printf: { job: jobSemantics(printfCompleted, harness.root), stdout: printfStdout },
      shell: { job: jobSemantics(shellCompleted, harness.root), stdout: shellStdout, stderr: shellStderr },
      binary: { job: jobSemantics(binaryCompleted, harness.root), stdout: binaryStdout, stderr: binaryStderr },
      detached: { job: jobSemantics(detachedCompleted, harness.root), stdout: detachedStdout },
    };
  } finally {
    harness.close();
  }
}

test('exact argv, shell, environment, cwd, exit, detached, and binary output retain behavior', async () => {
  const source = await runExecutionScenario('source');
  const target = await runExecutionScenario('target');
  assert.deepEqual(source, target);
  assert.equal(source.id.stdout.toString('utf8').trim(), '0');
  assert.equal(source.id.stderr.length, 0);
  assert.equal(source.printf.stdout.toString('utf8'), 'exact argv ✓');
  assert.equal(source.shell.job.exitCode, 7);
  assert.equal(source.shell.job.status, 'failed');
  assert.equal(source.shell.stdout.toString('utf8'), 'environment-exact');
  assert.equal(source.shell.stderr.toString('utf8'), 'stderr-exact');
  assert.deepEqual([...source.binary.stdout], [0, 1, 2, 127, 128, 255]);
  assert.deepEqual([...source.binary.stderr], [255, 0, 3]);
  assert.equal(source.detached.stdout.toString('utf8'), 'detached-exact');
});
