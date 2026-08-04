#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SezClient } from '../kernel/client.mjs';
import { loadPublicKey, verifyReceipt } from '../kernel/crypto.mjs';

const args = process.argv.slice(2);
let evidencePath = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--evidence') evidencePath = args[++index];
  else throw new Error(`unknown argument: ${args[index]}`);
}

async function command(file, argv = [], options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
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

function parseResponse(output) {
  const text = output.trim();
  if (text.startsWith('{')) {
    try { return JSON.parse(text); } catch {}
  }
  for (const line of output.split('\n').reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue;
    try { return JSON.parse(candidate); } catch {}
  }
  const diagnostic = output.match(/(?:^|\n)([A-Za-z][A-Za-z0-9_]*):\s+/);
  return diagnostic ? { code: diagnostic[1] } : null;
}

async function identity(name, flag) {
  const value = await command('/usr/bin/id', [flag, name]);
  assert.equal(value.code, 0, value.stderr);
  return Number(value.stdout.trim());
}

async function waitTerminal(client, jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = (await client.call('sez.job.wait', { jobId, waitMs: 1000 })).response;
    if (response.terminal) return response;
  }
  throw new Error(`job did not become terminal: ${jobId}`);
}

async function runAs(user, gid, executable, argv) {
  return await command('/usr/bin/setpriv', [`--reuid=${user}`, `--regid=${gid}`, '--init-groups', executable, ...argv]);
}

