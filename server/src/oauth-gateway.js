import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import httpProxy from 'http-proxy';
import {
  assertOAuthConfigured,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  getOAuthMetadata,
  parseClientCredentials,
  validateAuthorizationRequest,
  verifyAccessToken,
  verifyClient,
  verifyLoginPassword
} from './oauth.js';

const PUBLIC_PORT = Number(process.env.PORT || 8787);
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 8790);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || `http://localhost:${PUBLIC_PORT}`).replace(/\/$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || crypto.randomBytes(48).toString('base64url');
const SPAWN_BACKEND = process.env.SPAWN_BACKEND !== 'false';
const BACKEND_URL = `http://127.0.0.1:${INTERNAL_PORT}`;

assertOAuthConfigured();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDir = path.resolve(__dirname, '..');

let backendProcess = null;
if (SPAWN_BACKEND) {
  backendProcess = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(INTERNAL_PORT),
      API_KEY: INTERNAL_API_KEY
    },
    stdio: 'inherit'
  });

  backendProcess.on('exit', (code, signal) => {
    if (signal) console.error(`Web Agent backend exited from signal ${signal}`);
    else if (code !== 0) console.error(`Web Agent backend exited with code ${code}`);
  });
}

const app = express();
const proxy = httpProxy.createProxyServer({
  target: BACKEND_URL,
  ws: true,
  changeOrigin: false,
  xfwd: true
});

proxy.on('error', (error, req, res) => {
  console.error('Proxy error:', error.message);
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'backend_unavailable' }));
  } else if (res && typeof res.destroy === 'function') {
    res.destroy();
  }
});

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function authorizationPage(request, errorMessage = '') {
  const hidden = Object.entries(request)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
    .join('\n');
  const error = errorMessage ? `<div class="error">${htmlEscape(errorMessage)}</div>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize ChatGPT Web Agent</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f4f4f5; color:#18181b; }
    .card { width:min(440px, calc(100% - 32px)); background:#fff; border:1px solid #e4e4e7; border-radius:18px; padding:28px; box-shadow:0 14px 45px rgba(0,0,0,.08); }
    h1 { font-size:22px; margin:0 0 8px; }
    p { color:#52525b; line-height:1.55; margin:0 0 22px; }
    label { display:block; font-size:13px; font-weight:650; margin-bottom:7px; }
    input[type=password] { width:100%; box-sizing:border-box; padding:12px 13px; border:1px solid #d4d4d8; border-radius:10px; font:inherit; }
    button { width:100%; margin-top:14px; padding:12px 16px; border:0; border-radius:10px; background:#18181b; color:#fff; font:inherit; font-weight:700; cursor:pointer; }
    .error { margin-bottom:14px; padding:10px 12px; border-radius:9px; background:#fee2e2; color:#991b1b; font-size:13px; }
    .note { margin-top:16px; color:#71717a; font-size:12px; }
    @media (prefers-color-scheme: dark) { body { background:#09090b; color:#fafafa; } .card { background:#18181b; border-color:#3f3f46; } p,.note { color:#a1a1aa; } input[type=password] { background:#09090b; color:#fafafa; border-color:#52525b; } button { background:#fafafa; color:#18181b; } }
  </style>
</head>
<body>
  <main class="card">
    <h1>Authorize ChatGPT Web Agent</h1>
    <p>Allow your Custom GPT to control the Web Agent connected to your own Chrome and WordPress installation.</p>
    ${error}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label for="login_password">Web Agent access password</label>
      <input id="login_password" name="login_password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Authorize</button>
    </form>
    <div class="note">This is your Web Agent password, not your ChatGPT password. Your ChatGPT account remains signed in at chatgpt.com.</div>
  </main>
</body>
</html>`;
}

function bearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function oauthError(res, status, error, description) {
  return res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'chatgpt-web-agent-oauth-gateway',
    version: '0.3.0',
    backend: BACKEND_URL,
    auth: 'oauth2'
  });
});

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json(getOAuthMetadata(PUBLIC_BASE_URL));
});

app.get('/oauth/authorize', (req, res) => {
  try {
    const request = validateAuthorizationRequest(req.query || {});
    res.set('Cache-Control', 'no-store');
    res.type('html').send(authorizationPage(request));
  } catch (error) {
    res.status(400).type('html').send(`<h1>Authorization request rejected</h1><p>${htmlEscape(error.message)}</p>`);
  }
});

app.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '32kb' }), (req, res) => {
  let request;
  try {
    request = validateAuthorizationRequest(req.body || {});
  } catch (error) {
    return res.status(400).type('html').send(`<h1>Authorization request rejected</h1><p>${htmlEscape(error.message)}</p>`);
  }

  if (!verifyLoginPassword(req.body?.login_password)) {
    res.set('Cache-Control', 'no-store');
    return res.status(401).type('html').send(authorizationPage(request, 'Incorrect Web Agent access password.'));
  }

  const code = createAuthorizationCode(request);
  const redirect = new URL(request.redirect_uri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', request.state);
  res.redirect(302, redirect.toString());
});

app.post('/oauth/token', express.urlencoded({ extended: false, limit: '32kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { clientId, clientSecret } = parseClientCredentials(req);
  if (!verifyClient(clientId, clientSecret)) return oauthError(res, 401, 'invalid_client');

  try {
    const grantType = String(req.body?.grant_type || '');
    if (grantType === 'authorization_code') {
      const result = exchangeAuthorizationCode({
        code: req.body?.code,
        redirectUri: req.body?.redirect_uri,
        codeVerifier: req.body?.code_verifier
      });
      return res.json(result);
    }
    if (grantType === 'refresh_token') {
      return res.json(exchangeRefreshToken(req.body?.refresh_token));
    }
    return oauthError(res, 400, 'unsupported_grant_type');
  } catch (error) {
    return oauthError(res, 400, 'invalid_grant', error.message);
  }
});

app.use('/v1', (req, res) => {
  try {
    verifyAccessToken(bearerToken(req), 'agent:control');
  } catch (error) {
    res.set('WWW-Authenticate', 'Bearer realm="chatgpt-web-agent", scope="agent:control"');
    return res.status(401).json({ error: error.message === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token' });
  }

  const originalUrl = req.originalUrl || req.url;
  req.headers.authorization = `Bearer ${INTERNAL_API_KEY}`;
  req.url = originalUrl;
  proxy.web(req, res, { target: BACKEND_URL });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; } catch { /* ignore */ }
  if (pathname !== '/agent') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  proxy.ws(req, socket, head, { target: BACKEND_URL });
});

server.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`ChatGPT Web Agent OAuth gateway listening on ${PUBLIC_BASE_URL}`);
  console.log(`Internal Web Agent backend: ${BACKEND_URL}`);
  console.log('ChatGPT-facing authentication: OAuth 2.0 authorization code flow');
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(() => process.exit(0));
  if (backendProcess && !backendProcess.killed) backendProcess.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
