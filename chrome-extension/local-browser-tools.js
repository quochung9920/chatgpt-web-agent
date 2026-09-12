const debuggerTabs = new Set();

function isWebUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function summarizeTab(tab) {
  return {
    id: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    active: Boolean(tab.active),
    windowId: tab.windowId,
    pinned: Boolean(tab.pinned)
  };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no_active_tab');
  return tab;
}

async function getTab(tabId) {
  if (tabId !== undefined && tabId !== null) return chrome.tabs.get(Number(tabId));
  return activeTab();
}

async function runInTab(tabId, func, args = []) {
  const tab = await getTab(tabId);
  if (!isWebUrl(tab.url)) throw new Error('tab_not_scriptable');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func,
    args
  });
  return result;
}

async function waitForDocument(tabId, timeoutMs = 20000) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs || 20000), 500), 45000);
  while (Date.now() < deadline) {
    try {
      const state = await runInTab(tabId, () => ({ readyState: document.readyState, href: location.href }));
      if (state?.readyState === 'interactive' || state?.readyState === 'complete') return state;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('page_wait_timeout');
}

async function ensureDebugger(tabId) {
  const id = Number(tabId);
  if (!debuggerTabs.has(id)) {
    try {
      await chrome.debugger.attach({ tabId: id }, '1.3');
    } catch (error) {
      const message = String(error?.message || error || '');
      if (!/already attached|Another debugger/i.test(message)) throw error;
    }
    debuggerTabs.add(id);
  }
  return id;
}

async function sendCdp(tabId, method, params = {}) {
  const id = await ensureDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId: id }, method, params);
}

async function selectorPoint(tabId, selector) {
  return runInTab(tabId, (css) => {
    const el = document.querySelector(css);
    if (!el) throw new Error('selector_not_found');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('element_has_no_size');
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, [String(selector || '')]);
}

async function resolvePoint(tabId, args = {}, prefix = '') {
  const selectorKey = prefix ? `${prefix}Selector` : 'selector';
  const xKey = prefix ? `${prefix}X` : 'x';
  const yKey = prefix ? `${prefix}Y` : 'y';
  if (args[selectorKey]) return selectorPoint(tabId, args[selectorKey]);
  const x = Number(args[xKey]);
  const y = Number(args[yKey]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('coordinates_required');
  return { x, y };
}

async function mouseClick(tabId, args = {}, button = 'left', clickCount = 1) {
  const point = await resolvePoint(tabId, args);
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount });
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount });
  return { clicked: true, button, clickCount, ...point };
}

async function screenshot(tabId, fullPage = false) {
  const id = await ensureDebugger(tabId);
  await chrome.debugger.sendCommand({ tabId: id }, 'Page.enable');
  const params = { format: 'png', fromSurface: true, captureBeyondViewport: Boolean(fullPage) };
  if (fullPage) {
    const metrics = await chrome.debugger.sendCommand({ tabId: id }, 'Page.getLayoutMetrics');
    const size = metrics?.cssContentSize || metrics?.contentSize;
    if (size?.width && size?.height) {
      params.clip = {
        x: 0,
        y: 0,
        width: Math.min(Number(size.width), 10000),
        height: Math.min(Number(size.height), 30000),
        scale: 1
      };
    }
  }
  const result = await chrome.debugger.sendCommand({ tabId: id }, 'Page.captureScreenshot', params);
  return { dataUrl: `data:image/png;base64,${result.data}`, fullPage: Boolean(fullPage) };
}

export const LOCAL_AGENT_TOOLS = [
  'tabs.list', 'tabs.open', 'tabs.switch', 'tabs.close',
  'tab.active', 'tab.navigate', 'tab.reload', 'tab.back', 'tab.forward',
  'page.wait', 'page.read', 'page.accessibility', 'page.inspect', 'page.elements', 'page.elementAt',
  'page.click', 'page.doubleClick', 'page.rightClick', 'page.hover', 'page.type', 'page.key', 'page.scroll', 'page.drag',
  'page.viewport.get', 'page.viewport.set', 'page.viewport.clear', 'page.screenshot'
];

export function isLocalAgentTool(tool) {
  return LOCAL_AGENT_TOOLS.includes(String(tool || ''));
}

