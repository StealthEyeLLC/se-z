#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Root-only fixed entrypoint for one pre-materialized nspawn run plan. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPrivateKey } from '../../protocol/signatures/signing.js';
import { StreamingNspawnCommandExecutor } from './nspawn-executor.js';
import {
  DEFAULT_NSPAWN_RUNNER_CONFIG,
  FixedNspawnRehearsalRunner,
  NspawnRunnerError,
} from './nspawn-runner.js';

const PRIVATE_KEY = '/etc/se-z-nspawn/evidence-private.pem';
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,47}$/;

async function main(): Promise<void> {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    throw new Error('nspawn host certification CLI requires real root');
  }
  const [command, runId, ...rest] = process.argv.slice(2);
  if (!['preflight', 'run'].includes(command ?? '') || !runId || !RUN_ID.test(runId) || rest.length !== 0) {
    throw new Error('usage: se-z-nspawn-runner <preflight|run> <canonical-run-id>');
  }
  const planPath = join(DEFAULT_NSPAWN_RUNNER_CONFIG.inputsRoot, runId, 'plan.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as unknown;
  const runner = new FixedNspawnRehearsalRunner({
    executor: new StreamingNspawnCommandExecutor(),
    evidencePrivateKey: loadPrivateKey(PRIVATE_KEY),
  });
  if (command === 'preflight') {
    const verified = await runner.preflight(plan);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'preflight',
      runId: verified.runId,
      planDigest: verified.planDigest,
      baseSnapshot: verified.baseSnapshot,
      baseSnapshotGuid: verified.baseSnapshotGuid,
    })}\n`);
    return;
  }
  const receipt = await runner.run(plan);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (receipt.outcome !== 'passed') process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const body = error instanceof NspawnRunnerError
    ? { ok: false, code: error.code, message: error.message }
    : {
        ok: false,
        code: 'nspawn_invalid_invocation',
        message: error instanceof Error ? error.message : String(error),
      };
  process.stderr.write(`${JSON.stringify(body)}\n`);
  process.exitCode = 1;
}
