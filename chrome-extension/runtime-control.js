import {
  activateAgentGroupForTab,
  ensureAgentGroup,
  getAgentGroupStatus
} from './tab-group-session.js';
import { AGENT_MODES, normalizeAgentMode } from './agent-policy.js';

const GROUP_CHAT_BINDINGS_KEY = 'agentGroupChatBindings';
const groupChatCreationLocks = new Map();
let installed = false;

function isChatGptUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(String(url || ''));
}

function isChatGptSessionUrl(url) {
  return isChatGptUrl(url) || /^https:\/\/auth\.openai\.com\//i.test(String(url || ''));
}

async function listChatGptTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab?.id && isChatGptSessionUrl(tab.url))
    .map(({ id, title, url, active, windowId }) => ({ id, title, url, active, windowId }));
}

async function getGroupChatBindings() {
  const stored = await chrome.storage.local.get({ [GROUP_CHAT_BINDINGS_KEY]: {} });
  const value = stored[GROUP_CHAT_BINDINGS_KEY];
  return value && typeof value === 'object' ? value : {};
}

async function saveGroupChatBinding(groupId, tabId) {
  if (groupId == null || tabId == null) return;
  const bindings = await getGroupChatBindings();
  bindings[String(groupId)] = Number(tabId);
  await chrome.storage.local.set({
    [GROUP_CHAT_BINDINGS_KEY]: bindings,
    chatgptTabId: Number(tabId)
  });
}

async function removeGroupChatBinding(groupId) {
  if (groupId == null) return;
  const bindings = await getGroupChatBindings();
  if (!(String(groupId) in bindings)) return;
  delete bindings[String(groupId)];
  await chrome.storage.local.set({ [GROUP_CHAT_BINDINGS_KEY]: bindings });
}

async function getBoundChatGptTab(groupId) {
  if (groupId == null) return null;
  const bindings = await getGroupChatBindings();
  const tabId = Number(bindings[String(groupId)] || 0);
  if (!tabId) return null;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.id && isChatGptSessionUrl(tab.url)) return tab;
  } catch {}

  await removeGroupChatBinding(groupId);
  return null;
}

async function resolveChatGptTab(preferredTabId = null, { allowAny = true } = {}) {
  const stored = await chrome.storage.local.get({ chatgptTabId: null });
  const candidates = [preferredTabId, stored.chatgptTabId]
    .filter((value) => value != null)
    .map(Number)
    .filter(Number.isFinite);

  for (const id of candidates) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab?.id && isChatGptSessionUrl(tab.url)) {
        await chrome.storage.local.set({ chatgptTabId: tab.id });
        return tab;
      }
    } catch {}
  }

  if (!allowAny) return null;

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
      if (tab.status === 'complete' && isChatGptSessionUrl(tab.url)) return tab;
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

async function chatGptStatus(preferredTabId = null, { includeConversation = true, allowAny = true } = {}) {
  const tabs = await listChatGptTabs();
  const tab = await resolveChatGptTab(preferredTabId, { allowAny });
  if (!tab) {
    return {
      open: false,
      tabs,
      selectedTabId: null,
      bridgeReady: false,
      conversation: []
    };
  }

  if (!isChatGptUrl(tab.url)) {
    return {
      open: true,
      tabs: await listChatGptTabs(),
      selectedTabId: tab.id,
      selectedTitle: tab.title || 'ChatGPT sign in',
      selectedUrl: tab.url,
      bridgeReady: false,
      conversation: [],
      error: 'chatgpt_sign_in_required'
    };
  }

  try {
    const bridge = await sendChatBridge(tab.id, { type: 'chatgpt.bridge.ping' });
    return {
      open: true,
      tabs: await listChatGptTabs(),
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
      tabs: await listChatGptTabs(),
      selectedTabId: tab.id,
      selectedTitle: tab.title || 'ChatGPT',
      selectedUrl: tab.url,
      bridgeReady: false,
      conversation: [],
      error: error?.message || String(error)
    };
  }
}

