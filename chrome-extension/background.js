let socket = null;
let reconnectTimer = null;

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
      socket?.send(JSON.stringify({ requestId, ok: false, error: error.message }));
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

async function runInTab(func, args = []) {
  const tab = await activeTab();
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return result;
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
      return { ok: true };
    }
    case 'tab.reload': {
      const tab = await activeTab();
      await chrome.tabs.reload(tab.id);
      return { ok: true };
    }
    case 'page.read':
      return runInTab((maxLength) => ({
        url: location.href,
        title: document.title,
        text: document.body?.innerText?.slice(0, maxLength) || '',
        html: document.documentElement?.outerHTML?.slice(0, maxLength) || ''
      }), [Math.min(Number(args.maxLength || 50000), 100000)]);
    case 'page.click':
      return runInTab((selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('selector_not_found');
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return { clicked: true };
      }, [args.selector]);
    case 'page.type':
      return runInTab((selector, text, clear) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('selector_not_found');
        if (!('value' in el)) throw new Error('element_not_editable');
        el.focus();
        if (clear) el.value = '';
        el.value += text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true };
      }, [args.selector, String(args.text ?? ''), args.clear !== false]);
    case 'page.scroll':
      return runInTab((x, y) => {
        window.scrollBy(Number(x || 0), Number(y || 0));
        return { x: window.scrollX, y: window.scrollY };
      }, [args.x, args.y]);
    case 'page.screenshot': {
      const tab = await activeTab();
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { dataUrl };
    }
    default:
      throw new Error('action_not_supported');
  }
}

chrome.runtime.onInstalled.addListener(() => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener(() => connect());
connect();
