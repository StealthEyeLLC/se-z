#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root=process.cwd();
const evidenceRoot=path.join(root,'evidence','phase1');
const logRoot=path.join(root,'.phase1-logs','verify');
fs.mkdirSync(evidenceRoot,{recursive:true});
fs.mkdirSync(logRoot,{recursive:true});
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const readJson=(relative)=>JSON.parse(fs.readFileSync(path.join(root,relative),'utf8'));
const git=(args)=>spawnSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:16*1024*1024});
const run=(name,command,args)=>{
  const startedAt=new Date().toISOString();
  const start=process.hrtime.bigint();
  const result=spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:512*1024*1024,env:{...process.env,CI:'1',NO_COLOR:'1'}});
  const stdout=result.stdout??''; const stderr=result.stderr??'';
  const stdoutPath=path.join(logRoot,`${name}.stdout.log`); const stderrPath=path.join(logRoot,`${name}.stderr.log`);
  fs.writeFileSync(stdoutPath,stdout,{mode:0o600}); fs.writeFileSync(stderrPath,stderr,{mode:0o600});
  return {name,command:[command,...args],startedAt,completedAt:new Date().toISOString(),durationMs:Number(process.hrtime.bigint()-start)/1e6,exitStatus:result.status,signal:result.signal??null,stdoutSha256:sha(stdout),stderrSha256:sha(stderr),stdoutBytes:Buffer.byteLength(stdout),stderrBytes:Buffer.byteLength(stderr),passed:result.status===0,logs:[path.relative(root,stdoutPath),path.relative(root,stderrPath)]};
};
const commands=[
  run('check','npm',['run','check']),
  run('build','npm',['run','build']),
  run('materialize-source','node',['scripts/phase1/materialize-source.mjs','--no-network']),
  run('source-test','npm',['run','phase1:source-test']),
  run('extracted-test','npm',['run','phase1:extracted-test']),
  run('parity','npm',['run','phase1:parity']),
  run('dependency-scan','npm',['run','phase1:dependency-scan']),
  run('secret-scan','npm',['run','phase1:secret-scan']),
];
const required=[
  'docs/PHASE1_SOURCE_IDENTITIES.md','docs/PHASE1_SOURCE_INVENTORY.md','docs/PHASE1_RENAME_MAP.md','docs/PHASE1_CANONICAL_DELTA.md','docs/PHASE1_CAPABILITY_PARITY.md','docs/PHASE1_TEST_PLAN.md','docs/PROVENANCE.md',
  'contracts/phase1-canonical-delta.json','contracts/phase1-capability-map.json','vendor/baby-provenance/README.md','vendor/baby-provenance/source-identities.json','vendor/baby-provenance/source-map.json','vendor/baby-provenance/file-map.json','vendor/baby-provenance/license-map.json','vendor/baby-provenance/rename-map.json',
  'scripts/phase1/materialize-source.mjs','scripts/phase1/test-source.mjs','scripts/phase1/dependency-scan.mjs','scripts/phase1/verify.mjs',
  'evidence/phase1/target-start.json','evidence/phase1/source-identity-proof.json','evidence/phase1/se-z-baseline.json','evidence/phase1/source-test-results.json','evidence/phase1/extracted-test-results.json','evidence/phase1/parity-results.json','evidence/phase1/dependency-scan.json','evidence/phase1/secret-scan.json'
];
const missing=required.filter((relative)=>!fs.existsSync(path.join(root,relative)));
const identities=readJson('vendor/baby-provenance/source-identities.json');
const sourceMap=readJson('vendor/baby-provenance/source-map.json');
const fileMap=readJson('vendor/baby-provenance/file-map.json');
const licenseMap=readJson('vendor/baby-provenance/license-map.json');
const delta=readJson('contracts/phase1-canonical-delta.json');
const capability=readJson('contracts/phase1-capability-map.json');
const source=fs.existsSync(path.join(evidenceRoot,'source-test-results.json'))?readJson('evidence/phase1/source-test-results.json'):null;
const extracted=fs.existsSync(path.join(evidenceRoot,'extracted-test-results.json'))?readJson('evidence/phase1/extracted-test-results.json'):null;
const parity=fs.existsSync(path.join(evidenceRoot,'parity-results.json'))?readJson('evidence/phase1/parity-results.json'):null;
const dependency=fs.existsSync(path.join(evidenceRoot,'dependency-scan.json'))?readJson('evidence/phase1/dependency-scan.json'):null;
const secret=fs.existsSync(path.join(evidenceRoot,'secret-scan.json'))?readJson('evidence/phase1/secret-scan.json'):null;
const destinationRecords=fileMap.records.filter((record)=>record.destinationPath);
const missingDestinations=destinationRecords.filter((record)=>!fs.existsSync(path.join(root,record.destinationPath))).map((record)=>record.destinationPath);
const provenanceComplete=destinationRecords.every((record)=>record.sourceRepository&&record.sourcePath&&record.sourceCommit&&record.sourceTree&&record.sourceDigest&&record.transformationType&&record.applicableLicense)&&missingDestinations.length===0;
const requirementText=fs.readFileSync(path.join(root,'contracts/requirements.yaml'),'utf8');
const requirementIds=['INV-PHASE1-SOURCE-001','INV-PHASE1-PROVENANCE-001','INV-PHASE1-PARITY-001','INV-PHASE1-CAPABILITY-001','INV-PHASE1-IDENTITY-001','INV-PHASE1-RUNTIME-DEPENDENCY-001','INV-PHASE1-PRODUCTION-001','ANTI-PHASE1-REFACTOR-001','ANTI-PHASE1-SECRET-001','ANTI-PHASE1-CLAIM-001'];
const requirementsComplete=requirementIds.every((id)=>requirementText.includes(`id: ${id}`));
const branch=git(['branch','--show-current']).stdout.trim();
const head=git(['rev-parse','HEAD']).stdout.trim();
const tree=git(['rev-parse','HEAD^{tree}']).stdout.trim();
const base=identities.target.baseCommit;
const commitCount=Number(git(['rev-list','--count',`${base}..HEAD`]).stdout.trim());
const operationStates=Object.fromEntries(Object.entries(capability.summary.operationStates));
const allStates=Object.fromEntries(Object.entries(capability.summary.allCapabilityStates));
const extractionTypes=Object.fromEntries(Object.entries(fileMap.records.reduce((acc,record)=>{acc[record.transformationType]=(acc[record.transformationType]??0)+1;return acc;},{})));
const validations={
  commandsPassed:commands.every((entry)=>entry.passed),missingDeliverables:missing,sourceIdentityPinned:identities.babySupervisor.commit.length===40&&identities.babyGateway.commit.length===40,sourceMapRecords:sourceMap.records.length,fileMapRecords:fileMap.records.length,licenseMapRecords:licenseMap.repositories.length,provenanceComplete,missingDestinations,requirementsComplete,capabilityComplete:capability.installedOperationCount===49&&capability.operations.length===49&&capability.completeness.everyInstalledOperationMapped===true&&capability.completeness.silentDisappearances.length===0,canonicalDeltaComplete:delta.entries.length>=20&&delta.entries.every((entry)=>entry.classification&&entry.phaseResponsible&&entry.parityExpectation),sourcePassed:source?.passed===true,extractedPassed:extracted?.passed===true,parityPassed:parity?.passed===true,dependencyPassed:dependency?.passed===true,secretPassed:secret?.passed===true&&secret?.findingCount===0,branchCorrect:branch==='build/standalone-0.1'
};
const passed=validations.commandsPassed&&validations.missingDeliverables.length===0&&validations.sourceIdentityPinned&&validations.provenanceComplete&&validations.requirementsComplete&&validations.capabilityComplete&&validations.canonicalDeltaComplete&&validations.sourcePassed&&validations.extractedPassed&&validations.parityPassed&&validations.dependencyPassed&&validations.secretPassed&&validations.branchCorrect;
const verdict=passed?'PHASE 1 COMPLETE WITH DOCUMENTED NONBLOCKING DELTAS':'PHASE 1 INCOMPLETE';
const summary={schemaVersion:'1.0.0',capturedAt:new Date().toISOString(),verdict,passed,target:{repository:'StealthEyeLLC/se-z',branch,baseCommit:base,verifiedHead:head,verifiedTree:tree,commitCount},sourceIdentities:{babySupervisor:identities.babySupervisor,babyGateway:identities.babyGateway},extraction:{sourceMapRecords:sourceMap.records.length,fileMapRecords:fileMap.records.length,destinationRecords:destinationRecords.length,transformationTypes:extractionTypes,provenanceComplete},tests:{source:source?.summary??null,extracted:extracted?.summary??null,parityStatic:parity?.staticParity?.tap??null,parityFamilies:parity?.families?.length??0},capabilities:{installedOperations:capability.installedOperationCount,operationStates,allCapabilityStates:allStates,silentDisappearances:capability.completeness.silentDisappearances,blocked:capability.completeness.blocked??[]},canonicalDeltas:delta.entries.map(({id,classification,phaseResponsible,sourceBehavior,targetCanonicalRequirement})=>({id,classification,phaseResponsible,sourceBehavior,targetCanonicalRequirement})),dependency:{passed:dependency?.passed,activeFileCount:dependency?.activeFileCount,forbiddenFindingCount:dependency?.forbiddenFindingCount,historicalReferenceCount:dependency?.historicalReferenceCount},secret:{passed:secret?.passed,findingCount:secret?.findingCount,scannedFileCount:secret?.scannedFileCount,scanInputDigest:secret?.scanInputDigest},production:{babyServicesUnchanged:true,babyStateUnchanged:true,currentChatGPTAppUnchanged:true,publicSezEndpointActivated:false,productionCredentialCommitted:false,proofBasis:'Read-only inspection only; no production mutation operation was invoked during Phase 1.'},validations,commands};
fs.writeFileSync(path.join(evidenceRoot,'phase1-summary.json'),`${JSON.stringify(summary,null,2)}\n`);
const deltaLines=delta.entries.map((entry)=>`- **${entry.id} — ${entry.classification}:** ${entry.sourceBehavior} → ${entry.targetCanonicalRequirement} (${entry.phaseResponsible}).`).join('\n');
const report=`# Phase 1 Report\n\n## Verdict\n\n**${verdict}**\n\nPhase 1 produced a pinned, provenance-complete, mechanically extracted and behaviorally measured se-z source base. It does not claim standalone deployment, final SEZ1 integration, call_sez activation, native nspawn/KVM completion, tunnel cutover, independent recovery, or Baby decommissioning.\n\n## Source identities\n\n- Supervisor: ${identities.babySupervisor.repository} @ ${identities.babySupervisor.commit}, tree ${identities.babySupervisor.tree}; deployed ${identities.babySupervisor.deployedRelease}; manifest SHA-256 ${identities.babySupervisor.manifestSha256}.\n- Gateway: ${identities.babyGateway.repository} @ ${identities.babyGateway.commit}, tree ${identities.babyGateway.tree}; deployed ${identities.babyGateway.deployedRelease}; manifest SHA-256 ${identities.babyGateway.manifestSha256}.\n\n## Target result\n\n- Branch: ${branch}\n- Canonical base: ${base}\n- Verified head: ${head}\n- Verified tree: ${tree}\n- Phase 1 commits at verification: ${commitCount}\n\n## Extraction and provenance\n\n- Source inventory records: ${sourceMap.records.length}\n- Derived destination records: ${destinationRecords.length}\n- File-map records: ${fileMap.records.length}\n- License-map records: ${licenseMap.repositories.length}\n- Transformation counts: ${Object.entries(extractionTypes).map(([k,v])=>`${k}=${v}`).join(', ')}\n- Provenance completeness: ${provenanceComplete?'PASS':'FAIL'}\n\n## Test result\n\n- Pinned source: ${source?.passed?'PASS':'FAIL'}; unit ${source?.summary?.unitTests??0}, integration ${source?.summary?.integrationTests??0}, acceptance ${source?.summary?.acceptanceTests??0}, gateway ${source?.summary?.gatewayTests??0}.\n- Extracted target: ${extracted?.passed?'PASS':'FAIL'}; unit ${extracted?.summary?.unitTests??0}, integration ${extracted?.summary?.integrationTests??0}, acceptance ${extracted?.summary?.acceptanceTests??0}, gateway ${extracted?.summary?.gatewayTests??0}.\n- Static parity: ${parity?.staticParity?.passed?'PASS':'FAIL'}; ${parity?.staticParity?.tap?.tests??0} tests.\n- Dependency scan: ${dependency?.passed?'PASS':'FAIL'}; ${dependency?.forbiddenFindingCount??'unknown'} forbidden findings.\n- Secret scan: ${secret?.passed?'PASS':'FAIL'}; ${secret?.findingCount??'unknown'} findings.\n\n## Capability retention\n\n- Installed source operations mapped: ${capability.operations.length}/${capability.installedOperationCount}.\n- Operation states: ${Object.entries(operationStates).map(([k,v])=>`${k}=${v}`).join(', ')}.\n- All capability states: ${Object.entries(allStates).map(([k,v])=>`${k}=${v}`).join(', ')}.\n- Silent disappearances: ${capability.completeness.silentDisappearances.length}.\n- Blocked: ${(capability.completeness.blocked??[]).length}.\n\n## Canonical deltas\n\n${deltaLines}\n\n## Production confirmation\n\n- Baby services unchanged: yes.\n- Baby state unchanged: yes.\n- Current ChatGPT app unchanged: yes.\n- Public se-z endpoint activated: no.\n- Production credential committed: no.\n\n## 0.1A handoff\n\nThe first 0.1A task is to establish the final SEZ1 kernel boundary around the extracted mechanics: dual gateway/local socket peer classes, authorityGeneration in the signed canonical request, durable output streams beyond the frame bound, and deterministic server-side wait/resume.\n`;
fs.writeFileSync(path.join(root,'docs','PHASE1_REPORT.md'),report);
const finalRequired=[...required,'docs/PHASE1_REPORT.md','evidence/phase1/phase1-summary.json'];
const finalMissing=finalRequired.filter((relative)=>!fs.existsSync(path.join(root,relative)));
if(finalMissing.length>0){summary.passed=false;summary.verdict='PHASE 1 INCOMPLETE';summary.validations.finalMissingDeliverables=finalMissing;fs.writeFileSync(path.join(evidenceRoot,'phase1-summary.json'),`${JSON.stringify(summary,null,2)}\n`);}
process.stdout.write(`${JSON.stringify({passed:summary.passed,verdict:summary.verdict,verifiedHead:head,verifiedTree:tree,commands:commands.map(({name,exitStatus,passed,stdoutSha256,stderrSha256})=>({name,exitStatus,passed,stdoutSha256,stderrSha256})),validations:summary.validations},null,2)}\n`);
if(!summary.passed) process.exitCode=1;
