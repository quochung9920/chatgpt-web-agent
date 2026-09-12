const statusDot = document.querySelector('#statusDot');
const statusText = document.querySelector('#statusText');
const chatgptDot = document.querySelector('#chatgptDot');
const chatgptBadge = document.querySelector('#chatgptBadge');
const connectionLine = document.querySelector('#connectionLine');
const tabTitle = document.querySelector('#tabTitle');
const tabUrl = document.querySelector('#tabUrl');
const tabSelect = document.querySelector('#chatgptTabSelect');
const messagesEl = document.querySelector('#messages');
const emptyState = document.querySelector('#emptyState');
const thinking = document.querySelector('#thinking');
const promptEl = document.querySelector('#prompt');
const sendButton = document.querySelector('#send');
const chatError = document.querySelector('#chatError');
const agentIdEl = document.querySelector('#agentId');

let conversation = [];
let selectedChatGptTabId = null;
let sending = false;
let lastConversationSignature = '';

function httpBaseFromWs(value) {
  return String(value || '')
    .replace(/^ws:/i, 'http:')
    .replace(/^wss:/i, 'https:')
    .replace(/\/$/, '');
}

async function getConfig() {
  return chrome.storage.local.get({
    serverUrl: 'ws://localhost:8787',
    agentId: 'desktop-chrome',
    agentToken: ''
  });
}

async function runtimeRequest(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || `${type}_failed`);
  return response.result;
}

function setError(message = '') {
  if (!message) {
    chatError.textContent = '';
    chatError.classList.add('hidden');
    return;
  }
  chatError.textContent = message;
  chatError.classList.remove('hidden');
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    const chatArea = document.querySelector('#chatArea');
    chatArea.scrollTop = chatArea.scrollHeight;
  });
}

function conversationSignature(items) {
  return items.map((item) => `${item.role}:${item.text}`).join('\n---\n');
}

function renderConversation(items, force = false) {
  const normalized = Array.isArray(items)
    ? items.filter((item) => item && ['user', 'assistant'].includes(item.role) && String(item.text || '').trim())
    : [];
  const signature = conversationSignature(normalized);
  if (!force && signature === lastConversationSignature) return;

  conversation = normalized;
  lastConversationSignature = signature;
  messagesEl.replaceChildren();
  emptyState.classList.toggle('hidden', conversation.length > 0);

  for (const item of conversation) {
    const message = document.createElement('article');
    message.className = `message ${item.role}`;

    const role = document.createElement('div');
    role.className = 'message-role';
    role.textContent = item.role === 'user' ? 'You' : 'ChatGPT';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = item.text;

    message.append(role, bubble);
    messagesEl.append(message);
  }
  scrollChatToBottom();
}

function appendLocalMessage(role, text, className = '') {
  const message = document.createElement('article');
  message.className = `message ${role}${className ? ` ${className}` : ''}`;
  const roleEl = document.createElement('div');
  roleEl.className = 'message-role';
  roleEl.textContent = role === 'user' ? 'You' : 'ChatGPT';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;
  message.append(roleEl, bubble);
  messagesEl.append(message);
  emptyState.classList.add('hidden');
  scrollChatToBottom();
}

function autoResizePrompt() {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(Math.max(promptEl.scrollHeight, 42), 132)}px`;
}

function updateComposerState(ready) {
  promptEl.disabled = !ready || sending;
  sendButton.disabled = !ready || sending || !promptEl.value.trim();
  if (!ready) promptEl.placeholder = 'Open and sign in to ChatGPT first…';
  else if (sending) promptEl.placeholder = 'Waiting for ChatGPT…';
  else promptEl.placeholder = 'Message ChatGPT…';
}

async function refreshServerStatus() {
  statusDot.className = 'status-dot checking';
  statusText.textContent = 'Server';

  const config = await getConfig();
  agentIdEl.textContent = config.agentId || 'desktop-chrome';

  if (!config.agentToken) {
    statusDot.className = 'status-dot offline';
    connectionLine.textContent = 'Agent token missing';
    return false;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(`${httpBaseFromWs(config.serverUrl)}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json().catch(() => ({}));
    statusDot.className = 'status-dot online';
    connectionLine.textContent = `${config.serverUrl} · ${data.version ? `server v${data.version}` : 'online'}`;
    return true;
  } catch (error) {
    statusDot.className = 'status-dot offline';
    connectionLine.textContent = `${config.serverUrl} · offline`;
    return false;
  }
}

async function refreshCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    tabTitle.textContent = 'No active tab';
    tabUrl.textContent = '—';
    return;
  }
  tabTitle.textContent = tab.title || 'Untitled tab';
  tabUrl.textContent = tab.url || '—';
}

function populateChatGptTabs(tabs, selectedId) {
  const existing = String(tabSelect.value || '');
  tabSelect.replaceChildren();

  if (!tabs?.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No ChatGPT tab';
    tabSelect.append(option);
    tabSelect.disabled = true;
    return;
  }

  tabSelect.disabled = false;
  for (const tab of tabs) {
    const option = document.createElement('option');
    option.value = String(tab.id);
    option.textContent = tab.title || `ChatGPT tab ${tab.id}`;
    tabSelect.append(option);
  }

  const preferred = String(selectedId || existing || tabs[0].id);
  if (Array.from(tabSelect.options).some((option) => option.value === preferred)) {
    tabSelect.value = preferred;
  }
}

