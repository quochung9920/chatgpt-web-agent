let socket = null;
let reconnectTimer = null;

const attachedTabs = new Set();
const debugBuffers = new Map();
const MAX_DEBUG_ITEMS = 250;

async function getConfig() {
  return chrome.storage.local.get({
    serverUrl: 'ws://localhost:8787',
    agentId: 'desktop-chrome',
    agentToken: ''
  });
}

async function connect() {
  clearTimeout(reconnectTimer);
  const { serverUrl, agentId, agentToken } = await getConfig();
  if (!agentToken) return;

  try {
    socket?.close();
  } catch {}

  const base = serverUrl.replace(/\/$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  socket = new WebSocket(`${base}/agent?id=${encodeURIComponent(agentId)}&token=${encodeURIComponent(agentToken)}`);

  socket.onmessage = async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const { requestId, action, args = {} } = message;
    try {
      const result = await executeAction(action, args);
      socket?.send(JSON.stringify({ requestId, ok: true, result }));
    } catch (error) {
      socket?.send(JSON.stringify({ requestId, ok: false, error: error?.message || String(error) }));
    }
  };

  socket.onclose = () => {
    reconnectTimer = setTimeout(connect, 3000);
  };

  socket.onerror = () => socket?.close();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no_active_tab');
  return tab;
}

async function runInTab(func, args = [], tabId = null) {
  const targetTabId = tabId || (await activeTab()).id;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func,
    args
  });
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
      source: 'console',
      level: params.type,
      timestamp: params.timestamp,
      text: (params.args || []).map((item) => item.value ?? item.description ?? item.type).join(' '),
      stackTrace: params.stackTrace || null
    });
    return;
  }

  if (method === 'Log.entryAdded') {
    pushLimited(buffer.console, {
      source: params.entry?.source || 'log',
      level: params.entry?.level || 'info',
      timestamp: params.entry?.timestamp,
      text: params.entry?.text || '',
      url: params.entry?.url || null,
      lineNumber: params.entry?.lineNumber || null
    });
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    pushLimited(buffer.network, {
      type: 'request',
      requestId: params.requestId,
      timestamp: params.timestamp,
      method: params.request?.method,
      url: params.request?.url,
      resourceType: params.type || null
    });
    return;
  }

  if (method === 'Network.responseReceived') {
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
});

async function screenshotTab(tabId, { fullPage = false } = {}) {
  await ensureDebugger(tabId);

  const params = {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: Boolean(fullPage)
  };

  if (fullPage) {
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    const size = metrics?.cssContentSize || metrics?.contentSize;
    if (size?.width && size?.height) {
      params.clip = {
        x: 0,
        y: 0,
        width: Math.min(size.width, 10000),
        height: Math.min(size.height, 30000),
        scale: 1
      };
    }
  }

  const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params);
  return { dataUrl: `data:image/png;base64,${result.data}`, fullPage: Boolean(fullPage) };
}

