#!/usr/bin/env node
import fsp from 'node:fs/promises';
import { SezClient } from '../kernel/client.mjs';
import { MAX_FRAME_SIZE } from '../kernel/util.mjs';

function usage() {
  process.stderr.write('usage: se-z-gateway [--config PATH] [--socket PATH] [--key PATH] [--key-id ID] [--gateway-id ID] [--request-id UUID] [--idempotency-key KEY] OPERATION [--json JSON]\n');
  process.exit(64);
}

const args = process.argv.slice(2);
const options = {
  configPath: process.env.SEZ_GATEWAY_CONFIG ?? null,
  socketPath: process.env.SEZ_GATEWAY_SOCKET ?? '/run/se-z/gateway.sock',
  privateKeyPath: process.env.SEZ_GATEWAY_PRIVATE_KEY ?? '/etc/se-z/keys/gateway.private.pem',
  gatewayKeyId: process.env.SEZ_GATEWAY_KEY_ID ?? 'gateway-v1',
  gatewayId: process.env.SEZ_GATEWAY_ID ?? 'se-z-gateway',
};
let operation = null;
let payload = {};
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === '--config') options.configPath = args[++index] ?? usage();
  else if (value === '--socket') options.socketPath = args[++index] ?? usage();
  else if (value === '--key') options.privateKeyPath = args[++index] ?? usage();
  else if (value === '--key-id') options.gatewayKeyId = args[++index] ?? usage();
  else if (value === '--gateway-id') options.gatewayId = args[++index] ?? usage();
  else if (value === '--request-id') options.requestId = args[++index] ?? usage();
  else if (value === '--idempotency-key') options.idempotencyKey = args[++index] ?? usage();
  else if (value === '--json') {
    const text = args[++index] ?? usage();
    try { payload = JSON.parse(text); } catch { usage(); }
  } else if (value.startsWith('-') || operation !== null) usage();
  else operation = value;
}
if (!operation) usage();
let config = {};
if (options.configPath) config = JSON.parse(await fsp.readFile(options.configPath, 'utf8'));
const client = await SezClient.gateway({
  socketPath: options.socketPath ?? config.gatewaySocket ?? '/run/se-z/gateway.sock',
  privateKeyPath: options.privateKeyPath,
  gatewayId: options.gatewayId,
  gatewayKeyId: options.gatewayKeyId,
  clientId: 'se-z-gateway',
  maximumFrameSize: config.maximumFrameSize ?? MAX_FRAME_SIZE,
});
try {
  const result = await client.call(operation, payload, {
    requestId: options.requestId,
    idempotencyKey: options.idempotencyKey,
  });
  process.stdout.write(`${JSON.stringify(result.response)}\n`);
  if (result.response?.error) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code ?? 'operation_failed', message: error.message })}\n`);
  process.exitCode = 1;
}
