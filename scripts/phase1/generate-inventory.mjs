import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { SOURCE_IDENTITIES, componentFamily, destinationFor, languageFor, parityExpectationFor, transformationFor } from './source-layout.mjs';

const repositoryRoot = process.cwd();
const sourceRoots = {
  supervisor: process.env.SEZ_PHASE1_SUPERVISOR_SOURCE ?? path.resolve(repositoryRoot, '../sources/baby-quirt'),
  gateway: process.env.SEZ_PHASE1_GATEWAY_SOURCE ?? path.resolve(repositoryRoot, '../sources/baby-quirt-mcp')
};

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function git(root, args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }
function tracked(root) { return git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean); }
function fileBytes(root, sourcePath) {
  const full = path.join(root, sourcePath);
  const stat = fs.lstatSync(full);
  return stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
}
function textOrEmpty(bytes) {
  if (bytes.includes(0)) return '';
  return bytes.toString('utf8');
}
function exportsFrom(text) {
  const found = new Set();
  for (const match of text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gu)) found.add(match[1]);
  for (const match of text.matchAll(/\bmodule\.exports\.([A-Za-z_$][\w$]*)/gu)) found.add(match[1]);
  return [...found].sort();
}
function pathLiterals(text) {
  return [...new Set([...text.matchAll(/['"](\/(?:etc|var|run|opt|root|tmp)\/[^'"\n]+)['"]/gu)].map((m) => m[1]))].sort();
}
function processes(text) {
  const result = new Set();
  for (const match of text.matchAll(/(?:spawn|execFile|execFileSync|spawnSync)\s*\(\s*['"]([^'"]+)['"]/gu)) result.add(match[1]);
  for (const command of ['systemctl','systemd-run','machinectl','tar','git','npm','node','bash','sh','mount','umount','chown','chmod','kill']) if (text.includes(command)) result.add(command);
  return [...result].sort();
}
function purpose(family, sourcePath) {
  return `${family} mechanic from ${sourcePath}`;
}
function dependencies(component, sourcePath, text) {
  const runtime = new Set();
  for (const match of text.matchAll(/(?:from\s+|import\s*\()['"]([^.'"][^'"]*)['"]/gu)) runtime.add(match[1].split('/').slice(0, match[1].startsWith('@') ? 2 : 1).join('/'));
  if (component === 'supervisor' && sourcePath.includes('peer-cred')) runtime.add('native peer-credential addon');
  return [...runtime].sort();
}
function testsFor(component, sourcePath, allFiles, allTexts) {
  if (!sourcePath.startsWith('src/') && !sourcePath.startsWith('native/')) return [];
  const stem = path.basename(sourcePath).replace(/\.(?:ts|js|cc)$/u, '');
  return allFiles.filter((candidate) => /^(test|integration|acceptance)\//u.test(candidate) && (allTexts.get(candidate)?.includes(sourcePath.replace(/^src\//u, '../src/')) || allTexts.get(candidate)?.includes(stem))).sort();
}

const capturedAt = new Date().toISOString();
const records = [];
for (const component of ['supervisor', 'gateway']) {
  const root = sourceRoots[component];
  const identity = SOURCE_IDENTITIES[component];
  if (git(root, ['rev-parse', 'HEAD']) !== identity.commit) throw new Error(`${component} source commit mismatch`);
  if (git(root, ['rev-parse', 'HEAD^{tree}']) !== identity.tree) throw new Error(`${component} source tree mismatch`);
  const files = tracked(root);
  const texts = new Map(files.map((sourcePath) => [sourcePath, textOrEmpty(fileBytes(root, sourcePath))]));
  for (const sourcePath of files) {
    const bytes = fileBytes(root, sourcePath);
    const text = texts.get(sourcePath);
    const family = componentFamily(component, sourcePath);
    const destinationPath = destinationFor(component, sourcePath);
    const transformationType = transformationFor(component, sourcePath);
    const readPaths = pathLiterals(text).filter((value) => /read|load|stat|current|previous|manifest|state|receipt|key|credential/iu.test(text));
    const writtenPaths = pathLiterals(text).filter((value) => /write|mkdir|rename|copy|remove|unlink|append|save|stage|activate/iu.test(text));
    records.push({
      sourceRepository: identity.repository,
      sourceCommit: identity.commit,
      sourceTree: identity.tree,
      sourcePath,
      sourceLanguage: languageFor(sourcePath),
      sourceDigest: sha256(bytes),
      componentFamily: family,
      majorExportedSymbols: exportsFrom(text),
      runtimePurpose: purpose(family, sourcePath),
      stateRead: readPaths,
      stateWritten: writtenPaths,
      externalProcessesInvoked: processes(text),
      systemDependencies: [...new Set([...(text.includes('systemd') ? ['systemd'] : []), ...(text.includes('/proc/') ? ['procfs'] : []), ...(text.includes('SO_PEERCRED') || text.includes('peer_cred') ? ['Linux SO_PEERCRED'] : []), ...(text.includes('node-pty') || family === 'PTY' ? ['Linux PTY'] : [])])],
      runtimeDependencies: dependencies(component, sourcePath, text),
      buildDependencies: component === 'supervisor' && (sourcePath.endsWith('.ts') || sourcePath.endsWith('.cc') || sourcePath.endsWith('.gyp')) ? ['Node.js 24.18.0','TypeScript 5.8','node-gyp 11','C/C++ toolchain'] : ['Node.js 24.18.0'],
      sourceTests: testsFor(component, sourcePath, files, texts),
      destinationPath,
      copyStatus: destinationPath ? 'PLANNED' : 'SOURCE_REFERENCE_ONLY',
      renameStatus: destinationPath ? (transformationType === 'exact copy' ? 'NOT_REQUIRED' : 'PLANNED') : 'NOT_APPLICABLE',
      canonicalDeltaStatus: ['protocol','peer authorization','OAuth','MCP gateway','recovery source mechanics','streams','GitHub authority'].includes(family) ? 'CANONICAL_DELTA_RECORDED' : 'NO_KNOWN_NONMECHANICAL_DELTA',
      parityTestStatus: destinationPath ? 'PLANNED' : 'SOURCE_HARNESS',
      transformationType,
      parityExpectation: parityExpectationFor(family),
      notes: destinationPath ? 'Destination is se-z-owned; imports and active identities require mechanical adaptation.' : 'Retained through the pinned source-reference harness and provenance records.'
    });
  }
}
records.sort((a,b) => a.sourceRepository.localeCompare(b.sourceRepository) || a.sourcePath.localeCompare(b.sourcePath));

const sourceMap = {schemaVersion:'1.0.0', capturedAt, sources: SOURCE_IDENTITIES, recordCount: records.length, records};
fs.mkdirSync(path.join(repositoryRoot,'vendor/baby-provenance'), {recursive:true});
fs.writeFileSync(path.join(repositoryRoot,'vendor/baby-provenance/source-map.json'), JSON.stringify(sourceMap,null,2)+'\n');
const fileMap = {
  schemaVersion:'1.0.0', capturedAt,
  records: records.filter((r) => r.destinationPath).map((r) => ({
    sourceRepository:r.sourceRepository, sourcePath:r.sourcePath, sourceCommit:r.sourceCommit, sourceTree:r.sourceTree,
    sourceDigest:r.sourceDigest, destinationPath:r.destinationPath, transformationType:r.transformationType,
    targetDigest:null, applicableLicense:r.sourceRepository.endsWith('baby-quirt-mcp') ? 'StealthEye LLC proprietary; NOTICE.md preserved centrally' : 'StealthEye LLC proprietary; no separate license file in pinned tree; target NOTICE and provenance apply',
    extractionStatus:'PLANNED'
  }))
};
fs.writeFileSync(path.join(repositoryRoot,'vendor/baby-provenance/file-map.json'), JSON.stringify(fileMap,null,2)+'\n');

const counts = new Map();
for (const record of records) counts.set(record.componentFamily, (counts.get(record.componentFamily) ?? 0) + 1);
let inventory = '# Phase 1 Source Inventory\n\n';
inventory += `Generated from the exact pinned trees. **${records.length} tracked files** are inventoried; every file copied later must resolve to one of these SHA-256 records.\n\n`;
inventory += '## Component counts\n\n| Component family | Files |\n|---|---:|\n';
for (const [family,count] of [...counts].sort((a,b)=>a[0].localeCompare(b[0]))) inventory += `| ${family} | ${count} |\n`;
inventory += '\n## Complete file inventory\n\n| Source | Path | SHA-256 | Language | Family | Destination | Status |\n|---|---|---|---|---|---|---|\n';
for (const r of records) inventory += `| ${r.sourceRepository} | \`${r.sourcePath}\` | \`${r.sourceDigest}\` | ${r.sourceLanguage} | ${r.componentFamily} | ${r.destinationPath ? `\`${r.destinationPath}\`` : 'source harness only'} | ${r.copyStatus} |\n`;
inventory += '\nThe machine-readable record in `vendor/baby-provenance/source-map.json` additionally records exports, state paths, external processes, dependencies, source tests, rename status, canonical-delta status, and parity status.\n';
fs.writeFileSync(path.join(repositoryRoot,'docs/PHASE1_SOURCE_INVENTORY.md'), inventory);
