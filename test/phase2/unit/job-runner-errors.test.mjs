import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function runNode(argv, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('missing executable publishes a durable failed runner result instead of disappearing', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'se-z-runner-error-'));
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));
  const jobId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const stdoutPath = path.join(root, 'stdout.bin');
  const stderrPath = path.join(root, 'stderr.bin');
  const stdoutState = path.join(root, 'stdout.json');
  const stderrState = path.join(root, 'stderr.json');
  const runnerStatePath = path.join(root, 'runner-state.json');
  const runnerResultPath = path.join(root, 'runner-result.json');
  const specPath = path.join(root, 'runner-spec.json');
  const spec = {
    runnerSpec: true,
    jobId,
    requestId,
    requestedArgv: ['/definitely/not/a/command'],
    launchArgv: ['/definitely/not/a/command'],
    cwd: root,
    environment: { PATH: '/usr/bin:/bin', HOME: root, USER: 'root', LOGNAME: 'root', SHELL: '/bin/bash', LANG: 'C.UTF-8', TERM: 'xterm-256color' },
    stdin: null,
    umask: 0o022,
    timeoutMs: null,
    stdoutPath,
    stderrPath,
    streamStatePaths: { stdout: stdoutState, stderr: stderrState },
    runnerStatePath,
    runnerResultPath,
    faultInjection: {},
  };
  await fsp.writeFile(specPath, `${JSON.stringify(spec)}\n`);
  const result = await runNode([path.resolve('src/kernel/job-runner.mjs'), specPath]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 1, result.stderr);
  const durable = JSON.parse(await fsp.readFile(runnerResultPath, 'utf8'));
  assert.equal(durable.jobId, jobId);
  assert.equal(durable.requestId, requestId);
  assert.equal(durable.state, 'failed');
  assert.equal(durable.exitCode, null);
  assert.equal(durable.signal, null);
  assert.equal(durable.error.code, 'operation_failed');
  assert.match(durable.error.message, /ENOENT|not\/a\/command/);
  assert.equal(durable.stdout.bytes, 0);
  assert.equal(durable.stderr.bytes, 0);
  assert.ok(durable.terminalAt);
  assert.equal((await fsp.stat(stdoutPath)).size, 0);
  assert.equal((await fsp.stat(stderrPath)).size, 0);
});
