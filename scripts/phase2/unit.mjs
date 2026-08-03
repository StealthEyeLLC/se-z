#!/usr/bin/env node
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
let evidencePath = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--evidence') evidencePath = path.resolve(args[++index]);
  else throw new Error(`unknown argument: ${args[index]}`);
}

async function command(file, argv) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

const startedAt = new Date().toISOString();
const start = process.hrtime.bigint();
const unitDirectory = path.join(process.cwd(), 'test/phase2/unit');
const unitFiles = (await fsp.readdir(unitDirectory)).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join(unitDirectory, name));
const result = await command(process.execPath, ['--test', ...unitFiles]);
const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
const combined = Buffer.concat([result.stdout, result.stderr]);
const text = combined.toString('utf8');
const passMatches = [...text.matchAll(/^# pass (\d+)$/gm)];
const failMatches = [...text.matchAll(/^# fail (\d+)$/gm)];
const testsMatches = [...text.matchAll(/^# tests (\d+)$/gm)];
const evidence = {
  schemaVersion: 1,
  kind: 'phase2-unit',
  startedAt,
  completedAt: new Date().toISOString(),
  passed: result.code === 0 && result.signal === null,
  exitCode: result.code,
  signal: result.signal,
  durationMs,
  tests: testsMatches.length ? Number(testsMatches.at(-1)[1]) : null,
  pass: passMatches.length ? Number(passMatches.at(-1)[1]) : null,
  fail: failMatches.length ? Number(failMatches.at(-1)[1]) : null,
  outputBytes: combined.length,
  outputSha256: crypto.createHash('sha256').update(combined).digest('hex'),
};
if (evidencePath) {
  await fsp.mkdir(path.dirname(evidencePath), { recursive: true });
  await fsp.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (!evidence.passed) process.exitCode = result.code ?? 1;
