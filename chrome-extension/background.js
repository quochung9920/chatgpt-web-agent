let socket = null;
let reconnectTimer = null;
let connectionGeneration = 0;

const attachedTabs = new Set();
const debugBuffers = new Map();
const MAX_DEBUG_ITEMS = 300;

async function getConfig() {
  return chrome.storage.local.get({
    serverUrl: 'ws://localhost:8787',
    agentId: 'desktop-chrome',
    agentToken: ''
  });
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
  const base = serverUrl.replace(/\/$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const nextSocket = new WebSocket(`${base}/agent?id=${encodeURIComponent(agentId)}&token=${encodeURIComponent(agentToken)}`);
  socket = nextSocket;

  nextSocket.onmessage = async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const { requestId, action, args = {} } = message;
    try {
      const result = await executeAction(action, args);
      if (nextSocket.readyState === WebSocket.OPEN) nextSocket.send(JSON.stringify({ requestId, ok: true, result }));
    } catch (error) {
      if (nextSocket.readyState === WebSocket.OPEN) nextSocket.send(JSON.stringify({ requestId, ok: false, error: error?.message || String(error) }));
    }
  };

  nextSocket.onclose = () => {
    if (generation !== connectionGeneration) return;
    if (socket === nextSocket) socket = null;
    reconnectTimer = setTimeout(connect, 3000);
  };
  nextSocket.onerror = () => {
    if (generation === connectionGeneration) nextSocket.close();
  };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no_active_tab');
  return tab;
}

async function getTab(tabId) {
  if (tabId) return chrome.tabs.get(Number(tabId));
  return activeTab();
}

async function runInTab(func, args = [], tabId = null) {
  const tab = await getTab(tabId);
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return result;
}

async function waitForDocument(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs || 15000), 500), 30000);
  while (Date.now() < deadline) {
    try {
      const state = await runInTab(() => ({ readyState: document.readyState, href: location.href }), [], tabId);
      if (state?.readyState === 'complete' || state?.readyState === 'interactive') return state;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('page_wait_timeout');
}

function getDebugBuffer(tabId) {
  if (!debugBuffers.has(tabId)) debugBuffers.set(tabId, { console: [], network: [] });
  return debugBuffers.get(tabId);
}

function pushLimited(list, item) {
  list.push(item);
  if (list.length > MAX_DEBUG_ITEMS) list.splice(0, list.length - MAX_DEBUG_ITEMS);
}

async function ensureDebugger(tabId) {
  if (!attachedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  }
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Log.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  getDebugBuffer(tabId);
}

async function sendCdp(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  const buffer = getDebugBuffer(source.tabId);
  if (method === 'Runtime.consoleAPICalled') {
    pushLimited(buffer.console, {
      source: 'console', level: params.type, timestamp: params.timestamp,
      text: (params.args || []).map((item) => item.value ?? item.description ?? item.type).join(' '),
      stackTrace: params.stackTrace || null
    });
  } else if (method === 'Log.entryAdded') {
    pushLimited(buffer.console, {
      source: params.entry?.source || 'log', level: params.entry?.level || 'info', timestamp: params.entry?.timestamp,
      text: params.entry?.text || '', url: params.entry?.url || null, lineNumber: params.entry?.lineNumber || null
    });
  } else if (method === 'Network.requestWillBeSent') {
    pushLimited(buffer.network, {
      type: 'request', requestId: params.requestId, timestamp: params.timestamp,
      method: params.request?.method, url: params.request?.url, resourceType: params.type || null
    });
  } else if (method === 'Network.responseReceived') {
    pushLimited(buffer.network, {
      type: 'response', requestId: params.requestId, timestamp: params.timestamp,
      url: params.response?.url, status: params.response?.status, mimeType: params.response?.mimeType,
      resourceType: params.type || null, fromDiskCache: Boolean(params.response?.fromDiskCache),
      fromServiceWorker: Boolean(params.response?.fromServiceWorker)
    });
  }
});

function validateWebUrl(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('invalid_url');
  return String(url);
}

function modifiersMask(modifiers) {
  const list = Array.isArray(modifiers) ? modifiers.map((v) => String(v).toLowerCase()) : [];
  let mask = 0;
  if (list.includes('alt')) mask |= 1;
  if (list.includes('ctrl') || list.includes('control')) mask |= 2;
  if (list.includes('meta') || list.includes('cmd') || list.includes('command')) mask |= 4;
  if (list.includes('shift')) mask |= 8;
  return mask;
}

