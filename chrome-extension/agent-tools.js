import { executeLocalBrowserTool as executeScopedTool, LOCAL_AGENT_TOOLS as BASE_TOOLS } from './group-scoped-tools.js';
import { assertTabInAgentGroup, getPreferredAgentTab } from './tab-group-session.js';

const localDebuggerTabs = new Set();

export const AGENT_TOOLS = [...new Set([
  ...BASE_TOOLS,
  'page.observe',
  'page.find',
  'page.clickText',
  'page.typeByLabel',
  'page.focus',
  'page.selectOption',
  'page.check',
  'page.hotkey',
  'page.upload'
])];

export function isAgentTool(tool) {
  return AGENT_TOOLS.includes(String(tool || ''));
}

async function resolveTabId(tabId) {
  if (tabId != null) {
    await assertTabInAgentGroup(tabId);
    return Number(tabId);
  }
  return (await getPreferredAgentTab()).id;
}

async function sendCdp(tabId, method, params = {}) {
  const id = await resolveTabId(tabId);
  if (!localDebuggerTabs.has(id)) {
    try {
      await chrome.debugger.attach({ tabId: id }, '1.3');
    } catch (error) {
      const text = String(error?.message || error || '');
      if (!/already attached|another debugger/i.test(text)) throw error;
    }
    localDebuggerTabs.add(id);
  }
  return chrome.debugger.sendCommand({ tabId: id }, method, params);
}

