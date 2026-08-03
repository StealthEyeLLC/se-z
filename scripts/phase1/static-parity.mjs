#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
const root = process.cwd();
const testRoot = path.join(root, 'test/parity');
const tests = fs.readdirSync(testRoot, { recursive: true })
  .map((entry) => path.join('test/parity', String(entry)))
  .filter((entry) => entry.endsWith('.test.mjs'))
  .sort();
if (tests.length === 0) throw new Error('no static parity tests found');
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
