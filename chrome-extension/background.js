import { executeAgentTool, isAgentTool } from './agent-tools.js';
import { assertTabInAgentGroup, getPreferredAgentTab } from './tab-group-session.js';

let socket = null;
let reconnectTimer = null;
let connectionGeneration = 0;
let installed = false;

const attachedTabs = new Set();
const debugBuffers = new Map();
const MAX_DEBUG_ITEMS = 300;
const REMOTE_EXTRA_TOOLS = new Set([
  'page.elementScreenshot',
  'debug.start',
  'debug.logs',
  'debug.clear',
  'debug.stop'
]);

async function getConfig() {
  return chrome.storage.local.get({
    serverUrl: 'ws://localhost:8787',
    agentId: 'desktop-chrome',
    agentToken: ''
  });
}

function getDebugBuffer(tabId) {
  if (!debugBuffers.has(tabId)) debugBuffers.set(tabId, { console: [], network: [] });
  return debugBuffers.get(tabId);
}

function pushLimited(list, item) {
  list.push(item);
  if (list.length > MAX_DEBUG_ITEMS) list.splice(0, list.length - MAX_DEBUG_ITEMS);
}

async function groupedTabId(tabId = null) {
  if (tabId != null) {
    const tab = await assertTabInAgentGroup(Number(tabId));
    return tab.id;
  }
  return (await getPreferredAgentTab()).id;
}

async function ensureDebugger(tabId) {
  const id = await groupedTabId(tabId);
  if (!attachedTabs.has(id)) {
    try {
      await chrome.debugger.attach({ tabId: id }, '1.3');
    } catch (error) {
      const text = String(error?.message || error || '');
      if (!/already attached|another debugger/i.test(text)) throw error;
    }
    attachedTabs.add(id);
  }
  await chrome.debugger.sendCommand({ tabId: id }, 'Runtime.enable').catch(() => {});
  await chrome.debugger.sendCommand({ tabId: id }, 'Network.enable').catch(() => {});
  await chrome.debugger.sendCommand({ tabId: id }, 'Log.enable').catch(() => {});
  await chrome.debugger.sendCommand({ tabId: id }, 'Page.enable').catch(() => {});
  getDebugBuffer(id);
  return id;
}

async function executeRemoteExtra(action, args = {}) {
  const tabId = await groupedTabId(args.tabId);

  switch (action) {
    case 'page.elementScreenshot': {
      const selector = String(args.selector || '');
      if (!selector) throw new Error('selector_required');
      const [{ result: rect }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (css) => {
          const el = document.querySelector(css);
          if (!el) throw new Error('selector_not_found');
          const box = el.getBoundingClientRect();
          if (!box.width || !box.height) throw new Error('element_has_no_size');
          return {
            x: box.left + scrollX,
            y: box.top + scrollY,
            width: box.width,
            height: box.height
          };
        },
        args: [selector]
      });
      const id = await ensureDebugger(tabId);
      const capture = await chrome.debugger.sendCommand({ tabId: id }, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { ...rect, scale: 1 }
      });
      return { dataUrl: `data:image/png;base64,${capture.data}`, rect };
    }

    case 'debug.start': {
      const id = await ensureDebugger(tabId);
      if (args.clear !== false) debugBuffers.set(id, { console: [], network: [] });
      return { started: true, tabId: id };
    }

    case 'debug.logs': {
      await assertTabInAgentGroup(tabId);
      const buffer = getDebugBuffer(tabId);
      if (!args.errorsOnly) return { console: buffer.console, network: buffer.network };
      return {
        console: buffer.console.filter((item) => ['error', 'warning', 'warn'].includes(String(item.level).toLowerCase())),
        network: buffer.network.filter((item) => item.type === 'response' && Number(item.status || 0) >= 400)
      };
    }

    case 'debug.clear':
      await assertTabInAgentGroup(tabId);
      debugBuffers.set(tabId, { console: [], network: [] });
      return { cleared: true };

    case 'debug.stop':
      await assertTabInAgentGroup(tabId);
      if (attachedTabs.has(tabId)) {
        try { await chrome.debugger.detach({ tabId }); } catch {}
        attachedTabs.delete(tabId);
      }
      return { stopped: true, tabId };

    default:
      throw new Error('remote_extra_tool_not_supported');
  }
}

