import crypto from 'node:crypto';

const CLIENT_ID = process.env.OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';
const SIGNING_SECRET = process.env.OAUTH_SIGNING_SECRET || '';
const LOGIN_PASSWORD = process.env.OAUTH_LOGIN_PASSWORD || '';
const ACCESS_TOKEN_TTL = Math.min(Math.max(Number(process.env.OAUTH_ACCESS_TOKEN_TTL || 3600), 300), 86400);
const REFRESH_TOKEN_TTL = Math.min(Math.max(Number(process.env.OAUTH_REFRESH_TOKEN_TTL || 2592000), 3600), 31536000);
const AUTH_CODE_TTL = Math.min(Math.max(Number(process.env.OAUTH_AUTH_CODE_TTL || 300), 60), 900);
const ALLOWED_REDIRECT_URIS = (process.env.OAUTH_ALLOWED_REDIRECT_URIS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const DEFAULT_SCOPE = process.env.OAUTH_DEFAULT_SCOPE || 'agent:control';

const codes = new Map();

function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function base64url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buffer.toString('base64url');
}

function encodePayload(payload) {
  return base64url(JSON.stringify(payload));
}

function sign(input) {
  return base64url(crypto.createHmac('sha256', SIGNING_SECRET).update(input).digest());
}

function tokenFor(type, payload, ttl) {
  const now = Math.floor(Date.now() / 1000);
  const body = encodePayload({
    ...payload,
    typ: type,
    iat: now,
    exp: now + ttl,
    jti: crypto.randomUUID()
  });
  const prefix = type === 'access' ? 'cwa1' : 'cwr1';
  const unsigned = `${prefix}.${body}`;
  return `${unsigned}.${sign(unsigned)}`;
}

function parseSignedToken(token, expectedType) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('invalid_token');
  const [prefix, encoded, signature] = parts;
  const expectedPrefix = expectedType === 'access' ? 'cwa1' : 'cwr1';
  if (prefix !== expectedPrefix) throw new Error('invalid_token');
  const unsigned = `${prefix}.${encoded}`;
  if (!safeEqual(signature, sign(unsigned))) throw new Error('invalid_token');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid_token');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.typ !== expectedType || !payload.exp || payload.exp <= now) throw new Error('token_expired');
  if (payload.aud !== CLIENT_ID) throw new Error('invalid_token_audience');
  return payload;
}

function normalizeScope(scope) {
  const values = String(scope || DEFAULT_SCOPE)
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)].join(' ');
}

function hasScope(scopeString, required) {
  if (!required) return true;
  return normalizeScope(scopeString).split(' ').includes(required);
}

function validateRedirectUri(uri) {
  if (!uri) return false;
  if (!ALLOWED_REDIRECT_URIS.length) return false;
  return ALLOWED_REDIRECT_URIS.includes(String(uri));
}

function hashCodeChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(String(verifier)).digest());
}

export function assertOAuthConfigured() {
  const missing = [];
  if (!CLIENT_ID) missing.push('OAUTH_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('OAUTH_CLIENT_SECRET');
  if (!SIGNING_SECRET) missing.push('OAUTH_SIGNING_SECRET');
  if (!LOGIN_PASSWORD) missing.push('OAUTH_LOGIN_PASSWORD');
  if (!ALLOWED_REDIRECT_URIS.length) missing.push('OAUTH_ALLOWED_REDIRECT_URIS');
  if (missing.length) throw new Error(`oauth_not_configured:${missing.join(',')}`);
}

export function getOAuthMetadata(publicBaseUrl) {
  const base = String(publicBaseUrl || '').replace(/\/$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [DEFAULT_SCOPE]
  };
}

export function validateAuthorizationRequest(input = {}) {
  if (String(input.response_type || '') !== 'code') throw new Error('unsupported_response_type');
  if (!safeEqual(input.client_id || '', CLIENT_ID)) throw new Error('invalid_client');
  if (!validateRedirectUri(input.redirect_uri)) throw new Error('invalid_redirect_uri');
  if (!input.state) throw new Error('state_required');
  if (input.code_challenge_method && input.code_challenge_method !== 'S256') throw new Error('unsupported_code_challenge_method');
  if (input.code_challenge_method === 'S256' && !input.code_challenge) throw new Error('code_challenge_required');

  return {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: String(input.redirect_uri),
    state: String(input.state),
    scope: normalizeScope(input.scope),
    code_challenge: input.code_challenge ? String(input.code_challenge) : '',
    code_challenge_method: input.code_challenge ? 'S256' : ''
  };
}

export function verifyLoginPassword(password) {
  return LOGIN_PASSWORD && safeEqual(password || '', LOGIN_PASSWORD);
}

export function createAuthorizationCode(request) {
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, {
    ...request,
    expiresAt: Date.now() + AUTH_CODE_TTL * 1000,
    used: false
  });
  return code;
}

function consumeAuthorizationCode(code, redirectUri, codeVerifier) {
  const entry = codes.get(String(code || ''));
  if (!entry || entry.used || entry.expiresAt <= Date.now()) {
    codes.delete(String(code || ''));
    throw new Error('invalid_grant');
  }
  if (entry.redirect_uri !== String(redirectUri || '')) throw new Error('invalid_grant');

  if (entry.code_challenge) {
    if (!codeVerifier) throw new Error('invalid_grant');
    if (!safeEqual(hashCodeChallenge(codeVerifier), entry.code_challenge)) throw new Error('invalid_grant');
  }

  entry.used = true;
  codes.delete(String(code || ''));
  return entry;
}

export function verifyClient(clientId, clientSecret) {
  return Boolean(clientId && clientSecret && safeEqual(clientId, CLIENT_ID) && safeEqual(clientSecret, CLIENT_SECRET));
}

export function exchangeAuthorizationCode({ code, redirectUri, codeVerifier }) {
  const entry = consumeAuthorizationCode(code, redirectUri, codeVerifier);
  const common = { aud: CLIENT_ID, sub: 'web-agent-owner', scope: entry.scope };
  return {
    access_token: tokenFor('access', common, ACCESS_TOKEN_TTL),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: tokenFor('refresh', common, REFRESH_TOKEN_TTL),
    scope: entry.scope
  };
}

export function exchangeRefreshToken(refreshToken) {
  const payload = parseSignedToken(refreshToken, 'refresh');
  const common = { aud: CLIENT_ID, sub: payload.sub || 'web-agent-owner', scope: normalizeScope(payload.scope) };
  return {
    access_token: tokenFor('access', common, ACCESS_TOKEN_TTL),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: tokenFor('refresh', common, REFRESH_TOKEN_TTL),
    scope: common.scope
  };
}

export function verifyAccessToken(accessToken, requiredScope = 'agent:control') {
  const payload = parseSignedToken(accessToken, 'access');
  if (!hasScope(payload.scope, requiredScope)) throw new Error('insufficient_scope');
  return payload;
}

export function parseClientCredentials(req) {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        return {
          clientId: decoded.slice(0, separator),
          clientSecret: decoded.slice(separator + 1)
        };
      }
    } catch {
      // Fall through to form credentials.
    }
  }
  return {
    clientId: String(req.body?.client_id || ''),
    clientSecret: String(req.body?.client_secret || '')
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of codes.entries()) {
    if (entry.used || entry.expiresAt <= now) codes.delete(code);
  }
}, 60_000).unref();