async function executeAction(action, args) {
  switch (action) {
    case 'tabs.list':
      return (await chrome.tabs.query({})).map(({ id, title, url, active, windowId }) => ({ id, title, url, active, windowId }));

    case 'tab.active': {
      const { id, title, url, active, windowId } = await activeTab();
      return { id, title, url, active, windowId };
    }

    case 'tab.navigate': {
      const tab = await activeTab();
      if (!/^https?:\/\//i.test(args.url || '')) throw new Error('invalid_url');
      await chrome.tabs.update(tab.id, { url: args.url });
      if (args.wait !== false) await waitForDocument(tab.id, args.timeoutMs);
      return { ok: true, url: args.url };
    }

    case 'tab.reload': {
      const tab = await activeTab();
      await chrome.tabs.reload(tab.id);
      if (args.wait !== false) await waitForDocument(tab.id, args.timeoutMs);
      return { ok: true };
    }

    case 'page.wait': {
      const tab = await activeTab();
      return waitForDocument(tab.id, args.timeoutMs);
    }

    case 'page.read':
      return runInTab((maxLength) => ({
        url: location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          scrollX: window.scrollX,
          scrollY: window.scrollY
        },
        document: {
          width: document.documentElement?.scrollWidth || 0,
          height: document.documentElement?.scrollHeight || 0
        },
        text: document.body?.innerText?.slice(0, maxLength) || '',
        html: document.documentElement?.outerHTML?.slice(0, maxLength) || ''
      }), [Math.min(Number(args.maxLength || 50000), 100000)]);

    case 'page.inspect': {
      const properties = Array.isArray(args.properties) && args.properties.length
        ? args.properties.slice(0, 80).map(String)
        : [
            'display', 'position', 'box-sizing', 'width', 'height', 'min-width', 'max-width',
            'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
            'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
            'gap', 'row-gap', 'column-gap', 'align-items', 'justify-content', 'flex-direction',
            'grid-template-columns', 'grid-template-rows', 'overflow',
            'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
            'color', 'background-color', 'background-image', 'border-radius', 'border-width',
            'border-color', 'opacity', 'transform'
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
          selector,
          tagName: el.tagName?.toLowerCase(),
          id: el.id || null,
          className: typeof el.className === 'string' ? el.className : null,
          text: (el.innerText || el.textContent || '').trim().slice(0, 5000),
          attributes,
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          rect: {
            x: rect.x,
            y: rect.y,
            top: rect.top,
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            pageX: rect.left + window.scrollX,
            pageY: rect.top + window.scrollY
          },
          computed
        };
      }, [String(args.selector || ''), properties]);
    }

    case 'page.elements':
      return runInTab((selector, limit) => Array.from(document.querySelectorAll(selector)).slice(0, limit).map((el, index) => {
        const rect = el.getBoundingClientRect();
        return {
          index,
          tagName: el.tagName?.toLowerCase(),
          id: el.id || null,
          className: typeof el.className === 'string' ? el.className : null,
          text: (el.innerText || el.textContent || '').trim().slice(0, 500),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      }), [String(args.selector || '*'), Math.min(Math.max(Number(args.limit || 20), 1), 50)]);

    case 'page.click':
      return runInTab((selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('selector_not_found');
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return { clicked: true };
      }, [String(args.selector || '')]);

    case 'page.type':
      return runInTab((selector, text, clear) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('selector_not_found');
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();

        if (el.isContentEditable) {
          if (clear) el.textContent = '';
          el.textContent = `${clear ? '' : el.textContent || ''}${text}`;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        } else if ('value' in el) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
          const next = `${clear ? '' : el.value || ''}${text}`;
          if (setter) setter.call(el, next);
          else el.value = next;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          throw new Error('element_not_editable');
        }

        return { typed: true };
      }, [String(args.selector || ''), String(args.text ?? ''), args.clear !== false]);

    case 'page.scroll':
      return runInTab((x, y, absolute) => {
        if (absolute) window.scrollTo(Number(x || 0), Number(y || 0));
        else window.scrollBy(Number(x || 0), Number(y || 0));
        return { x: window.scrollX, y: window.scrollY };
      }, [args.x, args.y, Boolean(args.absolute)]);

    case 'page.viewport.get':
      return runInTab(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height
      }));

    case 'page.viewport.set': {
      const tab = await activeTab();
      const width = Math.min(Math.max(Number(args.width || 390), 240), 3840);
      const height = Math.min(Math.max(Number(args.height || 844), 320), 2160);
      const deviceScaleFactor = Math.min(Math.max(Number(args.deviceScaleFactor || 1), 0.5), 4);
      const mobile = Boolean(args.mobile);
      await sendCdp(tab.id, 'Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile,
        screenWidth: width,
        screenHeight: height,
        dontSetVisibleSize: false
      });
      await sendCdp(tab.id, 'Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
      return { width, height, deviceScaleFactor, mobile };
    }

    case 'page.viewport.clear': {
      const tab = await activeTab();
      await sendCdp(tab.id, 'Emulation.clearDeviceMetricsOverride');
      await sendCdp(tab.id, 'Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
      return { cleared: true };
    }

    case 'page.screenshot': {
      const tab = await activeTab();
      return screenshotTab(tab.id, { fullPage: Boolean(args.fullPage) });
    }

    case 'page.elementScreenshot': {
      const tab = await activeTab();
      const rect = await runInTab((selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('selector_not_found');
        const box = el.getBoundingClientRect();
        return {
          x: box.left + window.scrollX,
          y: box.top + window.scrollY,
          width: box.width,
          height: box.height
        };
      }, [String(args.selector || '')], tab.id);

      if (!rect.width || !rect.height) throw new Error('element_has_no_size');
      await ensureDebugger(tab.id);
      const capture = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: Math.max(0, rect.x),
          y: Math.max(0, rect.y),
          width: Math.min(rect.width, 10000),
          height: Math.min(rect.height, 10000),
          scale: 1
        }
      });
      return { dataUrl: `data:image/png;base64,${capture.data}`, rect };
    }

    case 'debug.start': {
      const tab = await activeTab();
      await ensureDebugger(tab.id);
      if (args.clear !== false) debugBuffers.set(tab.id, { console: [], network: [] });
      return { started: true, tabId: tab.id };
    }

    case 'debug.logs': {
      const tab = await activeTab();
      await ensureDebugger(tab.id);
      const buffer = getDebugBuffer(tab.id);
      const errorsOnly = Boolean(args.errorsOnly);
      return {
        console: errorsOnly
          ? buffer.console.filter((item) => ['error', 'warning', 'warn'].includes(item.level))
          : buffer.console,
        network: errorsOnly
          ? buffer.network.filter((item) => item.type === 'response' && Number(item.status || 0) >= 400)
          : buffer.network
      };
    }

    case 'debug.clear': {
      const tab = await activeTab();
      debugBuffers.set(tab.id, { console: [], network: [] });
      return { cleared: true };
    }

    case 'debug.stop': {
      const tab = await activeTab();
      if (attachedTabs.has(tab.id)) {
        await chrome.debugger.detach({ tabId: tab.id });
        attachedTabs.delete(tab.id);
      }
      return { stopped: true, tabId: tab.id };
    }

    default:
      throw new Error('action_not_supported');
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  debugBuffers.delete(tabId);
});

chrome.runtime.onInstalled.addListener(() => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener(() => connect());
connect();
