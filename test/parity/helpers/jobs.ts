import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceSupervisor, target } from './index.js';

export interface JobHarness {
  kind: 'source' | 'target';
  root: string;
  config: any;
  store: any;
  jobs: any;
  close(): void;
}

export async function createJobHarness(kind: 'source' | 'target'): Promise<JobHarness> {
  const prefix = kind === 'source' ? 'sez-parity-source-jobs-' : 'sez-parity-target-jobs-';
  const root = mkdtempSync(join(tmpdir(), prefix));
  const [configModule, storeModule, jobsModule] = kind === 'source'
    ? await Promise.all([
      sourceSupervisor('src/config.ts'),
      sourceSupervisor('src/state/store.ts'),
      sourceSupervisor('src/jobs/manager.ts'),
    ])
    : await Promise.all([
      target('src/supervisor/configuration/config.ts'),
      target('src/state/store/store.ts'),
      target('src/jobs/manager.ts'),
    ]);
  const config = configModule.loadRuntimeConfig({
    stateRoot: root,
    configRoot: join(root, 'config'),
    expectedMachineIdSha256: 'test',
    maxOutputBytes: 64 * 1024 * 1024,
  });
  const store = new storeModule.StateStore(config);
  const jobs = new jobsModule.JobManager(config, store);
  return {
    kind, root, config, store, jobs,
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

export function jobSemantics(job: any, root: string): Record<string, unknown> {
  return {
    operation: String(job.operation).replace(/^baby\./u, 'sez.'),
    status: job.status,
    cwd: job.cwd === root ? '<ROOT>' : job.cwd,
    argv: job.argv,
    shell: job.shell ?? null,
    script: job.script ?? null,
    env: job.env,
    detached: job.detached,
    exitCode: job.exitCode ?? null,
    signal: job.signal ?? null,
    stdoutClosed: job.streams.stdoutClosed,
    stderrClosed: job.streams.stderrClosed,
    stdoutOffset: job.streams.stdoutOffset,
    stderrOffset: job.streams.stderrOffset,
  };
}
