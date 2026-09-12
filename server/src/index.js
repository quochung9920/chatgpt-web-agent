import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.API_KEY || '';
const AGENT_ID = process.env.AGENT_ID || 'desktop-chrome';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const WORDPRESS_BASE_URL = (process.env.WORDPRESS_BASE_URL || '').replace(/\/$/, '');
const WORDPRESS_TOKEN = process.env.WORDPRESS_TOKEN || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireApiKey(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!API_KEY || !timingSafeEqual(token, API_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'chatgpt-web-agent', version: '0.1.0' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const agents = new Map();
const pending = new Map();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/agent') return socket.destroy();

  const id = url.searchParams.get('id');
  const token = url.searchParams.get('token');
  if (!id || id !== AGENT_ID || !AGENT_TOKEN || !timingSafeEqual(token, AGENT_TOKEN)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.agentId = id;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  agents.set(ws.agentId, ws);

  ws.on('message', (buffer) => {
    let message;
    try { message = JSON.parse(buffer.toString()); } catch { return; }
    if (!message.requestId || !pending.has(message.requestId)) return;

    const entry = pending.get(message.requestId);
    clearTimeout(entry.timer);
    pending.delete(message.requestId);
    if (message.ok === false) entry.reject(new Error(message.error || 'agent_error'));
    else entry.resolve(message.result ?? null);
  });

  ws.on('close', () => {
    if (agents.get(ws.agentId) === ws) agents.delete(ws.agentId);
  });
});

function callAgent(action, args = {}) {
  const ws = agents.get(AGENT_ID);
  if (!ws || ws.readyState !== ws.OPEN) {
    return Promise.reject(new Error('browser_agent_offline'));
  }

  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('browser_agent_timeout'));
    }, REQUEST_TIMEOUT_MS);

    pending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ requestId, action, args }));
  });
}

app.get('/v1/browser/status', requireApiKey, (_req, res) => {
  const ws = agents.get(AGENT_ID);
  res.json({ online: Boolean(ws && ws.readyState === ws.OPEN), agentId: AGENT_ID });
});

const ALLOWED_BROWSER_ACTIONS = new Set([
  'tabs.list', 'tab.active', 'tab.navigate', 'tab.reload',
  'page.read', 'page.click', 'page.type', 'page.scroll', 'page.screenshot'
]);

app.post('/v1/browser/action', requireApiKey, async (req, res) => {
  const { action, args = {} } = req.body || {};
  if (!ALLOWED_BROWSER_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'action_not_allowed' });
  }

  try {
    const result = await callAgent(action, args);
    res.json({ ok: true, result });
  } catch (error) {
    const status = error.message === 'browser_agent_offline' ? 503 : 500;
    res.status(status).json({ error: error.message });
  }
});

async function wordpressFetch(path, options = {}) {
  if (!WORDPRESS_BASE_URL || !WORDPRESS_TOKEN) throw new Error('wordpress_not_configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${WORDPRESS_BASE_URL}/wp-json/chatgpt-web-agent/v1${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-ChatGPT-Web-Agent-Token': WORDPRESS_TOKEN,
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.code || `wordpress_http_${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

app.get('/v1/wordpress/site', requireApiKey, async (_req, res) => {
  try { res.json(await wordpressFetch('/site')); }
  catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/v1/wordpress/pages', requireApiKey, async (req, res) => {
  try {
    const qs = new URLSearchParams();
    if (req.query.search) qs.set('search', String(req.query.search));
    if (req.query.per_page) qs.set('per_page', String(req.query.per_page));
    res.json(await wordpressFetch(`/pages${qs.size ? `?${qs}` : ''}`));
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/v1/wordpress/pages/:id', requireApiKey, async (req, res) => {
  try { res.json(await wordpressFetch(`/pages/${Number(req.params.id)}`)); }
  catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/v1/wordpress/pages', requireApiKey, async (req, res) => {
  try {
    res.status(201).json(await wordpressFetch('/pages', { method: 'POST', body: JSON.stringify(req.body || {}) }));
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.patch('/v1/wordpress/pages/:id', requireApiKey, async (req, res) => {
  try {
    res.json(await wordpressFetch(`/pages/${Number(req.params.id)}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) }));
  } catch (error) { res.status(502).json({ error: error.message }); }
});

server.listen(PORT, () => {
  console.log(`ChatGPT Web Agent listening on http://0.0.0.0:${PORT}`);
});