async function runSafeSnapshot(tabId, { maxLength = 18000, interactiveLimit = 100, accessibilityLimit = 140 } = {}) {
  const id = await resolveTabId(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (maxChars, maxInteractive, maxAx) => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const roleFor = (el) => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        const type = String(el.getAttribute('type') || '').toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input' && type === 'checkbox') return 'checkbox';
        if (tag === 'input' && type === 'radio') return 'radio';
        if (tag === 'input') return 'textbox';
        return null;
      };
      const safeText = (el) => {
        const type = String(el.getAttribute?.('type') || '').toLowerCase();
        if (type === 'password') return '[REDACTED_PASSWORD]';
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return String(el.value || '').slice(0, 240);
        return String(el.innerText || el.textContent || '').trim().slice(0, 240);
      };
      const selectorFor = (el) => {
        const part = (node) => {
          if (node.id) return `#${CSS.escape(node.id)}`;
          const testId = node.getAttribute('data-testid');
          if (testId) return `${node.tagName.toLowerCase()}[data-testid="${CSS.escape(testId)}"]`;
          const name = node.getAttribute('name');
          if (name) return `${node.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const tag = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (!parent) return tag;
          const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
          return `${tag}:nth-of-type(${Math.max(1, siblings.indexOf(node) + 1)})`;
        };
        const path = [];
        let node = el;
        while (node && node.nodeType === Node.ELEMENT_NODE && path.length < 7) {
          const segment = part(node);
          path.unshift(segment);
          if (node.id || node.getAttribute('data-testid')) break;
          node = node.parentElement;
        }
        return path.join(' > ');
      };
      const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[aria-label],[data-testid],[contenteditable="true"]')).filter(visible);
      const interactive = nodes.slice(0, maxInteractive).map((el, index) => {
        const rect = el.getBoundingClientRect();
        const type = String(el.getAttribute('type') || '').toLowerCase();
        return {
          index,
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          role: roleFor(el),
          type: type || null,
          name: el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('name') || null,
          text: safeText(el),
          placeholder: type === 'password' ? null : el.getAttribute('placeholder'),
          checked: 'checked' in el ? Boolean(el.checked) : undefined,
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      });
      const accessibility = interactive.slice(0, maxAx).map(({ index, selector, role, name, text, disabled, rect, type, checked }) => ({
        index, selector, role, name: name || (type === 'password' ? '[PASSWORD_FIELD]' : text), disabled, checked, rect
      }));
      return {
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY },
        document: { width: document.documentElement?.scrollWidth || 0, height: document.documentElement?.scrollHeight || 0 },
        text: String(document.body?.innerText || '').slice(0, maxChars),
        interactive,
        accessibility
      };
    },
    args: [Math.min(Number(maxLength || 18000), 50000), Math.min(Number(interactiveLimit || 100), 180), Math.min(Number(accessibilityLimit || 140), 220)]
  });
  return result;
}

async function semanticFind(tabId, args = {}) {
  const id = await resolveTabId(tabId);
  const query = String(args.query || args.text || args.label || '').trim();
  if (!query) throw new Error('query_required');
  const role = String(args.role || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(args.limit || 12), 1), 30);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (needle, wantedRole, maxItems) => {
      const normalized = needle.toLowerCase();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const roleFor = (el) => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit.toLowerCase();
        const tag = el.tagName.toLowerCase();
        const type = String(el.getAttribute('type') || '').toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input' && type === 'checkbox') return 'checkbox';
        if (tag === 'input' && type === 'radio') return 'radio';
        if (tag === 'input') return 'textbox';
        return tag;
      };
      const selectorFor = (el) => {
        const part = (node) => {
          if (node.id) return `#${CSS.escape(node.id)}`;
          const testId = node.getAttribute('data-testid');
          if (testId) return `${node.tagName.toLowerCase()}[data-testid="${CSS.escape(testId)}"]`;
          const name = node.getAttribute('name');
          if (name) return `${node.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const tag = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (!parent) return tag;
          const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
          return `${tag}:nth-of-type(${Math.max(1, siblings.indexOf(node) + 1)})`;
        };
        const path = [];
        let node = el;
        while (node && node.nodeType === Node.ELEMENT_NODE && path.length < 7) {
          const segment = part(node);
          path.unshift(segment);
          if (node.id || node.getAttribute('data-testid')) break;
          node = node.parentElement;
        }
        return path.join(' > ');
      };
      return Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[aria-label],[data-testid],[contenteditable="true"]'))
        .filter(visible)
        .map((el) => {
          const inferredRole = roleFor(el);
          const type = String(el.getAttribute('type') || '').toLowerCase();
          const label = [
            el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('name'), el.getAttribute('placeholder'),
            type === 'password' ? '[PASSWORD_FIELD]' : (el.innerText || el.value || el.textContent || '')
          ].filter(Boolean).join(' ').trim();
          const haystack = label.toLowerCase();
          let score = haystack === normalized ? 100 : haystack.startsWith(normalized) ? 80 : haystack.includes(normalized) ? 60 : 0;
          if (wantedRole && inferredRole === wantedRole) score += 25;
          if (wantedRole && inferredRole !== wantedRole) score -= 30;
          const rect = el.getBoundingClientRect();
          return { score, selector: selectorFor(el), role: inferredRole, label: label.slice(0, 220), type: type || null, checked: 'checked' in el ? Boolean(el.checked) : undefined, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxItems);
    },
    args: [query, role, limit]
  });
  return result;
}

async function firstSemanticTarget(tabId, args, fallbackRole = '') {
  const matches = await semanticFind(tabId, { query: args.label || args.text || args.query, role: args.role || fallbackRole, limit: 5 });
  if (!matches[0]) throw new Error('semantic_target_not_found');
  return matches[0];
}

async function typeByLabel(tabId, args = {}) {
  const target = await firstSemanticTarget(tabId, args, 'textbox');
  return executeScopedTool('page.type', { tabId: await resolveTabId(tabId), selector: target.selector, text: String(args.text ?? ''), clear: args.clear !== false });
}

async function focusTarget(tabId, args = {}) {
  const id = await resolveTabId(tabId);
  let selector = args.selector ? String(args.selector) : '';
  if (!selector) selector = (await firstSemanticTarget(id, args)).selector;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (css) => {
      const el = document.querySelector(css);
      if (!el) throw new Error('focus_target_not_found');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      return { focused: true, selector: css };
    },
    args: [selector]
  });
  return result;
}

async function selectOption(tabId, args = {}) {
  const id = await resolveTabId(tabId);
  let selector = args.selector ? String(args.selector) : '';
  if (!selector) selector = (await firstSemanticTarget(id, args, 'combobox')).selector;
  const desired = String(args.value ?? args.option ?? args.text ?? '');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (css, wanted) => {
      const el = document.querySelector(css);
      if (!(el instanceof HTMLSelectElement)) throw new Error('select_not_found');
      const option = Array.from(el.options).find((item) => item.value === wanted || item.text.trim().toLowerCase() === wanted.trim().toLowerCase());
      if (!option) throw new Error('option_not_found');
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: true, value: option.value, text: option.text };
    },
    args: [selector, desired]
  });
  return result;
}

async function setChecked(tabId, args = {}) {
  const id = await resolveTabId(tabId);
  let selector = args.selector ? String(args.selector) : '';
  if (!selector) selector = (await firstSemanticTarget(id, args, args.role || 'checkbox')).selector;
  const desired = args.checked !== false;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (css, next) => {
      const el = document.querySelector(css);
      if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(el.type)) throw new Error('checkable_not_found');
      if (Boolean(el.checked) !== Boolean(next)) el.click();
      return { checked: Boolean(el.checked), selector: css };
    },
    args: [selector, desired]
  });
  return result;
}

async function hotkey(tabId, args = {}) {
  const id = await resolveTabId(tabId);
  const source = Array.isArray(args.keys) ? args.keys.map(String) : String(args.keys || args.hotkey || '').split('+').map((item) => item.trim()).filter(Boolean);
  if (!source.length) throw new Error('hotkey_required');
  const normalized = source.map((item) => item.toLowerCase());
  const keyToken = source.find((item) => !['ctrl', 'control', 'alt', 'option', 'shift', 'meta', 'cmd', 'command'].includes(item.toLowerCase()));
  if (!keyToken) throw new Error('hotkey_key_required');
  let modifiers = 0;
  if (normalized.some((item) => ['alt', 'option'].includes(item))) modifiers |= 1;
  if (normalized.some((item) => ['ctrl', 'control'].includes(item))) modifiers |= 2;
  if (normalized.some((item) => ['meta', 'cmd', 'command'].includes(item))) modifiers |= 4;
  if (normalized.includes('shift')) modifiers |= 8;
  const key = String(keyToken);
  const code = args.code || (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key);
  await sendCdp(id, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, modifiers });
  await sendCdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
  return { pressed: true, keys: source };
}

async function uploadData(tabId, args = {}) {
  const id = await resolveTabId(tabId);
  const dataUrl = String(args.dataUrl || '');
  if (!/^data:[^;]+;base64,/i.test(dataUrl)) throw new Error('valid_data_url_required');
  if (dataUrl.length > 20 * 1024 * 1024) throw new Error('upload_too_large');
  let selector = args.selector ? String(args.selector) : '';
  if (!selector && (args.label || args.query)) selector = (await firstSemanticTarget(id, args)).selector;
  if (!selector) selector = 'input[type="file"]';
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (css, source, filename, mimeType) => {
      const input = document.querySelector(css);
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
    },
    args: [selector, dataUrl, String(args.filename || 'upload.bin'), String(args.mimeType || '')]
  });
  return result;
}

export async function executeAgentTool(tool, args = {}) {
  const name = String(tool || '');
  switch (name) {
    case 'page.read': {
      const snapshot = await runSafeSnapshot(args.tabId, args);
      return { url: snapshot.url, title: snapshot.title, viewport: snapshot.viewport, document: snapshot.document, text: snapshot.text, interactive: snapshot.interactive };
    }
    case 'page.accessibility': return (await runSafeSnapshot(args.tabId, args)).accessibility;
    case 'page.observe': {
      const tabId = await resolveTabId(args.tabId);
      const snapshot = await runSafeSnapshot(tabId, args);
      let screenshot = null;
      if (args.includeScreenshot !== false) screenshot = await executeScopedTool('page.screenshot', { tabId, fullPage: Boolean(args.fullPage) });
      return { ...snapshot, screenshot };
    }
    case 'page.find': return semanticFind(args.tabId, args);
    case 'page.clickText': {
      const target = await firstSemanticTarget(args.tabId, args, args.role || '');
      return executeScopedTool('page.click', { tabId: await resolveTabId(args.tabId), selector: target.selector });
    }
    case 'page.typeByLabel': return typeByLabel(args.tabId, args);
    case 'page.focus': return focusTarget(args.tabId, args);
    case 'page.selectOption': return selectOption(args.tabId, args);
    case 'page.check': return setChecked(args.tabId, args);
    case 'page.hotkey': return hotkey(args.tabId, args);
    case 'page.upload': return uploadData(args.tabId, args);
    default: return executeScopedTool(name, args);
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) localDebuggerTabs.delete(source.tabId);
});
