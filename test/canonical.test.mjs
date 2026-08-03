import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CORE_OPERATIONS, catalogDigest } from '../src/catalog.mjs';
import * as constants from '../src/constants.mjs';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('canonical product identity', () => {
  assert.equal(constants.PRODUCT, 'se-z');
  assert.equal(constants.PUBLIC_TOOL, 'call_sez');
  assert.equal(constants.PROTOCOL, 'SEZ1');
  assert.equal(constants.AUTHORITY_SCOPE, 'sez.root');
  assert.equal(constants.LIFECYCLE_SCOPE, 'offline_access');
});

test('public schema is frozen and generic', async () => {
  const schema = await json('contracts/tool-schema.json');
  assert.deepEqual(schema.required, ['operation', 'payload', 'idempotencyKey']);
  assert.deepEqual(Object.keys(schema.properties), ['operation', 'payload', 'idempotencyKey']);
  assert.equal(schema.properties.operation.enum, undefined);
});

test('SEZ1 request includes authorityGeneration', async () => {
  const schema = await json('protocol/schemas/request.schema.json');
  assert.ok(schema.required.includes('authorityGeneration'));
  assert.equal(schema.properties.authorityGeneration.minimum, 1);
});

test('result requires catalogDigest and durable streams', async () => {
  const schema = await json('protocol/schemas/result.schema.json');
  assert.ok(schema.required.includes('catalogDigest'));
  assert.ok(schema.required.includes('streams'));
  assert.ok(schema.$defs.stream.required.includes('handle'));
  assert.ok(schema.$defs.stream.required.includes('nextOffset'));
});

test('catalog is stable and digestible', () => {
  assert.ok(CORE_OPERATIONS.includes('sez.request.resume'));
  assert.ok(CORE_OPERATIONS.includes('sez.job.wait'));
  assert.match(catalogDigest(), /^[a-f0-9]{64}$/);
});

test('canonical documents contain final consistency fixes', async () => {
  const canonical = await readFile('CANONICAL.md', 'utf8');
  const oauth = await readFile('docs/OAUTH.md', 'utf8');
  const protocol = await readFile('protocol/SEZ1.md', 'utf8');
  for (const token of ['authorityGeneration', '/var/lib/se-z-gateway/', '/run/se-z/gateway.sock', '/run/se-z/local.sock']) assert.ok(canonical.includes(token));
  for (const token of ['/.well-known/oauth-protected-resource', 'WWW-Authenticate', 'offline_access']) assert.ok(oauth.includes(token));
  for (const token of ['16 MiB', 'sez.request.resume', 'catalogDigest']) assert.ok(protocol.includes(token));
});
