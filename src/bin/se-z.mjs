#!/usr/bin/env node
import fsp from 'node:fs/promises';
import process from 'node:process';
import { SezClient } from '../kernel/client.mjs';
import { loadConfig } from '../kernel/config.mjs';
import { loadPublicKeys, verifyReceipt, operationResultDigest, requestDigest } from '../kernel/crypto.mjs';
import { SezError, randomId } from '../kernel/util.mjs';

function parseGlobal(argv) {
  const options = { socketPath: '/run/se-z/local.sock', json: false };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--socket') options.socketPath = argv[++index];
    else if (arg === '--json' || arg === '--json-output') options.json = true;
    else if (arg === '--authority-generation') options.authorityGeneration = Number(argv[++index]);
    else if (arg === '--idempotency-key') options.idempotencyKey = argv[++index];
    else if (arg === '--request-id') options.requestId = argv[++index];
    else rest.push(arg);
  }
  return { options, rest };
}

async function payloadFrom(value) {
  if (value === undefined) return {};
  if (value === '-') return JSON.parse(await readStdinText());
  if (value.startsWith('@')) return JSON.parse(await fsp.readFile(value.slice(1), 'utf8'));
  return JSON.parse(value);
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function printJson(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function metadata(call) {
  const jobId = call.response?.jobId ?? call.response?.result?.job?.jobId ?? '';
  process.stderr.write(`se-z requestId=${call.request.requestId} idempotencyKey=${call.request.idempotencyKey}${jobId ? ` jobId=${jobId}` : ''}\n`);
}

async function callOperation(client, operation, payload, options) {
  const call = await client.call(operation, payload, options);
  metadata(call);
  return call;
}

async function readStreamFully(client, jobId, stream, startOffset = 0, destination = null, callOptions = {}) {
  let offset = startOffset;
  while (true) {
    const call = await client.call('sez.job.stream.read', { jobId, stream, offset, length: 1024 * 1024 }, { idempotencyKey: `cli-stream-${jobId}-${stream}-${offset}-${randomId()}`, authorityGeneration: callOptions.authorityGeneration });
    const response = call.response;
    if (response.error) throw new SezError(response.error.code, response.error.message, response.error.details);
    const page = response.result;
    const bytes = Buffer.from(page.data, 'base64');
    if (destination) destination.write(bytes);
    offset = page.nextOffset;
    if (page.endOfStream || (page.bytes === 0 && page.complete)) return { offset, descriptor: page };
    if (page.bytes === 0) return { offset, descriptor: page };
  }
}

async function executeAndWait(client, operation, payload, options) {
  const call = await callOperation(client, operation, payload, options);
  if (call.response.error) {
    if (options.json) printJson(call);
    else process.stderr.write(`${call.response.error.code}: ${call.response.error.message}\n`);
    return 1;
  }
  const jobId = call.response.jobId;
  if (!jobId) {
    printJson(call);
    return call.response.terminal && call.response.state === 'completed' ? 0 : 1;
  }
  if (payload.detached) {
    printJson(call);
    return 0;
  }
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.once('SIGINT', onInterrupt);
  let finalResponse = call.response;
  try {
    while (!finalResponse.terminal && !interrupted) {
      const waitCall = await client.call('sez.job.wait', { jobId, waitMs: 30_000 }, { idempotencyKey: `cli-wait-${jobId}-${randomId()}`, authorityGeneration: options.authorityGeneration });
      finalResponse = waitCall.response;
      if (finalResponse.error) break;
    }
    if (interrupted) {
      process.stderr.write(`se-z wait interrupted; durable job ${jobId} was not cancelled\n`);
      return 130;
    }
    const job = finalResponse.result?.job ?? finalResponse.result?.originalResponse?.job ?? finalResponse.result?.job;
    if (options.json) {
      const stdout = await readStreamFully(client, jobId, 'stdout', 0, null, options);
      const stderr = await readStreamFully(client, jobId, 'stderr', 0, null, options);
      printJson({ initial: call.response, final: finalResponse, streamReadback: { stdout: stdout.descriptor, stderr: stderr.descriptor } });
    } else {
      await readStreamFully(client, jobId, 'stdout', 0, process.stdout, options);
      await readStreamFully(client, jobId, 'stderr', 0, process.stderr, options);
    }
    const actualJob = finalResponse.result?.job;
    if (finalResponse.error) return 1;
    if (finalResponse.state === 'completed') return Number.isInteger(actualJob?.exitCode) ? actualJob.exitCode : 0;
    if (finalResponse.state === 'cancelled') return 130;
    return 1;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

async function verifyReceiptCommand(args) {
  const input = args[0] ?? '-';
  const requestArgIndex = args.indexOf('--request');
  const requestFile = requestArgIndex >= 0 ? args[requestArgIndex + 1] : null;
  const parsed = JSON.parse(input === '-' ? await readStdinText() : await fsp.readFile(input.startsWith('@') ? input.slice(1) : input, 'utf8'));
  const response = parsed.receipt ? parsed : null;
  const receipt = response?.receipt ?? parsed;
  const config = await loadConfig(process.env.SEZ_CONFIG);
  const keys = await loadPublicKeys(config.receiptVerificationKeys);
  const signature = verifyReceipt(receipt, keys);
  const checks = { signature };
  if (response) {
    const { resultDigest, receipt: _receipt, ...base } = response;
    const computed = operationResultDigest(base);
    checks.responseResultDigest = { valid: computed === resultDigest, computed, claimed: resultDigest };
    checks.receiptResultDigest = { valid: receipt.resultDigest === resultDigest, receipt: receipt.resultDigest, response: resultDigest };
  }
  if (requestFile) {
    const request = JSON.parse(await fsp.readFile(requestFile.startsWith('@') ? requestFile.slice(1) : requestFile, 'utf8'));
    const computed = requestDigest(request);
    checks.requestDigest = { valid: computed === receipt.requestDigest, computed, receipt: receipt.requestDigest };
  }
  const valid = Object.values(checks).every((entry) => entry.valid !== false);
  printJson({ valid, receiptId: receipt.receiptId, keyId: receipt.receiptKeyId, checks });
  return valid ? 0 : 1;
}

function usage() {
  return `se-z — native SEZ1 local operator\n\n` +
    `Global: --socket PATH --json --idempotency-key KEY --request-id UUID --authority-generation N\n\n` +
    `Commands:\n` +
    `  se-z call <sez.operation> [JSON|@file|-]\n` +
    `  se-z describe|health|version|doctor\n` +
    `  se-z exec [--detached] -- <argv...>\n` +
    `  se-z shell [--detached] <command>\n` +
    `  se-z job get|wait|cancel <jobId>\n` +
    `  se-z stream read <jobId> <stdout|stderr> [offset] [length]\n` +
    `  se-z file|pty|artifact <verb> [JSON|@file|-]\n` +
    `  se-z request resume [JSON|@file|-]\n` +
    `  se-z receipt verify <response-or-receipt.json> [--request request.json]\n`;
}

async function main() {
  const raw = process.argv.slice(2);
  if (raw[0] === 'receipt' && raw[1] === 'verify') return await verifyReceiptCommand(raw.slice(2));
  const { options, rest } = parseGlobal(raw);
  const command = rest.shift();
  if (!command || command === 'help' || command === '--help') { process.stdout.write(usage()); return 0; }
  const client = new SezClient({ socketPath: options.socketPath });
  const callOptions = { idempotencyKey: options.idempotencyKey, requestId: options.requestId, authorityGeneration: options.authorityGeneration };
  if (['describe', 'health', 'version', 'doctor'].includes(command)) {
    const call = await callOperation(client, `sez.${command}`, {}, callOptions);
    printJson(call.response);
    return call.response.error ? 1 : 0;
  }
  if (command === 'call') {
    const operation = rest.shift(); if (!operation) throw new SezError('invalid_payload', 'call requires an operation');
    const call = await callOperation(client, operation, await payloadFrom(rest.shift()), callOptions);
    printJson(call.response); return call.response.error ? 1 : 0;
  }
  if (command === 'exec') {
    const detachedIndex = rest.indexOf('--detached'); const detached = detachedIndex >= 0; if (detached) rest.splice(detachedIndex, 1);
    const separator = rest.indexOf('--'); const argv = separator >= 0 ? rest.slice(separator + 1) : rest;
    if (!argv.length) throw new SezError('invalid_payload', 'exec requires argv after --');
    return await executeAndWait(client, 'sez.exec', { argv, detached }, options);
  }
  if (command === 'shell') {
    const detachedIndex = rest.indexOf('--detached'); const detached = detachedIndex >= 0; if (detached) rest.splice(detachedIndex, 1);
    const shellCommand = rest.join(' '); if (!shellCommand) throw new SezError('invalid_payload', 'shell requires command text');
    return await executeAndWait(client, 'sez.shell', { command: shellCommand, detached }, options);
  }
  if (command === 'job') {
    const verb = rest.shift(); const jobId = rest.shift();
    const operation = { get: 'sez.job.get', wait: 'sez.job.wait', cancel: 'sez.job.cancel' }[verb];
    if (!operation || !jobId) throw new SezError('invalid_payload', 'job requires get|wait|cancel and jobId');
    const payload = verb === 'wait' ? { jobId, waitMs: Number(rest.shift() ?? 30_000) } : { jobId };
    const call = await callOperation(client, operation, payload, callOptions); printJson(call.response); return call.response.error ? 1 : 0;
  }
  if (command === 'stream' && rest.shift() === 'read') {
    const jobId = rest.shift(); const stream = rest.shift(); const offset = Number(rest.shift() ?? 0); const length = Number(rest.shift() ?? 1024 * 1024);
    const call = await callOperation(client, 'sez.job.stream.read', { jobId, stream, offset, length }, callOptions);
    if (options.json) printJson(call.response); else if (!call.response.error) process.stdout.write(Buffer.from(call.response.result.data, 'base64'));
    return call.response.error ? 1 : 0;
  }
  if (['file', 'pty', 'artifact'].includes(command)) {
    const verb = rest.shift(); if (!verb) throw new SezError('invalid_payload', `${command} requires a verb`);
    const call = await callOperation(client, `sez.${command}.${verb}`, await payloadFrom(rest.shift()), callOptions); printJson(call.response); return call.response.error ? 1 : 0;
  }
  if (command === 'request' && rest.shift() === 'resume') {
    const call = await callOperation(client, 'sez.request.resume', await payloadFrom(rest.shift()), callOptions); printJson(call.response); return call.response.error ? 1 : 0;
  }
  throw new SezError('invalid_payload', `Unknown command: ${command}`);
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${error.code ?? 'internal_error'}: ${error.message}\n`);
  process.exitCode = 1;
});