const startedAt = new Date().toISOString();
const checks = [];
const check = (name, detail = {}) => { checks.push({ name, passed: true, detail }); };
const operator = `sezv${process.pid}`;
const unrelated = `sezu${process.pid}`;
let operatorCreated = false;
let unrelatedCreated = false;
try {
  for (const unit of ['se-z.service', 'se-z-local.socket', 'se-z-gateway.socket']) {
    const active = await command('/usr/bin/systemctl', ['is-active', unit]);
    assert.equal(active.code, 0, `${unit}: ${active.stdout}${active.stderr}`);
    assert.equal(active.stdout.trim(), 'active');
  }
  const mainPidResult = await command('/usr/bin/systemctl', ['show', '-p', 'MainPID', '--value', 'se-z.service']);
  const mainPid = Number(mainPidResult.stdout.trim());
  assert.ok(mainPid > 1);
  const status = await fsp.readFile(`/proc/${mainPid}/status`, 'utf8');
  assert.match(status, /^Uid:\s+0\s+0\s+0\s+0$/m);
  check('production service and both socket units are active with UID-0 supervisor', { mainPid });

  const config = JSON.parse(await fsp.readFile('/etc/se-z/config.json', 'utf8'));
  assert.equal(config.localSocket, '/run/se-z/local.sock');
  assert.equal(config.gatewaySocket, '/run/se-z/gateway.sock');
  assert.equal(config.testMode, false);
  assert.equal(config.directBind, false);
  assert.deepEqual(config.faultInjection, {});
  assert.ok(config.gatewayExecutable.startsWith('/opt/se-z/releases/'));
  assert.ok(config.nodePath.startsWith('/opt/se-z/releases/'));
  check('strict installed configuration is production-shaped and fault injection is disabled', { release: config.releaseIdentity });

  const localGroup = Number((await command('/usr/bin/getent', ['group', 'se-z'])).stdout.trim().split(':')[2]);
  const gatewayGroup = Number((await command('/usr/bin/getent', ['group', 'se-z-gateway'])).stdout.trim().split(':')[2]);
  for (const [socketPath, expectedGid] of [['/run/se-z/local.sock', localGroup], ['/run/se-z/gateway.sock', gatewayGroup]]) {
    const stat = await fsp.stat(socketPath);
    assert.equal(stat.uid, 0);
    assert.equal(stat.gid, expectedGid);
    assert.equal(stat.mode & 0o777, 0o660);
    assert.ok(stat.isSocket());
  }
  check('local and gateway sockets have exact path, owner, group and mode');

  const local = new SezClient({ socketPath: '/run/se-z/local.sock', clientId: 'phase2-install-verify' });
  const describe = (await local.call('sez.describe')).response;
  assert.equal(describe.error, null);
  assert.equal(describe.result.product, 'se-z');
  assert.equal(describe.result.protocol, 'SEZ1');
  assert.equal(describe.result.releaseMilestone, '0.1A');
  const installedDefinitions = await import('file:///opt/se-z/current/libexec/kernel/definitions.mjs');
  assert.equal(describe.result.activeOperations.length, installedDefinitions.ACTIVE_OPERATION_NAMES.length);
  assert.equal(describe.catalogDigest, installedDefinitions.CATALOG_DIGEST);
  assert.equal(describe.catalogDigest, describe.result.catalogDigest);
  check('installed discovery is signed SEZ1 with exact 0.1A catalog', { catalogDigest: describe.catalogDigest });

  const launch = (await local.call('sez.exec', { argv: ['/usr/bin/id', '-u'] })).response;
  const terminal = await waitTerminal(local, launch.jobId);
  assert.equal(terminal.state, 'completed');
  assert.equal(terminal.result.job.exitCode, 0);
  const stream = (await local.call('sez.job.stream.read', { jobId: launch.jobId, stream: 'stdout', offset: 0, length: 64 })).response;
  assert.equal(Buffer.from(stream.result.data, 'base64').toString(), '0\n');
  const receiptKey = await loadPublicKey('/etc/se-z/keys/receipt.public.pem');
  const receiptCheck = verifyReceipt(terminal.receipt, new Map([['receipt-v1', receiptKey]]));
  assert.equal(receiptCheck.valid, true);
  assert.equal(terminal.receipt.stdoutDigest, stream.result.finalSha256);
  check('installed supervisor executes exact argv as UID 0 and receipt verifies', { jobId: launch.jobId, receiptId: terminal.receipt.receiptId });

  const addOperator = await command('/usr/sbin/useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', '--gid', 'nogroup', '--groups', 'se-z', operator]);
  assert.equal(addOperator.code, 0, addOperator.stderr);
  operatorCreated = true;
  const operatorUid = await identity(operator, '-u');
  const operatorGid = await identity(operator, '-g');
  const operatorHealth = await runAs(operator, operatorGid, '/usr/local/bin/se-z', ['health']);
  assert.equal(operatorHealth.code, 0, operatorHealth.stderr);
  assert.equal(parseResponse(operatorHealth.stdout)?.result?.healthy, true);
  check('genuine non-root supplementary se-z group member is authorized', { uid: operatorUid, gid: operatorGid });

  const addUnrelated = await command('/usr/sbin/useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', '--gid', 'nogroup', unrelated]);
  assert.equal(addUnrelated.code, 0, addUnrelated.stderr);
  unrelatedCreated = true;
  const unrelatedUid = await identity(unrelated, '-u');
  const unrelatedGid = await identity(unrelated, '-g');
  const unrelatedHealth = await runAs(unrelated, unrelatedGid, '/usr/local/bin/se-z', ['health']);
  assert.notEqual(unrelatedHealth.code, 0);
  const unrelatedError = parseResponse(`${unrelatedHealth.stdout}\n${unrelatedHealth.stderr}`);
  assert.ok(['unauthorized_peer', 'invalid_frame', 'EACCES'].includes(unrelatedError?.code ?? unrelatedError?.error?.code));
  check('unrelated non-root local peer is rejected', { uid: unrelatedUid, gid: unrelatedGid });

  const gatewayUid = await identity('se-z-gateway', '-u');
  const gatewayGid = await identity('se-z-gateway', '-g');
  const gatewayHealth = await runAs('se-z-gateway', gatewayGid, '/usr/local/bin/se-z-gateway', ['sez.health', '--json', '{}']);
  assert.equal(gatewayHealth.code, 0, gatewayHealth.stderr);
  const gatewayResponse = parseResponse(gatewayHealth.stdout);
  assert.equal(gatewayResponse?.result?.healthy, true);
  assert.equal(gatewayResponse?.error, null);
  check('expected unprivileged gateway UID/GID/executable and Ed25519 signature are authorized', { uid: gatewayUid, gid: gatewayGid, receiptId: gatewayResponse.receipt.receiptId });

  const localOnGateway = await runAs(operatorUid, operatorGid, '/usr/local/bin/se-z', ['--socket', '/run/se-z/gateway.sock', 'health']);
  assert.notEqual(localOnGateway.code, 0);
  const localOnGatewayError = parseResponse(`${localOnGateway.stdout}\n${localOnGateway.stderr}`);
  assert.ok(['peer_class_mismatch', 'EACCES'].includes(localOnGatewayError?.code ?? localOnGatewayError?.error?.code));
  const gatewayOnLocal = await runAs(gatewayUid, gatewayGid, '/usr/local/bin/se-z-gateway', ['--socket', '/run/se-z/local.sock', 'sez.health', '--json', '{}']);
  assert.notEqual(gatewayOnLocal.code, 0);
  const gatewayOnLocalError = parseResponse(`${gatewayOnLocal.stdout}\n${gatewayOnLocal.stderr}`);
  assert.ok(['peer_class_mismatch', 'EACCES'].includes(gatewayOnLocalError?.code ?? gatewayOnLocalError?.error?.code));
  check('local and gateway peer classes cannot cross sockets by physical ACL or protocol rejection');

  const result = {
    schemaVersion: 1,
    kind: 'phase2-install-verification',
    startedAt,
    completedAt: new Date().toISOString(),
    passed: true,
    checks,
    checkCount: checks.length,
    releaseId: config.releaseIdentity.candidate,
    sourceCommit: config.buildIdentity.sourceCommit,
    sourceTree: config.buildIdentity.sourceTree,
    catalogDigest: describe.catalogDigest,
  };
  if (evidencePath) {
    await fsp.mkdir(path.dirname(evidencePath), { recursive: true });
    await fsp.writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const result = { schemaVersion: 1, kind: 'phase2-install-verification', startedAt, completedAt: new Date().toISOString(), passed: false, checks, error: { name: error.name, message: error.message, stack: error.stack } };
  if (evidencePath) {
    await fsp.mkdir(path.dirname(evidencePath), { recursive: true }).catch(() => {});
    await fsp.writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`).catch(() => {});
  }
  throw error;
} finally {
  if (operatorCreated) await command('/usr/sbin/userdel', [operator]);
  if (unrelatedCreated) await command('/usr/sbin/userdel', [unrelated]);
}
