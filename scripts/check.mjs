import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', 'dist', '.git'].includes(entry.name)) out.push(...await walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const files = await walk('.');
for (const file of files.filter((value) => value.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`syntax failure in ${file}: ${result.stderr}`);
}
for (const file of files.filter((value) => value.endsWith('.json'))) {
  JSON.parse(await readFile(file, 'utf8'));
}
const requirements = await readFile('contracts/requirements.yaml', 'utf8');
for (const token of ['INV-SEZ1-001', 'INV-OAUTH-001', 'INV-SOCKET-001', 'INV-STREAM-001', 'ANTI-THEATER-001']) {
  if (!requirements.includes(token)) throw new Error(`missing requirement ${token}`);
}
console.log(`checked ${files.length} repository files`);
