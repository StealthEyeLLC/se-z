#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const sourcePath = path.join(root, 'contracts/requirements.yaml');
const outputPath = path.join(root, 'evidence/phase1/requirements-audit.json');
const writeEvidence = !process.argv.includes('--no-write');
const text = fs.readFileSync(sourcePath, 'utf8');
const starts = [...text.matchAll(/^  - id:\s*(\S+)\s*$/gmu)];
const requiredPhase1Ids = [
  'INV-PHASE1-SOURCE-001',
  'INV-PHASE1-PROVENANCE-001',
  'INV-PHASE1-PARITY-001',
  'INV-PHASE1-CAPABILITY-001',
  'INV-PHASE1-IDENTITY-001',
  'INV-PHASE1-RUNTIME-DEPENDENCY-001',
  'INV-PHASE1-PRODUCTION-001',
  'ANTI-PHASE1-REFACTOR-001',
  'ANTI-PHASE1-SECRET-001',
  'ANTI-PHASE1-CLAIM-001',
];
function scalar(block, key) {
  return block.match(new RegExp(`^    ${key}:\\s*(.+?)\\s*$`, 'mu'))?.[1] ?? null;
}
function list(block, key) {
  const value = scalar(block, key);
  if (value === null || !value.startsWith('[') || !value.endsWith(']')) return [];
  return value.slice(1, -1).split(',').map((entry) => entry.trim()).filter(Boolean);
}
const requirements = starts.map((match, index) => {
  const end = starts[index + 1]?.index ?? text.length;
  const block = text.slice(match.index, end);
  const requirement = {
    id: match[1],
    class: scalar(block, 'class'),
    statement: scalar(block, 'statement'),
    enforcedBy: list(block, 'enforcedBy'),
    tests: list(block, 'tests'),
    evidence: list(block, 'evidence'),
    releaseGate: scalar(block, 'releaseGate'),
  };
  const missing = [];
  if (!['invariant', 'anti-invariant'].includes(requirement.class)) missing.push('class');
  if (!requirement.statement) missing.push('statement');
  if (requirement.enforcedBy.length === 0) missing.push('enforcedBy');
  if (requirement.tests.length === 0) missing.push('tests');
  if (requirement.evidence.length === 0) missing.push('evidence');
  if (requirement.releaseGate !== 'mandatory') missing.push('releaseGate');
  return { ...requirement, missing, passed: missing.length === 0 };
});
const ids = requirements.map((entry) => entry.id);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
const missingPhase1Ids = requiredPhase1Ids.filter((id) => !ids.includes(id));
const result = {
  schemaVersion: '1.0.0',
  capturedAt: new Date().toISOString(),
  source: 'contracts/requirements.yaml',
  requirementCount: requirements.length,
  requiredPhase1Ids,
  missingPhase1Ids,
  duplicates,
  requirements,
  passed: requirements.length > 0
    && requirements.every((entry) => entry.passed)
    && duplicates.length === 0
    && missingPhase1Ids.length === 0,
};
if (writeEvidence) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify({ requirementCount: result.requirementCount, missingPhase1Ids, duplicates, passed: result.passed }, null, 2));
if (!result.passed) process.exitCode = 1;
