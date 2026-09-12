import {
  activateAgentGroupForTab,
  ensureAgentGroup,
  getAgentGroupStatus
} from './tab-group-session.js';
import { AGENT_MODES, normalizeAgentMode } from './agent-policy.js';

let installed = false;

function isChatGptUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(String(url || ''));
}

async function listChatGptTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab?.id && isChatGptUrl(tab.url))
    .map(({ id, title, url, active, windowId }) => ({ id, title, url, active, windowId }));
}

async function resolveChatGptTab(preferredTabId = null) {
  const stored = await chrome.storage.local.get({ chatgptTabId: null });
  const candidates = [preferredTabId, stored.chatgptTabId]
    .filter((value) => value != null)
    .map(Number)
    .filter(Number.isFinite);

  for (const id of candidates) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab?.id && isChatGptUrl(tab.url)) {
        await chrome.storage.local.set({ chatgptTabId: tab.id });
        return tab;
      }
    } catch {}
  }

  const tabs = await listChatGptTabs();
  if (!tabs.length) return null;
  const selected = tabs.find((tab) => tab.active) || tabs[0];
  await chrome.storage.local.set({ chatgptTabId: selected.id });
  return chrome.tabs.get(selected.id);
}

async function waitForTabReady(tabId, timeoutMs = 20000) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs || 20000), 1000), 45000);
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(Number(tabId));
      if (tab.status === 'complete' && isChatGptUrl(tab.url)) return tab;
    } catch {
      throw new Error('chatgpt_tab_closed');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('chatgpt_tab_load_timeout');
}

async function sendChatBridge(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(Number(tabId), message);
  } catch (error) {
    const text = String(error?.message || error || '');
    if (!/Receiving end does not exist|Could not establish connection/i.test(text)) throw error;
    await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      files: ['chatgpt-content.js']
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return chrome.tabs.sendMessage(Number(tabId), message);
  }
}

async function chatGptStatus(preferredTabId = null, { includeConversation = true } = {}) {
  const tabs = await listChatGptTabs();
  const tab = await resolveChatGptTab(preferredTabId);
  if (!tab) {
    return {
      open: false,
      tabs,
      selectedTabId: null,
      bridgeReady: false,
      conversation: []
    };
  }

  try {
    const bridge = await sendChatBridge(tab.id, { type: 'chatgpt.bridge.ping' });
    return {
      open: true,
      tabs,
      selectedTabId: tab.id,
      selectedTitle: tab.title || 'ChatGPT',
      selectedUrl: tab.url,
      bridgeReady: Boolean(bridge?.ok && bridge?.composer),
      conversation: includeConversation && bridge?.ok ? (bridge.conversation || []) : [],
      error: bridge?.ok ? '' : (bridge?.error || 'chatgpt_bridge_unavailable')
    };
  } catch (error) {
    return {
      open: true,
      tabs,
      selectedTabId: tab.id,
      selectedTitle: tab.title || 'ChatGPT',
      selectedUrl: tab.url,
      bridgeReady: false,
      conversation: [],
      error: error?.message || String(error)
    };
  }
}

async function createChatGptTab(active = false) {
  const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: Boolean(active) });
  if (!tab?.id) throw new Error('chatgpt_tab_create_failed');
  await chrome.storage.local.set({ chatgptTabId: tab.id });
  await waitForTabReady(tab.id);
  return chatGptStatus(tab.id);
}

async function selectChatGptTab(tabId) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!tab?.id || !isChatGptUrl(tab.url)) throw new Error('not_a_chatgpt_tab');
  await chrome.storage.local.set({ chatgptTabId: tab.id });
  return chatGptStatus(tab.id);
}

async function openChatGptTab() {
  let tab = await resolveChatGptTab();
  if (!tab) return createChatGptTab(true);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  tab = await chrome.tabs.get(tab.id);
  return chatGptStatus(tab.id);
}

async function syncChatGpt(tabId, limit = 40) {
  const tab = await resolveChatGptTab(tabId);
  if (!tab) throw new Error('chatgpt_tab_not_found');
  const response = await sendChatBridge(tab.id, {
    type: 'chatgpt.bridge.sync',
    limit: Math.min(Math.max(Number(limit || 40), 1), 50)
  });
  if (!response?.ok) throw new Error(response?.error || 'chatgpt_sync_failed');
  return {
    selectedTabId: tab.id,
    conversation: response.conversation || []
  };
}

async function getPermissionMode() {
  const stored = await chrome.storage.local.get({ agentPermissionMode: AGENT_MODES.AUTO });
  return normalizeAgentMode(stored.agentPermissionMode);
}

async function setPermissionMode(mode) {
  const normalized = normalizeAgentMode(mode);
  await chrome.storage.local.set({ agentPermissionMode: normalized });
  return normalized;
}

async function handleChatGptMessage(message) {
  switch (message.type) {
    case 'chatgpt.status':
      return chatGptStatus(message.tabId, { includeConversation: message.includeConversation !== false });
    case 'chatgpt.sync':
      return syncChatGpt(message.tabId, message.limit);
    case 'chatgpt.new':
      return createChatGptTab(Boolean(message.active));
    case 'chatgpt.open':
      return openChatGptTab();
    case 'chatgpt.select':
      return selectChatGptTab(message.tabId);
    default:
      throw new Error('unsupported_chatgpt_message');
  }
}

async function handleAgentControlMessage(message) {
  switch (message.type) {
    case 'agent.group.ensure':
      return ensureAgentGroup(message.seedTabId ?? null, {
        forceNewIfOutside: Boolean(message.forceNewIfOutside)
      });
    case 'agent.group.status':
      return getAgentGroupStatus();
    case 'agent.group.new':
      return activateAgentGroupForTab(message.seedTabId, { forceNewIfOutside: true });
    case 'agent.mode.get':
      return { mode: await getPermissionMode() };
    case 'agent.mode.set':
      return { mode: await setPermissionMode(message.mode) };
    case 'agent.state': {
      const stored = await chrome.storage.local.get({ agentRunState: null });
      return stored.agentRunState || null;
    }
    default:
      throw new Error('unsupported_agent_control_message');
  }
}

function handleRuntimeMessage(message, _sender, sendResponse) {
  const type = String(message?.type || '');
  if (!type || type === 'agent.event') return;

  let handler = null;
  if (type.startsWith('chatgpt.')) handler = handleChatGptMessage;
  else if (type.startsWith('agent.group.') || type.startsWith('agent.mode.') || type === 'agent.state') {
    handler = handleAgentControlMessage;
  }
  if (!handler) return;

  Promise.resolve(handler(message))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
}

export function installRuntimeControl() {
  if (installed) return;
  installed = true;
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}