async function createChatGptTab(active = false, windowId = null) {
  const createProperties = {
    url: 'https://chatgpt.com/',
    active: Boolean(active)
  };
  if (Number.isInteger(Number(windowId)) && Number(windowId) >= 0) {
    createProperties.windowId = Number(windowId);
  }

  const tab = await chrome.tabs.create(createProperties);
  if (!tab?.id) throw new Error('chatgpt_tab_create_failed');

  try {
    const refreshed = await chrome.tabs.get(tab.id);
    if (Number(refreshed.groupId) >= 0) await chrome.tabs.ungroup(tab.id);
  } catch {}

  await chrome.storage.local.set({ chatgptTabId: tab.id });
  await waitForTabReady(tab.id);
  return chrome.tabs.get(tab.id);
}

async function createAndBindChatForGroup(groupId, { active = false, windowId = null } = {}) {
  const key = String(groupId);
  if (groupChatCreationLocks.has(key)) return groupChatCreationLocks.get(key);

  const creation = (async () => {
    const tab = await createChatGptTab(active, windowId);
    await saveGroupChatBinding(groupId, tab.id);
    return chatGptStatus(tab.id, { allowAny: false });
  })();

  groupChatCreationLocks.set(key, creation);
  try {
    return await creation;
  } finally {
    if (groupChatCreationLocks.get(key) === creation) groupChatCreationLocks.delete(key);
  }
}

export async function ensureChatGptForGroup(groupId, {
  forceNew = false,
  active = false,
  windowId = null
} = {}) {
  if (groupId == null) throw new Error('agent_group_id_required');

  const key = String(groupId);
  if (groupChatCreationLocks.has(key)) return groupChatCreationLocks.get(key);

  if (!forceNew) {
    const bound = await getBoundChatGptTab(groupId);
    if (bound?.id) {
      await chrome.storage.local.set({ chatgptTabId: bound.id });
      return chatGptStatus(bound.id, { allowAny: false });
    }
  }

  return createAndBindChatForGroup(groupId, { active, windowId });
}

async function statusForCurrentGroup(preferredTabId = null, includeConversation = true) {
  if (preferredTabId != null) {
    return chatGptStatus(preferredTabId, { includeConversation });
  }

  const group = await getAgentGroupStatus().catch(() => null);
  if (group?.active && group.groupId != null) {
    return ensureChatGptForGroup(group.groupId, {
      forceNew: false,
      active: false,
      windowId: group.windowId
    });
  }

  return chatGptStatus(null, { includeConversation });
}

async function createChatForCurrentGroup(active = false) {
  const group = await getAgentGroupStatus().catch(() => null);
  if (group?.active && group.groupId != null) {
    return createAndBindChatForGroup(group.groupId, {
      active,
      windowId: group.windowId
    });
  }

  const tab = await createChatGptTab(active, null);
  return chatGptStatus(tab.id, { allowAny: false });
}

async function selectChatGptTab(tabId) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!tab?.id || !isChatGptSessionUrl(tab.url)) throw new Error('not_a_chatgpt_tab');
  await chrome.storage.local.set({ chatgptTabId: tab.id });

  const group = await getAgentGroupStatus().catch(() => null);
  if (group?.active && group.groupId != null) {
    await saveGroupChatBinding(group.groupId, tab.id);
  }

  return chatGptStatus(tab.id, { allowAny: false });
}

async function openChatGptTab() {
  const group = await getAgentGroupStatus().catch(() => null);
  let tab = null;

  if (group?.active && group.groupId != null) {
    tab = await getBoundChatGptTab(group.groupId);
    if (!tab) {
      const created = await ensureChatGptForGroup(group.groupId, {
        active: false,
        windowId: group.windowId
      });
      if (created?.selectedTabId) tab = await chrome.tabs.get(created.selectedTabId);
    }
  }

  if (!tab) tab = await resolveChatGptTab();
  if (!tab) {
    tab = await createChatGptTab(false, group?.windowId ?? null);
    if (group?.active && group.groupId != null) await saveGroupChatBinding(group.groupId, tab.id);
  }

  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return chatGptStatus(tab.id, { allowAny: false });
}

async function syncChatGpt(tabId, limit = 40) {
  const tab = await resolveChatGptTab(tabId, { allowAny: true });
  if (!tab || !isChatGptUrl(tab.url)) throw new Error('chatgpt_tab_not_ready');
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
      return statusForCurrentGroup(message.tabId, message.includeConversation !== false);
    case 'chatgpt.sync':
      return syncChatGpt(message.tabId, message.limit);
    case 'chatgpt.new':
      return createChatForCurrentGroup(Boolean(message.active));
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
