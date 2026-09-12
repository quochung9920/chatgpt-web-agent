(() => {
  if (globalThis.__CHATGPT_WEB_AGENT_LIVE_BRIDGE__) return;
  globalThis.__CHATGPT_WEB_AGENT_LIVE_BRIDGE__ = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const MODELISH = /\b(gpt|chatgpt|o[1-9]|instant|thinking|pro|auto|model)\b/i;

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) !== 0;
  }

  function cleanText(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('button, svg, [aria-hidden="true"]').forEach((item) => item.remove());
    return String(clone.innerText || clone.textContent || '').trim();
  }

  function assistantNodes() {
    return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  }

  function findStopButton() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="stop" i]'
    ];
    return selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some(isVisible));
  }

  function emitRawStream(text, done = false, generating = false) {
    if (!text) return;
    try {
      chrome.runtime.sendMessage({
        type: 'webagent.stream.raw',
        text,
        done: Boolean(done),
        generating: Boolean(generating),
        href: location.href,
        title: document.title,
        at: Date.now()
      });
    } catch {}
  }

  let lastCount = assistantNodes().length;
  let lastText = cleanText(assistantNodes().at(-1));
  let lastEmittedText = lastText;
  let lastDoneText = lastText;
  let lastChangeAt = Date.now();
  let lastEmitAt = 0;

  function scanAssistantStream() {
    const nodes = assistantNodes();
    const count = nodes.length;
    const text = cleanText(nodes.at(-1));
    const generating = findStopButton();
    const changedTurn = count !== lastCount;
    const changedText = Boolean(text && text !== lastText);

    if (changedTurn) {
      lastCount = count;
      lastDoneText = '';
      lastChangeAt = Date.now();
    }

    if (changedText) {
      lastText = text;
      lastChangeAt = Date.now();
      lastDoneText = '';
    }

    if (text && text !== lastEmittedText && Date.now() - lastEmitAt >= 90) {
      lastEmittedText = text;
      lastEmitAt = Date.now();
      emitRawStream(text, false, generating);
    }

    if (text && !generating && text !== lastDoneText && Date.now() - lastChangeAt >= 850) {
      lastDoneText = text;
      if (text !== lastEmittedText) {
        lastEmittedText = text;
        lastEmitAt = Date.now();
      }
      emitRawStream(text, true, false);
    }
  }

  setInterval(scanAssistantStream, 120);

  function buttonText(button) {
    return String(button?.innerText || button?.textContent || button?.getAttribute?.('aria-label') || button?.title || '').replace(/\s+/g, ' ').trim();
  }

  function modelPickerScore(button) {
    if (!isVisible(button)) return -1;
    const text = buttonText(button);
    const testId = String(button.getAttribute('data-testid') || '').toLowerCase();
    const aria = String(button.getAttribute('aria-label') || '').toLowerCase();
    const title = String(button.title || '').toLowerCase();
    if (/share|new chat|profile|account|temporary|voice|attach|upload/i.test(`${text} ${aria} ${title}`)) return -1;

    let score = 0;
    if (testId.includes('model')) score += 120;
    if (aria.includes('model') || title.includes('model')) score += 90;
    if (MODELISH.test(text)) score += 55;
    if (button.getAttribute('aria-haspopup') === 'menu' || button.getAttribute('aria-haspopup') === 'listbox') score += 18;
    const rect = button.getBoundingClientRect();
    if (rect.top < 180) score += 20;
    if (text.length > 0 && text.length <= 70) score += 8;
    return score;
  }

  function findModelPicker() {
    const explicitSelectors = [
      'button[data-testid="model-switcher-dropdown-button"]',
      'button[data-testid*="model-switcher"]',
      '[data-testid*="model-selector"] button',
      'button[aria-label*="model" i]'
    ];
    for (const selector of explicitSelectors) {
      const found = Array.from(document.querySelectorAll(selector)).find(isVisible);
      if (found) return found;
    }

    return Array.from(document.querySelectorAll('button'))
      .map((button) => ({ button, score: modelPickerScore(button) }))
      .filter((item) => item.score >= 55)
      .sort((a, b) => b.score - a.score)[0]?.button || null;
  }

  function currentModelLabel() {
    const picker = findModelPicker();
    const label = buttonText(picker);
    return label || '';
  }

  function visibleMenuRoots() {
    const selectors = [
      '[role="menu"]',
      '[role="listbox"]',
      '[data-radix-menu-content]',
      '[data-headlessui-state*="open"]'
    ];
    const roots = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (isVisible(node) && !roots.includes(node)) roots.push(node);
      }
    }
    return roots;
  }

  function normalizeModelOption(text) {
    return String(text || '').replace(/[✓✔]/g, '').replace(/\s+/g, ' ').trim();
  }

  function collectModelOptions() {
    const roots = visibleMenuRoots();
    const candidates = [];
    const selector = '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], button';
    const scope = roots.length ? roots : [document];

    for (const root of scope) {
      for (const node of root.querySelectorAll(selector)) {
        if (!isVisible(node)) continue;
        const label = normalizeModelOption(buttonText(node));
        if (!label || label.length > 90) continue;
        if (/^(legacy models|more models|learn more|settings|upgrade|manage)$/i.test(label)) continue;
        const role = String(node.getAttribute('role') || '');
        const looksSelectable = /menuitemradio|option|radio/.test(role) || MODELISH.test(label);
        if (!looksSelectable) continue;
        candidates.push({ label, node });
      }
    }

    const seen = new Set();
    return candidates.filter((item) => {
      const key = item.label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function closeModelMenu() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    await sleep(80);
  }

  async function listModels() {
    const picker = findModelPicker();
    const current = currentModelLabel();
    if (!picker) return { current, models: current ? [current] : [], pickerFound: false };

    picker.click();
    await sleep(260);
    const entries = collectModelOptions();
    const models = entries.map((item) => item.label);
    if (current && !models.some((item) => item.toLowerCase() === current.toLowerCase())) models.unshift(current);
    await closeModelMenu();
    return { current, models, pickerFound: true };
  }

  async function selectModel(label) {
    const desired = normalizeModelOption(label);
    if (!desired) throw new Error('model_label_required');
    const picker = findModelPicker();
    if (!picker) throw new Error('chatgpt_model_picker_not_found');

    picker.click();
    await sleep(260);
    let entries = collectModelOptions();
    let target = entries.find((item) => item.label.toLowerCase() === desired.toLowerCase())
      || entries.find((item) => item.label.toLowerCase().includes(desired.toLowerCase()))
      || entries.find((item) => desired.toLowerCase().includes(item.label.toLowerCase()));

    if (!target) {
      const expansion = Array.from(document.querySelectorAll('[role="menuitem"], button')).find((node) => {
        if (!isVisible(node)) return false;
        return /legacy models|more models|other models/i.test(buttonText(node));
      });
      if (expansion) {
        expansion.click();
        await sleep(220);
        entries = collectModelOptions();
        target = entries.find((item) => item.label.toLowerCase() === desired.toLowerCase())
          || entries.find((item) => item.label.toLowerCase().includes(desired.toLowerCase()));
      }
    }

    if (!target) {
      await closeModelMenu();
      throw new Error('chatgpt_model_option_not_found');
    }

    target.node.click();
    await sleep(550);
    return {
      selected: true,
      requested: desired,
      current: currentModelLabel() || desired
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !String(message.type || '').startsWith('webagent.live.')) return;
    (async () => {
      switch (message.type) {
        case 'webagent.live.ping':
          return { ok: true, href: location.href, currentModel: currentModelLabel() };
        case 'webagent.live.model.current':
          return { ok: true, current: currentModelLabel() };
        case 'webagent.live.models':
          return { ok: true, ...(await listModels()) };
        case 'webagent.live.model.select':
          return { ok: true, ...(await selectModel(message.label)) };
        default:
          throw new Error('unsupported_live_bridge_message');
      }
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
})();
