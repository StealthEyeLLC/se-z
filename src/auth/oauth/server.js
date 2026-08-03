// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  scryptSync,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const ALLOWED_SCOPES = new Set(['sez.root', 'offline_access']);
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const PASSWORD_WINDOW_MS = 10 * 60 * 1000;
const PASSWORD_BLOCK_MS = 15 * 60 * 1000;
const PASSWORD_MAX_FAILURES = 5;
const GITHUB_TIMEOUT_MS = 10_000;
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_API_VERSION = '2026-03-10';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

function sha256Hex(value) {
  return sha256(value).toString('hex');
}

function token(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function oauthError(response, status, error, description) {
  sendJson(response, status, {
    error,
    ...(description ? { error_description: description } : {}),
  });
}

function sendJson(response, status, body, headers = {}) {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(encoded.length),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  response.end(encoded);
}

function sendHtml(response, status, body) {
  const encoded = Buffer.from(body, 'utf8');
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(encoded.length),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  response.end(encoded);
}

function redirect(response, location, status = 302) {
  response.writeHead(status, {
    location,
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
  });
  response.end();
}

async function readBody(request, maximumBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function readParameters(request) {
  const text = await readBody(request);
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (contentType.startsWith('application/json')) {
    const parsed = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') params.set(key, value);
    }
    return params;
  }
  if (!contentType.startsWith('application/x-www-form-urlencoded')) {
    throw new Error('unsupported_content_type');
  }
  return new URLSearchParams(text);
}

async function responseJson(response, label) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error(`${label} response exceeded its bound`);
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return value;
}

function normalizedScopes(raw) {
  const values = String(raw ?? 'sez.root offline_access').split(/\s+/u).filter(Boolean);
  const unique = [...new Set(values)];
  if (!unique.includes('sez.root')) throw new Error('sez.root scope is required');
  if (unique.some((scope) => !ALLOWED_SCOPES.has(scope))) throw new Error('unsupported scope');
  return unique;
}

function allowedRedirectUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'chatgpt.com'
    || host.endsWith('.chatgpt.com')
    || host === 'openai.com'
    || host.endsWith('.openai.com');
}

function remoteAddress(request) {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
}

function passwordParts(encoded) {
  const parts = String(encoded ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') throw new Error('owner password hash is invalid');
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64url');
  const digest = Buffer.from(parts[5], 'base64url');
  if (!Number.isSafeInteger(n) || n < 16_384 || n > 1_048_576) throw new Error('owner password scrypt N is invalid');
  if (!Number.isSafeInteger(r) || r < 1 || r > 32) throw new Error('owner password scrypt r is invalid');
  if (!Number.isSafeInteger(p) || p < 1 || p > 8) throw new Error('owner password scrypt p is invalid');
  if (salt.length < 16 || digest.length < 32) throw new Error('owner password hash material is invalid');
  return { n, r, p, salt, digest };
}

export function hashOwnerPassword(password, options = {}) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024) {
    throw new Error('owner password must contain between 16 and 1024 characters');
  }
  const n = options.n ?? 16_384;
  const r = options.r ?? 8;
  const p = options.p ?? 1;
  const salt = options.salt ?? randomBytes(24);
  const digest = scryptSync(password, salt, 64, { N: n, r, p, maxmem: 128 * n * r + 1024 * 1024 });
  return `scrypt$${n}$${r}$${p}$${base64url(salt)}$${base64url(digest)}`;
}

export function verifyOwnerPassword(password, encoded) {
  const { n, r, p, salt, digest } = passwordParts(encoded);
  const actual = scryptSync(String(password ?? ''), salt, digest.length, {
    N: n,
    r,
    p,
    maxmem: 128 * n * r + 1024 * 1024,
  });
  return actual.length === digest.length && timingSafeEqual(actual, digest);
}

class OAuthStateStore {
  constructor(path) {
    this.path = path;
    this.data = this.#load();
  }