async function elementPoint(tabId, selector) {
  return runInTab((css) => {
    const el = document.querySelector(css);
    if (!el) throw new Error('selector_not_found');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('element_has_no_size');
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, [String(selector || '')], tabId);
}

async function resolvePoint(tabId, args, prefix = '') {
  const selector = args[`${prefix}Selector`] || (!prefix ? args.selector : null);
  if (selector) return elementPoint(tabId, selector);
  const x = Number(args[`${prefix}X`] ?? (!prefix ? args.x : NaN));
  const y = Number(args[`${prefix}Y`] ?? (!prefix ? args.y : NaN));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('coordinates_required');
  return { x, y };
}

async function mouseClick(tabId, args, button = 'left', clickCount = 1) {
  const point = await resolvePoint(tabId, args);
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  for (let i = 1; i <= clickCount; i += 1) {
    await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: i });
    await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: i });
  }
  return { clicked: true, button, clickCount, ...point };
}

async function screenshotTab(tabId, { fullPage = false } = {}) {
  await ensureDebugger(tabId);
  const params = { format: 'png', fromSurface: true, captureBeyondViewport: Boolean(fullPage) };
  if (fullPage) {
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    const size = metrics?.cssContentSize || metrics?.contentSize;
    if (size?.width && size?.height) {
      params.clip = { x: 0, y: 0, width: Math.min(size.width, 10000), height: Math.min(size.height, 30000), scale: 1 };
    }
  }
  const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params);
  return { dataUrl: `data:image/png;base64,${result.data}`, fullPage: Boolean(fullPage) };
}

