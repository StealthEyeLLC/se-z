#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { createHash, randomBytes } from 'node:crypto';

const baseUrl = new URL(process.env.SEZ_GATEWAY_SMOKE_BASE_URL ?? 'http://127.0.0.1:2096');
const publicResource = process.env.SEZ_GATEWAY_PUBLIC_RESOURCE ?? 'https://se-z.stealtheye.io';
const protectedResource = process.env.SEZ_GATEWAY_RESOURCE_URI ?? `${publicResource}/mcp`;
const callback = process.env.SEZ_GATEWAY_SMOKE_CALLBACK ?? 'https://chatgpt.com/aip/oauth/callback';
const expectedClientId = process.env.SEZ_GATEWAY_GITHUB_CLIENT_ID ?? '';
const expectedGitHubCallback = process.env.SEZ_GATEWAY_GITHUB_CALLBACK_URI ?? `${publicResource}/oauth/github/callback`;

if (!expectedClientId) throw new Error('SEZ_GATEWAY_GITHUB_CLIENT_ID is required');

function endpoint(path) {
  return new URL(path, baseUrl).toString();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(response, label, expectedStatus = 200) {
  const text = await response.text();
  if (response.status !== expectedStatus) throw new Error(`${label} returned ${response.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const registration = await json(await fetch(endpoint('/oauth/register'), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'se-z GitHub login preflight',
    redirect_uris: [callback],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }),
}), 'dynamic registration', 201);

const verifier = randomBytes(48).toString('base64url');
const authorize = new URL(endpoint('/oauth/authorize'));
authorize.searchParams.set('response_type', 'code');
authorize.searchParams.set('client_id', registration.client_id);
authorize.searchParams.set('redirect_uri', callback);
authorize.searchParams.set('scope', 'sez.root offline_access');
authorize.searchParams.set('state', randomBytes(24).toString('base64url'));
authorize.searchParams.set('resource', protectedResource);
authorize.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
authorize.searchParams.set('code_challenge_method', 'S256');

const response = await fetch(authorize, { redirect: 'manual' });
assert(response.status === 302, `authorization redirect returned ${response.status}`);
const github = new URL(response.headers.get('location'));
assert(github.origin === 'https://github.com', 'authorization did not redirect to GitHub');
assert(github.pathname === '/login/oauth/authorize', 'GitHub authorization path is wrong');
assert(github.searchParams.get('client_id') === expectedClientId, 'GitHub client ID is wrong');
assert(github.searchParams.get('redirect_uri') === expectedGitHubCallback, 'GitHub callback URI is wrong');
assert(github.searchParams.get('state'), 'GitHub state is missing');
assert(github.searchParams.get('code_challenge_method') === 'S256', 'GitHub PKCE method is wrong');
assert(github.searchParams.get('code_challenge'), 'GitHub PKCE challenge is missing');
assert(github.searchParams.get('allow_signup') === 'false', 'GitHub signup must be disabled');

process.stdout.write(`${JSON.stringify({
  status: 'ok',
  identityProvider: 'github',
  protectedResource,
  githubAuthorizeOrigin: github.origin,
  githubCallback: github.searchParams.get('redirect_uri'),
  githubPkce: github.searchParams.get('code_challenge_method'),
  dynamicRegistration: true,
})}\n`);