export async function executeLocalBrowserTool(tool, args = {}) {
  switch (tool) {
    case 'tabs.list':
      return (await chrome.tabs.query({})).map(summarizeTab);

    case 'tabs.open': {
      if (!isWebUrl(args.url)) throw new Error('invalid_url');
      const tab = await chrome.tabs.create({ url: String(args.url), active: args.active !== false });
      if (args.wait !== false && tab.id) await waitForDocument(tab.id, args.timeoutMs);
      return summarizeTab(await chrome.tabs.get(tab.id));
    }

    case 'tabs.switch': {
      const tab = await chrome.tabs.get(Number(args.tabId));
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return summarizeTab(await chrome.tabs.get(tab.id));
    }

    case 'tabs.close': {
      const tab = await getTab(args.tabId);
      await chrome.tabs.remove(tab.id);
      return { closed: true, tabId: tab.id };
    }

    case 'tab.active':
      return summarizeTab(await activeTab());

    case 'tab.navigate': {
      const tab = await getTab(args.tabId);
      if (!isWebUrl(args.url)) throw new Error('invalid_url');
      await chrome.tabs.update(tab.id, { url: String(args.url) });
      if (args.wait !== false) await waitForDocument(tab.id, args.timeoutMs);
      return summarizeTab(await chrome.tabs.get(tab.id));
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
      return runInTab(args.tabId, (maxLength, interactiveLimit) => {
        const interactive = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'))
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          })
          .slice(0, interactiveLimit)
          .map((el, index) => {
            const rect = el.getBoundingClientRect();
            return {
              index,
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role'),
              type: el.getAttribute('type'),
              name: el.getAttribute('aria-label') || el.getAttribute('name') || null,
              text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 240),
              id: el.id || null,
              className: typeof el.className === 'string' ? el.className : null,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            };
          });
        return {
          url: location.href,
          title: document.title,
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY },
          document: { width: document.documentElement?.scrollWidth || 0, height: document.documentElement?.scrollHeight || 0 },
          text: document.body?.innerText?.slice(0, maxLength) || '',
          interactive
        };
      }, [Math.min(Number(args.maxLength || 20000), 60000), Math.min(Math.max(Number(args.interactiveLimit || 80), 1), 160)]);

    case 'page.accessibility':
      return runInTab(args.tabId, (limit) => Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[aria-label],[contenteditable="true"]'))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        })
        .slice(0, limit)
        .map((el, index) => {
          const rect = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || ({ a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox' }[tag] || tag);
          return {
            index,
            role,
            name: el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('name') || (el.innerText || el.value || el.textContent || '').trim().slice(0, 160),
            disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        }), [Math.min(Math.max(Number(args.limit || 120), 1), 250)]);

    case 'page.inspect':
      return runInTab(args.tabId, (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('selector_not_found');
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const attributes = {};
        for (const attr of el.attributes || []) attributes[attr.name] = attr.value;
        return {
          tagName: el.tagName.toLowerCase(),
          id: el.id || null,
          className: typeof el.className === 'string' ? el.className : null,
          text: (el.innerText || el.textContent || '').trim().slice(0, 3000),
          attributes,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
          computed: {
            display: style.display,
            position: style.position,
            width: style.width,
            height: style.height,
            color: style.color,
            backgroundColor: style.backgroundColor,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            padding: style.padding,
            margin: style.margin,
            gap: style.gap,
            borderRadius: style.borderRadius,
            opacity: style.opacity
          }
        };
      }, [String(args.selector || '')]);

    case 'page.elements':
      return runInTab(args.tabId, (selector, limit) => Array.from(document.querySelectorAll(selector)).slice(0, limit).map((el, index) => {
        const rect = el.getBoundingClientRect();
        return {
          index,
          tagName: el.tagName.toLowerCase(),
          id: el.id || null,
          className: typeof el.className === 'string' ? el.className : null,
          text: (el.innerText || el.textContent || '').trim().slice(0, 500),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      }), [String(args.selector || '*'), Math.min(Math.max(Number(args.limit || 30), 1), 100)]);

    case 'page.elementAt':
      return runInTab(args.tabId, (x, y) => {
        const el = document.elementFromPoint(Number(x), Number(y));
        if (!el) throw new Error('element_not_found');
        const rect = el.getBoundingClientRect();
        return {
          tagName: el.tagName.toLowerCase(),
          id: el.id || null,
          className: typeof el.className === 'string' ? el.className : null,
          text: (el.innerText || el.textContent || '').trim().slice(0, 500),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      }, [Number(args.x), Number(args.y)]);

    case 'page.click': {
      const tab = await getTab(args.tabId);
      if (args.selector) {
        return runInTab(tab.id, (selector) => {
          const el = document.querySelector(selector);
          if (!el) throw new Error('selector_not_found');
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.click();
          return { clicked: true, selector };
        }, [String(args.selector)]);
      }
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

    case 'page.type':
      return runInTab(args.tabId, (selector, text, clear) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('selector_not_found');
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        if (el.isContentEditable) {
          if (clear) el.textContent = '';
          el.textContent = `${clear ? '' : el.textContent || ''}${text}`;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          return { typed: true };
        }
        if ('value' in el) {
          const prototype = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          const value = `${clear ? '' : el.value || ''}${text}`;
          if (setter) setter.call(el, value); else el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { typed: true };
        }
        throw new Error('element_not_editable');
      }, [String(args.selector || ''), String(args.text ?? ''), args.clear !== false]);

    case 'page.key': {
      const tab = await getTab(args.tabId);
      const key = String(args.key || 'Enter');
      const code = String(args.code || key);
      await sendCdp(tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: args.text ? String(args.text) : undefined });
      await sendCdp(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code });
      return { pressed: true, key };
    }

    case 'page.scroll':
      return runInTab(args.tabId, (x, y, absolute) => {
        if (absolute) scrollTo(Number(x || 0), Number(y || 0));
        else scrollBy(Number(x || 0), Number(y || 0));
        return { x: scrollX, y: scrollY };
      }, [args.x, args.y, Boolean(args.absolute)]);

    case 'page.drag': {
      const tab = await getTab(args.tabId);
      const from = await resolvePoint(tab.id, args, 'from');
      const to = await resolvePoint(tab.id, args, 'to');
      const steps = Math.min(Math.max(Number(args.steps || 12), 2), 40);
      await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
      await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, button: 'left', buttons: 1 });
      }
      await sendCdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      return { dragged: true, from, to };
    }

    case 'page.viewport.get':
      return runInTab(args.tabId, () => ({ width: innerWidth, height: innerHeight, devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height }));

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
      return screenshot(tab.id, Boolean(args.fullPage));
    }

    default:
      throw new Error('tool_not_supported');
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) debuggerTabs.delete(source.tabId);
});
