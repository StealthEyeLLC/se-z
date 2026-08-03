#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const evidenceRoot = path.join(root, 'evidence/phase1');
const testRoot = path.join(root, 'test/parity');
const tests = fs.readdirSync(testRoot, { recursive: true })
  .map((entry) => path.join('test/parity', String(entry)))
  .filter((entry) => entry.endsWith('.test.mjs'))
  .sort();
const staticRun = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (staticRun.status !== 0) {
  process.stdout.write(staticRun.stdout ?? '');
  process.stderr.write(staticRun.stderr ?? '');
  process.exit(staticRun.status ?? 1);
}
const sourcePath = path.join(evidenceRoot, 'source-test-results.json');
const extractedPath = path.join(evidenceRoot, 'extracted-test-results.json');
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const extracted = JSON.parse(fs.readFileSync(extractedPath, 'utf8'));
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'test/parity/fixtures/family-matrix.json'), 'utf8'));
const deltas = JSON.parse(fs.readFileSync(path.join(root, 'contracts/phase1-canonical-delta.json'), 'utf8')).entries;
const capabilityMap = JSON.parse(fs.readFileSync(path.join(root, 'contracts/phase1-capability-map.json'), 'utf8'));
const behavioral = extracted.commands.find((entry) => entry.name === 'parity-behavioral');
const families = Object.entries(matrix.families).map(([family, entry]) => ({
  family,
  sourceReferencePassed: source.passed,
  extractedPassed: extracted.passed,
  behavioralParityPassed: behavioral?.passed === true,
  implementationFiles: entry.implementation,
  testFiles: entry.tests,
  status: source.passed && extracted.passed && behavioral?.passed === true ? 'PASSED' : 'FAILED',
}));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const result = {
  schemaVersion: '1.0.0', capturedAt: new Date().toISOString(),
  strategy: 'exact pinned source suites plus mechanically ported suites, source-versus-target behavioral tests, family lineage assertions, and explicit canonical-delta classification',
  staticTestFiles: tests,
  staticParityTestDigest: sha256(`${staticRun.stdout ?? ''}${staticRun.stderr ?? ''}`),
  sourceTestEvidenceSha256: sha256(fs.readFileSync(sourcePath)),
  extractedTestEvidenceSha256: sha256(fs.readFileSync(extractedPath)),
  normalization: ['UUIDs','timestamps','temporary paths','PIDs','job/session/artifact/receipt IDs','nonces','fixture key IDs','signatures','release paths','hostnames','machine identities','stream handles'],
  retainedSemantics: ['state','terminal status','exit code','signal','stdout bytes','stderr bytes','stream offsets','stream completion','file bytes','modes','digests','error type','idempotency','replay','receipt verification','operation schemas','cleanup state'],
  families,
  canonicalDeltaCount: deltas.length,
  canonicalDeltaIds: deltas.map((entry) => entry.id),
  installedOperationCount: capabilityMap.installedOperationCount,
  mappedOperationCount: capabilityMap.operations.length,
  silentDisappearances: capabilityMap.completeness.silentDisappearances,
  passed: source.passed && extracted.passed && behavioral?.passed === true
    && families.every((entry) => entry.status === 'PASSED')
    && capabilityMap.operations.length === capabilityMap.installedOperationCount
    && capabilityMap.completeness.silentDisappearances.length === 0,
};
fs.writeFileSync(path.join(evidenceRoot, 'parity-results.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(staticRun.stdout ?? '');
console.log(JSON.stringify({ families: families.length, staticTests: tests.length, behavioralTests: behavioral?.tap?.tests ?? 0, passed: result.passed }, null, 2));
if (!result.passed) process.exitCode = 1;
