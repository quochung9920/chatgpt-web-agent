(() => {
  const tabSelect = document.querySelector('#chatgptTabSelect');
  const messagesEl = document.querySelector('#messages');
  const thinking = document.querySelector('#thinking');
  const composerActions = document.querySelector('.composer-actions');
  const composerHint = document.querySelector('#composerHint');
  const refreshButton = document.querySelector('#refresh');
  const newChatButton = document.querySelector('#newChat');

  let modelSelect = null;
  let liveArticle = null;
  let liveBubble = null;
  let liveHideTimer = null;
  let lastModelRefreshAt = 0;

  function selectedChatTabId() {
    return Number(tabSelect?.value || 0) || null;
  }

  async function runtimeRequest(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) throw new Error(response?.error || `${type}_failed`);
    return response.result;
  }

  function cleanStreamText(text) {
    return String(text || '')
      .replace(/<web_agent>[\s\S]*?<\/web_agent>/gi, '')
      .replace(/<web_agent>[\s\S]*$/gi, '')
      .replace(/```(?:json)?\s*\{\s*"type"\s*:\s*"tool_call"[\s\S]*$/gi, '')
      .trim();
  }

  function ensureLiveBubble() {
    if (liveArticle?.isConnected && liveBubble?.isConnected) return liveBubble;

    liveArticle = document.createElement('article');
    liveArticle.className = 'message assistant live-stream-message';

    const role = document.createElement('div');
    role.className = 'message-role';
    role.textContent = 'ChatGPT · live';

    liveBubble = document.createElement('div');
    liveBubble.className = 'message-bubble live-stream-bubble';

    liveArticle.append(role, liveBubble);
    messagesEl.append(liveArticle);
    document.querySelector('#emptyState')?.classList.add('hidden');
    return liveBubble;
  }

  function removeLiveBubble(delay = 0) {
    clearTimeout(liveHideTimer);
    liveHideTimer = setTimeout(() => {
      liveArticle?.remove();
      liveArticle = null;
      liveBubble = null;
    }, delay);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const chatArea = document.querySelector('#chatArea');
      if (chatArea) chatArea.scrollTop = chatArea.scrollHeight;
    });
  }

  function renderLiveStream(text, done) {
    const clean = cleanStreamText(text);
    if (!clean) {
      if (done) removeLiveBubble(150);
      return;
    }

    clearTimeout(liveHideTimer);
    const bubble = ensureLiveBubble();
    bubble.textContent = clean;
    liveArticle.classList.toggle('done', Boolean(done));
    scrollToBottom();
    if (done) removeLiveBubble(450);
  }

  function buildModelControl() {
    if (!composerActions || modelSelect) return;
    const wrap = document.createElement('div');
    wrap.className = 'model-control';
    wrap.title = 'ChatGPT model used by this conversation';

    modelSelect = document.createElement('select');
    modelSelect.id = 'chatgptModelSelect';
    modelSelect.className = 'model-select';
    modelSelect.setAttribute('aria-label', 'ChatGPT model');

    const loading = document.createElement('option');
    loading.value = '';
    loading.textContent = 'Model…';
    modelSelect.append(loading);
    modelSelect.disabled = true;

    wrap.append(modelSelect);
    composerActions.insertBefore(wrap, composerHint || composerActions.firstChild);

    modelSelect.addEventListener('focus', () => {
      if (Date.now() - lastModelRefreshAt > 30000) refreshModels().catch(() => {});
    });

    modelSelect.addEventListener('change', async () => {
      const tabId = selectedChatTabId();
      const label = modelSelect.value;
      if (!tabId || !label) return;
      modelSelect.disabled = true;
      try {
        const result = await runtimeRequest('webagent.model.select', { tabId, label });
        const current = result?.current || label;
        await refreshModels({ preferred: current, force: true });
      } catch (error) {
        modelSelect.title = `Could not change model: ${error?.message || error}`;
        await refreshModels({ force: true }).catch(() => {});
      }
    });
  }

  function populateModels(current, models) {
    buildModelControl();
    if (!modelSelect) return;

    const unique = [];
    const seen = new Set();
    for (const label of [current, ...(Array.isArray(models) ? models : [])]) {
      const value = String(label || '').replace(/\s+/g, ' ').trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(value);
    }

    modelSelect.replaceChildren();
    if (!unique.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Model unavailable';
      modelSelect.append(option);
      modelSelect.disabled = true;
      return;
    }

    for (const label of unique) {
      const option = document.createElement('option');
      option.value = label;
      option.textContent = label;
      modelSelect.append(option);
    }

    const selected = unique.find((item) => item.toLowerCase() === String(current || '').toLowerCase()) || unique[0];
    modelSelect.value = selected;
    modelSelect.disabled = false;
    modelSelect.title = `Current ChatGPT model: ${selected}`;
  }

  async function refreshModels({ preferred = '', force = false } = {}) {
    buildModelControl();
    const tabId = selectedChatTabId();
    if (!tabId) {
      populateModels('', []);
      return;
    }
    if (!force && Date.now() - lastModelRefreshAt < 1500) return;

    lastModelRefreshAt = Date.now();
    if (modelSelect) modelSelect.disabled = true;
    try {
      const result = await runtimeRequest('webagent.model.list', { tabId });
      populateModels(preferred || result?.current || '', result?.models || []);
    } catch (error) {
      if (modelSelect) {
        modelSelect.replaceChildren();
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Model unavailable';
        modelSelect.append(option);
        modelSelect.disabled = true;
        modelSelect.title = error?.message || String(error);
      }
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'webagent.stream') return;
    const tabId = selectedChatTabId();
    if (!tabId || Number(message.tabId) !== Number(tabId)) return;
    renderLiveStream(message.text || '', Boolean(message.done));
  });

  tabSelect?.addEventListener('change', () => {
    removeLiveBubble(0);
    setTimeout(() => refreshModels({ force: true }).catch(() => {}), 220);
  });

  newChatButton?.addEventListener('click', () => {
    removeLiveBubble(0);
    setTimeout(() => refreshModels({ force: true }).catch(() => {}), 1000);
  });

  refreshButton?.addEventListener('click', () => {
    setTimeout(() => refreshModels({ force: true }).catch(() => {}), 180);
  });

  const thinkingObserver = new MutationObserver(() => {
    if (!thinking?.classList.contains('hidden')) {
      if (modelSelect) modelSelect.disabled = true;
    } else if (modelSelect?.options.length) {
      modelSelect.disabled = false;
    }
  });
  if (thinking) thinkingObserver.observe(thinking, { attributes: true, attributeFilter: ['class'] });

  buildModelControl();
  setTimeout(() => refreshModels({ force: true }).catch(() => {}), 700);
})();
