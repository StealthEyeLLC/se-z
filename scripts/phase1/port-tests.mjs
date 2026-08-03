import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { SOURCE_IDENTITIES, applyMechanicalIdentity } from './source-layout.mjs';

const root = process.cwd();
const sourceRoots = {
  supervisor: process.env.SEZ_PHASE1_SUPERVISOR_SOURCE ?? path.resolve(root, '../sources/baby-quirt'),
  gateway: process.env.SEZ_PHASE1_GATEWAY_SOURCE ?? path.resolve(root, '../sources/baby-quirt-mcp')
};
const selected = process.argv.includes('--gateway') ? ['gateway'] : process.argv.includes('--supervisor') ? ['supervisor'] : ['supervisor','gateway'];
const sourceMapPath = path.join(root,'vendor/baby-provenance/source-map.json');
const fileMapPath = path.join(root,'vendor/baby-provenance/file-map.json');
const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath,'utf8'));
const fileMap = JSON.parse(fs.readFileSync(fileMapPath,'utf8'));

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function git(sourceRoot,args) { return execFileSync('git',['-C',sourceRoot,...args],{encoding:'utf8'}).trim(); }
function normalize(value) { return path.posix.normalize(value.replaceAll('\\','/')); }
function isText(bytes) { return !bytes.includes(0); }
function tracked(sourceRoot) { return git(sourceRoot,['ls-tree','-r','--name-only','HEAD']).split('\n').filter(Boolean); }
function readBytes(sourceRoot,sourcePath) {
  const full=path.join(sourceRoot,sourcePath);
  const stat=fs.lstatSync(full);
  return stat.isSymbolicLink()?Buffer.from(fs.readlinkSync(full)):fs.readFileSync(full);
}
function isSourceOnlyTest(component, sourcePath) {
  if (component === 'supervisor') return ['test/nspawn-bootstrap.test.ts', 'test/standalone-architecture.test.ts'].includes(sourcePath);
  if (component === 'gateway') return [
    'test/deployment.test.js',
    'test/release-v2.test.js',
    'test/standalone-architecture.test.js',
  ].includes(sourcePath);
  return false;
}
function testDestination(component,sourcePath) {
  if (isSourceOnlyTest(component, sourcePath)) return null;
  if (component==='supervisor') {
    if (sourcePath.startsWith('test/')) return `test/extracted/supervisor/unit/${sourcePath.slice(5)}`;
    if (sourcePath.startsWith('integration/')) return `test/extracted/supervisor/integration/${sourcePath.slice(12)}`;
    if (sourcePath.startsWith('acceptance/')) return `test/extracted/supervisor/acceptance/${sourcePath.slice(11)}`;
    if (sourcePath.startsWith('schemas/')) return `test/extracted/supervisor/fixtures/source-adapted/${sourcePath}`;
    if (sourcePath.startsWith('contracts/')) return `test/extracted/supervisor/fixtures/source-adapted/${sourcePath}`;
    if (sourcePath.startsWith('.github/workflows/')) return `test/extracted/supervisor/fixtures/source-adapted/repository/${sourcePath}`;
  }
  if (component==='gateway' && sourcePath.startsWith('test/')) return `test/extracted/gateway/${sourcePath.slice(5)}`;
  return null;
}
function header(destinationPath,text,component,sourcePath) {
  const line=`Derived test fixture: ${SOURCE_IDENTITIES[component].repository}@${SOURCE_IDENTITIES[component].commit}:${sourcePath}; exact lineage in vendor/baby-provenance/file-map.json.`;
  if (text.startsWith('#!')) { const at=text.indexOf('\n'); return `${text.slice(0,at+1)}// ${line}\n${text.slice(at+1)}`; }
  if (/\.(?:ts|js|mjs|cjs)$/u.test(destinationPath)) return `// ${line}\n${text}`;
  return text;
}

