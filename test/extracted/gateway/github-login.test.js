// Derived test fixture: StealthEyeLLC/baby-quirt-mcp@0bfcd99757afe198151e96b18771626388914205:test/github-login.test.js; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { OAuthAuthorizationServer } from '../../../src/auth/oauth/server.js';
import { createSezMcpServer } from '../../../src/gateway/mcp/server.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function challenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function fixture(githubUserId = 247854506) {
  const root = mkdtempSync(join(tmpdir(), 'se-z-github-login-'));
  const { privateKey } = generateKeyPairSync('ed25519');
  const signingPath = join(root, 'oauth-private.pem');
  const secretPath = join(root, 'github-client-secret');
  const statePath = join(root, 'oauth-state.json');
  writeFileSync(signingPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  writeFileSync(secretPath, 'github-app-client-secret-for-tests-only', { mode: 0o600 });
  const config = {
    bindHost: '127.0.0.1',
    httpPort: 0,
    publicResource: 'https://se-z.stealtheye.io',
    protectedResource: 'https://se-z.stealtheye.io/mcp',
    oauthIssuer: 'https://se-z.stealtheye.io',
    oauthResource: 'https://se-z.stealtheye.io/mcp',
    oauthJwksUri: 'https://se-z.stealtheye.io/oauth/jwks.json',
    oauthSigningPrivateKeyPath: signingPath,
    oauthStatePath: statePath,
    identityProvider: 'github',
    ownerPasswordScrypt: '',
    githubClientId: 'Iv1.0123456789abcdef',
    githubClientSecretPath: secretPath,
    githubAllowedUserId: 247854506,
    githubLoginHint: 'StealthEyeLLC',
    githubCallbackUri: 'https://se-z.stealtheye.io/oauth/github/callback',
    expectedSubject: 'stealtheye-owner',
    requiredScope: 'sez.root',
    jwksCacheMs: 300_000,
    maxRequestBytes: 1024 * 1024,
    version: 'test',
    commitSha: 'test',
  };
  const calls = [];
  const githubFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('client_id'), config.githubClientId);
      assert.equal(body.get('client_secret'), 'github-app-client-secret-for-tests-only');
      assert.equal(body.get('redirect_uri'), config.githubCallbackUri);
      assert.ok(body.get('code_verifier'));
      return new Response(JSON.stringify({ access_token: 'ghu_test_identity_token', token_type: 'bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url) === 'https://api.github.com/user') {
      assert.equal(options.headers.authorization, 'Bearer ghu_test_identity_token');
      return new Response(JSON.stringify({ id: githubUserId, login: githubUserId === 247854506 ? 'StealthEyeLLC' : 'intruder' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  };
  const oauthServer = new OAuthAuthorizationServer(config, { fetch: githubFetch });
  const server = createSezMcpServer(config, {
    oauthServer,
    client: { call: async () => assert.fail('unexpected private call') },
  });
  servers.push(server);
  return { config, server, statePath, calls };
}

async function start(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
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

async function begin(base, config, client, verifier, state = 'chatgpt-state') {
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', client.client_id);
  authorize.searchParams.set('redirect_uri', client.redirect_uris[0]);
  authorize.searchParams.set('scope', 'sez.root offline_access');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('resource', config.protectedResource);
  authorize.searchParams.set('code_challenge', challenge(verifier));
  authorize.searchParams.set('code_challenge_method', 'S256');
  const response = await fetch(authorize, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return new URL(response.headers.get('location'));
}

describe('GitHub App owner identity', () => {
  it('uses GitHub App login, verifies the exact numeric owner, and completes MCP OAuth', async () => {
    const { config, server, statePath, calls } = fixture();
    const base = await start(server);
    const client = await register(base);
    const verifier = 'v'.repeat(64);
    const github = await begin(base, config, client, verifier);
    assert.equal(github.origin, 'https://github.com');
    assert.equal(github.pathname, '/login/oauth/authorize');
    assert.equal(github.searchParams.get('client_id'), config.githubClientId);
    assert.equal(github.searchParams.get('redirect_uri'), config.githubCallbackUri);
    assert.equal(github.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(github.searchParams.get('allow_signup'), 'false');
    assert.equal(github.searchParams.get('prompt'), 'select_account');
    assert.equal(github.searchParams.get('login'), 'StealthEyeLLC');
    const githubState = github.searchParams.get('state');
    assert.ok(githubState);

    const callback = await fetch(`${base}/oauth/github/callback?code=github-code&state=${encodeURIComponent(githubState)}`, { redirect: 'manual' });
    assert.equal(callback.status, 302);
    const chatgpt = new URL(callback.headers.get('location'));
    assert.equal(chatgpt.origin, 'https://chatgpt.com');
    assert.equal(chatgpt.searchParams.get('state'), 'chatgpt-state');
    const code = chatgpt.searchParams.get('code');
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
    assert.equal(calls.length, 2);
    assert.equal(readFileSync(statePath, 'utf8').includes('ghu_test_identity_token'), false);
    assert.equal(readFileSync(statePath, 'utf8').includes('github-app-client-secret-for-tests-only'), false);
  });

  it('rejects every GitHub account except the pinned numeric owner', async () => {
    const { config, server } = fixture(999999999);
    const base = await start(server);
    const client = await register(base);
    const github = await begin(base, config, client, 'x'.repeat(64), 'denied-state');
    const response = await fetch(`${base}/oauth/github/callback?code=github-code&state=${encodeURIComponent(github.searchParams.get('state'))}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const callback = new URL(response.headers.get('location'));
    assert.equal(callback.searchParams.get('error'), 'access_denied');
    assert.equal(callback.searchParams.get('state'), 'denied-state');
    assert.equal(callback.searchParams.has('code'), false);
  });

  it('does not expose the password approval route in GitHub mode', async () => {
    const { config, server } = fixture();
    const base = await start(server);
    const client = await register(base);
    await begin(base, config, client, 'z'.repeat(64));
    const response = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ flow_id: 'irrelevant', password: 'irrelevant-password-value' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 405);
  });
});
