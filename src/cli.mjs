#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as constants from './constants.mjs';
import { CORE_OPERATIONS, catalogDigest } from './catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] ?? 'help';

if (command === 'version') {
  console.log(JSON.stringify({
    product: constants.PRODUCT,
    repository: constants.REPOSITORY,
    version: constants.VERSION,
    protocol: constants.PROTOCOL,
    protocolVersion: constants.PROTOCOL_VERSION,
    status: 'canonical-scaffold'
  }, null, 2));
  process.exit(0);
}

if (command === 'catalog') {
  console.log(JSON.stringify({
    publicTool: constants.PUBLIC_TOOL,
    operations: CORE_OPERATIONS,
    catalogDigest: catalogDigest()
  }, null, 2));
  process.exit(0);
}

if (command === 'spec') {
  const specPath = resolve(here, '../docs/ENGINEERING_SPEC.md');
  console.log(await readFile(specPath, 'utf8'));
  process.exit(0);
}

console.log(`se-z canonical scaffold\n\nCommands:\n  se-z version\n  se-z catalog\n  se-z spec\n\nRuntime socket operations are intentionally not claimed by the initialization scaffold.`);