async function executeAction(action, args) {
  switch (action) {
    case 'tabs.list':
      return (await chrome.tabs.query({})).map(({ id, title, url, active, windowId, pinned }) => ({ id, title, url, active, windowId, pinned }));

    case 'tabs.open': {
      const tab = await chrome.tabs.create({ url: validateWebUrl(args.url), active: args.active !== false });
      if (args.wait !== false && tab.id) await waitForDocument(tab.id, args.timeoutMs);
      return { id: tab.id, title: tab.title, url: tab.url, windowId: tab.windowId };
    }

    case 'tabs.switch': {
      const tab = await chrome.tabs.get(Number(args.tabId));
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { id: tab.id, windowId: tab.windowId, active: true };
    }

    case 'tabs.close': {
      const tabId = Number(args.tabId || (await activeTab()).id);
      await chrome.tabs.remove(tabId);
      return { closed: true, tabId };
    }

    case 'tab.active': {
      const { id, title, url, active, windowId } = await activeTab();
      return { id, title, url, active, windowId };
    }

    case 'tab.navigate': {
      const tab = await getTab(args.tabId);
      const url = validateWebUrl(args.url);
      await chrome.tabs.update(tab.id, { url });
      if (args.wait !== false) await waitForDocument(tab.id, args.timeoutMs);
      return { ok: true, tabId: tab.id, url };
    }

    case 'tab.reload': {
      const tab = await getTab(args.tabId);
      await chrome.tabs.reload(tab.id, { bypassCache: Boolean(args.bypassCache) });
      if (args.wait !== false) await waitForDocument(tab.id, args.timeoutMs);
      return { ok: true, tabId: tab.id };
    }

    case 'tab.back': {
      const tab = await getTab(args.tabId);
      await chrome.tabs.goBack(tab.id);
      if (args.wait !== false) await waitForDocument(tab.id, args.timeoutMs);
      return { ok: true, tabId: tab.id };
    }

    case 'tab.forward': {
      const tab = await getTab(args.tabId);
      await chrome.tabs.goForward(tab.id);
      if (args.wait !== false) await waitForDocument(tab.id, args.timeoutMs);
      return { ok: true, tabId: tab.id };
    }

    case 'page.wait': {
      const tab = await getTab(args.tabId);
      return waitForDocument(tab.id, args.timeoutMs);
    }

    case 'page.read':
      return runInTab((maxLength, interactiveLimit) => {
        const interactive = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          })
          .slice(0, interactiveLimit)
          .map((el, index) => {
            const r = el.getBoundingClientRect();
            return {
              index,
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role'),
              type: el.getAttribute('type'),
              name: el.getAttribute('aria-label') || el.getAttribute('name') || null,
              text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 240),
              id: el.id || null,
              className: typeof el.className === 'string' ? el.className : null,
              rect: { x: r.x, y: r.y, width: r.width, height: r.height }
            };
          });
        return {
          url: location.href,
          title: document.title,
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY },
          document: { width: document.documentElement?.scrollWidth || 0, height: document.documentElement?.scrollHeight || 0 },
          text: document.body?.innerText?.slice(0, maxLength) || '',
          html: document.documentElement?.outerHTML?.slice(0, maxLength) || '',
          interactive
        };
      }, [Math.min(Number(args.maxLength || 30000), 100000), Math.min(Math.max(Number(args.interactiveLimit || 80), 1), 200)], args.tabId);

    case 'page.inspect': {
      const properties = Array.isArray(args.properties) && args.properties.length ? args.properties.slice(0, 80).map(String) : [
        'display','position','box-sizing','width','height','min-width','max-width','margin-top','margin-right','margin-bottom','margin-left',
        'padding-top','padding-right','padding-bottom','padding-left','gap','row-gap','column-gap','align-items','justify-content','flex-direction',
        'grid-template-columns','grid-template-rows','overflow','font-family','font-size','font-weight','line-height','letter-spacing','text-align',
        'color','background-color','background-image','border-radius','border-width','border-color','opacity','transform','z-index','cursor'
      ];
      return runInTab((selector, requestedProperties) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('selector_not_found');
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const computed = {};
        for (const property of requestedProperties) computed[property] = style.getPropertyValue(property);
        const attributes = {};
        for (const attr of el.attributes || []) attributes[attr.name] = attr.value;
        return {
          selector, tagName: el.tagName?.toLowerCase(), id: el.id || null,
          className: typeof el.className === 'string' ? el.className : null,
          text: (el.innerText || el.textContent || '').trim().slice(0, 5000), attributes,
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          rect: { x: rect.x, y: rect.y, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, pageX: rect.left + scrollX, pageY: rect.top + scrollY },
          computed
        };
      }, [String(args.selector || ''), properties], args.tabId);
    }

    case 'page.elements':
      return runInTab((selector, limit) => Array.from(document.querySelectorAll(selector)).slice(0, limit).map((el, index) => {
        const rect = el.getBoundingClientRect();
        return { index, tagName: el.tagName?.toLowerCase(), id: el.id || null, className: typeof el.className === 'string' ? el.className : null, text: (el.innerText || el.textContent || '').trim().slice(0, 500), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      }), [String(args.selector || '*'), Math.min(Math.max(Number(args.limit || 20), 1), 100)], args.tabId);

    case 'page.elementAt':
      return runInTab((x, y) => {
        const el = document.elementFromPoint(Number(x), Number(y));
        if (!el) throw new Error('element_not_found');
        const rect = el.getBoundingClientRect();
        const attrs = {};
        for (const attr of el.attributes || []) attrs[attr.name] = attr.value;
        return { tagName: el.tagName.toLowerCase(), id: el.id || null, className: typeof el.className === 'string' ? el.className : null, text: (el.innerText || el.textContent || '').trim().slice(0, 1000), attributes: attrs, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      }, [args.x, args.y], args.tabId);

    case 'page.accessibility': {
      const tab = await getTab(args.tabId);
      await sendCdp(tab.id, 'Accessibility.enable');
      const tree = await sendCdp(tab.id, 'Accessibility.getFullAXTree', {});
      const limit = Math.min(Math.max(Number(args.limit || 300), 1), 1000);
      return (tree.nodes || []).filter((node) => !node.ignored).slice(0, limit).map((node) => ({
        nodeId: node.nodeId,
        parentId: node.parentId || null,
        childIds: node.childIds || [],
        role: node.role?.value || null,
        name: node.name?.value || null,
        value: node.value?.value ?? null,
        description: node.description?.value || null,
        backendDOMNodeId: node.backendDOMNodeId || null
      }));
    }

    case 'page.click': {
      const tab = await getTab(args.tabId);
      return mouseClick(tab.id, args, 'left', 1);
    }

    case 'page.doubleClick': {
      const tab = await getTab(args.tabId);
      return mouseClick(tab.id, args, 'left', 2);
    }

    case 'page.rightClick': {
      const tab = await getTab(args.tabId);
      return mouseClick(tab.id, args, 'right', 1);
    }

    case 'page.hover': {
      const tab = await getTab(args.tabId);
      const point = await resolvePoint(tab.id, args);
      await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
      return { hovered: true, ...point };
    }

    case 'page.type': {
      const tab = await getTab(args.tabId);
      if (args.selector) await mouseClick(tab.id, { selector: args.selector }, 'left', 1);
      if (args.clear !== false) {
        await sendCdp(tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
        await sendCdp(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
        await sendCdp(tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
        await sendCdp(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
      }
      await sendCdp(tab.id, 'Input.insertText', { text: String(args.text ?? '') });
      return { typed: true, length: String(args.text ?? '').length };
    }

    case 'page.key': {
      const tab = await getTab(args.tabId);
      const key = String(args.key || '');
      if (!key) throw new Error('key_required');
      const code = String(args.code || key);
      const modifiers = modifiersMask(args.modifiers);
      await sendCdp(tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, text: args.text ? String(args.text) : undefined });
      await sendCdp(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
      return { pressed: true, key, code, modifiers };
    }

    case 'page.scroll':
      return runInTab((x, y, absolute) => {
        if (absolute) scrollTo(Number(x || 0), Number(y || 0));
        else scrollBy(Number(x || 0), Number(y || 0));
        return { x: scrollX, y: scrollY };
      }, [args.x, args.y, Boolean(args.absolute)], args.tabId);

    case 'page.drag': {
      const tab = await getTab(args.tabId);
      const from = await resolvePoint(tab.id, args, 'from');
      const to = await resolvePoint(tab.id, args, 'to');
      const steps = Math.min(Math.max(Number(args.steps || 12), 2), 60);
      await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
      await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, button: 'left', buttons: 1 });
      }
      await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      return { dragged: true, from, to, steps };
    }

    case 'page.upload': {
      const dataUrl = String(args.dataUrl || '');
      if (dataUrl.length > 20 * 1024 * 1024) throw new Error('upload_too_large');
      return runInTab((selector, source, filename, mimeType) => {
        const input = document.querySelector(selector);
        if (!(input instanceof HTMLInputElement) || input.type !== 'file') throw new Error('file_input_not_found');
        const match = source.match(/^data:([^;,]+)?;base64,(.+)$/s);
        if (!match) throw new Error('invalid_data_url');
        const binary = atob(match[2]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], filename || 'upload.bin', { type: mimeType || match[1] || 'application/octet-stream' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { uploaded: true, name: file.name, size: file.size, type: file.type };
      }, [String(args.selector || 'input[type=file]'), dataUrl, String(args.filename || 'upload.bin'), String(args.mimeType || '')], args.tabId);
    }

    case 'page.viewport.get':
      return runInTab(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height }), [], args.tabId);

    case 'page.viewport.set': {
      const tab = await getTab(args.tabId);
      const width = Math.min(Math.max(Number(args.width || 390), 240), 3840);
      const height = Math.min(Math.max(Number(args.height || 844), 320), 2160);
      const deviceScaleFactor = Math.min(Math.max(Number(args.deviceScaleFactor || 1), 0.5), 4);
      const mobile = Boolean(args.mobile);
      await sendCdp(tab.id, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile, screenWidth: width, screenHeight: height, dontSetVisibleSize: false });
      await sendCdp(tab.id, 'Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
      return { width, height, deviceScaleFactor, mobile };
    }

    case 'page.viewport.clear': {
      const tab = await getTab(args.tabId);
      await sendCdp(tab.id, 'Emulation.clearDeviceMetricsOverride');
      await sendCdp(tab.id, 'Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
      return { cleared: true };
    }

    case 'page.screenshot': {
      const tab = await getTab(args.tabId);
      return screenshotTab(tab.id, { fullPage: Boolean(args.fullPage) });
    }

    case 'page.elementScreenshot': {
      const tab = await getTab(args.tabId);
      const rect = await runInTab((selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('selector_not_found');
        const box = el.getBoundingClientRect();
        return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height };
      }, [String(args.selector || '')], tab.id);
      if (!rect.width || !rect.height) throw new Error('element_has_no_size');
      const capture = await sendCdp(tab.id, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { ...rect, scale: 1 } });
      return { dataUrl: `data:image/png;base64,${capture.data}`, rect };
    }

    case 'debug.start': {
      const tab = await getTab(args.tabId);
      await ensureDebugger(tab.id);
      if (args.clear !== false) debugBuffers.set(tab.id, { console: [], network: [] });
      return { started: true, tabId: tab.id };
    }

    case 'debug.logs': {
      const tab = await getTab(args.tabId);
      const buffer = getDebugBuffer(tab.id);
      if (!args.errorsOnly) return { console: buffer.console, network: buffer.network };
      return {
        console: buffer.console.filter((item) => ['error', 'warning', 'warn'].includes(String(item.level).toLowerCase())),
        network: buffer.network.filter((item) => item.type === 'response' && Number(item.status || 0) >= 400)
      };
    }

    case 'debug.clear': {
      const tab = await getTab(args.tabId);
      debugBuffers.set(tab.id, { console: [], network: [] });
      return { cleared: true };
    }

    case 'debug.stop': {
      const tab = await getTab(args.tabId);
      if (attachedTabs.has(tab.id)) {
        try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
        attachedTabs.delete(tab.id);
      }
      return { stopped: true };
    }

    default:
      throw new Error('action_not_supported');
  }
}

chrome.runtime.onInstalled.addListener(() => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener(() => connect());
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  debugBuffers.delete(tabId);
});
connect();