async function refreshChatGptState({ syncConversation = true } = {}) {
  chatgptDot.className = 'status-dot checking';
  chatgptBadge.textContent = 'ChatGPT';
  try {
    const state = await runtimeRequest('chatgpt.status', { tabId: selectedChatGptTabId });
    populateChatGptTabs(state.tabs || [], state.selectedTabId);
    selectedChatGptTabId = state.selectedTabId || null;

    if (!state.open) {
      chatgptDot.className = 'status-dot offline';
      chatgptBadge.textContent = 'ChatGPT closed';
      updateComposerState(false);
      if (!sending) renderConversation([], true);
      return state;
    }

    if (!state.bridgeReady) {
      chatgptDot.className = 'status-dot offline';
      chatgptBadge.textContent = 'ChatGPT not ready';
      updateComposerState(false);
      if (state.error) setError(`ChatGPT bridge: ${state.error}`);
      return state;
    }

    chatgptDot.className = 'status-dot online';
    chatgptBadge.textContent = 'ChatGPT ready';
    if (!sending) updateComposerState(true);
    if (syncConversation && !sending && state.conversation) renderConversation(state.conversation);
    return state;
  } catch (error) {
    chatgptDot.className = 'status-dot offline';
    chatgptBadge.textContent = 'Bridge error';
    updateComposerState(false);
    setError(error?.message || String(error));
    return null;
  }
}

async function syncChat() {
  setError('');
  if (!selectedChatGptTabId) {
    await refreshChatGptState();
    if (!selectedChatGptTabId) return;
  }
  try {
    const result = await runtimeRequest('chatgpt.sync', { tabId: selectedChatGptTabId, limit: 30 });
    renderConversation(result.conversation || [], true);
  } catch (error) {
    setError(`Could not sync ChatGPT: ${error?.message || error}`);
  }
}

async function sendPrompt() {
  const text = promptEl.value.trim();
  if (!text || sending) return;

  setError('');
  sending = true;
  promptEl.value = '';
  autoResizePrompt();
  updateComposerState(true);
  appendLocalMessage('user', text);
  thinking.classList.remove('hidden');
  scrollChatToBottom();

  try {
    const result = await runtimeRequest('chatgpt.send', {
      tabId: selectedChatGptTabId,
      text,
      timeoutMs: 180000
    });
    selectedChatGptTabId = result.tabId || selectedChatGptTabId;
    thinking.classList.add('hidden');
    renderConversation(result.conversation || [...conversation, { role: 'user', text }, { role: 'assistant', text: result.text }], true);
    if (result.timedOut) setError('The response took longer than expected; the latest visible answer was synced.');
  } catch (error) {
    thinking.classList.add('hidden');
    appendLocalMessage('assistant', `Could not send through the ChatGPT tab: ${error?.message || error}`, 'error');
    setError('If ChatGPT changed its web UI, reload the ChatGPT tab and try Sync chat.');
  } finally {
    sending = false;
    updateComposerState(Boolean(selectedChatGptTabId));
    promptEl.focus();
  }
}

async function refreshAll() {
  await Promise.all([refreshServerStatus(), refreshCurrentTab()]);
  await refreshChatGptState({ syncConversation: !sending });
}

document.querySelector('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.querySelector('#refresh').addEventListener('click', refreshAll);
document.querySelector('#syncChat').addEventListener('click', syncChat);
document.querySelector('#send').addEventListener('click', sendPrompt);

document.querySelector('#newChat').addEventListener('click', async () => {
  if (sending) return;
  setError('');
  try {
    const state = await runtimeRequest('chatgpt.new', { active: false });
    selectedChatGptTabId = state.selectedTabId || null;
    renderConversation([], true);
    await refreshChatGptState({ syncConversation: false });
    promptEl.focus();
  } catch (error) {
    setError(`Could not create a new ChatGPT tab: ${error?.message || error}`);
  }
});

document.querySelector('#openChatgpt').addEventListener('click', async () => {
  try {
    const state = await runtimeRequest('chatgpt.open', { active: true });
    selectedChatGptTabId = state.selectedTabId || selectedChatGptTabId;
  } catch (error) {
    setError(`Could not open ChatGPT: ${error?.message || error}`);
  }
});

tabSelect.addEventListener('change', async () => {
  if (!tabSelect.value || sending) return;
  setError('');
  try {
    const state = await runtimeRequest('chatgpt.select', { tabId: Number(tabSelect.value) });
    selectedChatGptTabId = state.selectedTabId || Number(tabSelect.value);
    renderConversation(state.conversation || [], true);
    await refreshChatGptState({ syncConversation: false });
  } catch (error) {
    setError(`Could not select ChatGPT tab: ${error?.message || error}`);
  }
});

promptEl.addEventListener('input', () => {
  autoResizePrompt();
  sendButton.disabled = sending || promptEl.disabled || !promptEl.value.trim();
});

promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
  }
});

chrome.tabs.onActivated.addListener(() => {
  refreshCurrentTab();
  if (!sending) refreshChatGptState({ syncConversation: false });
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    refreshCurrentTab();
    if (!sending) refreshChatGptState({ syncConversation: changeInfo.status === 'complete' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (Number(tabId) === Number(selectedChatGptTabId)) selectedChatGptTabId = null;
  if (!sending) refreshChatGptState();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverUrl || changes.agentId || changes.agentToken) refreshServerStatus();
});

updateComposerState(false);
autoResizePrompt();
refreshAll();
setInterval(() => {
  refreshServerStatus();
  refreshCurrentTab();
  if (!sending) refreshChatGptState({ syncConversation: false });
}, 5000);
