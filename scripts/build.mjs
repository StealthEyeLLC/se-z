import { cp, mkdir, readdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else out.push(path);
  }
  return out;
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist/bin', { recursive: true });
for (const dir of ['src', 'protocol', 'contracts', 'docs']) await cp(dir, join('dist', dir), { recursive: true });
const launcher = `#!/bin/sh\nexec node "$(dirname "$0")/../src/cli.mjs" "$@"\n`;
await writeFile('dist/bin/se-z', launcher);
await chmod('dist/bin/se-z', 0o755);
const files = (await walk('dist')).sort();
const manifest = [];
for (const file of files) {
  const data = await readFile(file);
  manifest.push({ path: file.replace(/^dist\//, ''), size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
await writeFile('dist/manifest.json', JSON.stringify({ schemaVersion: 1, product: 'se-z', status: 'canonical-scaffold', files: manifest }, null, 2) + '\n');
console.log(`built canonical scaffold with ${manifest.length} files`);
