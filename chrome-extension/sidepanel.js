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
const agentActivity = document.querySelector('#agentActivity');
const agentActivityStatus = document.querySelector('#agentActivityStatus');
const agentSteps = document.querySelector('#agentSteps');
const stopAgentButton = document.querySelector('#stopAgent');

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

function isInternalAgentMessage(item) {
  const text = String(item?.text || '').trim();
  return text.startsWith('[WEB_AGENT_SYSTEM]') || text.startsWith('[WEB_AGENT_TOOL_RESULT]');
}

function stripAgentProtocol(text) {
  return String(text || '').replace(/<web_agent>[\s\S]*?<\/web_agent>/gi, '').trim();
}

function conversationSignature(items) {
  return items.map((item) => `${item.role}:${item.text}`).join('\n---\n');
}

function renderConversation(items, force = false) {
  const normalized = Array.isArray(items)
    ? items
        .filter((item) => item && ['user', 'assistant'].includes(item.role) && String(item.text || '').trim())
        .filter((item) => !isInternalAgentMessage(item))
        .map((item) => ({ ...item, text: stripAgentProtocol(item.text) }))
        .filter((item) => item.text)
    : [];
  const signature = conversationSignature(normalized);
  if (!force && signature === lastConversationSignature) return;

  conversation = normalized;
  lastConversationSignature = signature;
  messagesEl.replaceChildren();
  emptyState.classList.toggle('hidden', conversation.length > 0);

  for (const item of conversation) appendRenderedMessage(item.role, item.text);
  scrollChatToBottom();
}

function appendRenderedMessage(role, text, className = '') {
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
}

function appendLocalMessage(role, text, className = '') {
  appendRenderedMessage(role, text, className);
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
  else if (sending) promptEl.placeholder = 'Agent is working in Chrome…';
  else promptEl.placeholder = 'Tell the agent what to do in Chrome…';
}

function resetAgentActivity() {
  agentSteps.replaceChildren();
  agentActivityStatus.textContent = 'Preparing browser context…';
  agentActivity.classList.remove('hidden');
  stopAgentButton.disabled = false;
}

function addAgentStep(event) {
  agentActivity.classList.remove('hidden');
  const row = document.createElement('div');
  row.className = `agent-step ${event.ok === false ? 'error' : ''}`;

  const mark = document.createElement('span');
  mark.className = 'agent-step-mark';
  if (event.kind === 'tool_result') mark.textContent = event.ok === false ? '×' : '✓';
  else if (event.kind === 'final') mark.textContent = '✓';
  else if (event.kind === 'reasoning') mark.textContent = '•';
  else mark.textContent = '→';

  const text = document.createElement('span');
  text.textContent = event.message || event.tool || event.kind || 'Working…';
  row.append(mark, text);
  agentSteps.append(row);

  while (agentSteps.children.length > 12) agentSteps.firstElementChild?.remove();
  agentActivityStatus.textContent = event.message || 'Working…';
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
  } catch {
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
  if (Array.from(tabSelect.options).some((option) => option.value === preferred)) tabSelect.value = preferred;
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
    const result = await runtimeRequest('chatgpt.sync', { tabId: selectedChatGptTabId, limit: 40 });
    renderConversation(result.conversation || [], true);
  } catch (error) {
    setError(`Could not sync ChatGPT: ${error?.message || error}`);
  }
}

async function runAgentTask() {
  const text = promptEl.value.trim();
  if (!text || sending) return;

  setError('');
  sending = true;
  promptEl.value = '';
  autoResizePrompt();
  updateComposerState(true);
  appendLocalMessage('user', text);
  resetAgentActivity();
  thinking.classList.remove('hidden');
  scrollChatToBottom();

  try {
    const result = await runtimeRequest('agent.run', {
      tabId: selectedChatGptTabId,
      task: text
    });
    selectedChatGptTabId = result.tabId || selectedChatGptTabId;
    thinking.classList.add('hidden');
    const finalText = stripAgentProtocol(result.text || '').trim() || 'Task complete.';
    appendLocalMessage('assistant', finalText);
    agentActivityStatus.textContent = `Finished after ${result.steps ?? 0} browser step${result.steps === 1 ? '' : 's'}`;
    stopAgentButton.disabled = true;
  } catch (error) {
    thinking.classList.add('hidden');
    const message = error?.message || String(error);
    appendLocalMessage('assistant', `Agent stopped: ${message}`, 'error');
    setError(message === 'agent_stopped' ? 'Agent stopped by user.' : `Agent error: ${message}`);
    agentActivityStatus.textContent = message === 'agent_stopped' ? 'Stopped' : 'Agent error';
    stopAgentButton.disabled = true;
  } finally {
    sending = false;
    updateComposerState(Boolean(selectedChatGptTabId));
    promptEl.focus();
    refreshCurrentTab();
  }
}

async function refreshAll() {
  await Promise.all([refreshServerStatus(), refreshCurrentTab()]);
  await refreshChatGptState({ syncConversation: !sending });
}

document.querySelector('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.querySelector('#refresh').addEventListener('click', refreshAll);
document.querySelector('#syncChat').addEventListener('click', syncChat);
document.querySelector('#send').addEventListener('click', runAgentTask);

stopAgentButton.addEventListener('click', async () => {
  if (!sending) return;
  stopAgentButton.disabled = true;
  agentActivityStatus.textContent = 'Stopping…';
  try { await runtimeRequest('agent.stop'); } catch {}
});

document.querySelector('#newChat').addEventListener('click', async () => {
  if (sending) return;
  setError('');
  try {
    const state = await runtimeRequest('chatgpt.new', { active: false });
    selectedChatGptTabId = state.selectedTabId || null;
    renderConversation([], true);
    agentActivity.classList.add('hidden');
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
    agentActivity.classList.add('hidden');
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
    runAgentTask();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'agent.event' || !message.event) return;
  const event = message.event;
  addAgentStep(event);
  if (event.kind === 'stopped') agentActivityStatus.textContent = 'Stopping…';
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
