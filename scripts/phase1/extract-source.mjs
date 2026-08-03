import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { SOURCE_IDENTITIES, applyMechanicalIdentity } from './source-layout.mjs';

const root = process.cwd();
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/u, '').split('=');
  return [key, rest.join('=') || 'true'];
}));
const componentArg = args.get('component') ?? 'all';
const components = componentArg === 'all' ? ['supervisor','gateway'] : componentArg.split(',');
const selectedFamilies = args.has('families') ? new Set(args.get('families').split(',').map((value) => value.trim())) : null;
const sourceRoots = {
  supervisor: process.env.SEZ_PHASE1_SUPERVISOR_SOURCE ?? path.resolve(root, '../sources/baby-quirt'),
  gateway: process.env.SEZ_PHASE1_GATEWAY_SOURCE ?? path.resolve(root, '../sources/baby-quirt-mcp')
};

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function git(sourceRoot, values) { return execFileSync('git', ['-C', sourceRoot, ...values], {encoding:'utf8'}).trim(); }
function normalize(value) { return path.posix.normalize(value.replaceAll('\\','/')); }
function sourceBytes(sourceRoot, sourcePath) {
  const full = path.join(sourceRoot, sourcePath);
  const stat = fs.lstatSync(full);
  return stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
}
function isText(bytes) { return !bytes.includes(0); }
function provenanceHeader(destinationPath, text) {
  const line = 'Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.';
  if (text.startsWith('#!')) {
    const at = text.indexOf('\n');
    const marker = /\.(?:ts|js|mjs|cjs|cc|cpp|c|h)$/u.test(destinationPath) ? '// ' : '# ';
    return at < 0 ? `${text}\n${marker}${line}\n` : `${text.slice(0,at+1)}${marker}${line}\n${text.slice(at+1)}`;
  }
  if (/\.(?:ts|js|mjs|cjs|cc|cpp|c|h)$/u.test(destinationPath)) return `// ${line}\n${text}`;
  if (/\.(?:sh|service|socket|timer|conf|rules)$/u.test(destinationPath) || destinationPath.startsWith('packaging/')) return `# ${line}\n${text}`;
  return text;
}

const sourceMapPath = path.join(root,'vendor/baby-provenance/source-map.json');
const fileMapPath = path.join(root,'vendor/baby-provenance/file-map.json');
const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath,'utf8'));
const fileMap = JSON.parse(fs.readFileSync(fileMapPath,'utf8'));
const componentForRepo = new Map([
  [SOURCE_IDENTITIES.supervisor.repository,'supervisor'],
  [SOURCE_IDENTITIES.gateway.repository,'gateway']
]);
const recordsByComponent = new Map();
for (const component of ['supervisor','gateway']) {
  const identity = SOURCE_IDENTITIES[component];
  const sourceRoot = sourceRoots[component];
  if (!fs.existsSync(sourceRoot)) throw new Error(`${component} source root does not exist: ${sourceRoot}`);
  if (git(sourceRoot,['rev-parse','HEAD']) !== identity.commit) throw new Error(`${component} commit mismatch`);
  if (git(sourceRoot,['rev-parse','HEAD^{tree}']) !== identity.tree) throw new Error(`${component} tree mismatch`);
  const componentRecords = sourceMap.records.filter((record) => record.sourceRepository === identity.repository);
  recordsByComponent.set(component, componentRecords);
}

function resolveMappedSource(component, sourcePath, specifier) {
  if (!specifier.startsWith('.')) return null;
  const records = recordsByComponent.get(component);
  const destinationBySource = new Map(records.filter((record) => record.destinationPath).map((record) => [record.sourcePath,record.destinationPath]));
  const base = normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const candidates = [base];
  if (base.endsWith('.js')) candidates.push(`${base.slice(0,-3)}.ts`);
  if (base.endsWith('.mjs')) candidates.push(`${base.slice(0,-4)}.ts`);
  if (!path.posix.extname(base)) candidates.push(`${base}.ts`,`${base}.js`,`${base}/index.ts`,`${base}/index.js`);
  for (const candidate of candidates) {
    const destinationPath = destinationBySource.get(candidate);
    if (!destinationPath) continue;
    return {sourcePath:candidate,destinationPath};
  }
  return null;
}

