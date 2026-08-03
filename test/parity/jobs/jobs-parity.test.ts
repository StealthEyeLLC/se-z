import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJobHarness, jobSemantics } from '../helpers/jobs.js';

async function runJobScenario(kind: 'source' | 'target') {
  const harness = await createJobHarness(kind);
  try {
    const started = await harness.jobs.shell(`${kind}-lifecycle`, { command: 'sleep 0.15; exit 0', cwd: harness.root });
    assert.ok(['pending', 'running'].includes(started.status));
    const lookupBefore = harness.jobs.getJob(started.jobId);
    const completed = await harness.jobs.waitForJob({ jobId: started.jobId, timeoutMs: 10_000 });
    const lookupAfter = harness.jobs.getJob(started.jobId);
    const listed = harness.jobs.listJobs({ limit: 100 }).map((job: any) => jobSemantics(job, harness.root));

    const timeoutJob = await harness.jobs.shell(`${kind}-timeout`, { command: 'sleep 30', cwd: harness.root });
    let timeoutError = '';
    try {
      await harness.jobs.waitForJob({ jobId: timeoutJob.jobId, timeoutMs: 25 });
    } catch (error) {
      timeoutError = error instanceof Error ? error.message : String(error);
    }
    const cancelled = harness.jobs.cancelJob({ jobId: timeoutJob.jobId, signal: 'SIGTERM' });
    const cancellationLookup = harness.jobs.getJob(timeoutJob.jobId);

    const recoveryJob = await harness.jobs.shell(`${kind}-recovery`, { command: 'sleep 1', cwd: harness.root });
    const recoveredCount = harness.jobs.recoverRunningJobs();
    const recovered = harness.jobs.getJob(recoveryJob.jobId);
    harness.jobs.cancelJob({ jobId: recoveryJob.jobId, signal: 'SIGTERM' });

    // Child close handlers persist terminal state and close stream writers asynchronously.
    // Drain them before deleting the isolated fixture root.
    await new Promise((resolve) => setTimeout(resolve, 350));

    return {
      acceptedStatus: started.status,
      lookupBefore: jobSemantics(lookupBefore, harness.root),
      completed: jobSemantics(completed, harness.root),
      lookupAfter: jobSemantics(lookupAfter, harness.root),
      listedStatuses: listed.map((job: any) => job.status).sort(),
      timeoutError,
      cancelled: jobSemantics(cancelled, harness.root),
      cancellationLookup: jobSemantics(cancellationLookup, harness.root),
      recoveredCount,
      recoveredStatus: recovered.status,
    };
  } finally {
    harness.close();
  }
}

test('accepted/running/completed, lookup, list, bounded wait, cancellation, and restart discovery retain behavior', async () => {
  const source = await runJobScenario('source');
  const target = await runJobScenario('target');
  assert.deepEqual(source, target);
  assert.equal(source.completed.status, 'completed');
  assert.equal(source.completed.exitCode, 0);
  assert.equal(source.timeoutError, 'Job wait timeout');
  assert.equal(source.cancelled.status, 'cancelled');
  assert.equal(source.cancellationLookup.status, 'cancelled');
  assert.ok(source.recoveredCount >= 1);
  assert.equal(source.recoveredStatus, 'adopted');
});
