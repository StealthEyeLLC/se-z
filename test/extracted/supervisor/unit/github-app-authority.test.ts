// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/github-app-authority.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GitHubAppAuthority } from '../../../../src/github/app-authority.js';

const APP_ID = '4380878';
const INSTALLATION_ID = '148647330';
const ACCOUNT = 'StealthEyeLLC';
const REPOSITORY = 'StealthEyeLLC/sez-x';
const BASE_COMMIT = 'a'.repeat(40);
const BASE_TREE = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const COMMIT = 'e'.repeat(40);

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });
}

function fixture(): { directory: string; keyPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'sez-github-app-test-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = join(directory, 'app.pem');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { directory, keyPath };
}

function mockGitHub(): { fetchFn: typeof fetch; calls: Array<{ method: string; path: string; body?: unknown }>; deleted: () => boolean } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let branchDeleted = false;
  let postDeleteReads = 0;
  let proofBranch = '';

  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });

    const authorization = new Headers(init.headers).get('Authorization') ?? '';
    assert.match(authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$|^Bearer installation-token-123456$/);

    if (method === 'GET' && url.pathname === '/app') {
      const jwt = authorization.slice('Bearer '.length);
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as { iss?: string };
      assert.equal(payload.iss, APP_ID);
      return response(200, { id: Number(APP_ID), name: 'Sez GitHub Authority', slug: 'sez-github-authority', owner: { login: ACCOUNT } });
    }
    if (method === 'GET' && url.pathname === `/app/installations/${INSTALLATION_ID}`) {
      return response(200, { id: Number(INSTALLATION_ID), account: { login: ACCOUNT }, repository_selection: 'all', permissions: { contents: 'write' } });
    }
    if (method === 'POST' && url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      assert.deepEqual(body, {
        repositories: ['sez-x'],
        permissions: { contents: body.permissions.contents, metadata: 'read' },
      });
      return response(201, { token: 'installation-token-123456', expires_at: '2026-07-27T11:00:00Z', repositories: [{ full_name: REPOSITORY }] });
    }
    if (method === 'GET' && url.pathname === `/repos/${REPOSITORY}`) {
      return response(200, { full_name: REPOSITORY, default_branch: 'main' });
    }
    if (method === 'GET' && url.pathname === `/repos/${REPOSITORY}/git/ref/heads/main`) {
      return response(200, { object: { sha: BASE_COMMIT } });
    }
    if (method === 'GET' && url.pathname === `/repos/${REPOSITORY}/git/commits/${BASE_COMMIT}`) {
      return response(200, { sha: BASE_COMMIT, tree: { sha: BASE_TREE } });
    }
    if (method === 'POST' && url.pathname === `/repos/${REPOSITORY}/git/blobs`) {
      return response(201, { sha: BLOB });
    }
    if (method === 'POST' && url.pathname === `/repos/${REPOSITORY}/git/trees`) {
      return response(201, { sha: TREE });
    }
    if (method === 'POST' && url.pathname === `/repos/${REPOSITORY}/git/commits`) {
      return response(201, { sha: COMMIT, tree: { sha: TREE } });
    }
    if (method === 'POST' && url.pathname === `/repos/${REPOSITORY}/git/refs`) {
      proofBranch = String(body.ref).replace('refs/heads/', '');
      return response(201, { ref: body.ref, object: { sha: COMMIT } });
    }
    if (method === 'GET' && proofBranch && url.pathname === `/repos/${REPOSITORY}/git/ref/heads/${proofBranch}`) {
      if (!branchDeleted) return response(200, { object: { sha: COMMIT } });
      postDeleteReads += 1;
      return postDeleteReads < 3
        ? response(200, { object: { sha: COMMIT } })
        : response(404, { message: 'Not Found' });
    }
    if (method === 'GET' && url.pathname === `/repos/${REPOSITORY}/git/commits/${COMMIT}`) {
      return response(200, { sha: COMMIT, tree: { sha: TREE } });
    }
    if (method === 'DELETE' && proofBranch && url.pathname === `/repos/${REPOSITORY}/git/refs/heads/${proofBranch}`) {
      branchDeleted = true;
      return response(204);
    }
    return response(500, { message: `unexpected ${method} ${url.pathname}` });
  };

  return { fetchFn, calls, deleted: () => branchDeleted };
}

describe('GitHubAppAuthority', () => {
  it('verifies exact App and installation identity with a repository-scoped read token', async () => {
    const { directory, keyPath } = fixture();
    try {
      const mock = mockGitHub();
      const authority = new GitHubAppAuthority({ credentialPath: keyPath, fetchFn: mock.fetchFn, now: () => 1_785_146_400_000 });
      const result = await authority.verify({ repository: REPOSITORY });
      assert.equal(result.verified, true);
      assert.deepEqual(result.app, { id: APP_ID, name: 'Sez GitHub Authority', slug: 'sez-github-authority', owner: ACCOUNT });
      assert.equal((result.repository as { fullName: string }).fullName, REPOSITORY);
      assert.equal((result.token as { persisted: boolean }).persisted, false);
      const tokenRequest = mock.calls.find((call) => call.path.endsWith('/access_tokens'))!;
      assert.equal((tokenRequest.body as { permissions: { contents: string } }).permissions.contents, 'read');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates, reads back, and positively deletes an ephemeral proof branch', async () => {
    const { directory, keyPath } = fixture();
    try {
      const mock = mockGitHub();
      const authority = new GitHubAppAuthority({ credentialPath: keyPath, fetchFn: mock.fetchFn, now: () => 1_785_146_400_000 });
      const result = await authority.proof({ repository: REPOSITORY });
      assert.equal(result.verified, true);
      assert.equal(mock.deleted(), true);
      const proof = result.proof as { deletionStatus: number; deletionReadback: number; commitSha: string; treeSha: string };
      assert.equal(proof.commitSha, COMMIT);
      assert.equal(proof.treeSha, TREE);
      assert.equal(proof.deletionStatus, 204);
      assert.equal(proof.deletionReadback, 404);
      const tokenRequest = mock.calls.find((call) => call.path.endsWith('/access_tokens'))!;
      assert.equal((tokenRequest.body as { permissions: { contents: string } }).permissions.contents, 'write');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects repositories outside StealthEyeLLC before any GitHub request', async () => {
    const { directory, keyPath } = fixture();
    try {
      const mock = mockGitHub();
      const authority = new GitHubAppAuthority({ credentialPath: keyPath, fetchFn: mock.fetchFn });
      await assert.rejects(() => authority.proof({ repository: 'other/example' }), /StealthEyeLLC/);
      assert.equal(mock.calls.length, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
