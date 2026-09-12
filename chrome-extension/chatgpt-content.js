(() => {
  if (globalThis.__CHATGPT_WEB_AGENT_CHAT_BRIDGE__) return;
  globalThis.__CHATGPT_WEB_AGENT_CHAT_BRIDGE__ = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function findComposer() {
    const selectors = [
      'textarea#prompt-textarea',
      '#prompt-textarea[contenteditable="true"]',
      'textarea[data-testid="prompt-textarea"]',
      '[data-testid="prompt-textarea"][contenteditable="true"]',
      'form textarea',
      'form [contenteditable="true"]'
    ];
    for (const selector of selectors) {
      const matches = Array.from(document.querySelectorAll(selector));
      const visible = matches.find(isVisible);
      if (visible) return visible;
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'form button[type="submit"]'
    ];
    for (const selector of selectors) {
      const matches = Array.from(document.querySelectorAll(selector));
      const visible = matches.find((button) => isVisible(button) && !button.disabled);
      if (visible) return visible;
    }
    return null;
  }

  function findStopButton() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]'
    ];
    for (const selector of selectors) {
      const matches = Array.from(document.querySelectorAll(selector));
      if (matches.some(isVisible)) return true;
    }
    return false;
  }

  function getRoleNodes() {
    return Array.from(document.querySelectorAll('[data-message-author-role]'))
      .filter((node) => ['user', 'assistant'].includes(node.getAttribute('data-message-author-role')));
  }

  function getAssistantNodes() {
    return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  }

  function cleanMessageText(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('button, svg, [aria-hidden="true"]').forEach((item) => item.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }

  function getConversation(limit = 20) {
    const nodes = getRoleNodes().slice(-Math.max(1, Math.min(Number(limit || 20), 50)));
    return nodes.map((node) => ({
      role: node.getAttribute('data-message-author-role'),
      text: cleanMessageText(node)
    })).filter((item) => item.text);
  }

  function nativeValueSetter(element) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
    return prototype ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set : null;
  }

  async function setComposerText(text) {
    const composer = findComposer();
    if (!composer) throw new Error('chatgpt_composer_not_found');
    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const setter = nativeValueSetter(composer);
      if (setter) setter.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return composer;
    }

    if (composer.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch {
        inserted = false;
      }
      if (!inserted) composer.textContent = text;
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text
      }));
      return composer;
    }

    throw new Error('chatgpt_composer_not_editable');
  }

  async function submitComposer(composer) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const button = findSendButton();
      if (button) {
        button.click();
        return;
      }
      await sleep(100);
    }

    composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true
    }));
    composer.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true
    }));
  }

  function dataUrlToFile(dataUrl, filename) {
    const match = String(dataUrl || '').match(/^data:([^;,]+)?;base64,(.+)$/s);
    if (!match) throw new Error('invalid_image_data_url');
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], filename, { type: match[1] || 'image/png' });
  }

  function findFileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    return inputs.find((input) => !input.disabled) || null;
  }

  async function revealFileInput() {
    let input = findFileInput();
    if (input) return input;

    const buttons = Array.from(document.querySelectorAll('button'));
    const attach = buttons.find((button) => {
      const label = `${button.getAttribute('aria-label') || ''} ${button.title || ''} ${button.innerText || ''}`.toLowerCase();
      return /attach|upload|add photos|add files|file/.test(label) && isVisible(button);
    });

    if (attach) {
      attach.click();
      for (let i = 0; i < 20; i += 1) {
        await sleep(100);
        input = findFileInput();
        if (input) return input;
      }
    }
    return null;
  }

  async function attachImage(dataUrl, filename = 'web-agent-screenshot.png') {
    if (!dataUrl) return { attached: false };
    const input = await revealFileInput();
    if (!input) throw new Error('chatgpt_file_input_not_found');

    const file = dataUrlToFile(dataUrl, filename);
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(900);
    return { attached: true, name: file.name, size: file.size, type: file.type };
  }

  async function waitForAssistantResponse(before, timeoutMs = 180000) {
    const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs || 180000), 15000), 300000);
    let stableText = '';
    let stableSince = 0;

    while (Date.now() < deadline) {
      const assistants = getAssistantNodes();
      const latest = assistants.at(-1);
      const text = cleanMessageText(latest);
      const isNew = assistants.length > before.count || (text && text !== before.lastText);

      if (isNew && text) {
        if (text === stableText) {
          if (!stableSince) stableSince = Date.now();
        } else {
          stableText = text;
          stableSince = Date.now();
        }

        if (!findStopButton() && Date.now() - stableSince >= 1400) {
          return { text, conversation: getConversation(30) };
        }
      }

      await sleep(350);
    }

    if (stableText) return { text: stableText, conversation: getConversation(30), timedOut: true };
    throw new Error('chatgpt_response_timeout');
  }

  async function sendPrompt(text, timeoutMs, imageDataUrl = '') {
    const prompt = String(text || '').trim();
    if (!prompt) throw new Error('empty_prompt');

    const assistants = getAssistantNodes();
    const before = {
      count: assistants.length,
      lastText: cleanMessageText(assistants.at(-1))
    };

    let attachment = { attached: false };
    let attachmentError = '';
    if (imageDataUrl) {
      try {
        attachment = await attachImage(imageDataUrl);
      } catch (error) {
        attachmentError = error?.message || String(error);
      }
    }

    const composer = await setComposerText(prompt);
    await sleep(150);
    await submitComposer(composer);
    const response = await waitForAssistantResponse(before, timeoutMs);
    return { ...response, attachment, attachmentError };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !String(message.type || '').startsWith('chatgpt.bridge.')) return;

    (async () => {
      switch (message.type) {
        case 'chatgpt.bridge.ping':
          return {
            ok: true,
            href: location.href,
            title: document.title,
            composer: Boolean(findComposer()),
            conversation: getConversation(12)
          };
        case 'chatgpt.bridge.sync':
          return { ok: true, conversation: getConversation(message.limit || 30) };
        case 'chatgpt.bridge.send':
          return {
            ok: true,
            ...(await sendPrompt(message.text, message.timeoutMs, message.imageDataUrl || ''))
          };
        default:
          throw new Error('unsupported_bridge_message');
      }
    })().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });

    return true;
  });
})();