  #empty() {
    return {
      version: 1,
      clients: {},
      authorizationRequests: {},
      authorizationCodes: {},
      refreshTokens: {},
    };
  }

  #load() {
    if (!existsSync(this.path)) return this.#empty();
    const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    if (!parsed || parsed.version !== 1) throw new Error('OAuth state file has an unsupported version');
    return {
      ...this.#empty(),
      ...parsed,
      clients: parsed.clients ?? {},
      authorizationRequests: parsed.authorizationRequests ?? {},
      authorizationCodes: parsed.authorizationCodes ?? {},
      refreshTokens: parsed.refreshTokens ?? {},
    };
  }

  #clean(now = Date.now()) {
    for (const collection of ['authorizationRequests', 'authorizationCodes', 'refreshTokens']) {
      for (const [key, value] of Object.entries(this.data[collection])) {
        if (!value || Number(value.expiresAt) <= now) delete this.data[collection][key];
      }
    }
  }

  persist() {
    this.#clean();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
  }

  registerClient(record) {
    this.data.clients[record.clientId] = record;
    this.persist();
  }

  client(clientId) {
    this.#clean();
    return this.data.clients[clientId];
  }

  saveAuthorizationRequest(flowId, record) {
    this.data.authorizationRequests[flowId] = record;
    this.persist();
  }

  authorizationRequest(flowId) {
    this.#clean();
    return this.data.authorizationRequests[flowId];
  }

  consumeAuthorizationRequest(flowId) {
    this.#clean();
    const value = this.data.authorizationRequests[flowId];
    delete this.data.authorizationRequests[flowId];
    this.persist();
    return value;
  }

  saveAuthorizationCode(code, record) {
    this.data.authorizationCodes[sha256Hex(code)] = record;
    this.persist();
  }

  consumeAuthorizationCode(code) {
    this.#clean();
    const key = sha256Hex(code);
    const value = this.data.authorizationCodes[key];
    delete this.data.authorizationCodes[key];
    this.persist();
    return value;
  }

  saveRefreshToken(refreshToken, record) {
    this.data.refreshTokens[sha256Hex(refreshToken)] = record;
    this.persist();
  }

  consumeRefreshToken(refreshToken) {
    this.#clean();
    const key = sha256Hex(refreshToken);
    const value = this.data.refreshTokens[key];
    delete this.data.refreshTokens[key];
    this.persist();
    return value;
  }

  revokeRefreshToken(refreshToken) {
    delete this.data.refreshTokens[sha256Hex(refreshToken)];
    this.persist();
  }
}

function publicJwk(privateKey) {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const kid = `bq-oauth-${sha256Hex(`${jwk.kty}:${jwk.crv}:${jwk.x}`).slice(0, 20)}`;
  return Object.freeze({ ...jwk, kid, use: 'sig', alg: 'EdDSA' });
}

function redirectWithError(record, error, description) {
  const target = new URL(record.redirectUri);
  target.searchParams.set('error', error);
  if (description) target.searchParams.set('error_description', description);
  if (record.state) target.searchParams.set('state', record.state);
  return target.toString();
}

