#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const requireClean = process.argv.includes('--require-clean');
const failures = [];
const requiredFiles = [
  'docs/PHASE1_REPORT.md',
  'contracts/phase1-capability-map.json',
  'evidence/phase1/source-materialization.json',
  'evidence/phase1/source-test-results.json',
  'evidence/phase1/extracted-test-results.json',
  'evidence/phase1/parity-results.json',
  'evidence/phase1/dependency-scan.json',
  'evidence/phase1/secret-scan.json',
  'evidence/phase1/requirements-audit.json',
  'evidence/phase1/production-readback.json',
  'evidence/phase1/phase1-summary.json',
];
for (const relative of requiredFiles) if (!fs.existsSync(path.join(root, relative))) failures.push(`missing required file: ${relative}`);
function read(relative) { return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')); }
function sha256(relative) { return createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex'); }
function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function git(args, options = {}) { return spawnSync('git', ['-C', root, ...args], { encoding: options.encoding ?? 'utf8', maxBuffer: 16 * 1024 * 1024 }); }
function gitBlob(commit, relative) {
  const value = git(['show', `${commit}:${relative}`], { encoding: 'buffer' });
  if (value.status !== 0) throw new Error(value.stderr?.toString().trim() || `unable to read ${relative} at ${commit}`);
  return value.stdout;
}
function check(condition, message) { if (!condition) failures.push(message); }
if (failures.length === 0) {
  const materialization = read('evidence/phase1/source-materialization.json');
  const source = read('evidence/phase1/source-test-results.json');
  const extracted = read('evidence/phase1/extracted-test-results.json');
  const parity = read('evidence/phase1/parity-results.json');
  const dependency = read('evidence/phase1/dependency-scan.json');
  const secret = read('evidence/phase1/secret-scan.json');
  const requirements = read('evidence/phase1/requirements-audit.json');
  const production = read('evidence/phase1/production-readback.json');
  const summary = read('evidence/phase1/phase1-summary.json');
  const capability = read('contracts/phase1-capability-map.json');
  check(materialization.passed === true && materialization.components.length === 2, 'source materialization did not pass for both components');
  for (const component of materialization.components) {
    check(component.commit === component.expectedCommit, `${component.component} commit mismatch`);
    check(component.tree === component.expectedTree, `${component.component} tree mismatch`);
    check(component.archiveSha256 === component.expectedArchiveSha256, `${component.component} archive mismatch`);
    check(component.trackedFileCount === component.expectedTrackedFileCount, `${component.component} tracked-file count mismatch`);
    check(component.sourceDigestMismatchCount === 0, `${component.component} source-map digest mismatches`);
    check(component.trackedFilesClean === true, `${component.component} pinned source has tracked modifications`);
  }
  check(source.passed === true && source.commands.every((entry) => entry.passed), 'one or more exact source commands failed');
  check(extracted.passed === true && extracted.commands.every((entry) => entry.passed), 'one or more extracted target commands failed');
  check(extracted.cleanDetachedWorktree === true && extracted.worktreeStatusAfterTests === '', 'target evidence was not produced from a clean deterministic worktree');
  check(parity.passed === true && parity.families.every((entry) => entry.status === 'PASSED'), 'parity evidence failed');
  check(capability.operations.length === capability.installedOperationCount, 'installed operation map is incomplete');
  check(capability.completeness.silentDisappearances.length === 0, 'capability map contains silent disappearances');
  check(capability.operations.every((entry) => entry.productionSupportedOperation === false), 'Phase 1 capability map marks an operation production-supported');
  check(dependency.passed === true && dependency.forbiddenFindingCount === 0, 'active runtime Baby dependency scan failed');
  check(secret.passed === true && secret.findingCount === 0, 'repository secret scan failed');
  check(requirements.passed === true && requirements.missingPhase1Ids.length === 0 && requirements.duplicates.length === 0, 'requirements audit failed');
  check(production.passed === true && production.mismatches.length === 0 && production.secretsReadOrCaptured === false, 'production readback mismatch');
  check(summary.status === 'PASSED' && summary.phase1Complete === true, 'Phase 1 summary is not passed');
  check(summary.productionActivated === false, 'summary incorrectly claims production activation');
  check(summary.standaloneClaim === false, 'summary incorrectly claims standalone completion');
  check(summary.testedCommit === extracted.commit && summary.testedTree === extracted.tree, 'summary is not bound to extracted-test commit/tree');
  const evidenceBoundaryResult = git(['log', '--diff-filter=A', '--format=%H', '--', 'evidence/phase1/phase1-summary.json']);
  const evidenceBoundary = evidenceBoundaryResult.stdout.trim().split('\n').filter(Boolean).at(-1);
  check(Boolean(evidenceBoundary), 'unable to locate immutable Phase 1 evidence commit');
  if (evidenceBoundary) {
    check(git(['merge-base', '--is-ancestor', summary.testedCommit, evidenceBoundary]).status === 0, 'Phase 1 evidence commit does not descend from tested commit');
    check(git(['merge-base', '--is-ancestor', evidenceBoundary, 'HEAD']).status === 0, 'Phase 1 evidence commit is not an ancestor of HEAD');
    for (const [relative, expected] of Object.entries(summary.evidenceDigests)) {
      try { check(sha256Bytes(gitBlob(evidenceBoundary, relative)) === expected, `historical evidence digest mismatch: ${relative}`); }
      catch (error) { failures.push(error.message); }
    }
    const immutableHistoricalPaths = [
      ...requiredFiles.filter((relative) => relative.startsWith('evidence/phase1/')),
      'docs/PHASE1_REPORT.md',
      'contracts/phase1-capability-map.json',
    ];
    for (const relative of immutableHistoricalPaths) {
      try { check(sha256Bytes(gitBlob(evidenceBoundary, relative)) === sha256(relative), `immutable Phase 1 evidence changed after ${evidenceBoundary}: ${relative}`); }
      catch (error) { failures.push(error.message); }
    }
    const evidenceOnly = git(['diff', '--name-only', `${summary.testedCommit}..${evidenceBoundary}`]);
    if (evidenceOnly.status !== 0) failures.push(evidenceOnly.stderr.trim() || 'unable to inspect Phase 1 evidence-only commit');
    else {
      const unexpected = evidenceOnly.stdout.trim().split('\n').filter(Boolean).filter((relative) => !(relative.startsWith('evidence/phase1/') || relative === 'docs/PHASE1_REPORT.md'));
      check(unexpected.length === 0, `Phase 1 evidence commit changed implementation: ${unexpected.join(', ')}`);
    }
  }
  const testedTree = git(['rev-parse', `${summary.testedCommit}^{tree}`]);
  check(testedTree.status === 0 && testedTree.stdout.trim() === summary.testedTree, 'tested commit tree no longer matches immutable Phase 1 summary');
  const report = fs.readFileSync(path.join(root, 'docs/PHASE1_REPORT.md'), 'utf8');
  check(report.includes(summary.testedCommit), 'Phase 1 report does not identify the tested commit');
  check(report.includes('Standalone claim: No'), 'Phase 1 report does not preserve the standalone boundary');
}
const diffCheck = git(['diff', '--check']);
if (diffCheck.status !== 0) failures.push(diffCheck.stdout.trim() || diffCheck.stderr.trim() || 'git diff --check failed');
const stagedDiffCheck = git(['diff', '--cached', '--check']);
if (stagedDiffCheck.status !== 0) failures.push(stagedDiffCheck.stdout.trim() || stagedDiffCheck.stderr.trim() || 'git diff --cached --check failed');
if (requireClean) {
  const status = git(['status', '--porcelain=v1']);
  if (status.status !== 0 || status.stdout !== '') failures.push(`working tree is not clean: ${status.stdout.trim()}`);
}
const result = {
  schemaVersion: '1.0.0',
  verifiedAt: new Date().toISOString(),
  requireClean,
  failureCount: failures.length,
  failures,
  passed: failures.length === 0,
};
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
