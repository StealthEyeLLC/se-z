// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('JWT segment is invalid');
  return Buffer.from(value, 'base64url');
}

function parseObject(value, label) {
  const parsed = JSON.parse(decodeBase64Url(value).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be an object`);
  return parsed;
}

function scopes(payload) {
  if (typeof payload.scope === 'string') return payload.scope.split(/\s+/u).filter(Boolean);
  if (Array.isArray(payload.scp)) return payload.scp.filter((value) => typeof value === 'string');
  return [];
}

function audienceMatches(actual, expected) {
  return actual === expected || (Array.isArray(actual) && actual.includes(expected));
}

function verifyJwt(token, jwks, config, nowMs = Date.now()) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Bearer token is not a compact JWT');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseObject(encodedHeader, 'JWT header');
  const payload = parseObject(encodedPayload, 'JWT payload');
  if (!['EdDSA', 'RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string') throw new Error('JWT header is not acceptable');
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const jwk = keys.find((candidate) => candidate?.kid === header.kid && candidate.use !== 'enc');
  if (!jwk || Object.hasOwn(jwk, 'd')) throw new Error('JWT signing key is not trusted');
  if (jwk.alg && jwk.alg !== header.alg) throw new Error('JWT key algorithm does not match');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii');
  const signature = decodeBase64Url(encodedSignature);
  let valid = false;
  if (header.alg === 'EdDSA') valid = verifySignature(null, signingInput, key, signature);
  else if (header.alg === 'RS256') valid = verifySignature('RSA-SHA256', signingInput, key, signature);
  else valid = verifySignature('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
  if (!valid) throw new Error('JWT signature is invalid');
  const now = Math.floor(nowMs / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= now) throw new Error('JWT is expired or lacks expiry');
  if (!Number.isFinite(payload.iat) || payload.iat > now + 30) throw new Error('JWT issued-at time is invalid');
  if (payload.nbf !== undefined && payload.nbf > now + 30) throw new Error('JWT is not active');
  if (payload.iss !== config.oauthIssuer || !audienceMatches(payload.aud, config.oauthResource)) throw new Error('JWT issuer or audience does not match');
  if (payload.resource !== undefined && payload.resource !== config.oauthResource) throw new Error('JWT protected resource does not match');
  if (payload.sub !== config.expectedSubject) throw new Error('JWT subject is not the configured owner');
  const granted = scopes(payload);
  if (!granted.includes(config.requiredScope)) throw new Error('JWT lacks the required scope');
  return Object.freeze({ subject: payload.sub, scopes: granted, tokenFingerprint: createHash('sha256').update(token).digest('hex'), claims: payload });
}

function bearer(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.includes(',')) throw new Error('Bearer token is missing');
  const value = header.slice(7).trim();
  if (!value) throw new Error('Bearer token is missing');
  return value;
}

export class OAuthVerifier {
  #jwks = null;
  #expiresAt = 0;
  #refreshPromise = null;

  constructor(config, fetchOrOptions = fetch) {
    this.config = config;
    if (typeof fetchOrOptions === 'function') {
      this.fetchImpl = fetchOrOptions;
      this.localJwks = null;
    } else {
      this.fetchImpl = fetchOrOptions.fetchImpl ?? fetch;
      this.localJwks = fetchOrOptions.localJwks ?? null;
    }
  }

  async #refreshJwks() {
    if (this.localJwks) return this.localJwks;
    if (!this.#refreshPromise) {
      this.#refreshPromise = (async () => {
        const response = await this.fetchImpl(this.config.oauthJwksUri, { headers: { accept: 'application/json' }, redirect: 'error' });
        if (!response.ok) throw new Error('OAuth JWKS is unavailable');
        const text = await response.text();
        if (Buffer.byteLength(text) > 262_144) throw new Error('OAuth JWKS response is too large');
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed?.keys) || parsed.keys.length < 1 || parsed.keys.length > 64) throw new Error('OAuth JWKS is invalid');
        if (parsed.keys.some((key) => key && Object.hasOwn(key, 'd'))) throw new Error('OAuth JWKS contains private key material');
        this.#jwks = parsed;
        this.#expiresAt = Date.now() + this.config.jwksCacheMs;
        return parsed;
      })().finally(() => {
        this.#refreshPromise = null;
      });
    }
    return await this.#refreshPromise;
  }

  async verify(authorization) {
    const token = bearer(authorization);
    const now = Date.now();
    const jwks = this.localJwks ?? (this.#jwks && now < this.#expiresAt ? this.#jwks : await this.#refreshJwks());
    return verifyJwt(token, jwks, this.config, now);
  }
}

export { verifyJwt };