function loginPage(record, flowId, error = '') {
  const redirectHost = new URL(record.redirectUri).host;
  const errorBlock = error ? `<p class="error">${htmlEscape(error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize se-z</title>
<style>
:root{color-scheme:dark}body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#111827;color:#f9fafb;margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(92vw,420px);background:#1f2937;border:1px solid #374151;border-radius:18px;padding:28px;box-shadow:0 20px 50px #0008}h1{font-size:1.45rem;margin:0 0 12px}p{line-height:1.45;color:#d1d5db}.scope{font-family:ui-monospace,SFMono-Regular,monospace;background:#111827;border-radius:8px;padding:10px}.error{color:#fecaca;background:#7f1d1d;padding:10px;border-radius:8px}label{display:block;font-weight:650;margin:18px 0 8px}input{box-sizing:border-box;width:100%;padding:13px;border-radius:10px;border:1px solid #4b5563;background:#111827;color:#fff;font-size:1rem}button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:10px;background:#f9fafb;color:#111827;font-size:1rem;font-weight:750}.small{font-size:.84rem;color:#9ca3af;word-break:break-all}</style>
</head>
<body><main class="card">
<h1>Authorize se-z</h1>
<p>Enter the owner password to let ChatGPT use the single <strong>call_sez</strong> tool.</p>
<p class="scope">Scope: ${htmlEscape(record.scope.join(' '))}</p>
<p class="small">Return to: ${htmlEscape(redirectHost)}</p>
${errorBlock}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="flow_id" value="${htmlEscape(flowId)}">
<label for="password">Owner password</label>
<input id="password" name="password" type="password" autocomplete="current-password" minlength="16" required autofocus>
<button type="submit">Authorize</button>
</form>
</main></body></html>`;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

export class OAuthAuthorizationServer {
  constructor(config, options = {}) {
    if (!config.oauthSigningPrivateKeyPath) throw new Error('SEZ_GATEWAY_OAUTH_SIGNING_PRIVATE_KEY_PATH is required');
    if (!config.oauthStatePath) throw new Error('SEZ_GATEWAY_OAUTH_STATE_PATH is required');
    this.config = config;
    this.identityProvider = config.identityProvider ?? 'github';
    if (!['password', 'github'].includes(this.identityProvider)) throw new Error('identity provider is invalid');
    if (this.identityProvider === 'password') {
      requiredString(config.ownerPasswordScrypt, 'SEZ_GATEWAY_OWNER_PASSWORD_SCRYPT');
      passwordParts(config.ownerPasswordScrypt);
      this.githubClientSecret = '';
    } else {
      requiredString(config.githubClientId, 'SEZ_GATEWAY_GITHUB_CLIENT_ID');
      requiredString(config.githubClientSecretPath, 'SEZ_GATEWAY_GITHUB_CLIENT_SECRET_PATH');
      if (!Number.isSafeInteger(config.githubAllowedUserId) || config.githubAllowedUserId <= 0) {
        throw new Error('SEZ_GATEWAY_GITHUB_ALLOWED_USER_ID must be a positive integer');
      }
      const callback = new URL(requiredString(config.githubCallbackUri, 'SEZ_GATEWAY_GITHUB_CALLBACK_URI'));
      if (callback.origin !== new URL(config.publicResource).origin || callback.pathname !== '/oauth/github/callback' || callback.search || callback.hash) {
        throw new Error('SEZ_GATEWAY_GITHUB_CALLBACK_URI must be the exact public GitHub callback');
      }
      this.githubClientSecret = readFileSync(config.githubClientSecretPath, 'utf8').trim();
      if (this.githubClientSecret.length < 20 || this.githubClientSecret.length > 512) throw new Error('GitHub client secret is invalid');
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new Error('fetch is unavailable');
    this.privateKey = createPrivateKey(readFileSync(config.oauthSigningPrivateKeyPath, 'utf8'));
    this.publicKey = publicJwk(this.privateKey);
    this.store = new OAuthStateStore(config.oauthStatePath);
    this.passwordFailures = new Map();
  }

  jwks() {
    return Object.freeze({ keys: [this.publicKey] });
  }

  protectedResourceMetadata() {
    return Object.freeze({
      resource: this.config.protectedResource,
      authorization_servers: [this.config.oauthIssuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [this.config.requiredScope],
      resource_documentation: `${this.config.publicResource}/healthz`,
    });
  }

  authorizationServerMetadata() {
    const issuer = this.config.oauthIssuer;
    return Object.freeze({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      jwks_uri: `${issuer}/oauth/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [this.config.requiredScope, 'offline_access'],
      resource_parameter_supported: true,
      service_documentation: `${this.config.publicResource}/healthz`,
    });
  }

  #accessToken(scope) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'EdDSA', kid: this.publicKey.kid, typ: 'at+jwt' }));
    const payload = base64url(JSON.stringify({
      iss: this.config.oauthIssuer,
      sub: this.config.expectedSubject,
      aud: this.config.protectedResource,
      resource: this.config.protectedResource,
      scope: scope.join(' '),
      iat: now,
      nbf: now - 1,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
      jti: randomUUID(),
    }));
    const signingInput = `${header}.${payload}`;
    const signature = sign(null, Buffer.from(signingInput, 'ascii'), this.privateKey).toString('base64url');
    return `${signingInput}.${signature}`;
  }

  #tokenResponse(clientId, scope) {
    const refreshToken = token(48);
    this.store.saveRefreshToken(refreshToken, {
      clientId,
      subject: this.config.expectedSubject,
      resource: this.config.protectedResource,
      scope,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    });
    return {
      access_token: this.#accessToken(scope),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scope.join(' '),
    };
  }

  #passwordBlocked(address) {
    const now = Date.now();
    const current = this.passwordFailures.get(address);
    if (!current) return false;
    if (current.blockedUntil && current.blockedUntil > now) return true;
    if (now - current.windowStarted > PASSWORD_WINDOW_MS) this.passwordFailures.delete(address);
    return false;
  }

  #passwordFailure(address) {
    const now = Date.now();
    const current = this.passwordFailures.get(address);
    const record = !current || now - current.windowStarted > PASSWORD_WINDOW_MS
      ? { count: 0, windowStarted: now, blockedUntil: 0 }
      : current;
    record.count += 1;
    if (record.count >= PASSWORD_MAX_FAILURES) record.blockedUntil = now + PASSWORD_BLOCK_MS;
    this.passwordFailures.set(address, record);
  }

  async #register(request, response) {
    let body;
    try {
      const raw = await readBody(request);
      body = JSON.parse(raw || '{}');
    } catch {
      oauthError(response, 400, 'invalid_client_metadata', 'Registration body must be valid JSON.');
      return;
    }
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (redirectUris.length < 1 || redirectUris.length > 8 || redirectUris.some((uri) => typeof uri !== 'string' || !allowedRedirectUri(uri))) {
      oauthError(response, 400, 'invalid_redirect_uri', 'Only HTTPS ChatGPT or OpenAI callback URLs are accepted.');
      return;
    }
    const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token'];
    const responseTypes = Array.isArray(body.response_types) ? body.response_types : ['code'];
    if (grantTypes.some((value) => !['authorization_code', 'refresh_token'].includes(value)) || !grantTypes.includes('authorization_code')) {
      oauthError(response, 400, 'invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported.');
      return;
    }
    if (responseTypes.length !== 1 || responseTypes[0] !== 'code') {
      oauthError(response, 400, 'invalid_client_metadata', 'Only the code response type is supported.');
      return;
    }
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
      oauthError(response, 400, 'invalid_client_metadata', 'Only public PKCE clients are supported.');
      return;
    }
    const clientId = `bq_${token(24)}`;
    const client = {
      clientId,
      clientName: typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : 'ChatGPT',
      redirectUris: [...new Set(redirectUris)],
      createdAt: Date.now(),
    };
    this.store.registerClient(client);
    sendJson(response, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }

  #startAuthorization(url, response) {
    const clientId = url.searchParams.get('client_id') ?? '';
    const client = this.store.client(clientId);
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    if (!client || !client.redirectUris.includes(redirectUri)) {
      oauthError(response, 400, 'invalid_request', 'The OAuth client or redirect URI is not registered.');
      return;
    }
    const record = {
      clientId,
      redirectUri,
      state: url.searchParams.get('state') ?? '',
    };
    if (url.searchParams.get('response_type') !== 'code') {
      redirect(response, redirectWithError(record, 'unsupported_response_type', 'Only authorization code is supported.'));
      return;
    }
    const codeChallenge = url.searchParams.get('code_challenge') ?? '';
    if (url.searchParams.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) {
      redirect(response, redirectWithError(record, 'invalid_request', 'PKCE S256 is required.'));
      return;
    }
    const resource = url.searchParams.get('resource') ?? '';
    if (resource !== this.config.protectedResource) {
      redirect(response, redirectWithError(record, 'invalid_target', 'The protected resource does not match.'));
      return;
    }
    let scope;
    try {
      scope = normalizedScopes(url.searchParams.get('scope'));
    } catch (error) {
      redirect(response, redirectWithError(record, 'invalid_scope', error.message));
      return;
    }
    const flowId = token(32);
    const requestRecord = {
      ...record,
      codeChallenge,
      resource,
      scope,
      expiresAt: Date.now() + AUTHORIZATION_REQUEST_TTL_MS,
    };
    if (this.identityProvider === 'github') {
      const githubVerifier = token(48);
      requestRecord.githubVerifier = githubVerifier;
      this.store.saveAuthorizationRequest(flowId, requestRecord);
      const github = new URL(GITHUB_AUTHORIZE_URL);
      github.searchParams.set('client_id', this.config.githubClientId);
      github.searchParams.set('redirect_uri', this.config.githubCallbackUri);
      github.searchParams.set('state', flowId);
      github.searchParams.set('code_challenge', base64url(sha256(githubVerifier)));
      github.searchParams.set('code_challenge_method', 'S256');
      github.searchParams.set('allow_signup', 'false');
      github.searchParams.set('prompt', 'select_account');
      if (this.config.githubLoginHint) github.searchParams.set('login', this.config.githubLoginHint);
      redirect(response, github.toString());
      return;
    }
    this.store.saveAuthorizationRequest(flowId, requestRecord);
    sendHtml(response, 200, loginPage(requestRecord, flowId));
  }

  #issueAuthorizationCode(record, response, identity = {}) {
    const code = token(40);
    this.store.saveAuthorizationCode(code, {
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      codeChallenge: record.codeChallenge,
      resource: record.resource,
      scope: record.scope,
      subject: this.config.expectedSubject,
      identityProvider: identity.provider ?? this.identityProvider,
      identitySubject: identity.subject ?? null,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
    });
    const target = new URL(record.redirectUri);
    target.searchParams.set('code', code);
    if (record.state) target.searchParams.set('state', record.state);
    redirect(response, target.toString());
  }

  async #completePasswordAuthorization(request, response) {
    if (this.identityProvider !== 'password') {
      oauthError(response, 405, 'invalid_request', 'Password authorization is disabled.');
      return;
    }
    let params;
    try {
      params = await readParameters(request);
    } catch {
      oauthError(response, 400, 'invalid_request', 'The authorization form was invalid.');
      return;
    }
    const flowId = params.get('flow_id') ?? '';
    const record = this.store.authorizationRequest(flowId);
    if (!record) {
      oauthError(response, 400, 'invalid_request', 'The authorization request expired.');
      return;
    }
    const address = remoteAddress(request);
    if (this.#passwordBlocked(address)) {
      sendHtml(response, 429, loginPage(record, flowId, 'Too many failed attempts. Try again later.'));
      return;
    }
    let valid = false;
    try {
      valid = verifyOwnerPassword(params.get('password') ?? '', this.config.ownerPasswordScrypt);
    } catch {
      valid = false;
    }
    if (!valid) {
      this.#passwordFailure(address);
      sendHtml(response, 401, loginPage(record, flowId, 'The owner password is incorrect.'));
      return;
    }
    this.passwordFailures.delete(address);
    const consumed = this.store.consumeAuthorizationRequest(flowId);
    if (!consumed) {
      oauthError(response, 400, 'invalid_request', 'The authorization request expired.');
      return;
    }
    this.#issueAuthorizationCode(consumed, response, { provider: 'password' });
  }

  async #githubAccessToken(code, verifier) {
    const response = await this.fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'StealthEye-Sez-Sez-MCP',
      },
      body: new URLSearchParams({
        client_id: this.config.githubClientId,
        client_secret: this.githubClientSecret,
        code,
        redirect_uri: this.config.githubCallbackUri,
        code_verifier: verifier,
      }),
    });
    const value = await responseJson(response, 'GitHub token exchange');
    if (value.error || typeof value.access_token !== 'string' || value.access_token.length < 10 || String(value.token_type).toLowerCase() !== 'bearer') {
      throw new Error('GitHub token exchange was rejected');
    }
    return value.access_token;
  }

  async #githubUser(accessToken) {
    const response = await this.fetch(GITHUB_USER_URL, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'StealthEye-Sez-Sez-MCP',
        'x-github-api-version': GITHUB_API_VERSION,
      },
    });
    const value = await responseJson(response, 'GitHub user lookup');
    if (!Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.login !== 'string') {
      throw new Error('GitHub user response was invalid');
    }
    return value;
  }

  async #completeGitHubAuthorization(url, response) {
    if (this.identityProvider !== 'github') {
      oauthError(response, 404, 'not_found');
      return;
    }
    const flowId = url.searchParams.get('state') ?? '';
    const record = this.store.consumeAuthorizationRequest(flowId);
    if (!record || typeof record.githubVerifier !== 'string') {
      oauthError(response, 400, 'invalid_request', 'The authorization request expired.');
      return;
    }
    if (url.searchParams.get('error')) {
      redirect(response, redirectWithError(record, 'access_denied', 'GitHub authorization was not completed.'));
      return;
    }
    const code = url.searchParams.get('code') ?? '';
    if (!code) {
      redirect(response, redirectWithError(record, 'invalid_request', 'GitHub did not return an authorization code.'));
      return;
    }
    try {
      const accessToken = await this.#githubAccessToken(code, record.githubVerifier);
      const user = await this.#githubUser(accessToken);
      if (user.id !== this.config.githubAllowedUserId) {
        redirect(response, redirectWithError(record, 'access_denied', 'This GitHub account is not authorized for se-z.'));
        return;
      }
      this.#issueAuthorizationCode(record, response, { provider: 'github', subject: String(user.id) });
    } catch {
      redirect(response, redirectWithError(record, 'temporarily_unavailable', 'GitHub identity verification failed. Start authorization again.'));
    }
  }

  async #token(request, response) {
    let params;
    try {
      params = await readParameters(request);
    } catch {
      oauthError(response, 400, 'invalid_request', 'Token request body is invalid.');
      return;
    }
    const grantType = params.get('grant_type') ?? '';
    const clientId = params.get('client_id') ?? '';
    if (!this.store.client(clientId)) {
      oauthError(response, 401, 'invalid_client');
      return;
    }
    const requestedResource = params.get('resource');
    if (requestedResource && requestedResource !== this.config.protectedResource) {
      oauthError(response, 400, 'invalid_target');
      return;
    }
    if (grantType === 'authorization_code') {
      const code = params.get('code') ?? '';
      const record = this.store.consumeAuthorizationCode(code);
      if (!record || record.clientId !== clientId || record.redirectUri !== (params.get('redirect_uri') ?? '')) {
        oauthError(response, 400, 'invalid_grant');
        return;
      }
      const verifier = params.get('code_verifier') ?? '';
      if (verifier.length < 43 || verifier.length > 128 || base64url(sha256(verifier)) !== record.codeChallenge) {
        oauthError(response, 400, 'invalid_grant');
        return;
      }
      if (record.resource !== this.config.protectedResource) {
        oauthError(response, 400, 'invalid_target');
        return;
      }
      sendJson(response, 200, this.#tokenResponse(clientId, record.scope));
      return;
    }
    if (grantType === 'refresh_token') {
      const refreshToken = params.get('refresh_token') ?? '';
      const record = this.store.consumeRefreshToken(refreshToken);
      if (!record || record.clientId !== clientId || record.resource !== this.config.protectedResource) {
        oauthError(response, 400, 'invalid_grant');
        return;
      }
      sendJson(response, 200, this.#tokenResponse(clientId, record.scope));
      return;
    }
    oauthError(response, 400, 'unsupported_grant_type');
  }

  async #revoke(request, response) {
    let params;
    try {
      params = await readParameters(request);
    } catch {
      oauthError(response, 400, 'invalid_request');
      return;
    }
    const value = params.get('token') ?? '';
    if (value) this.store.revokeRefreshToken(value);
    response.writeHead(200, { 'cache-control': 'no-store', 'content-length': '0' });
    response.end();
  }

  async handle(request, response, url) {
    const method = request.method ?? '';
    if (method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) {
      sendJson(response, 200, this.protectedResourceMetadata());
      return true;
    }
    if (method === 'GET' && (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration')) {
      sendJson(response, 200, this.authorizationServerMetadata());
      return true;
    }
    if (method === 'GET' && url.pathname === '/oauth/jwks.json') {
      sendJson(response, 200, this.jwks());
      return true;
    }
    if (method === 'POST' && url.pathname === '/oauth/register') {
      await this.#register(request, response);
      return true;
    }
    if (method === 'GET' && url.pathname === '/oauth/authorize') {
      this.#startAuthorization(url, response);
      return true;
    }
    if (method === 'POST' && url.pathname === '/oauth/authorize') {
      await this.#completePasswordAuthorization(request, response);
      return true;
    }
    if (method === 'GET' && url.pathname === '/oauth/github/callback') {
      await this.#completeGitHubAuthorization(url, response);
      return true;
    }
    if (method === 'POST' && url.pathname === '/oauth/token') {
      await this.#token(request, response);
      return true;
    }
    if (method === 'POST' && url.pathname === '/oauth/revoke') {
      await this.#revoke(request, response);
      return true;
    }
    return false;
  }
}

export function createOAuthAuthorizationServer(config, options = {}) {
  return new OAuthAuthorizationServer(config, options);
}