function rewriteRelativeImports(component, sourcePath, destinationPath, text) {
  return text.replace(/(['"])(\.\.?\/[^'"\n]+)\1/gu, (whole, quote, specifier) => {
    const resolved = resolveMappedSource(component, sourcePath, specifier);
    if (!resolved) return whole;
    let runtimeDestination = resolved.destinationPath;
    if (specifier.endsWith('.js') && runtimeDestination.endsWith('.ts')) runtimeDestination = `${runtimeDestination.slice(0,-3)}.js`;
    if (specifier.endsWith('.mjs') && runtimeDestination.endsWith('.ts')) runtimeDestination = `${runtimeDestination.slice(0,-3)}.mjs`;
    let relative = path.posix.relative(path.posix.dirname(destinationPath), runtimeDestination);
    if (!relative.startsWith('.')) relative = `./${relative}`;
    return `${quote}${relative}${quote}`;
  });
}

function applyRelocationAdaptations(destinationPath, text) {
  let output = text;
  if (destinationPath === 'src/native/peercred/binding.gyp') {
    output = output.replace('native/src/peer_cred.cc','src/peer_cred.cc');
  }
  if (destinationPath === 'scripts/extracted/supervisor/build-bundle.sh') {
    output = output
      .replace('ROOT="$(cd "$(dirname "$0")/.." && pwd)"', 'ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"')
      .replaceAll('test -d dist/src', 'test -d dist-extracted/supervisor')
      .replaceAll('test -f build/Release/peer_cred.node', 'test -f src/native/peercred/build/Release/peer_cred.node')
      .replaceAll('cp -R dist/src/. "$RELEASE_DIR/lib/dist/"', 'cp -R dist-extracted/. "$RELEASE_DIR/lib/dist/"')
      .replaceAll('cp package.json package-lock.json binding.gyp "$RELEASE_DIR/lib/"', 'cp package.json package-lock.json "$RELEASE_DIR/lib/"\ncp src/native/peercred/binding.gyp "$RELEASE_DIR/lib/binding.gyp"')
      .replaceAll('cp build/Release/peer_cred.node "$RELEASE_DIR/lib/build/Release/peer_cred.node"', 'cp src/native/peercred/build/Release/peer_cred.node "$RELEASE_DIR/lib/build/Release/peer_cred.node"')
      .replaceAll('"$RELEASE_ROOT/lib/dist/index.js"', '"$RELEASE_ROOT/lib/dist/supervisor/server/index.js"')
      .replaceAll('"$RELEASE_ROOT/lib/dist/cli/main.js"', '"$RELEASE_ROOT/lib/dist/supervisor/cli/main.js"')
      .replaceAll('"$RELEASE_ROOT/lib/dist/cli/$command.js"', '"$RELEASE_ROOT/lib/dist/supervisor/cli/$command.js"')
      .replaceAll('cp -R ops/systemd "$RELEASE_DIR/ops/"', 'cp -R packaging/systemd "$RELEASE_DIR/ops/"')
      .replaceAll('cp -R ops/tmpfiles "$RELEASE_DIR/ops/"', 'cp -R packaging/tmpfiles "$RELEASE_DIR/ops/"')
      .replaceAll('cp -R schemas "$RELEASE_DIR/"', 'cp -R protocol/schemas "$RELEASE_DIR/schemas"')
      .replaceAll('node --import tsx scripts/create-package-spec.ts', 'node --import tsx scripts/extracted/supervisor/create-package-spec.ts')
      .replaceAll('node --import tsx scripts/package-release.ts', 'node --import tsx scripts/extracted/supervisor/package-release.ts');
  }
  if (destinationPath === 'scripts/extracted/supervisor/create-package-spec.ts') {
    output = output
      .replace("join(root, 'scripts', 'build-bundle.sh')", "join(root, 'scripts', 'extracted', 'supervisor', 'build-bundle.sh')")
      .replaceAll("'lib/dist/index.js'", "'lib/dist/supervisor/server/index.js'")
      .replaceAll("'lib/dist/cli/install.js'", "'lib/dist/supervisor/cli/install.js'")
      .replaceAll("'lib/dist/cli/repair.js'", "'lib/dist/supervisor/cli/repair.js'")
      .replaceAll("'lib/dist/cli/rollback.js'", "'lib/dist/supervisor/cli/rollback.js'")
      .replaceAll("'lib/dist/cli/verify.js'", "'lib/dist/supervisor/cli/verify.js'");
  }
  if (destinationPath === 'scripts/extracted/supervisor/release.sh') {
    output = output
      .replace('ROOT="$(cd "$(dirname "$0")/.." && pwd)"', 'ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"')
      .replaceAll('scripts/build-bundle.sh', 'scripts/extracted/supervisor/build-bundle.sh');
  }
  if (destinationPath === 'src/supervisor/peers/peer-cred.ts') {
    output = output.replace("import { createRequire } from 'node:module';", "import { createRequire } from 'node:module';\nimport { fileURLToPath } from 'node:url';");
    output = output.replace(
      /function loadNative\(\): PeerCredNative \{[\s\S]*?\n\}/u,
      `function loadNative(): PeerCredNative {\n  if (native) return native;\n  const candidates = [\n    new URL('../../native/peercred/build/Release/peer_cred.node', import.meta.url),\n    new URL('../../native/peercred/build/Debug/peer_cred.node', import.meta.url),\n    new URL('../../../../src/native/peercred/build/Release/peer_cred.node', import.meta.url),\n    new URL('../../../../src/native/peercred/build/Debug/peer_cred.node', import.meta.url),\n  ];\n  let lastError: unknown;\n  for (const candidate of candidates) {\n    try {\n      native = require(fileURLToPath(candidate)) as PeerCredNative;\n      return native;\n    } catch (error) {\n      lastError = error;\n    }\n  }\n  throw lastError instanceof Error ? lastError : new Error('se-z peer credential addon is unavailable');\n}`
    );
  }
  return output;
}

const extracted = [];
for (const record of sourceMap.records) {
  const component = componentForRepo.get(record.sourceRepository);
  if (!component || !components.includes(component) || !record.destinationPath) continue;
  if (selectedFamilies && !selectedFamilies.has(record.componentFamily)) continue;
  const sourceRoot = sourceRoots[component];
  const bytes = sourceBytes(sourceRoot,record.sourcePath);
  if (sha256(bytes) !== record.sourceDigest) throw new Error(`source digest mismatch: ${record.sourcePath}`);
  const destinationFull = path.join(root,record.destinationPath);
  fs.mkdirSync(path.dirname(destinationFull),{recursive:true});
  let targetBytes;
  if (isText(bytes) && !record.destinationPath.startsWith('test/parity/fixtures/source-contracts/')) {
    let text = bytes.toString('utf8');
    text = rewriteRelativeImports(component,record.sourcePath,record.destinationPath,text);
    text = applyMechanicalIdentity(text);
    text = applyRelocationAdaptations(record.destinationPath,text);
    if (record.destinationPath.startsWith('src/') || record.destinationPath.startsWith('packaging/') || record.destinationPath.startsWith('scripts/extracted/')) text = provenanceHeader(record.destinationPath,text);
    targetBytes = Buffer.from(text);
  } else {
    targetBytes = bytes;
  }
  fs.writeFileSync(destinationFull,targetBytes);
  const sourceMode = fs.statSync(path.join(sourceRoot,record.sourcePath)).mode & 0o777;
  if (sourceMode & 0o111) fs.chmodSync(destinationFull,sourceMode);
  const targetDigest = sha256(targetBytes);
  const mapEntry = fileMap.records.find((entry) => entry.sourceRepository===record.sourceRepository && entry.sourcePath===record.sourcePath && entry.destinationPath===record.destinationPath);
  if (!mapEntry) throw new Error(`missing file-map entry: ${record.sourcePath}`);
  mapEntry.targetDigest = targetDigest;
  mapEntry.extractionStatus = 'EXTRACTED';
  mapEntry.extractedAt = new Date().toISOString();
  record.copyStatus = 'COPIED';
  record.renameStatus = targetDigest === record.sourceDigest ? 'NOT_REQUIRED' : 'APPLIED';
  record.parityTestStatus = 'PENDING_EXECUTION';
  extracted.push({component,family:record.componentFamily,sourcePath:record.sourcePath,destinationPath:record.destinationPath,sourceDigest:record.sourceDigest,targetDigest,transformationType:record.transformationType});
}
sourceMap.extractedAt = new Date().toISOString();
sourceMap.extractedRecordCount = sourceMap.records.filter((record) => record.copyStatus==='COPIED').length;
fileMap.extractedAt = sourceMap.extractedAt;
fileMap.extractedRecordCount = fileMap.records.filter((record) => record.extractionStatus==='EXTRACTED').length;
fs.writeFileSync(sourceMapPath,JSON.stringify(sourceMap,null,2)+'\n');
fs.writeFileSync(fileMapPath,JSON.stringify(fileMap,null,2)+'\n');
const summary = {capturedAt:new Date().toISOString(),components,families:selectedFamilies?[...selectedFamilies]:null,count:extracted.length,records:extracted};
fs.mkdirSync(path.join(root,'evidence/phase1'),{recursive:true});
fs.writeFileSync(path.join(root,'evidence/phase1/extraction-last.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({extracted:extracted.length,componentCounts:Object.fromEntries(components.map((component)=>[component,extracted.filter((entry)=>entry.component===component).length])),fileMapExtracted:fileMap.extractedRecordCount},null,2));