for (const component of selected) {
  const targetRoot = component === 'supervisor' ? path.join(root, 'test/extracted/supervisor') : path.join(root, 'test/extracted/gateway');
  fs.rmSync(targetRoot, {recursive:true, force:true});
}
const componentRepo = {supervisor:SOURCE_IDENTITIES.supervisor.repository,gateway:SOURCE_IDENTITIES.gateway.repository};
const destinations = new Map(sourceMap.records.filter((r)=>r.destinationPath).map((r)=>[`${r.sourceRepository}:${r.sourcePath}`,r.destinationPath]));
for (const component of selected) {
  const repo=componentRepo[component];
  for (const sourcePath of tracked(sourceRoots[component])) {
    const destination=testDestination(component,sourcePath);
    if (destination) destinations.set(`${repo}:${sourcePath}`,destination);
  }
}

function resolve(component,sourcePath,specifier) {
  if (!specifier.startsWith('.')) return null;
  const repo=componentRepo[component];
  const base=normalize(path.posix.join(path.posix.dirname(sourcePath),specifier));
  const candidates=[base];
  if (base.endsWith('.js')) candidates.push(`${base.slice(0,-3)}.ts`);
  if (base.endsWith('.mjs')) candidates.push(`${base.slice(0,-4)}.ts`);
  if (!path.posix.extname(base)) candidates.push(`${base}.ts`,`${base}.js`,`${base}.json`,`${base}/index.ts`,`${base}/index.js`);
  for (const candidate of candidates) {
    const destination=destinations.get(`${repo}:${candidate}`);
    if (destination) return {sourcePath:candidate,destination};
  }
  return null;
}
function rewriteImports(component,sourcePath,destinationPath,text) {
  return text.replace(/(['"])(\.\.?\/[^'"\n]+)\1/gu,(whole,quote,specifier)=>{
    const resolved=resolve(component,sourcePath,specifier);
    if (!resolved) return whole;
    let target=resolved.destination;
    if (specifier.endsWith('.js') && target.endsWith('.ts')) target=`${target.slice(0,-3)}.js`;
    let relative=path.posix.relative(path.posix.dirname(destinationPath),target);
    if (!relative.startsWith('.')) relative=`./${relative}`;
    return `${quote}${relative}${quote}`;
  });
}
function rewriteRootPaths(component,sourcePath,destinationPath,text) {
  let output=text;
  if (component==='supervisor') {
    output=output.replaceAll("join(import.meta.dirname, '..', 'schemas'", "join(import.meta.dirname, '..', '..', '..', '..', 'test', 'extracted', 'supervisor', 'fixtures', 'source-adapted', 'schemas'");
    output=output.replaceAll("join(import.meta.dirname, '..')", "join(import.meta.dirname, '..', '..', '..', '..')");
    output=output.replaceAll("join(import.meta.dirname, '..');", "join(import.meta.dirname, '..', '..', '..', '..');");
    const mappings=sourceMap.records.filter((r)=>r.sourceRepository===SOURCE_IDENTITIES.supervisor.repository && r.destinationPath);
    for (const record of mappings.sort((a,b)=>b.sourcePath.length-a.sourcePath.length)) output=output.split(record.sourcePath).join(record.destinationPath);
    output=output.split("join(root, 'binding.gyp')").join("join(root, 'src', 'native', 'peercred', 'binding.gyp')");
    if (sourcePath === 'test/deployment-lane.test.ts') {
      output = output
        .replace('/test -d dist\\/src/u', '/test -d dist-extracted\\/supervisor/u')
        .replace('/cp -R dist\\/src\\/\\. \"\\$RELEASE_DIR\\/lib\\/dist\\/\"/u', '/cp -R dist-extracted\\/\\. \"\\$RELEASE_DIR\\/lib\\/dist\\/\"/u');
    }
    output=output.split("join(REPO_ROOT, 'acceptance/fixtures/").join("join(REPO_ROOT, 'test/extracted/supervisor/acceptance/fixtures/");
  }
  if (component==='gateway') {
    output=output.replaceAll("join(import.meta.dirname, '..')", "join(import.meta.dirname, '..', '..', '..')");
    output=output.replaceAll("new URL('../', import.meta.url)", "new URL('../../../', import.meta.url)");
  }
  return output;
}

function applyTargetTestAdaptations(component, sourcePath, text) {
  let output = text;
  if (component === 'gateway' && sourcePath === 'test/config.test.js') {
    output = output.replaceAll('must equal sez\\.apply', 'must equal sez\\.root');
  }
  if (component === 'gateway' && sourcePath === 'test/contract.test.js') {
    const oldAssertion = "assert.throws(() => validateArguments({ operation: 'sez.exec', payload: {}, idempotencyKey: 'health-001' }), /operation is invalid/u);";
    const newAssertion = "assert.deepEqual(validateArguments({ operation: 'sez.exec', payload: {}, idempotencyKey: 'health-001' }), { operation: 'sez.exec', payload: {}, idempotencyKey: 'health-001' });\n    assert.throws(() => validateArguments({ operation: 'baby.exec', payload: {}, idempotencyKey: 'health-001' }), /operation is invalid/u);";
    if (!output.includes(oldAssertion)) throw new Error('gateway contract canonical adapter anchor not found');
    output = output.replace(oldAssertion, newAssertion);
  }
  if (component === 'gateway' && sourcePath === 'test/entrypoint.test.js') {
    output = output.replaceAll("join(current, 'src/main.js')", "join(current, 'src/gateway/mcp/main.js')");
  }
  return output;
}

const selectedRepos = new Set(selected.map((component) => componentRepo[component]));
for (const record of sourceMap.records) {
  if (!selectedRepos.has(record.sourceRepository) || record.transformationType !== 'test fixture derived from source') continue;
  const component = record.sourceRepository === SOURCE_IDENTITIES.supervisor.repository ? 'supervisor' : 'gateway';
  if (isSourceOnlyTest(component, record.sourcePath)) {
    record.destinationPath = null;
    record.copyStatus = 'SOURCE_REFERENCE_ONLY';
    record.renameStatus = 'NOT_APPLICABLE';
    record.parityTestStatus = 'SOURCE_HARNESS_CANONICAL_SUPERSEDED';
    record.notes = 'Source-only repository architecture or release-layout assertions are executed by the exact source harness; target paths and architecture follow higher-precedence se-z canonicals and receive dedicated target tests.';
  }
}
fileMap.records = fileMap.records.filter((entry) => {
  if (!selectedRepos.has(entry.sourceRepository)) return true;
  if (entry.transformationType !== 'test fixture derived from source') return true;
  if (entry.destinationPath.startsWith('test/parity/fixtures/source-contracts/')) return true;
  return false;
});

const copied=[];
for (const component of selected) {
  const sourceRoot=sourceRoots[component];
  const identity=SOURCE_IDENTITIES[component];
  if (git(sourceRoot,['rev-parse','HEAD'])!==identity.commit) throw new Error(`${component} source commit mismatch`);
  if (git(sourceRoot,['rev-parse','HEAD^{tree}'])!==identity.tree) throw new Error(`${component} source tree mismatch`);
  const repo=componentRepo[component];
  const recordByPath=new Map(sourceMap.records.filter((r)=>r.sourceRepository===repo).map((r)=>[r.sourcePath,r]));
  for (const sourcePath of tracked(sourceRoot)) {
    const destinationPath=testDestination(component,sourcePath);
    if (!destinationPath) continue;
    const bytes=readBytes(sourceRoot,sourcePath);
    const sourceRecord=recordByPath.get(sourcePath);
    if (!sourceRecord) throw new Error(`missing source inventory record ${repo}:${sourcePath}`);
    if (sha256(bytes)!==sourceRecord.sourceDigest) throw new Error(`source digest mismatch ${sourcePath}`);
    let targetBytes=bytes;
    if (isText(bytes)) {
      let text=bytes.toString('utf8');
      text=rewriteImports(component,sourcePath,destinationPath,text);
      text=rewriteRootPaths(component,sourcePath,destinationPath,text);
      text=applyMechanicalIdentity(text);
      text=applyTargetTestAdaptations(component,sourcePath,text);
      text=header(destinationPath,text,component,sourcePath);
      targetBytes=Buffer.from(text);
    }
    const full=path.join(root,destinationPath);
    fs.mkdirSync(path.dirname(full),{recursive:true});
    fs.writeFileSync(full,targetBytes);
    const targetDigest=sha256(targetBytes);
    sourceRecord.destinationPath=destinationPath;
    sourceRecord.copyStatus='COPIED';
    sourceRecord.renameStatus=targetDigest===sourceRecord.sourceDigest?'NOT_REQUIRED':'APPLIED';
    sourceRecord.transformationType='test fixture derived from source';
    sourceRecord.parityTestStatus='PORTED_PENDING_EXECUTION';
    sourceRecord.notes='Mechanically ported against relocated se-z implementation; canonical-only differences remain classified.';
    let mapEntry=fileMap.records.find((entry)=>entry.sourceRepository===repo&&entry.sourcePath===sourcePath&&entry.destinationPath===destinationPath);
    if (!mapEntry) {
      mapEntry={sourceRepository:repo,sourcePath,sourceCommit:identity.commit,sourceTree:identity.tree,sourceDigest:sourceRecord.sourceDigest,destinationPath,transformationType:'test fixture derived from source',applicableLicense:repo.endsWith('baby-quirt-mcp')?'StealthEye LLC proprietary; NOTICE.md preserved centrally':'StealthEye LLC proprietary; target NOTICE and provenance apply'};
      fileMap.records.push(mapEntry);
    }
    mapEntry.targetDigest=targetDigest;
    mapEntry.extractionStatus='EXTRACTED';
    mapEntry.extractedAt=new Date().toISOString();
    copied.push({component,sourcePath,destinationPath,sourceDigest:sourceRecord.sourceDigest,targetDigest});
  }
}
sourceMap.extractedRecordCount=sourceMap.records.filter((r)=>r.copyStatus==='COPIED').length;
sourceMap.portedTestRecordCount=sourceMap.records.filter((r)=>r.transformationType==='test fixture derived from source'&&r.copyStatus==='COPIED').length;
sourceMap.testsPortedAt=new Date().toISOString();
fileMap.records.sort((a,b)=>a.sourceRepository.localeCompare(b.sourceRepository)||a.sourcePath.localeCompare(b.sourcePath)||a.destinationPath.localeCompare(b.destinationPath));
fileMap.extractedRecordCount=fileMap.records.filter((r)=>r.extractionStatus==='EXTRACTED').length;
fileMap.portedTestRecordCount=fileMap.records.filter((r)=>r.transformationType==='test fixture derived from source'&&r.extractionStatus==='EXTRACTED').length;
fileMap.testsPortedAt=sourceMap.testsPortedAt;
fs.writeFileSync(sourceMapPath,JSON.stringify(sourceMap,null,2)+'\n');
fs.writeFileSync(fileMapPath,JSON.stringify(fileMap,null,2)+'\n');
fs.mkdirSync(path.join(root,'evidence/phase1'),{recursive:true});
fs.writeFileSync(path.join(root,'evidence/phase1/test-port-last.json'),JSON.stringify({capturedAt:new Date().toISOString(),count:copied.length,records:copied},null,2)+'\n');
console.log(JSON.stringify({ported:copied.length,byComponent:Object.fromEntries(selected.map((c)=>[c,copied.filter((r)=>r.component===c).length])),fileMapExtracted:fileMap.extractedRecordCount},null,2));
