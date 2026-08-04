import fs from 'node:fs';
import path from 'node:path';
import { ACTIVE_OPERATION_NAMES, CATALOG_DIGEST } from '../../src/kernel/definitions.mjs';

const readJson = (file, required = true) => {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`missing ${file}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const packageResult = readJson('evidence/phase3/package-reproducibility.json');
const finalPackage = readJson('evidence/phase3/final-package.json', false) ?? packageResult;
const nspawn = readJson('evidence/phase3/nspawn-acceptance.json', false);
const hostCandidate = readJson('evidence/phase3/host-candidate.json', false);
const productionReadback = readJson('evidence/phase3/production-readback.json', false);
const githubCleanup = readJson('evidence/phase3/github-cleanup-results.json', false);
const detachedVerification = readJson('evidence/phase3/final-detached-verification.json', false);
const blockers = readJson('evidence/phase3/external-blockers.json');
const phase3Operations = readJson('contracts/operations-0.1b.json');

const independentChecks = {
  packageReproducibility: packageResult.passed === true,
  finalPackage: finalPackage.passed === true,
  nspawnAcceptance: nspawn?.passed === true && nspawn?.cleanup?.passed === true,
  hostCandidateAcceptance: hostCandidate?.passed === true && hostCandidate?.cleanup?.passed === true,
  productionReadback: productionReadback?.passed === true && productionReadback?.mismatches?.length === 0,
  githubProofCleanup: githubCleanup?.passed === true,
  detachedVerification: detachedVerification?.passed === true && detachedVerification?.consecutiveVerifierPasses >= 2,
};
const independentComplete = Object.values(independentChecks).every(Boolean);
const remainingMandatoryGates = blockers.remaining.filter((item) => item.mandatory).map((item) => item.gate);
const externalOnly = blockers.remaining.every((item) => item.classification === 'external_openai_platform' || item.classification === 'external_dns');
const verdict = independentComplete && externalOnly
  ? 'PHASE 3 INCOMPLETE — ALL INDEPENDENT WORK COMPLETE; EXTERNAL OPENAI/DNS GATES REMAIN'
  : 'PHASE 3 INCOMPLETE';

const out = {
  schemaVersion: '1.0.0',
  verdict,
  independentImplementation: independentComplete ? 'complete_and_verified' : 'incomplete',
  independentChecks,
  remainingMandatoryGates,
  package: {
    passed: finalPackage.passed === true,
    sha256: finalPackage.sha256,
    size: finalPackage.size,
    archive: path.basename(finalPackage.archive ?? packageResult.archive ?? ''),
    implementationCommit: finalPackage.implementationCommit ?? packageResult.implementationCommit ?? null,
    implementationTree: finalPackage.implementationTree ?? packageResult.implementationTree ?? null,
  },
  catalogDigest: CATALOG_DIGEST,
  activeOperationCount: ACTIVE_OPERATION_NAMES.length,
  phase3OperationCount: phase3Operations.operations.length,
  productionActive: false,
  standaloneComplete: false,
};
fs.writeFileSync('evidence/phase3/phase3-summary.json', `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out));
