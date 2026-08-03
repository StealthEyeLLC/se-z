#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** CLI wrapper used by the one-shot bootstrap/certification lane. */

import { prepareNspawnInput } from '../../../src/releases/rehearsal/nspawn-input.js';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const known = new Set([
    '--run-id', '--requested-at', '--deadline', '--sez-repo', '--sez-commit',
    '--gateway-repo', '--gateway-commit', '--dependency-cache', '--bootstrap-record',
    '--harness', '--output-root',
  ]);
  const args = process.argv.slice(2);
  if (args.length !== known.size * 2) throw new Error('exact nspawn input options are required');
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index]!)) throw new Error(`unknown nspawn input option: ${args[index]}`);
  }
  const plan = prepareNspawnInput({
    runId: option('--run-id'),
    requestedAt: option('--requested-at'),
    deadline: option('--deadline'),
    sezRepositoryPath: option('--sez-repo'),
    sezCommit: option('--sez-commit'),
    gatewayRepositoryPath: option('--gateway-repo'),
    gatewayCommit: option('--gateway-commit'),
    dependencyCachePath: option('--dependency-cache'),
    bootstrapRecordPath: option('--bootstrap-record'),
    harnessPath: option('--harness'),
    outputRoot: option('--output-root'),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId: plan.runId,
    planDigest: plan.planDigest,
    sezCommit: plan.inputs.sez.commit,
    sezTree: plan.inputs.sez.tree,
    gatewayCommit: plan.inputs.gateway.commit,
    gatewayTree: plan.inputs.gateway.tree,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: 'nspawn_input_invalid',
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
