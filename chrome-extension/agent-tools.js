import { executeLocalBrowserTool as executeScopedTool, LOCAL_AGENT_TOOLS as BASE_TOOLS } from './group-scoped-tools.js';
import { assertTabInAgentGroup, getPreferredAgentTab } from './tab-group-session.js';

export const AGENT_TOOLS = [...new Set([
  ...BASE_TOOLS,
  'page.observe',
  'page.find',
  'page.clickText',
  'page.typeByLabel'
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
      const safeText = (el) => {
        const type = String(el.getAttribute?.('type') || '').toLowerCase();
        if (type === 'password') return '[REDACTED_PASSWORD]';
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return String(el.value || '').slice(0, 240);
        return String(el.innerText || el.textContent || '').trim().slice(0, 240);
      };
      const stableSelector = (el) => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const testId = el.getAttribute('data-testid');
        if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
        const aria = el.getAttribute('aria-label');
        if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
        const name = el.getAttribute('name');
        if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        const parent = el.parentElement;
        if (!parent) return el.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter((item) => item.tagName === el.tagName);
        return `${el.tagName.toLowerCase()}:nth-of-type(${Math.max(1, siblings.indexOf(el) + 1)})`;
      };
      const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[aria-label],[data-testid],[contenteditable="true"]')).filter(visible);
      const interactive = nodes.slice(0, maxInteractive).map((el, index) => {
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const type = String(el.getAttribute('type') || '').toLowerCase();
        return {
          index,
          selector: stableSelector(el),
          tag,
          role: el.getAttribute('role') || ({ a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox' }[tag] || null),
          type: type || null,
          name: el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('name') || null,
          text: safeText(el),
          placeholder: type === 'password' ? null : el.getAttribute('placeholder'),
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      });
      const accessibility = interactive.slice(0, maxAx).map(({ index, selector, role, name, text, disabled, rect, type }) => ({
        index, selector, role, name: name || (type === 'password' ? '[PASSWORD_FIELD]' : text), disabled, rect
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
      const selectorFor = (el) => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const testId = el.getAttribute('data-testid');
        if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
        const aria = el.getAttribute('aria-label');
        if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
        const name = el.getAttribute('name');
        if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        const parent = el.parentElement;
        if (!parent) return el.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter((item) => item.tagName === el.tagName);
        return `${el.tagName.toLowerCase()}:nth-of-type(${Math.max(1, siblings.indexOf(el) + 1)})`;
      };
      const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[aria-label],[data-testid],[contenteditable="true"]'))
        .filter(visible)
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          const inferredRole = (el.getAttribute('role') || ({ a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox' }[tag] || tag)).toLowerCase();
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
          return { score, selector: selectorFor(el), role: inferredRole, label: label.slice(0, 220), type: type || null, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxItems);
      return candidates;
    },
    args: [query, role, limit]
  });
  return result;
}

async function typeByLabel(tabId, args = {}) {
  const matches = await semanticFind(tabId, { query: args.label || args.query, role: args.role || 'textbox', limit: 5 });
  const target = matches[0];
  if (!target) throw new Error('labeled_input_not_found');
  return executeScopedTool('page.type', { tabId: await resolveTabId(tabId), selector: target.selector, text: String(args.text ?? ''), clear: args.clear !== false });
}

export async function executeAgentTool(tool, args = {}) {
  const name = String(tool || '');
  switch (name) {
    case 'page.read': {
      const snapshot = await runSafeSnapshot(args.tabId, args);
      return { url: snapshot.url, title: snapshot.title, viewport: snapshot.viewport, document: snapshot.document, text: snapshot.text, interactive: snapshot.interactive };
    }
    case 'page.accessibility': {
      const snapshot = await runSafeSnapshot(args.tabId, args);
      return snapshot.accessibility;
    }
    case 'page.observe': {
      const tabId = await resolveTabId(args.tabId);
      const snapshot = await runSafeSnapshot(tabId, args);
      let screenshot = null;
      if (args.includeScreenshot !== false) screenshot = await executeScopedTool('page.screenshot', { tabId, fullPage: Boolean(args.fullPage) });
      return { ...snapshot, screenshot };
    }
    case 'page.find':
      return semanticFind(args.tabId, args);
    case 'page.clickText': {
      const matches = await semanticFind(args.tabId, { query: args.text || args.query, role: args.role, limit: 5 });
      const target = matches[0];
      if (!target) throw new Error('click_target_not_found');
      return executeScopedTool('page.click', { tabId: await resolveTabId(args.tabId), selector: target.selector });
    }
    case 'page.typeByLabel':
      return typeByLabel(args.tabId, args);
    default:
      return executeScopedTool(name, args);
  }
}
