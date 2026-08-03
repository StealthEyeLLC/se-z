import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const outputPath = path.join(root, 'evidence/phase1/dependency-scan.json');
const writeEvidence = !process.argv.includes('--no-write');
const activeRoots = ['src', 'packaging', 'scripts/extracted'];
const allowedHistoricalRoots = ['NOTICE','docs/PROVENANCE.md','docs/MIGRATION.md','vendor/baby-provenance','test/parity','evidence/phase1'];
const patterns = [
  { id:'baby-runtime-import', re:/(?:from|import\s*\(|require\s*\()\s*['"][^'"]*(?:baby-quirt|baby-quirt-mcp)/u },
  { id:'baby-executable-invocation', re:/(?:spawn|execFile|execFileSync|systemctl|service)\s*\([^\n]*(?:baby-quirt|baby-quirt-mcp)/u },
  { id:'baby-socket', re:/\/run\/horsey\/baby-quirt\.sock/u },
  { id:'baby-state-path', re:/\/(?:var\/lib|etc|opt)\/baby-quirt(?:-mcp)?(?:\/|\b)/u },
  { id:'baby-service', re:/\bbaby-quirt(?:-mcp)?\.(?:service|socket)\b/u },
  { id:'legacy-public-tool', re:/\bcall_quirt\b/u },
  { id:'legacy-operation-registration', re:/['"]baby\.[a-z0-9_.-]+['"]/u },
  { id:'legacy-protocol-identity', re:/['"]QRT1['"]/u },
  { id:'legacy-bq-identity', re:/\b(?:bq|BQ)[_-][A-Za-z0-9_.-]+/u }
];
function walk(relative) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) return [];
  const stat = fs.lstatSync(full);
  if (stat.isFile()) return [relative];
  return fs.readdirSync(full, { withFileTypes:true }).flatMap((entry) => {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory() && ['node_modules','build','dist','dist-extracted'].includes(entry.name)) return [];
    return entry.isDirectory() ? walk(child) : entry.isFile() ? [child] : [];
  });
}
const activeFiles = activeRoots.flatMap(walk).sort();
const findings = [];
for (const relative of activeFiles) {
  const bytes = fs.readFileSync(path.join(root, relative));
  if (bytes.includes(0)) continue;
  const lines = bytes.toString('utf8').split('\n');
  lines.forEach((line, index) => {
    if (line.includes('Provenance: exact pinned source') || line.includes('vendor/baby-provenance/file-map.json')) return;
    for (const pattern of patterns) if (pattern.re.test(line)) findings.push({ path:relative, line:index+1, pattern:pattern.id, lineSha256:createHash('sha256').update(line).digest('hex') });
  });
}
const packageJson = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const packageDependencies = [...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.optionalDependencies ?? {})];
for (const name of packageDependencies) if (/baby-quirt/u.test(name)) findings.push({path:'package.json',line:null,pattern:'baby-package-dependency',name});
const historicalReferences = allowedHistoricalRoots.flatMap(walk).reduce((count, relative) => {
  const bytes = fs.readFileSync(path.join(root,relative));
  if (bytes.includes(0)) return count;
  return count + ((bytes.toString('utf8').match(/baby-quirt|call_quirt|\bbaby\.|QRT1/gu) ?? []).length);
}, 0);
const result = {
  schemaVersion:'1.0.0', capturedAt:new Date().toISOString(), activeRoots, allowedHistoricalRoots,
  activeFileCount:activeFiles.length, packageRuntimeDependencies:packageDependencies,
  forbiddenFindingCount:findings.length, findings, historicalReferenceCount:historicalReferences,
  passed:findings.length===0
};
if (writeEvidence) {
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result,null,2));
if(!result.passed) process.exitCode=1;
