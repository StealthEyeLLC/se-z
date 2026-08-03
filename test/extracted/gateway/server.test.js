// Derived test fixture: StealthEyeLLC/baby-quirt-mcp@0bfcd99757afe198151e96b18771626388914205:test/server.test.js; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { OAuthVerifier, verifyJwt } from '../../../src/auth/oauth/tokens.js';
import { createSezMcpServer } from '../../../src/gateway/mcp/server.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function baseConfig() {
  return {
    bindHost: '127.0.0.1',
    httpPort: 0,
    publicResource: 'https://se-z.stealtheye.io',
    oauthIssuer: 'https://se-z.stealtheye.io',
    oauthResource: 'https://se-z.stealtheye.io/mcp',
    oauthJwksUri: 'https://se-z.stealtheye.io/oauth/jwks.json',
    expectedSubject: 'stealtheye-owner',
    requiredScope: 'sez.root',
    jwksCacheMs: 300_000,
    maxRequestBytes: 1024 * 1024,
    version: 'test',
    commitSha: 'test',
  };
}

function tokenFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const kid = 'oauth-test-key';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'https://se-z.stealtheye.io', aud: 'https://se-z.stealtheye.io/mcp', sub: 'stealtheye-owner', scope: 'sez.root', iat: now, exp: now + 300 })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString('base64url');
  return {
    token: `${signingInput}.${signature}`,
    jwks: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }] },
  };
}

async function post(server, body, authorization = 'Bearer test') {
  const address = server.address();
  return await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
}

describe('se-z gateway HTTP boundary', () => {
  it('requires OAuth before any MCP action', async () => {
    const server = createSezMcpServer(baseConfig(), {
      verifier: { verify: async () => { throw new Error('no'); } },
      client: { call: async () => assert.fail('unexpected call') },
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /oauth-protected-resource/u);
  });

  it('initializes and exposes only call_sez', async () => {
    const server = createSezMcpServer(baseConfig(), {
      verifier: { verify: async () => ({ subject: 'stealtheye-owner' }) },
      client: { call: async (operation, _payload, requestId) => ({ requestId, operation, result: { protocolVersion: '1.0.0', release: { version: '0.2.0', commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, operations: Array.from({ length: 42 }, (_, index) => ({ operation: `sez.test.${index}`, family: 'test', description: 'test' })) }, receipt: { receiptId: 'test' }, evidence: { verified: true } }) },
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const initialized = await (await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    assert.equal(initialized.result.serverInfo.name, 'StealthEye se-z');
    const listed = await (await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['call_sez']);
    const described = await (await post(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'call_sez', arguments: { operation: 'sez.describe', payload: {}, idempotencyKey: 'describe-http-001' } } })).json();
    assert.equal(described.result.structuredContent.capabilities.length, 42);
  });

  it('parses request targets independently of the Host header', async () => {
    const server = createSezMcpServer(baseConfig(), {
      verifier: { verify: async () => ({ subject: 'stealtheye-owner' }) },
      client: { call: async () => assert.fail('unexpected call') },
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: address.port, path: '/healthz', headers: { host: 'attacker.invalid:65535' } }, resolve);
      request.once('error', reject);
      request.end();
    });
    assert.equal(response.statusCode, 200);
    response.resume();
  });
});

describe('OAuth JWT verification', () => {
  it('accepts only a trusted exact-owner token with the required scope', () => {
    const { token, jwks } = tokenFixture();
    const verified = verifyJwt(token, jwks, baseConfig());
    assert.equal(verified.subject, 'stealtheye-owner');
    assert.throws(() => verifyJwt(token, jwks, { ...baseConfig(), expectedSubject: 'other-owner' }), /configured owner/u);
  });

  it('uses one in-flight JWKS refresh for concurrent verification', async () => {
    const { token, jwks } = tokenFixture();
    let fetchCount = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const verifier = new OAuthVerifier(baseConfig(), async () => {
      fetchCount += 1;
      await gate;
      return { ok: true, text: async () => JSON.stringify(jwks) };
    });
    const first = verifier.verify(`Bearer ${token}`);
    const second = verifier.verify(`Bearer ${token}`);
    release();
    const values = await Promise.all([first, second]);
    assert.equal(fetchCount, 1);
    assert.deepEqual(values.map((value) => value.subject), ['stealtheye-owner', 'stealtheye-owner']);
  });
});
