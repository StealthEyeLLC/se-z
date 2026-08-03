// New se-z Phase 1 differential parity test. GitHub is mocked; no token or network access is used.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { identityNormalize, sourceSupervisor, target } from '../helpers/index.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function run(kind: 'source' | 'target') {
  const module = kind === 'source' ? await sourceSupervisor('src/github/app-authority.ts') : await target('src/github/app-authority.ts');
  const root = mkdtempSync(join(tmpdir(), `sez-parity-${kind}-github-`));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = join(root, 'github-app.pem');
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const fetchFn = async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === '/app') return json(200, { id: 4380878, name: 'Z GitHub Authority', slug: 'z-github-authority', owner: { login: 'StealthEyeLLC' } });
    if (url.pathname === '/app/installations/148647330') return json(200, { id: 148647330, account: { login: 'StealthEyeLLC' }, repository_selection: 'all', permissions: { contents: 'write', administration: 'write' } });
    if (url.pathname === '/app/installations/148647330/access_tokens') return json(201, { token: 'fixture-token-value-long-enough', expires_at: '2026-08-03T13:00:00Z', repositories: [{ full_name: 'StealthEyeLLC/se-z' }] });
    if (url.pathname === '/repos/StealthEyeLLC/se-z') return json(200, { full_name: 'StealthEyeLLC/se-z', default_branch: 'main' });
    return json(404, { message: `unexpected ${method} ${url.pathname}` });
  };
  try {
    const authority = new module.GitHubAppAuthority({ credentialPath: keyPath, fetchFn, now: () => Date.parse('2026-08-03T12:00:00Z') });
    const result = await authority.verify({ repository: 'StealthEyeLLC/se-z' });
    let rejected = '';
    try { await authority.verify({ repository: 'OtherOrg/se-z' }); } catch (error: any) { rejected = error.message; }
    return { constants: module.GITHUB_APP_AUTHORITY, result, calls, rejected };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('App identity, installation identity, repository scope, ephemeral token and credential semantics retain behavior', async () => {
  const source = await run('source');
  const targetResult = await run('target');
  assert.deepEqual(identityNormalize(source.constants), targetResult.constants);
  assert.deepEqual(identityNormalize(source.result), targetResult.result);
  assert.deepEqual(source.calls, targetResult.calls);
  assert.equal(source.result.verified, true);
  assert.equal(source.result.token.scope, 'single_repository_contents_read');
  assert.equal(source.result.token.persisted, false);
  assert.equal(source.result.credential.plaintextPersisted, false);
  assert.match(source.rejected, /StealthEyeLLC/iu);
  assert.equal(source.rejected, targetResult.rejected);
  const tokenRequest = source.calls.find((call) => call.path.endsWith('/access_tokens'));
  assert.deepEqual(tokenRequest?.body, { repositories: ['se-z'], permissions: { contents: 'read', metadata: 'read' } });
});
