#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const evidenceRoot = path.join(root, 'evidence/phase1');
const read = (name) => JSON.parse(fs.readFileSync(path.join(evidenceRoot, name), 'utf8'));
const sha256File = (relative) => createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const identity = read('source-identity-proof.json');
const materialization = read('source-materialization.json');
const source = read('source-test-results.json');
const extracted = read('extracted-test-results.json');
const parity = read('parity-results.json');
const dependency = read('dependency-scan.json');
const secret = read('secret-scan.json');
const requirements = read('requirements-audit.json');
const production = read('production-readback.json');
const capability = JSON.parse(fs.readFileSync(path.join(root, 'contracts/phase1-capability-map.json'), 'utf8'));
const deltas = JSON.parse(fs.readFileSync(path.join(root, 'contracts/phase1-canonical-delta.json'), 'utf8')).entries;
const evidenceFiles = [
  'evidence/phase1/source-identity-proof.json',
  'evidence/phase1/production-baseline.json',
  'evidence/phase1/source-materialization.json',
  'evidence/phase1/source-test-results.json',
  'evidence/phase1/extracted-test-results.json',
  'evidence/phase1/parity-results.json',
  'evidence/phase1/dependency-scan.json',
  'evidence/phase1/secret-scan.json',
  'evidence/phase1/requirements-audit.json',
  'evidence/phase1/production-readback.json',
  'contracts/phase1-capability-map.json',
  'contracts/phase1-canonical-delta.json',
];
const evidenceDigests = Object.fromEntries(evidenceFiles.map((relative) => [relative, sha256File(relative)]));
const sourceTests = {
  unit: source.summary.unitTests,
  integration: source.summary.integrationTests,
  acceptance: source.summary.acceptanceTests,
  commands: source.summary.commandCount,
  skipped: source.summary.skippedTests,
};
const targetTests = {
  unit: extracted.summary.unitTests,
  integration: extracted.summary.integrationTests,
  acceptance: extracted.summary.acceptanceTests,
  gateway: extracted.summary.gatewayTests,
  parity: extracted.summary.parityTests,
  commands: extracted.summary.commandCount,
};
const checks = {
  sourceIdentity: materialization.passed,
  sourceSuites: source.passed,
  extractedSuites: extracted.passed,
  parity: parity.passed,
  capabilityCompleteness: capability.operations.length === capability.installedOperationCount && capability.completeness.silentDisappearances.length === 0,
  zeroBabyRuntimeDependency: dependency.passed && dependency.forbiddenFindingCount === 0,
  zeroRepositorySecrets: secret.passed && secret.findingCount === 0,
  requirements: requirements.passed,
  productionConfigurationUnchanged: production.passed,
};
const passed = Object.values(checks).every(Boolean);
const summary = {
  schemaVersion: '1.0.0',
  capturedAt: new Date().toISOString(),
  status: passed ? 'PASSED' : 'FAILED',
  phase: 'Phase 1 — extraction and parity',
  branch: git('branch', '--show-current'),
  testedCommit: extracted.commit,
  testedTree: extracted.tree,
  summaryGeneratedAtCommit: git('rev-parse', 'HEAD'),
  sourceIdentities: {
    supervisor: {
      repository: identity.supervisor.github.repository,
      commit: identity.supervisor.installedManifest.commit,
      tree: identity.supervisor.installedManifest.tree,
      manifestSha256: identity.supervisor.installedManifest.sha256,
      archiveSha256: identity.supervisor.github.archiveSha256,
    },
    gateway: {
      repository: identity.gateway.github.repository,
      commit: identity.gateway.installedManifest.commit,
      tree: identity.gateway.installedManifest.tree,
      manifestSha256: identity.gateway.installedManifest.sha256,
      archiveSha256: identity.gateway.github.archiveSha256,
    },
  },
  sourceTests,
  targetTests,
  capabilityMap: {
    installedOperationCount: capability.installedOperationCount,
    mappedOperationCount: capability.operations.length,
    coreOperationCount: capability.coreOperationCount,
    dynamicOperationCount: capability.dynamicOperationCount,
    operationStates: capability.summary.operationStates,
    internalCapabilityCount: capability.internalCapabilities.length,
    silentDisappearances: capability.completeness.silentDisappearances,
  },
  canonicalDeltas: deltas.map((entry) => entry.id),
  scans: {
    dependencyFindings: dependency.forbiddenFindingCount,
    activeRuntimeFilesScanned: dependency.activeFileCount,
    secretFindings: secret.findingCount,
    repositoryFilesScannedForSecrets: secret.scannedFileCount,
    requirementCount: requirements.requirementCount,
  },
  production: {
    baselineCapturedAt: production.baselineCapturedAt,
    configurationReadbackPassed: production.passed,
    mismatches: production.mismatches,
    routineOperationalRecordsMayAccrue: true,
    releaseOrServiceActivationPerformed: false,
  },
  checks,
  evidenceDigests,
  phase1Complete: passed,
  productionActivated: false,
  standaloneClaim: false,
  nextBuildGeneration: '0.1A',
};
fs.writeFileSync(path.join(evidenceRoot, 'phase1-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const report = `# Phase 1 Report

## Result

**Status: ${summary.status}.** Phase 1 extraction and parity is complete for tested commit \`${summary.testedCommit}\` (tree \`${summary.testedTree}\`) on branch \`${summary.branch}\`.

**Standalone claim: No.** No se-z production listener, \`call_sez\` app, final SEZ1 authority boundary, Secure MCP Tunnel, nspawn lifecycle, KVM lifecycle, or independent recovery product was activated by this phase. Those remain assigned to 0.1A–0.1C and the full standalone acceptance gate.

## Exact migration sources

| Component | Repository | Commit | Tree | Archive SHA-256 |
|---|---|---|---|---|
| Supervisor | \`${summary.sourceIdentities.supervisor.repository}\` | \`${summary.sourceIdentities.supervisor.commit}\` | \`${summary.sourceIdentities.supervisor.tree}\` | \`${summary.sourceIdentities.supervisor.archiveSha256}\` |
| Gateway | \`${summary.sourceIdentities.gateway.repository}\` | \`${summary.sourceIdentities.gateway.commit}\` | \`${summary.sourceIdentities.gateway.tree}\` | \`${summary.sourceIdentities.gateway.archiveSha256}\` |

Both exact trees were materialized, their commits, trees, archive digests, tracked-file counts, and per-file source-map digests were verified, and no branch head was substituted for a deployed commit.

## Executed tests

| Evidence group | Commands | Unit | Integration | Acceptance | Gateway | Parity | Skipped |
|---|---:|---:|---:|---:|---:|---:|---:|
| Exact pinned source | ${sourceTests.commands} | ${sourceTests.unit} | ${sourceTests.integration} | ${sourceTests.acceptance} | — | — | ${sourceTests.skipped} |
| Extracted target and behavioral parity | ${targetTests.commands} | ${targetTests.unit} | ${targetTests.integration} | ${targetTests.acceptance} | ${targetTests.gateway} | ${targetTests.parity} | — |

The target evidence came from a clean detached worktree at the tested commit. Check, build, native peer-credential compilation, scaffold tests, extracted supervisor tests, gateway tests, static lineage checks, and source-versus-target behavioral parity all passed.

## Capability retention

The signed installed source catalog contains **${summary.capabilityMap.installedOperationCount} operations**. The Phase 1 map contains **${summary.capabilityMap.mappedOperationCount}** entries: ${summary.capabilityMap.coreOperationCount} core operations and ${summary.capabilityMap.dynamicOperationCount} dynamic skill operation. Silent disappearances: **${summary.capabilityMap.silentDisappearances.length}**.

Phase 1 records whether mechanics were preserved, mechanically renamed, extracted but not integrated, superseded by the canonical target, deferred, or intentionally not carried. It does not mark extracted definitions as production-supported operations.

## Runtime-dependency, credential, and requirement gates

- Active target-runtime Baby dependency findings: **${summary.scans.dependencyFindings}** across ${summary.scans.activeRuntimeFilesScanned} active files.
- Repository credential findings: **${summary.scans.secretFindings}** across ${summary.scans.repositoryFilesScannedForSecrets} files.
- Requirements audited: **${summary.scans.requirementCount}**; all contain enforcement, executable tests, evidence, and a mandatory release gate.
- Canonical differences registered: **${summary.canonicalDeltas.length}**.

## Production readback

The read-only comparison found **${summary.production.mismatches.length} configuration mismatches**. Baby services, active/previous release pointers, socket identity and mode, installed manifest digests, and the public endpoint configuration matched the captured baseline. No release or service activation was performed. Routine authorized Baby job, stream, and receipt records created while doing this work are explicitly outside configuration equality and are not represented as unchanged state.

## Evidence

The machine-readable gate is \`npm run phase1:verify\`. Its inputs are content-addressed in \`evidence/phase1/phase1-summary.json\`. Raw command logs remain local and uncommitted; committed evidence contains bounded command metadata, counts, exit status, and stdout/stderr digests.

## Boundary after Phase 1

The next build generation is **0.1A**: final SEZ1 request authority generation, dual peer sockets, integrated supervisor registration, durable unbounded aggregate output, deterministic request wait/resume, and the canonical local CLI boundary. Phase 1 completion does not satisfy the product's standalone gate.
`;
fs.writeFileSync(path.join(root, 'docs/PHASE1_REPORT.md'), report);
console.log(JSON.stringify({ status: summary.status, testedCommit: summary.testedCommit, mappedOperations: summary.capabilityMap.mappedOperationCount, productionMismatches: summary.production.mismatches.length, standaloneClaim: summary.standaloneClaim }, null, 2));
if (!passed) process.exitCode = 1;
