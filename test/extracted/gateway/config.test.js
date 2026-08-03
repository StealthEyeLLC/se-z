// Derived test fixture: StealthEyeLLC/baby-quirt-mcp@0bfcd99757afe198151e96b18771626388914205:test/config.test.js; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../../../src/gateway/configuration/config.js';

const fingerprint = 'a'.repeat(64);

describe('se-z gateway resource configuration', () => {
  it('binds embedded OAuth to the exact MCP protected resource', () => {
    const config = loadConfig({ SEZ_OWNER_PRINCIPAL_FINGERPRINT: fingerprint });
    assert.equal(config.publicResource, 'https://se-z.stealtheye.io');
    assert.equal(config.protectedResource, 'https://se-z.stealtheye.io/mcp');
    assert.equal(config.oauthIssuer, 'https://se-z.stealtheye.io');
    assert.equal(config.oauthResource, 'https://se-z.stealtheye.io/mcp');
    assert.equal(config.oauthJwksUri, 'https://se-z.stealtheye.io/oauth/jwks.json');
    assert.equal(config.authorityIssuer, 'https://se-z.stealtheye.io');
    assert.equal(config.authorityResource, 'https://se-z.stealtheye.io/mcp');
    assert.equal(config.requiredScope, 'sez.root');
    assert.equal(config.identityProvider, 'github');
  });

  it('pins GitHub App login to the exact callback and numeric owner identity', () => {
    const config = loadConfig({
      SEZ_OWNER_PRINCIPAL_FINGERPRINT: fingerprint,
      SEZ_GATEWAY_IDENTITY_PROVIDER: 'github',
      SEZ_GATEWAY_GITHUB_CLIENT_ID: 'Iv1.0123456789abcdef',
    });
    assert.equal(config.identityProvider, 'github');
    assert.equal(config.githubAllowedUserId, 247854506);
    assert.equal(config.githubLoginHint, 'StealthEyeLLC');
    assert.equal(config.githubCallbackUri, 'https://se-z.stealtheye.io/oauth/github/callback');
    assert.equal(config.githubClientSecretPath, '/etc/se-z-gateway/github-client-secret');
  });


  it('rejects mutable authority identities and public listeners', () => {
    const base = { SEZ_OWNER_PRINCIPAL_FINGERPRINT: fingerprint };
    for (const [name, value, pattern] of [
      ['SEZ_GATEWAY_REQUIRED_SCOPE', 'fix.apply', /must equal sez\.root/u],
      ['SEZ_GATEWAY_GITHUB_ALLOWED_USER_ID', '1', /must equal 247854506/u],
      ['SEZ_GATEWAY_BIND_HOST', '0.0.0.0', /loopback address/u],
      ['SEZ_GATEWAY_PUBLIC_RESOURCE', 'https://alternate.stealtheye.io', /must equal https:\/\/se-z\.stealtheye\.io/u],
      ['SEZ_GATEWAY_OAUTH_ISSUER', 'https://alternate.stealtheye.io', /public resource origin/u],
      ['SEZ_AUTHORITY_ISSUER', 'https://alternate.stealtheye.io', /must equal https:\/\/se-z\.stealtheye\.io/u],
      ['SEZ_AUTHORITY_RESOURCE', 'https://se-z.stealtheye.io/alternate', /must equal https:\/\/se-z\.stealtheye\.io\/mcp/u],
      ['SEZ_GATEWAY_OAUTH_JWKS_URI', 'https://se-z.stealtheye.io/alternate-jwks', /must equal https:\/\/se-z\.stealtheye\.io\/oauth\/jwks\.json/u],
    ]) {
      assert.throws(() => loadConfig({ ...base, [name]: value }), pattern, name);
    }
    assert.equal(loadConfig({ ...base, SEZ_GATEWAY_BIND_HOST: '::1' }).bindHost, '::1');
  });

  it('rejects cross-origin or broad OAuth resources', () => {
    assert.throws(
      () => loadConfig({ SEZ_OWNER_PRINCIPAL_FINGERPRINT: fingerprint, SEZ_GATEWAY_RESOURCE_URI: 'https://attacker.invalid/mcp' }),
      /public resource origin/u,
    );
    assert.throws(
      () => loadConfig({ SEZ_OWNER_PRINCIPAL_FINGERPRINT: fingerprint, SEZ_GATEWAY_OAUTH_RESOURCE: 'https://mcp.stealtheye.io' }),
      /exact MCP protected resource/u,
    );
    assert.throws(
      () => loadConfig({
        SEZ_OWNER_PRINCIPAL_FINGERPRINT: fingerprint,
        SEZ_GATEWAY_GITHUB_CALLBACK_URI: 'https://attacker.invalid/oauth/github/callback',
      }),
      /public resource origin/u,
    );
  });
});
