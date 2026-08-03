#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { randomUUID } from 'node:crypto';
import { SezClient } from '../../../src/gateway/transport/client.js';
import { loadConfig } from '../../../src/gateway/configuration/config.js';

const config = loadConfig();
const client = new SezClient(config);
const response = await client.call('sez.health', {}, randomUUID());
const result = response.result;

if (!result || result.status !== 'healthy' || result.product !== 'se-z') {
  throw new Error('se-z live health result is invalid');
}
if (result.hostname !== config.targetHost || result.machineIdSha256 !== config.expectedMachineIdSha256) {
  throw new Error('se-z live health identity does not match');
}
if (response.evidence?.verified !== true) {
  throw new Error('se-z live receipt was not verified');
}

process.stdout.write(`${JSON.stringify({
  status: 'ok',
  operation: 'sez.health',
  product: result.product,
  protocolVersion: result.protocolVersion,
  hostname: result.hostname,
  machineIdSha256: result.machineIdSha256,
  receiptId: response.evidence.receiptId,
  resultDigest: response.evidence.resultDigest,
  receiptVerified: true,
})}\n`);
