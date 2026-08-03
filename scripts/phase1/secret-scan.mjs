import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const writeEvidence = !process.argv.includes('--no-write');
const outputArgument = process.argv.find((arg) => arg.startsWith('--output='));
const outputPath = outputArgument?.slice('--output='.length) ?? 'evidence/phase1/secret-scan.json';
const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd:root});
const files = listed.toString('utf8').split('\0').filter(Boolean).sort();
const patterns = [
  {id:'private-key-block', regex:/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{40,}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu},
  {id:'private-key-header', regex:/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu},
  {id:'github-token', regex:/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu},
  {id:'aws-access-key', regex:/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu},
  {id:'slack-token', regex:/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu},
  {id:'bearer-token', regex:/\bBearer\s+[A-Za-z0-9._~+\/-]{40,}={0,2}\b/gu},
  {id:'credential-url', regex:/https?:\/\/[^\s:@/]{3,}:[^\s@/]{8,}@/gu},
  {id:'long-secret-assignment', regex:/\b(?:client[_-]?secret|refresh[_-]?token|installation[_-]?token|tunnel[_-]?(?:key|token)|backup[_-]?(?:key|credential))\b\s*[:=]\s*['"][A-Za-z0-9._~+\/-]{32,}={0,2}['"]/giu}
];
const findings = [];
const fileDigests = [];
for (const relative of files) {
  const full = path.join(root,relative);
  const stat = fs.lstatSync(full);
  if (!stat.isFile()) continue;
  const bytes = fs.readFileSync(full);
  fileDigests.push({path:relative,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      const before = text.slice(0,match.index);
      const line = before.split('\n').length;
      const fixtureMarker = pattern.id === 'private-key-header' && relative.startsWith('test/') && !/-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u.test(text);
      if (!fixtureMarker) findings.push({path:relative,line,pattern:pattern.id,matchSha256:createHash('sha256').update(match[0]).digest('hex')});
    }
  }
  const base = path.basename(relative);
  if ((base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) && !relative.startsWith('test/')) {
    findings.push({path:relative,line:null,pattern:'live-environment-file',matchSha256:null});
  }
}
const result = {
  schemaVersion:'1.0.0',
  capturedAt:new Date().toISOString(),
  scope:'tracked and untracked nonignored repository files',
  scannedFileCount:fileDigests.length,
  scannedBytes:fileDigests.reduce((sum,item)=>sum+item.bytes,0),
  scanInputDigest:createHash('sha256').update(fileDigests.map((item)=>`${item.sha256}  ${item.path}\n`).join('')).digest('hex'),
  allowedMaterial:['public keys','key IDs','credential-reference names','paths','short explicit test fixtures'],
  forbiddenClasses:['private key blocks','OAuth client secrets','GitHub tokens','bearer tokens','refresh tokens','tunnel runtime keys','backup credentials','live environment files'],
  findingCount:findings.length,
  findings,
  passed:findings.length===0
};
if (writeEvidence) {
  fs.mkdirSync(path.dirname(path.join(root,outputPath)),{recursive:true});
  fs.writeFileSync(path.join(root,outputPath),JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result,null,2));
if (!result.passed) process.exitCode=1;
