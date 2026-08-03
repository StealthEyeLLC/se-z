// Derived test fixture: StealthEyeLLC/baby-quirt-mcp@0bfcd99757afe198151e96b18771626388914205:test/entrypoint.test.js; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const temporaryRoots = [];
const children = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(port, child, output) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`gateway exited before binding: ${output.stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return await response.json();
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`gateway did not bind: ${lastError?.message ?? 'unknown error'}; stderr=${output.stderr}`);
}

describe('production entrypoint', () => {
  it('binds through the mutable current symlink and shuts down cleanly', { skip: process.platform === 'win32' }, async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'se-z-gateway-entrypoint-'));
    temporaryRoots.push(temporaryRoot);
    const current = join(temporaryRoot, 'current');
    await symlink(repositoryRoot, current, 'dir');

    const gatewayKeys = generateKeyPairSync('ed25519');
    const receiptKeys = generateKeyPairSync('ed25519');
    const oauthKeys = generateKeyPairSync('ed25519');
    const gatewayPrivateKeyPath = join(temporaryRoot, 'gateway-private.pem');
    const receiptPublicKeyPath = join(temporaryRoot, 'receipt-public.pem');
    const oauthPrivateKeyPath = join(temporaryRoot, 'oauth-private.pem');
    const oauthStatePath = join(temporaryRoot, 'oauth-state.json');
    const githubSecretPath = join(temporaryRoot, 'github-client-secret');
    await writeFile(gatewayPrivateKeyPath, gatewayKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    await writeFile(receiptPublicKeyPath, receiptKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 });
    await writeFile(oauthPrivateKeyPath, oauthKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    await writeFile(githubSecretPath, 'fixture-github-client-secret-value', { mode: 0o600 });

    const port = await availablePort();
    const output = { stdout: '', stderr: '' };
    const child = spawn(process.execPath, [join(current, 'src/gateway/mcp/main.js')], {
      cwd: current,
      env: {
        ...process.env,
        SEZ_GATEWAY_BIND_HOST: '127.0.0.1',
        SEZ_GATEWAY_HTTP_PORT: String(port),
        SEZ_GATEWAY_PUBLIC_RESOURCE: 'https://se-z.stealtheye.io',
        SEZ_GATEWAY_RESOURCE_URI: 'https://se-z.stealtheye.io/mcp',
        SEZ_GATEWAY_OAUTH_ISSUER: 'https://se-z.stealtheye.io',
        SEZ_GATEWAY_OAUTH_RESOURCE: 'https://se-z.stealtheye.io/mcp',
        SEZ_GATEWAY_OAUTH_JWKS_URI: 'https://se-z.stealtheye.io/oauth/jwks.json',
        SEZ_GATEWAY_OAUTH_SIGNING_PRIVATE_KEY_PATH: oauthPrivateKeyPath,
        SEZ_GATEWAY_OAUTH_STATE_PATH: oauthStatePath,
        SEZ_GATEWAY_IDENTITY_PROVIDER: 'github',
        SEZ_GATEWAY_GITHUB_CLIENT_ID: 'Iv1.fixture-client-id',
        SEZ_GATEWAY_GITHUB_CLIENT_SECRET_PATH: githubSecretPath,
        SEZ_GATEWAY_GITHUB_ALLOWED_USER_ID: '247854506',
        SEZ_GATEWAY_AUTHORITY_PRIVATE_KEY_PATH: gatewayPrivateKeyPath,
        SEZ_RECEIPT_PUBLIC_KEY_PATH: receiptPublicKeyPath,
        SEZ_OWNER_PRINCIPAL_FINGERPRINT: '1'.repeat(64),
        SEZ_GATEWAY_ENFORCE_UID: '0',
        SEZ_GATEWAY_VERSION: 'entrypoint-test',
        SEZ_GATEWAY_COMMIT_SHA: 'entrypoint-test-commit',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });

    const health = await waitForHealth(port, child, output);
    assert.deepEqual(health, {
      status: 'ok',
      product: 'se-z-gateway',
      version: 'entrypoint-test',
      commit: 'entrypoint-test-commit',
      publicTools: 1,
      oauthIssuer: 'https://se-z.stealtheye.io',
      protectedResource: 'https://se-z.stealtheye.io/mcp',
    });
    assert.match(output.stdout, /"event":"se-z-gateway\.listening"/u);

    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null);
    assert.equal(code, 0, output.stderr);
  });
});
