import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE3 } from '../../src/phase3/constants.mjs';
import { validateGatewayConfig } from '../../src/phase3/config.mjs';

function productionConfig() {
  return {
    issuer: PHASE3.issuer,
    protectedResource: 'https://candidate.invalid/mcp',
    authorizationOrigin: PHASE3.issuer,
    mcpHost: '127.0.0.1',
    mcpPort: 3096,
    stateRoot: PHASE3.stateRoot,
    activeSlot: 'blue',
    gatewayStateSchema: PHASE3.stateSchema,
    gatewayId: 'se-z-gateway',
    gatewayKeyId: 'gateway-v1',
    gatewaySigningCredential: 'gateway-request-key',
    receiptVerificationKeys: [{ id: 'receipt-v1', path: '/etc/se-z/keys/receipt.public.pem' }],
    oauthSigningCredential: 'oauth-signing-key',
    oauthAcceptedKeys: [{ keyId: 'oauth-signing-v1' }],
    refreshHashCredential: 'refresh-hash-key',
    githubOAuthClientId: 'canonical-client-id',
    githubOAuthClientIdCredential: 'github-oauth-client-id',
    githubOAuthClientSecretCredential: 'github-oauth-client-secret',
    githubCallbackUri: `${PHASE3.issuer}/oauth/github/callback`,
    ownerGithubId: PHASE3.ownerGithubId,
    accessTokenTtlSeconds: 900,
    authorizationCodeTtlSeconds: 300,
    authorizationStateTtlSeconds: 600,
    refreshAbsoluteTtlSeconds: 2592000,
    refreshIdleTtlSeconds: 604800,
    requestBodyLimit: 1048576,
    tunnelProfileReference: '/etc/se-z-gateway/tunnel-profile.json',
    tunnelCredentialReference: 'tunnel-credential',
    supervisorGatewaySocket: PHASE3.gatewaySocket,
    releaseIdentity: '0.1B-candidate',
    testMode: false,
  };
}

test('production config accepts exact canonical GitHub OAuth spelling', () => {
  const config = productionConfig();
  assert.equal(validateGatewayConfig(config).githubOAuthClientId, 'canonical-client-id');
});

test('visually similar noncanonical GitHub OAuth field spellings are rejected', () => {
  const config = productionConfig();
  const { githubOAuthClientId, ...rest } = config;
  for (const badKey of ['githubOauthClientId', 'githubOAuthClientID']) {
    assert.throws(
      () => validateGatewayConfig({ ...rest, [badKey]: githubOAuthClientId }),
      /unknown configuration field/,
    );
  }
});
