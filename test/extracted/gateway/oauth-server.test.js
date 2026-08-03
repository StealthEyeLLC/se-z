// Derived test fixture: StealthEyeLLC/baby-quirt-mcp@0bfcd99757afe198151e96b18771626388914205:test/oauth-server.test.js; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { hashOwnerPassword } from '../../../src/auth/oauth/server.js';
import { verifyJwt } from '../../../src/auth/oauth/tokens.js';
import { createSezMcpServer } from '../../../src/gateway/mcp/server.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'se-z-oauth-'));
  const { privateKey } = generateKeyPairSync('ed25519');
  const signingPath = join(root, 'oauth-private.pem');
  writeFileSync(signingPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const config = {
    bindHost: '127.0.0.1',
    httpPort: 0,
    publicResource: 'https://se-z.stealtheye.io',
    protectedResource: 'https://se-z.stealtheye.io/mcp',
    oauthIssuer: 'https://se-z.stealtheye.io',
    oauthResource: 'https://se-z.stealtheye.io/mcp',
    oauthJwksUri: 'https://se-z.stealtheye.io/oauth/jwks.json',
    oauthSigningPrivateKeyPath: signingPath,
    oauthStatePath: join(root, 'oauth-state.json'),
    identityProvider: 'password',
    ownerPasswordScrypt: hashOwnerPassword('correct horse battery staple owner password', { salt: Buffer.alloc(24, 7) }),
    expectedSubject: 'stealtheye-owner',
    requiredScope: 'sez.root',
    jwksCacheMs: 300_000,
    maxRequestBytes: 1024 * 1024,
    version: 'test',
    commitSha: 'test',
  };
  const server = createSezMcpServer(config, {
    client: { call: async () => assert.fail('unexpected private call') },
  });
  servers.push(server);
  return { config, server };
}

async function start(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function challenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function register(base) {
  const response = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/aip/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(response.status, 201);
  return await response.json();
}

describe('embedded OAuth authorization server', () => {
  it('publishes path-aware protected-resource and authorization-server metadata', async () => {
    const { server } = fixture();
    const base = await start(server);
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        resource: 'https://se-z.stealtheye.io/mcp',
        authorization_servers: ['https://se-z.stealtheye.io'],
        bearer_methods_supported: ['header'],
        scopes_supported: ['sez.root'],
        resource_documentation: 'https://se-z.stealtheye.io/healthz',
      });
    }
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(metadata.issuer, 'https://se-z.stealtheye.io');
    assert.equal(metadata.registration_endpoint, 'https://se-z.stealtheye.io/oauth/register');
    assert.deepEqual(metadata.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.ok(metadata.scopes_supported.includes('offline_access'));
    const jwks = await (await fetch(`${base}/oauth/jwks.json`)).json();
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0].alg, 'EdDSA');
    assert.equal('d' in jwks.keys[0], false);
  });

  it('completes DCR, password authorization, PKCE, refresh, and authenticated MCP initialize', async () => {
    const { config, server } = fixture();
    const base = await start(server);
    const client = await register(base);
    const verifier = 'a'.repeat(64);
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', client.client_id);
    authorize.searchParams.set('redirect_uri', client.redirect_uris[0]);
    authorize.searchParams.set('scope', 'sez.root offline_access');
    authorize.searchParams.set('state', 'state-123');
    authorize.searchParams.set('resource', config.protectedResource);
    authorize.searchParams.set('code_challenge', challenge(verifier));
    authorize.searchParams.set('code_challenge_method', 'S256');
    const login = await fetch(authorize, { redirect: 'manual' });
    assert.equal(login.status, 200);
    const page = await login.text();
    const flowId = /name="flow_id" value="([^"]+)"/u.exec(page)?.[1];
    assert.ok(flowId);

    const wrong = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ flow_id: flowId, password: 'not-the-password-at-all' }),
      redirect: 'manual',
    });
    assert.equal(wrong.status, 401);

    const allowed = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ flow_id: flowId, password: 'correct horse battery staple owner password' }),
      redirect: 'manual',
    });
    assert.equal(allowed.status, 303);
    const callback = new URL(allowed.headers.get('location'));
    assert.equal(callback.origin, 'https://chatgpt.com');
    assert.equal(callback.searchParams.get('state'), 'state-123');
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        code,
        code_verifier: verifier,
        resource: config.protectedResource,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.refresh_token);
    assert.ok(tokens.scope.includes('offline_access'));

    const jwks = await (await fetch(`${base}/oauth/jwks.json`)).json();
    const verified = verifyJwt(tokens.access_token, jwks, config);
    assert.equal(verified.subject, 'stealtheye-owner');
    assert.equal(verified.claims.aud, config.protectedResource);
    assert.equal(verified.claims.resource, config.protectedResource);

    const initialized = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    });
    assert.equal(initialized.status, 200);
    assert.equal((await initialized.json()).result.serverInfo.name, 'StealthEye se-z');

    const refreshRequest = (refreshToken) => fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: refreshToken,
        resource: config.protectedResource,
      }),
    });
    const concurrent = await Promise.all([
      refreshRequest(tokens.refresh_token),
      refreshRequest(tokens.refresh_token),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 400]);
    const refreshed = concurrent.find((response) => response.status === 200);
    const rejected = concurrent.find((response) => response.status === 400);
    assert.ok(refreshed);
    assert.ok(rejected);
    assert.equal((await rejected.json()).error, 'invalid_grant');
    const rotated = await refreshed.json();
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);

    const replay = await refreshRequest(tokens.refresh_token);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_grant');
    const rotatedUse = await refreshRequest(rotated.refresh_token);
    assert.equal(rotatedUse.status, 200);
    const nextRotation = await rotatedUse.json();
    assert.notEqual(nextRotation.refresh_token, rotated.refresh_token);
    const rotatedReplay = await refreshRequest(rotated.refresh_token);
    assert.equal(rotatedReplay.status, 400);
    assert.equal((await rotatedReplay.json()).error, 'invalid_grant');

    const persisted = readFileSync(config.oauthStatePath, 'utf8');
    for (const rawToken of [tokens.refresh_token, rotated.refresh_token, nextRotation.refresh_token]) {
      assert.equal(persisted.includes(rawToken), false);
    }
    assert.equal(statSync(config.oauthStatePath).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(dirname(config.oauthStatePath)).filter((name) => name.includes('.tmp')),
      [],
    );
  });

  it('rejects off-origin registrations and wrong protected resources', async () => {
    const { config, server } = fixture();
    const base = await start(server);
    const badRegistration = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://attacker.invalid/callback'] }),
    });
    assert.equal(badRegistration.status, 400);
    const client = await register(base);
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', client.client_id);
    authorize.searchParams.set('redirect_uri', client.redirect_uris[0]);
    authorize.searchParams.set('scope', 'sez.root');
    authorize.searchParams.set('resource', `${config.publicResource}/wrong`);
    authorize.searchParams.set('code_challenge', challenge('b'.repeat(64)));
    authorize.searchParams.set('code_challenge_method', 'S256');
    const response = await fetch(authorize, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'invalid_target');
  });
});
