// New se-z Phase 1 differential parity test. Keys and state are ephemeral; no production OAuth data is read.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { identityNormalize, sourceGateway, target } from '../helpers/index.js';

async function create(kind: 'source' | 'target') {
  const module = kind === 'source' ? await sourceGateway('src/oauth-server.js') : await target('src/auth/oauth/server.js');
  const root = mkdtempSync(join(tmpdir(), `sez-parity-${kind}-oauth-`));
  const { privateKey } = generateKeyPairSync('ed25519');
  const keyPath = join(root, 'oauth-private.pem');
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const sourceIdentity = kind === 'source';
  const publicResource = sourceIdentity ? 'https://baby-quirt.test' : 'https://se-z.test';
  const config = {
    publicResource,
    protectedResource: `${publicResource}/mcp`,
    oauthIssuer: publicResource,
    oauthSigningPrivateKeyPath: keyPath,
    oauthStatePath: join(root, 'oauth-state.json'),
    identityProvider: 'password',
    ownerPasswordScrypt: module.hashOwnerPassword('fixture owner password 12345', { salt: Buffer.alloc(24, 9) }),
    expectedSubject: 'stealtheye-owner',
    requiredScope: sourceIdentity ? 'baby.apply' : 'sez.root',
  };
  const server = new module.OAuthAuthorizationServer(config, { fetch: async () => { throw new Error('unexpected fetch'); } });
  return { module, root, config, server };
}

test('password hashing and verification remain exact with fixed ephemeral salt', async () => {
  const source = await sourceGateway('src/oauth-server.js');
  const targetModule = await target('src/auth/oauth/server.js');
  const options = { salt: Buffer.alloc(24, 7) };
  const sourceHash = source.hashOwnerPassword('fixture owner password 12345', options);
  const targetHash = targetModule.hashOwnerPassword('fixture owner password 12345', options);
  assert.equal(sourceHash, targetHash);
  assert.equal(source.verifyOwnerPassword('fixture owner password 12345', sourceHash), true);
  assert.equal(targetModule.verifyOwnerPassword('fixture owner password 12345', targetHash), true);
  assert.equal(source.verifyOwnerPassword('wrong password', sourceHash), false);
  assert.equal(targetModule.verifyOwnerPassword('wrong password', targetHash), false);
});

test('protected-resource metadata, authorization metadata, PKCE declaration, refresh lifecycle, JWKS safety and state ownership normalize mechanically', async () => {
  const source = await create('source');
  const targetResult = await create('target');
  try {
    assert.deepEqual(identityNormalize(source.server.protectedResourceMetadata()), targetResult.server.protectedResourceMetadata());
    assert.deepEqual(identityNormalize(source.server.authorizationServerMetadata()), targetResult.server.authorizationServerMetadata());
    const metadata = targetResult.server.authorizationServerMetadata();
    assert.deepEqual(metadata.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.ok(metadata.scopes_supported.includes('sez.root'));
    assert.ok(metadata.scopes_supported.includes('offline_access'));
    assert.equal(metadata.resource_parameter_supported, true);
    const sourceJwk = source.server.jwks().keys[0];
    const targetJwk = targetResult.server.jwks().keys[0];
    const publicShape = ({ kid: _kid, x: _x, ...rest }: any) => rest;
    assert.deepEqual(publicShape(sourceJwk), publicShape(targetJwk));
    assert.match(sourceJwk.x, /^[A-Za-z0-9_-]{43}$/u);
    assert.match(targetJwk.x, /^[A-Za-z0-9_-]{43}$/u);
    assert.match(sourceJwk.kid, /^bq-oauth-[a-f0-9]{20}$/u);
    assert.match(targetJwk.kid, /^se-z-oauth-[a-f0-9]{20}$/u);
    assert.equal('d' in sourceJwk, false);
    assert.equal('d' in targetJwk, false);
    assert.ok(source.config.oauthStatePath.startsWith(source.root));
    assert.ok(targetResult.config.oauthStatePath.startsWith(targetResult.root));
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(targetResult.root, { recursive: true, force: true });
  }
});
