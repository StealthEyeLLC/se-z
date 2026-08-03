#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const lockRoot = path.join(root, '.phase1-sources/.locks');
const lockPath = path.join(lockRoot, 'phase1-evidence');
const ownerPath = path.join(lockPath, 'owner.json');

function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch { return null; }
}
function processStartTime(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/u);
    return fields[19] ?? null;
  } catch { return null; }
}
function activeOwner(owner) {
  return Number.isInteger(owner?.pid)
    && owner.bootId === bootId()
    && owner.processStartTime !== null
    && processStartTime(owner.pid) === owner.processStartTime;
}
function acquire() {
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')); } catch {}
    if (activeOwner(owner)) {
      throw new Error(`Phase 1 evidence is already running under pid ${owner.pid} from commit ${owner.commit ?? 'unknown'}`);
    }
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.mkdirSync(lockPath, { mode: 0o700 });
  }
  const owner = {
    pid: process.pid,
    bootId: bootId(),
    processStartTime: processStartTime(process.pid),
    commit: spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
}
function release() { fs.rmSync(lockPath, { recursive: true, force: true }); }
function onSignal(code) { release(); process.exit(code); }

acquire();
process.once('SIGINT', () => onSignal(130));
process.once('SIGTERM', () => onSignal(143));
const stages = [
  'phase1:source-test',
  'phase1:extracted-test',
  'phase1:parity',
  'phase1:dependency-scan',
  'phase1:requirements-audit',
  'phase1:production-readback',
  'phase1:secret-scan',
  'phase1:summarize',
];
let exitCode = 0;
try {
  for (const stage of stages) {
    const result = spawnSync('npm', ['run', stage], {
      cwd: root,
      env: { ...process.env, SEZ_PHASE1_EVIDENCE_OWNER_PID: String(process.pid) },
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  release();
}
process.exitCode = exitCode;
