import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import sharp from 'sharp';
import { WebSocket, WebSocketServer } from 'ws';
import { createTarget, getTarget, updateTarget } from './target-store.js';

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.API_KEY || '';
const AGENT_ID = process.env.AGENT_ID || 'desktop-chrome';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const WORDPRESS_BASE_URL = (process.env.WORDPRESS_BASE_URL || '').replace(/\/$/, '');
const WORDPRESS_TOKEN = process.env.WORDPRESS_TOKEN || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const REFERENCE_ALLOWED_HOSTS = (process.env.REFERENCE_ALLOWED_HOSTS || '')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'chatgpt-web-agent', version: '0.2.0' });
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
  const previous = agents.get(ws.agentId);
  if (previous && previous !== ws && previous.readyState === WebSocket.OPEN) previous.close(4000, 'replaced');
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
  if (!ws || ws.readyState !== WebSocket.OPEN) {
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

const ALLOWED_BROWSER_ACTIONS = new Set([
  'tabs.list', 'tab.active', 'tab.navigate', 'tab.reload',
  'page.wait', 'page.read', 'page.inspect', 'page.elements',
  'page.click', 'page.type', 'page.scroll',
  'page.viewport.get', 'page.viewport.set', 'page.viewport.clear',
  'page.screenshot', 'page.elementScreenshot',
  'debug.start', 'debug.logs', 'debug.clear', 'debug.stop'
]);

app.get('/v1/browser/status', requireApiKey, (_req, res) => {
  const ws = agents.get(AGENT_ID);
  res.json({ online: Boolean(ws && ws.readyState === WebSocket.OPEN), agentId: AGENT_ID });
});

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

app.get('/v1/wordpress/pages/:id/blocks', requireApiKey, async (req, res) => {
  try { res.json(await wordpressFetch(`/pages/${Number(req.params.id)}/blocks`)); }
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

app.get('/v1/wordpress/media', requireApiKey, async (req, res) => {
  try {
    const qs = new URLSearchParams();
    if (req.query.search) qs.set('search', String(req.query.search));
    if (req.query.per_page) qs.set('per_page', String(req.query.per_page));
    res.json(await wordpressFetch(`/media${qs.size ? `?${qs}` : ''}`));
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/v1/wordpress/media/import', requireApiKey, async (req, res) => {
  try {
    res.status(201).json(await wordpressFetch('/media/import', {
      method: 'POST',
      body: JSON.stringify(req.body || {})
    }));
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/v1/wordpress/styles/agent-css', requireApiKey, async (_req, res) => {
  try { res.json(await wordpressFetch('/styles/agent-css')); }
  catch (error) { res.status(502).json({ error: error.message }); }
});

app.put('/v1/wordpress/styles/agent-css', requireApiKey, async (req, res) => {
  try {
    res.json(await wordpressFetch('/styles/agent-css', {
      method: 'PUT',
      body: JSON.stringify(req.body || {})
    }));
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/v1/targets', requireApiKey, async (req, res) => {
  try {
    const target = await createTarget(req.body || {});
    res.status(201).json(target);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/v1/targets/:id', requireApiKey, async (req, res) => {
  try {
    const target = await getTarget(req.params.id);
    if (!target) return res.status(404).json({ error: 'target_not_found' });
    res.json(target);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/v1/targets/:id', requireApiKey, async (req, res) => {
  try {
    const target = await updateTarget(req.params.id, req.body || {});
    if (!target) return res.status(404).json({ error: 'target_not_found' });
    res.json(target);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function normalizeViewport(viewport) {
  if (!viewport) return null;
  return {
    width: clampNumber(viewport.width, 240, 3840, 1440),
    height: clampNumber(viewport.height, 320, 2160, 900),
    deviceScaleFactor: clampNumber(viewport.deviceScaleFactor, 0.5, 4, 1),
    mobile: Boolean(viewport.mobile)
  };
}

async function captureObservation(input = {}) {
  let target = null;
  if (input.targetId) {
    target = await getTarget(input.targetId);
    if (!target) throw new Error('target_not_found');
  }

  const destination = target?.destination || {};
  const url = input.url || destination.url || '';
  const viewport = normalizeViewport(input.viewport || target?.viewports?.[0]);
  const selectors = Array.isArray(input.selectors)
    ? input.selectors.map(String).filter(Boolean).slice(0, 20)
    : [];
  const includeDebug = input.includeDebug !== false;
  const fullPage = Boolean(input.fullPage);
  const settleMs = clampNumber(input.settleMs, 0, 5000, 500);
  const maxLength = clampNumber(input.maxLength, 1000, 100000, 20000);

  if (includeDebug) await callAgent('debug.start', { clear: true });
  if (viewport) await callAgent('page.viewport.set', viewport);
  if (url) await callAgent('tab.navigate', { url, wait: true, timeoutMs: REQUEST_TIMEOUT_MS });
  else await callAgent('page.wait', { timeoutMs: REQUEST_TIMEOUT_MS });
  if (settleMs) await sleep(settleMs);

  const page = await callAgent('page.read', { maxLength });
  const elements = {};
  for (const selector of selectors) {
    try {
      elements[selector] = await callAgent('page.inspect', { selector });
    } catch (error) {
      elements[selector] = { error: error.message };
    }
  }

  const screenshot = await callAgent('page.screenshot', { fullPage });
  const debug = includeDebug
    ? await callAgent('debug.logs', { errorsOnly: Boolean(input.errorsOnly) })
    : { console: [], network: [] };

  const observation = {
    targetId: target?.id || null,
    capturedAt: new Date().toISOString(),
    page,
    elements,
    debug,
    screenshot
  };

  if (target) {
    await updateTarget(target.id, {
      status: 'verifying',
      lastObservation: {
        capturedAt: observation.capturedAt,
        page: {
          url: page.url,
          title: page.title,
          viewport: page.viewport,
          document: page.document
        },
        inspectedSelectors: Object.keys(elements),
        consoleErrorCount: (debug.console || []).filter((item) => ['error', 'warning', 'warn'].includes(item.level)).length,
        networkErrorCount: (debug.network || []).filter((item) => item.type === 'response' && Number(item.status || 0) >= 400).length
      }
    });
  }

  return observation;
}

app.post('/v1/verification/capture', requireApiKey, async (req, res) => {
  try {
    res.json(await captureObservation(req.body || {}));
  } catch (error) {
    const status = error.message === 'target_not_found' ? 404
      : error.message === 'browser_agent_offline' ? 503
      : 500;
    res.status(status).json({ error: error.message });
  }
});

function hostAllowed(hostname) {
  if (!REFERENCE_ALLOWED_HOSTS.length) return true;
  const host = hostname.toLowerCase();
  return REFERENCE_ALLOWED_HOSTS.some((rule) => {
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === rule;
  });
}

function decodeImageDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('invalid_image_data_url');
  const buffer = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error('invalid_image_size');
  return buffer;
}

async function fetchReferenceImage(urlString) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:') throw new Error('reference_url_must_be_https');
  if (!hostAllowed(url.hostname)) throw new Error('reference_host_not_allowed');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`reference_http_${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error('reference_not_image');
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 20 * 1024 * 1024) throw new Error('reference_image_too_large');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error('reference_image_too_large');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

async function compareImages(referenceBuffer, candidateBuffer, includeDiff = false) {
  const referenceMeta = await sharp(referenceBuffer).metadata();
  const candidateMeta = await sharp(candidateBuffer).metadata();
  if (!referenceMeta.width || !referenceMeta.height || !candidateMeta.width || !candidateMeta.height) {
    throw new Error('invalid_image_dimensions');
  }

  const scale = Math.min(1, 1600 / candidateMeta.width, 1600 / candidateMeta.height);
  const width = Math.max(1, Math.round(candidateMeta.width * scale));
  const height = Math.max(1, Math.round(candidateMeta.height * scale));

  const [referenceRaw, candidateRaw] = await Promise.all([
    sharp(referenceBuffer).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer(),
    sharp(candidateBuffer).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer()
  ]);

  let totalDelta = 0;
  let differentPixels = 0;
  const pixelCount = width * height;
  const diff = includeDiff ? Buffer.alloc(pixelCount * 4) : null;

  for (let i = 0; i < referenceRaw.length; i += 4) {
    const dr = Math.abs(referenceRaw[i] - candidateRaw[i]);
    const dg = Math.abs(referenceRaw[i + 1] - candidateRaw[i + 1]);
    const db = Math.abs(referenceRaw[i + 2] - candidateRaw[i + 2]);
    const delta = (dr + dg + db) / 3;
    totalDelta += delta;
    if (delta > 32) differentPixels += 1;

    if (diff) {
      diff[i] = Math.min(255, dr * 3);
      diff[i + 1] = Math.min(255, dg * 3);
      diff[i + 2] = Math.min(255, db * 3);
      diff[i + 3] = 255;
    }
  }

  const pixelSimilarity = Math.max(0, 1 - totalDelta / (pixelCount * 255));
  const widthSimilarity = 1 - Math.min(1, Math.abs(referenceMeta.width - candidateMeta.width) / Math.max(referenceMeta.width, candidateMeta.width));
  const heightSimilarity = 1 - Math.min(1, Math.abs(referenceMeta.height - candidateMeta.height) / Math.max(referenceMeta.height, candidateMeta.height));
  const dimensionSimilarity = (widthSimilarity + heightSimilarity) / 2;
  const similarity = pixelSimilarity * 0.9 + dimensionSimilarity * 0.1;

  let diffDataUrl = null;
  if (diff) {
    const png = await sharp(diff, { raw: { width, height, channels: 4 } }).png().toBuffer();
    diffDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  }

  return {
    similarity: Number(similarity.toFixed(5)),
    pixelSimilarity: Number(pixelSimilarity.toFixed(5)),
    dimensionSimilarity: Number(dimensionSimilarity.toFixed(5)),
    differentPixelRatio: Number((differentPixels / pixelCount).toFixed(5)),
    reference: { width: referenceMeta.width, height: referenceMeta.height },
    candidate: { width: candidateMeta.width, height: candidateMeta.height },
    comparedAt: { width, height },
    diffDataUrl
  };
}

app.post('/v1/verification/compare', requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    let target = null;
    if (body.targetId) {
      target = await getTarget(body.targetId);
      if (!target) return res.status(404).json({ error: 'target_not_found' });
    }

    const observation = body.candidateDataUrl
      ? null
      : await captureObservation(body.capture || body);
    const candidateDataUrl = body.candidateDataUrl || observation?.screenshot?.dataUrl;
    const candidateBuffer = decodeImageDataUrl(candidateDataUrl);

    const referenceDataUrl = body.referenceDataUrl || target?.source?.referenceDataUrl;
    const referenceUrl = body.referenceUrl || target?.source?.referenceImageUrl;
    let referenceBuffer;
    if (referenceDataUrl) referenceBuffer = decodeImageDataUrl(referenceDataUrl);
    else if (referenceUrl) referenceBuffer = await fetchReferenceImage(referenceUrl);
    else return res.status(400).json({ error: 'reference_image_required' });

    const comparison = await compareImages(referenceBuffer, candidateBuffer, Boolean(body.includeDiff));

    if (target) {
      await updateTarget(target.id, {
        status: comparison.similarity >= Number(body.passThreshold || 0.92) ? 'complete' : 'repairing',
        lastObservation: {
          ...(target.lastObservation || {}),
          comparedAt: new Date().toISOString(),
          similarity: comparison.similarity,
          differentPixelRatio: comparison.differentPixelRatio,
          candidateDimensions: comparison.candidate,
          referenceDimensions: comparison.reference
        }
      });
    }

    res.json({
      ok: true,
      targetId: target?.id || null,
      comparison,
      observation: observation ? {
        capturedAt: observation.capturedAt,
        page: observation.page,
        elements: observation.elements,
        debug: observation.debug,
        screenshot: body.includeCandidateImage ? observation.screenshot : { fullPage: observation.screenshot.fullPage }
      } : null
    });
  } catch (error) {
    const status = error.message === 'browser_agent_offline' ? 503 : 500;
    res.status(status).json({ error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`ChatGPT Web Agent listening on http://0.0.0.0:${PORT}`);
});
