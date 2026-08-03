// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import {
  createHash,
  createPrivateKey,
  createSign,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const APP_ID = '4380878';
const INSTALLATION_ID = '148647330';
const EXPECTED_ACCOUNT = 'StealthEyeLLC';
const CREDENTIAL_NAME = 'github-se-z-app-private-key';
const REPOSITORY_PATTERN = /^StealthEyeLLC\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REQUEST_TIMEOUT_MS = 30_000;

export interface GitHubAppAuthorityOptions {
  appId?: string;
  installationId?: string;
  expectedAccount?: string;
  credentialPath?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface GitHubResponse<T> {
  status: number;
  body: T;
}

interface AppView {
  id?: number;
  name?: string;
  slug?: string;
  owner?: { login?: string };
}

interface InstallationView {
  id?: number;
  account?: { login?: string };
  repository_selection?: string;
  permissions?: Record<string, string>;
}

interface RepositoryView {
  full_name?: string;
  default_branch?: string;
}

interface RefView {
  object?: { sha?: string };
}

interface CommitView {
  sha?: string;
  tree?: { sha?: string };
}

interface ObjectView {
  sha?: string;
}

interface TokenView {
  token?: string;
  expires_at?: string;
  permissions?: Record<string, string>;
  repositories?: Array<{ full_name?: string }>;
}

interface RepositoryCommitView {
  sha?: string;
  commit?: { tree?: { sha?: string } };
}

interface RecursiveTreeView {
  truncated?: boolean;
  tree?: Array<{ path?: string; mode?: string; type?: string; sha?: string; size?: number }>;
}

interface BlobView {
  content?: string;
  encoding?: string;
  size?: number;
}

export interface GitHubSkillFile {
  path: string;
  mode: '100644' | '100755';
  size: number;
  data: Buffer;
}

export interface GitHubSkillMaterialization {
  repository: string;
  ref: string;
  commit: string;
  tree: string;
  skillPath: string;
  files: GitHubSkillFile[];
  timingsMs: { sourceResolution: number; sourceMaterialization: number };
  token: { scope: 'single_repository_contents_read'; persisted: false };
}

function credentialPath(): string {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory) return '';
  return `${directory}/${CREDENTIAL_NAME}`;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function safeRepository(repository: unknown): string {
  const value = String(repository ?? '');
  if (!REPOSITORY_PATTERN.test(value)) {
    throw new Error('repository must be a StealthEyeLLC owner/name identifier');
  }
  return value;
}

function safeSha(value: unknown, label: string): string {
  const sha = String(value ?? '');
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} did not return a Git commit SHA`);
  return sha;
}

function encodeRef(ref: string): string {
  return ref.split('/').map((part) => encodeURIComponent(part)).join('/');
}

export class GitHubAppAuthority {
  private readonly appId: string;
  private readonly installationId: string;
  private readonly expectedAccount: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly privateKey: KeyObject;

  constructor(options: GitHubAppAuthorityOptions = {}) {
    this.appId = options.appId ?? APP_ID;
    this.installationId = options.installationId ?? INSTALLATION_ID;
    this.expectedAccount = options.expectedAccount ?? EXPECTED_ACCOUNT;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;

    const path = options.credentialPath ?? credentialPath();
    if (!path) throw new Error('GitHub App encrypted credential is not loaded');
    const pem = readFileSync(path, 'utf8');
    this.privateKey = createPrivateKey({ key: pem, format: 'pem' });
    if (!['rsa', 'rsa-pss'].includes(this.privateKey.asymmetricKeyType ?? '')) {
      throw new Error('GitHub App private key must be RSA');
    }
  }

  async verify(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const repository = safeRepository(body.repository ?? 'StealthEyeLLC/sez-x');
    const identity = await this.verifyIdentity();
    const token = await this.mintInstallationToken(repository, 'read');
    const repo = await this.request<RepositoryView>(`/repos/${repository}`, {
      authorization: token.value,
    });
    if (repo.body.full_name !== repository) throw new Error('GitHub repository identity mismatch');
    if (!repo.body.default_branch) throw new Error('GitHub repository has no default branch');

    return {
      verified: true,
      app: identity.app,
      installation: identity.installation,
      repository: {
        fullName: repository,
        defaultBranch: repo.body.default_branch,
      },
      token: {
        scope: 'single_repository_contents_read',
        expiresAt: token.expiresAt,
        persisted: false,
      },
      credential: {
        source: 'systemd LoadCredentialEncrypted',
        name: CREDENTIAL_NAME,
        plaintextPersisted: false,
      },
      verifiedAt: new Date(this.now()).toISOString(),
    };
  }

  async materializeSkill(
    repositoryValue: unknown,
    refValue: unknown,
    skillPathValue: unknown,
    expectedCommitValue?: unknown,
  ): Promise<GitHubSkillMaterialization> {
    const started = this.now();
    const repository = safeRepository(repositoryValue);
    const ref = String(refValue ?? '');
    if (!ref || ref.length > 255 || ref.includes('\0')) throw new Error('ref must be a bounded Git ref');
    const skillPath = String(skillPathValue ?? '').replaceAll('\\', '/');
    if (!skillPath || skillPath.startsWith('/') || skillPath.length > 512 ||
        skillPath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('skillPath must be a normalized relative repository path');
    }
    await this.verifyIdentity();
    const token = await this.mintInstallationToken(repository, 'read');
    const commitResponse = await this.request<RepositoryCommitView>(
      `/repos/${repository}/commits/${encodeURIComponent(ref)}`,
      { authorization: token.value },
    );
    const commit = safeSha(commitResponse.body.sha, 'resolved commit');
    const tree = safeSha(commitResponse.body.commit?.tree?.sha, 'resolved tree');
    if (expectedCommitValue !== undefined && String(expectedCommitValue) !== commit) {
      throw new Error(`resolved commit does not match expectedCommit: ${commit}`);
    }
    const resolvedAt = this.now();
    const treeResponse = await this.request<RecursiveTreeView>(
      `/repos/${repository}/git/trees/${tree}?recursive=1`,
      { authorization: token.value },
    );
    if (treeResponse.body.truncated) throw new Error('GitHub recursive tree was truncated');
    const prefix = `${skillPath}/`;
    const selected = (treeResponse.body.tree ?? [])
      .filter((entry) => entry.path === skillPath || entry.path?.startsWith(prefix))
      .sort((a, b) => String(a.path).localeCompare(String(b.path)));
    if (selected.length === 0) throw new Error('skillPath does not exist at the resolved commit');
    const files: GitHubSkillFile[] = [];
    let total = 0;
    const paths = new Set<string>();
    for (const entry of selected) {
      if (entry.type === 'tree') continue;
      if (entry.mode === '120000') throw new Error(`symlink rejected: ${entry.path}`);
      if (entry.type === 'commit' || entry.mode === '160000') throw new Error(`Git submodule rejected: ${entry.path}`);
      if (entry.type !== 'blob' || !['100644', '100755'].includes(String(entry.mode))) {
        throw new Error(`unsupported Git object rejected: ${entry.path}`);
      }
      const repositoryPath = String(entry.path ?? '');
      const relativePath = repositoryPath.slice(prefix.length);
      if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`invalid normalized skill file path: ${repositoryPath}`);
      }
      if (paths.has(relativePath)) throw new Error(`duplicate normalized skill path: ${relativePath}`);
      paths.add(relativePath);
      if (files.length >= 256) throw new Error('skill exceeds 256 files');
      const declaredSize = Number(entry.size ?? 0);
      if (declaredSize > 4 * 1024 * 1024) throw new Error(`skill file exceeds 4 MiB: ${relativePath}`);
      const blobSha = safeSha(entry.sha, 'blob');
      const blob = await this.request<BlobView>(`/repos/${repository}/git/blobs/${blobSha}`, {
        authorization: token.value,
      });
      if (blob.body.encoding !== 'base64' || typeof blob.body.content !== 'string') {
        throw new Error(`GitHub blob encoding is unsupported: ${relativePath}`);
      }
      const data = Buffer.from(blob.body.content.replace(/\s/g, ''), 'base64');
      if (data.length !== Number(blob.body.size ?? data.length) || data.length !== declaredSize) {
        throw new Error(`GitHub blob size mismatch: ${relativePath}`);
      }
      total += data.length;
      if (total > 16 * 1024 * 1024) throw new Error('skill exceeds 16 MiB total');
      files.push({
        path: relativePath,
        mode: entry.mode as '100644' | '100755',
        size: data.length,
        data,
      });
    }
    if (!files.some((file) => file.path === 'skill.json')) throw new Error('skillPath has no skill.json');
    return {
      repository, ref, commit, tree, skillPath, files,
      timingsMs: { sourceResolution: resolvedAt - started, sourceMaterialization: this.now() - resolvedAt },
      token: { scope: 'single_repository_contents_read', persisted: false },
    };
  }

  async proof(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const repository = safeRepository(body.repository);
    const identity = await this.verifyIdentity();
    const token = await this.mintInstallationToken(repository, 'write');
    const repo = await this.request<RepositoryView>(`/repos/${repository}`, {
      authorization: token.value,
    });
    if (repo.body.full_name !== repository) throw new Error('GitHub repository identity mismatch');
    const defaultBranch = String(repo.body.default_branch ?? '');
    if (!defaultBranch) throw new Error('GitHub repository has no default branch');

    const baseRef = await this.request<RefView>(
      `/repos/${repository}/git/ref/heads/${encodeRef(defaultBranch)}`,
      { authorization: token.value },
    );
    const baseCommitSha = safeSha(baseRef.body.object?.sha, 'base ref');
    const baseCommit = await this.request<CommitView>(
      `/repos/${repository}/git/commits/${baseCommitSha}`,
      { authorization: token.value },
    );
    const baseTreeSha = safeSha(baseCommit.body.tree?.sha, 'base commit tree');

    const suffix = `${this.now()}-${randomBytes(6).toString('hex')}`;
    const branch = `se-z-authority-proof-${suffix}`;
    const path = `.se-z/github-app-authority-proof-${suffix}.json`;
    const payload = `${JSON.stringify({
      schemaVersion: '1.0.0',
      purpose: 'ephemeral GitHub App authority proof',
      appId: this.appId,
      installationId: this.installationId,
      account: this.expectedAccount,
      repository,
      baseCommit: baseCommitSha,
      createdAt: new Date(this.now()).toISOString(),
    }, null, 2)}\n`;
    const payloadSha256 = createHash('sha256').update(payload).digest('hex');

    let branchCreated = false;
    let commitSha = '';
    let treeSha = '';
    let primaryError: unknown;
    let deletionStatus: number | undefined;

    try {
      const blob = await this.request<ObjectView>(`/repos/${repository}/git/blobs`, {
        method: 'POST',
        authorization: token.value,
        body: { content: payload, encoding: 'utf-8' },
        expected: [201],
      });
      const blobSha = safeSha(blob.body.sha, 'proof blob');

      const tree = await this.request<ObjectView>(`/repos/${repository}/git/trees`, {
        method: 'POST',
        authorization: token.value,
        body: {
          base_tree: baseTreeSha,
          tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }],
        },
        expected: [201],
      });
      treeSha = safeSha(tree.body.sha, 'proof tree');

      const commit = await this.request<CommitView>(`/repos/${repository}/git/commits`, {
        method: 'POST',
        authorization: token.value,
        body: {
          message: 'test: prove se-z GitHub App authority',
          tree: treeSha,
          parents: [baseCommitSha],
        },
        expected: [201],
      });
      commitSha = safeSha(commit.body.sha, 'proof commit');

      await this.request(`/repos/${repository}/git/refs`, {
        method: 'POST',
        authorization: token.value,
        body: { ref: `refs/heads/${branch}`, sha: commitSha },
        expected: [201],
      });
      branchCreated = true;

      const refReadback = await this.request<RefView>(
        `/repos/${repository}/git/ref/heads/${encodeRef(branch)}`,
        { authorization: token.value },
      );
      if (refReadback.body.object?.sha !== commitSha) {
        throw new Error('proof branch commit readback mismatch');
      }
      const commitReadback = await this.request<CommitView>(
        `/repos/${repository}/git/commits/${commitSha}`,
        { authorization: token.value },
      );
      if (commitReadback.body.tree?.sha !== treeSha) {
        throw new Error('proof commit tree readback mismatch');
      }
    } catch (error) {
      primaryError = error;
    } finally {
      if (branchCreated) {
        try {
          const deleted = await this.request(
            `/repos/${repository}/git/refs/heads/${encodeRef(branch)}`,
            { method: 'DELETE', authorization: token.value, expected: [204] },
          );
          deletionStatus = deleted.status;
          await this.waitForRefAbsence(repository, branch, token.value);
        } catch (cleanupError) {
          if (primaryError) {
            throw new Error(`GitHub proof failed and branch cleanup also failed: ${this.message(cleanupError)}`);
          }
          throw cleanupError;
        }
      }
    }

    if (primaryError) throw primaryError;
    if (!branchCreated || deletionStatus !== 204) throw new Error('GitHub proof did not complete positive cleanup');

    return {
      verified: true,
      app: identity.app,
      installation: identity.installation,
      repository: {
        fullName: repository,
        defaultBranch,
        baseCommitSha,
        baseTreeSha,
      },
      proof: {
        branch,
        path,
        payloadSha256,
        commitSha,
        treeSha,
        commitReadback: true,
        treeReadback: true,
        deletionStatus,
        deletionReadback: 404,
      },
      token: {
        scope: 'single_repository_contents_write',
        expiresAt: token.expiresAt,
        persisted: false,
      },
      credential: {
        source: 'systemd LoadCredentialEncrypted',
        name: CREDENTIAL_NAME,
        plaintextPersisted: false,
      },
      completedAt: new Date(this.now()).toISOString(),
    };
  }

  private async verifyIdentity(): Promise<{
    app: Record<string, unknown>;
    installation: Record<string, unknown>;
  }> {
    const jwt = this.appJwt();
    const app = await this.request<AppView>('/app', { authorization: jwt });
    if (String(app.body.id ?? '') !== this.appId) throw new Error('GitHub App ID mismatch');

    const installation = await this.request<InstallationView>(
      `/app/installations/${this.installationId}`,
      { authorization: jwt },
    );
    if (String(installation.body.id ?? '') !== this.installationId) {
      throw new Error('GitHub App installation ID mismatch');
    }
    if (installation.body.account?.login !== this.expectedAccount) {
      throw new Error('GitHub App installation account mismatch');
    }

    return {
      app: {
        id: this.appId,
        name: app.body.name ?? null,
        slug: app.body.slug ?? null,
        owner: app.body.owner?.login ?? null,
      },
      installation: {
        id: this.installationId,
        account: installation.body.account.login,
        repositorySelection: installation.body.repository_selection ?? null,
        permissions: installation.body.permissions ?? {},
      },
    };
  }

  private async mintInstallationToken(
    repository: string,
    access: 'read' | 'write',
  ): Promise<{ value: string; expiresAt: string | null }> {
    const name = repository.slice(repository.indexOf('/') + 1);
    const response = await this.request<TokenView>(
      `/app/installations/${this.installationId}/access_tokens`,
      {
        method: 'POST',
        authorization: this.appJwt(),
        body: {
          repositories: [name],
          permissions: { contents: access, metadata: 'read' },
        },
        expected: [201],
      },
    );
    const value = response.body.token;
    if (typeof value !== 'string' || value.length < 20) {
      throw new Error('GitHub did not return an installation token');
    }
    const repositories = response.body.repositories ?? [];
    if (repositories.length > 0 && !repositories.some((item) => item.full_name === repository)) {
      throw new Error('GitHub installation token repository scope mismatch');
    }
    return { value, expiresAt: response.body.expires_at ?? null };
  }

  private async waitForRefAbsence(repository: string, branch: string, token: string): Promise<void> {
    const path = `/repos/${repository}/git/ref/heads/${encodeRef(branch)}`;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const readback = await this.request(path, {
        authorization: token,
        expected: [200, 404],
      });
      if (readback.status === 404) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('GitHub proof branch still exists after bounded deletion readback');
  }

  private appJwt(): string {
    const nowSeconds = Math.floor(this.now() / 1000);
    const unsigned = `${base64urlJson({ alg: 'RS256', typ: 'JWT' })}.${base64urlJson({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: this.appId,
    })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(this.privateKey).toString('base64url')}`;
  }

  private async request<T = Record<string, never>>(
    path: string,
    options: {
      method?: string;
      authorization: string;
      body?: unknown;
      expected?: number[];
    },
  ): Promise<GitHubResponse<T>> {
    const response = await this.fetchFn(`${API_ROOT}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.authorization}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'se-z-github-authority',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 500) };
      }
    }
    const expected = options.expected ?? [200];
    if (!expected.includes(response.status)) {
      const message = body && typeof body === 'object' && 'message' in body
        ? String((body as { message?: unknown }).message ?? 'request failed')
        : 'request failed';
      throw new Error(`GitHub ${options.method ?? 'GET'} ${path} failed (${response.status}): ${message}`);
    }
    return { status: response.status, body: body as T };
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown cleanup error';
  }
}

export const GITHUB_APP_AUTHORITY = Object.freeze({
  appId: APP_ID,
  installationId: INSTALLATION_ID,
  expectedAccount: EXPECTED_ACCOUNT,
  credentialName: CREDENTIAL_NAME,
});