async function executeRemoteAction(action, args = {}) {
  const name = String(action || '');
  if (isAgentTool(name)) return executeAgentTool(name, args);
  if (REMOTE_EXTRA_TOOLS.has(name)) return executeRemoteExtra(name, args);
  throw new Error('action_not_supported');
}

async function connect() {
  const generation = ++connectionGeneration;
  clearTimeout(reconnectTimer);

  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    try { socket.close(); } catch {}
    socket = null;
  }

  const { serverUrl, agentId, agentToken } = await getConfig();
  if (!agentToken || generation !== connectionGeneration) return;

  const base = String(serverUrl || 'ws://localhost:8787')
    .replace(/\/$/, '')
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:');

  const nextSocket = new WebSocket(`${base}/agent?id=${encodeURIComponent(agentId)}&token=${encodeURIComponent(agentToken)}`);
  socket = nextSocket;

  nextSocket.onmessage = async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const { requestId, action, args = {} } = message || {};
    try {
      const result = await executeRemoteAction(action, args);
      if (nextSocket.readyState === WebSocket.OPEN) nextSocket.send(JSON.stringify({ requestId, ok: true, result }));
    } catch (error) {
      if (nextSocket.readyState === WebSocket.OPEN) {
        nextSocket.send(JSON.stringify({ requestId, ok: false, error: error?.message || String(error) }));
      }
    }
  };

  nextSocket.onclose = () => {
    if (generation !== connectionGeneration) return;
    if (socket === nextSocket) socket = null;
    reconnectTimer = setTimeout(() => connect().catch(() => {}), 3000);
  };

  nextSocket.onerror = () => {
    if (generation === connectionGeneration) nextSocket.close();
  };
}

function handleDebuggerDetach(source) {
  if (source.tabId) attachedTabs.delete(source.tabId);
}

function handleDebuggerEvent(source, method, params) {
  if (!source.tabId || !attachedTabs.has(source.tabId)) return;
  const buffer = getDebugBuffer(source.tabId);

  if (method === 'Runtime.consoleAPICalled') {
    pushLimited(buffer.console, {
      source: 'console',
      level: params.type,
      timestamp: params.timestamp,
      text: (params.args || []).map((item) => item.value ?? item.description ?? item.type).join(' '),
      stackTrace: params.stackTrace || null
    });
  } else if (method === 'Log.entryAdded') {
    pushLimited(buffer.console, {
      source: params.entry?.source || 'log',
      level: params.entry?.level || 'info',
      timestamp: params.entry?.timestamp,
      text: params.entry?.text || '',
      url: params.entry?.url || null,
      lineNumber: params.entry?.lineNumber || null
    });
  } else if (method === 'Network.requestWillBeSent') {
    pushLimited(buffer.network, {
      type: 'request',
      requestId: params.requestId,
      timestamp: params.timestamp,
      method: params.request?.method,
      url: params.request?.url,
      resourceType: params.type || null
    });
  } else if (method === 'Network.responseReceived') {
    pushLimited(buffer.network, {
      type: 'response',
      requestId: params.requestId,
      timestamp: params.timestamp,
      url: params.response?.url,
      status: params.response?.status,
      mimeType: params.response?.mimeType,
      resourceType: params.type || null,
      fromDiskCache: Boolean(params.response?.fromDiskCache),
      fromServiceWorker: Boolean(params.response?.fromServiceWorker)
    });
  }
}

function handleStorageChanged(changes) {
  if (changes.serverUrl || changes.agentId || changes.agentToken) connect().catch(() => {});
}

function handleTabRemoved(tabId) {
  attachedTabs.delete(tabId);
  debugBuffers.delete(tabId);
}

export function installRemoteBackground() {
  if (installed) return;
  installed = true;

  chrome.debugger.onDetach.addListener(handleDebuggerDetach);
  chrome.debugger.onEvent.addListener(handleDebuggerEvent);
  chrome.storage.onChanged.addListener(handleStorageChanged);
  chrome.tabs.onRemoved.addListener(handleTabRemoved);

  connect().catch((error) => {
    console.error('Remote background connect failed:', error);
  });
}
