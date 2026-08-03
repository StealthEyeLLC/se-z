// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
const EXACT_PUBLIC_RESOURCE = 'https://se-z.stealtheye.io';
const EXACT_PROTECTED_RESOURCE = 'https://se-z.stealtheye.io/mcp';
const EXACT_JWKS_URI = 'https://se-z.stealtheye.io/oauth/jwks.json';
const EXACT_SCOPE = 'sez.root';
const EXACT_GITHUB_OWNER_ID = 247854506;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

function positiveInteger(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new Error(`${name} must be an absolute path`);
  return value;
}

function url(value, name) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error(`${name} must use https`);
  return parsed.toString().replace(/\/$/u, '');
}

function digest(value, name, allowZero = false) {
  if (!/^[a-f0-9]{64}$/u.test(value) || (!allowZero && value === '0'.repeat(64))) {
    throw new Error(`${name} must be a non-zero lowercase SHA-256 digest`);
  }
  return value;
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function loopbackHost(value) {
  const host = value ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('SEZ_GATEWAY_BIND_HOST must be a loopback address');
  return host;
}

function exactValue(value, expected, name) {
  if (value !== expected) throw new Error(`${name} must equal ${expected}`);
  return value;
}

function identityProvider(value) {
  const provider = value ?? 'github';
  if (!['password', 'github'].includes(provider)) throw new Error('SEZ_GATEWAY_IDENTITY_PROVIDER must be password or github');
  return provider;
}

export function loadConfig(env = process.env) {
  const publicResource = exactValue(
    url(env.SEZ_GATEWAY_PUBLIC_RESOURCE ?? EXACT_PUBLIC_RESOURCE, 'SEZ_GATEWAY_PUBLIC_RESOURCE'),
    EXACT_PUBLIC_RESOURCE,
    'SEZ_GATEWAY_PUBLIC_RESOURCE',
  );
  const configuredProtectedResource = url(
    env.SEZ_GATEWAY_RESOURCE_URI ?? EXACT_PROTECTED_RESOURCE,
    'SEZ_GATEWAY_RESOURCE_URI',
  );
  if (new URL(configuredProtectedResource).origin !== new URL(publicResource).origin) {
    throw new Error('SEZ_GATEWAY_RESOURCE_URI must use the public resource origin');
  }
  const protectedResource = exactValue(
    configuredProtectedResource,
    EXACT_PROTECTED_RESOURCE,
    'SEZ_GATEWAY_RESOURCE_URI',
  );
  const configuredOauthIssuer = url(
    env.SEZ_GATEWAY_OAUTH_ISSUER ?? EXACT_PUBLIC_RESOURCE,
    'SEZ_GATEWAY_OAUTH_ISSUER',
  );
  if (new URL(configuredOauthIssuer).origin !== new URL(publicResource).origin) {
    throw new Error('SEZ_GATEWAY_OAUTH_ISSUER must use the public resource origin');
  }
  const oauthIssuer = exactValue(
    configuredOauthIssuer,
    EXACT_PUBLIC_RESOURCE,
    'SEZ_GATEWAY_OAUTH_ISSUER',
  );
  const oauthResource = url(
    env.SEZ_GATEWAY_OAUTH_RESOURCE ?? EXACT_PROTECTED_RESOURCE,
    'SEZ_GATEWAY_OAUTH_RESOURCE',
  );
  if (oauthResource !== protectedResource) {
    throw new Error('SEZ_GATEWAY_OAUTH_RESOURCE must equal the exact MCP protected resource');
  }
  const provider = identityProvider(env.SEZ_GATEWAY_IDENTITY_PROVIDER);
  const githubAllowedUserId = positiveInteger(env, 'SEZ_GATEWAY_GITHUB_ALLOWED_USER_ID', EXACT_GITHUB_OWNER_ID);
  if (githubAllowedUserId !== EXACT_GITHUB_OWNER_ID) {
    throw new Error(`SEZ_GATEWAY_GITHUB_ALLOWED_USER_ID must equal ${EXACT_GITHUB_OWNER_ID}`);
  }
  const requiredScope = env.SEZ_GATEWAY_REQUIRED_SCOPE ?? EXACT_SCOPE;
  exactValue(requiredScope, EXACT_SCOPE, 'SEZ_GATEWAY_REQUIRED_SCOPE');
  const authorityIssuer = exactValue(
    url(env.SEZ_AUTHORITY_ISSUER ?? EXACT_PUBLIC_RESOURCE, 'SEZ_AUTHORITY_ISSUER'),
    EXACT_PUBLIC_RESOURCE,
    'SEZ_AUTHORITY_ISSUER',
  );
  const authorityResource = exactValue(
    url(env.SEZ_AUTHORITY_RESOURCE ?? EXACT_PROTECTED_RESOURCE, 'SEZ_AUTHORITY_RESOURCE'),
    EXACT_PROTECTED_RESOURCE,
    'SEZ_AUTHORITY_RESOURCE',
  );
  const oauthJwksUri = exactValue(
    url(env.SEZ_GATEWAY_OAUTH_JWKS_URI ?? EXACT_JWKS_URI, 'SEZ_GATEWAY_OAUTH_JWKS_URI'),
    EXACT_JWKS_URI,
    'SEZ_GATEWAY_OAUTH_JWKS_URI',
  );
  const githubCallbackUri = url(env.SEZ_GATEWAY_GITHUB_CALLBACK_URI ?? `${publicResource}/oauth/github/callback`, 'SEZ_GATEWAY_GITHUB_CALLBACK_URI');
  if (new URL(githubCallbackUri).origin !== new URL(publicResource).origin || new URL(githubCallbackUri).pathname !== '/oauth/github/callback') {
    throw new Error('SEZ_GATEWAY_GITHUB_CALLBACK_URI must use the public resource origin and /oauth/github/callback path');
  }
  return Object.freeze({
    bindHost: loopbackHost(env.SEZ_GATEWAY_BIND_HOST),
    httpPort: positiveInteger(env, 'SEZ_GATEWAY_HTTP_PORT', 2096),
    publicResource,
    protectedResource,
    oauthIssuer,
    oauthResource,
    authorityIssuer,
    authorityResource,
    oauthJwksUri,
    oauthSigningPrivateKeyPath: absolutePath(env.SEZ_GATEWAY_OAUTH_SIGNING_PRIVATE_KEY_PATH ?? '/etc/se-z-gateway/oauth-signing-private.pem', 'SEZ_GATEWAY_OAUTH_SIGNING_PRIVATE_KEY_PATH'),
    oauthStatePath: absolutePath(env.SEZ_GATEWAY_OAUTH_STATE_PATH ?? '/var/lib/se-z-gateway/oauth-state.json', 'SEZ_GATEWAY_OAUTH_STATE_PATH'),
    identityProvider: provider,
    ownerPasswordScrypt: env.SEZ_GATEWAY_OWNER_PASSWORD_SCRYPT ?? '',
    githubClientId: env.SEZ_GATEWAY_GITHUB_CLIENT_ID ?? '',
    githubClientSecretPath: absolutePath(env.SEZ_GATEWAY_GITHUB_CLIENT_SECRET_PATH ?? '/etc/se-z-gateway/github-client-secret', 'SEZ_GATEWAY_GITHUB_CLIENT_SECRET_PATH'),
    githubAllowedUserId,
    githubLoginHint: env.SEZ_GATEWAY_GITHUB_LOGIN_HINT ?? 'StealthEyeLLC',
    githubCallbackUri,
    requiredScope,
    expectedSubject: env.SEZ_GATEWAY_EXPECTED_SUBJECT ?? 'stealtheye-owner',
    socketPath: absolutePath(env.SEZ_SOCKET_PATH ?? '/run/se-z/gateway.sock', 'SEZ_SOCKET_PATH'),
    targetHost: env.SEZ_EXPECTED_HOSTNAME ?? 'vps-c9f04f5e',
    expectedMachineIdSha256: digest(env.SEZ_EXPECTED_MACHINE_ID_SHA256 ?? 'cd189817b39fea60d338b73878240a6fe7db71374c7a0f35ad60f8eb641e8817', 'SEZ_EXPECTED_MACHINE_ID_SHA256'),
    gatewayId: env.SEZ_GATEWAY_ID ?? 'stealtheye-sez-gateway',
    gatewayKeyId: env.SEZ_GATEWAY_KEY_ID ?? 'gateway-authority-v1',
    gatewayPrivateKeyPath: absolutePath(env.SEZ_GATEWAY_AUTHORITY_PRIVATE_KEY_PATH ?? '/etc/se-z/se-z/gateway-authority-private.pem', 'SEZ_GATEWAY_AUTHORITY_PRIVATE_KEY_PATH'),
    receiptPublicKeyPath: absolutePath(env.SEZ_RECEIPT_PUBLIC_KEY_PATH ?? '/etc/se-z/supervisor-receipt-public.pem', 'SEZ_RECEIPT_PUBLIC_KEY_PATH'),
    receiptKeyId: env.SEZ_RECEIPT_KEY_ID ?? 'supervisor-receipt-v1',
    ownerPrincipalFingerprint: digest(required(env, 'SEZ_OWNER_PRINCIPAL_FINGERPRINT'), 'SEZ_OWNER_PRINCIPAL_FINGERPRINT'),
    gatewayUid: positiveInteger(env, 'SEZ_GATEWAY_UID', 997),
    enforceGatewayUid: env.SEZ_GATEWAY_ENFORCE_UID !== '0',
    maxFrameSize: positiveInteger(env, 'SEZ_MAX_FRAME_SIZE', 16 * 1024 * 1024),
    requestTimeoutMs: positiveInteger(env, 'SEZ_GATEWAY_REQUEST_TIMEOUT_MS', 60_000),
    maxRequestBytes: positiveInteger(env, 'SEZ_GATEWAY_MAX_REQUEST_BYTES', 1024 * 1024),
    jwksCacheMs: positiveInteger(env, 'SEZ_GATEWAY_JWKS_CACHE_MS', 300_000),
    version: env.SEZ_GATEWAY_VERSION ?? '0.1.0',
    commitSha: env.SEZ_GATEWAY_COMMIT_SHA ?? 'development',
  });
}
