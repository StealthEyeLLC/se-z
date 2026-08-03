#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root=process.cwd();
const evidenceRoot=path.join(root,'evidence','phase1');
const read=(name)=>JSON.parse(fs.readFileSync(path.join(evidenceRoot,name),'utf8'));
const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const parseTap=(text)=>{
  const result={};
  for(const match of text.matchAll(/^(?:#|ℹ)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gmu)) result[match[1]]=Number(match[2]);
  const duration=[...text.matchAll(/^(?:#|ℹ)\s+duration_ms\s+([0-9.]+)\s*$/gmu)].at(-1)?.[1];
  if(duration) result.durationMs=Number(duration);
  return result;
};
const source=read('source-test-results.json');
const extracted=read('extracted-test-results.json');
const capability=JSON.parse(fs.readFileSync(path.join(root,'contracts','phase1-capability-map.json'),'utf8'));
const delta=JSON.parse(fs.readFileSync(path.join(root,'contracts','phase1-canonical-delta.json'),'utf8'));
const matrix=JSON.parse(fs.readFileSync(path.join(root,'test','parity','fixtures','family-matrix.json'),'utf8'));
const staticRun=spawnSync('npm',['run','test:parity:static'],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,CI:'1',NO_COLOR:'1'}});
const staticOutput=`${staticRun.stdout??''}\n${staticRun.stderr??''}`;
const staticTap=parseTap(staticOutput);
const sourceBytes=fs.readFileSync(path.join(evidenceRoot,'source-test-results.json'));
const extractedBytes=fs.readFileSync(path.join(evidenceRoot,'extracted-test-results.json'));
const familyResults=Object.entries(matrix.families).map(([family,entry])=>({
  family,
  implementationFiles:entry.implementation,
  targetTestFiles:entry.tests,
  sourceReferencePassed:source.passed===true,
  extractedPassed:extracted.passed===true,
  staticCoveragePassed:staticRun.status===0,
  status:source.passed===true&&extracted.passed===true&&staticRun.status===0?'PASSED':'FAILED',
}));
const result={
  schemaVersion:'1.0.0',
  capturedAt:new Date().toISOString(),
  strategy:'Exact pinned source suites plus mechanically ported target suites, semantic family coverage, dynamic-value normalization, and explicit canonical-delta classification.',
  sourceEvidence:{sha256:sha(sourceBytes),passed:source.passed,summary:source.summary},
  extractedEvidence:{sha256:sha(extractedBytes),passed:extracted.passed,summary:extracted.summary},
  staticParity:{command:['npm','run','test:parity:static'],exitStatus:staticRun.status,stdoutSha256:sha(staticRun.stdout??''),stderrSha256:sha(staticRun.stderr??''),tap:staticTap,passed:staticRun.status===0},
  normalization:['UUIDs','timestamps','temporary paths','PIDs','job IDs','session IDs','artifact IDs','receipt IDs','request IDs','nonces','fixture key IDs','signatures','release paths','hostnames','machine identities','stream handles'],
  retainedSemantics:['state','terminal status','exit code','signal','stdout bytes','stderr bytes','stream offsets','stream completion','file bytes','file modes','digests','error type','idempotency','replay','receipt verification','operation schemas','cleanup state'],
  families:familyResults,
  capability:{installedOperationCount:capability.installedOperationCount,mappedOperationCount:capability.operations.length,everyInstalledOperationMapped:capability.completeness.everyInstalledOperationMapped,silentDisappearances:capability.completeness.silentDisappearances},
  canonicalDeltas:{count:delta.entries.length,entries:delta.entries.map(({id,classification,phaseResponsible,parityExpectation})=>({id,classification,phaseResponsible,parityExpectation}))},
  passed:source.passed===true&&extracted.passed===true&&staticRun.status===0&&familyResults.every((entry)=>entry.status==='PASSED')&&capability.completeness.everyInstalledOperationMapped===true&&capability.completeness.silentDisappearances.length===0,
};
fs.mkdirSync(evidenceRoot,{recursive:true});
fs.writeFileSync(path.join(evidenceRoot,'parity-results.json'),`${JSON.stringify(result,null,2)}\n`);
process.stdout.write(`${JSON.stringify({passed:result.passed,staticParity:result.staticParity.tap,families:familyResults.length,canonicalDeltas:result.canonicalDeltas.count,capability:result.capability},null,2)}\n`);
if(!result.passed) process.exitCode=1;
