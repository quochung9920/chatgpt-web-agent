import './background.js';

async function enableSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.error('Failed to configure side panel:', error);
  }
}

function isChatGptUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(String(url || ''));
}

async function listChatGptTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab.id && isChatGptUrl(tab.url))
    .map(({ id, title, url, active, windowId }) => ({ id, title, url, active, windowId }));
}

async function resolveChatGptTab(preferredTabId = null) {
  const stored = await chrome.storage.local.get({ chatgptTabId: null });
  const candidates = [preferredTabId, stored.chatgptTabId].filter(Boolean).map(Number);

  for (const id of candidates) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab?.id && isChatGptUrl(tab.url)) {
        await chrome.storage.local.set({ chatgptTabId: tab.id });
        return tab;
      }
    } catch {
      // Try another candidate.
    }
  }

  const tabs = await listChatGptTabs();
  if (!tabs.length) return null;
  const selected = tabs.find((tab) => tab.active) || tabs[0];
  await chrome.storage.local.set({ chatgptTabId: selected.id });
  return chrome.tabs.get(selected.id);
}

async function waitForTabReady(tabId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete' && isChatGptUrl(tab.url)) return tab;
    } catch {
      throw new Error('chatgpt_tab_closed');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('chatgpt_tab_load_timeout');
}

async function sendBridgeMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const text = String(error?.message || error || '');
    if (!text.includes('Receiving end does not exist') && !text.includes('Could not establish connection')) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['chatgpt-content.js'] });
    await new Promise((resolve) => setTimeout(resolve, 80));
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function ensureChatGptBridge(tabId) {
  const response = await sendBridgeMessage(tabId, { type: 'chatgpt.bridge.ping' });
  if (!response?.ok) throw new Error(response?.error || 'chatgpt_bridge_unavailable');
  return response;
}

async function chatGptStatus(preferredTabId = null) {
  const tabs = await listChatGptTabs();
  const tab = await resolveChatGptTab(preferredTabId);
  if (!tab) return { open: false, tabs, selectedTabId: null, bridgeReady: false };

  try {
    const bridge = await ensureChatGptBridge(tab.id);
    return {
      open: true,
      tabs,
      selectedTabId: tab.id,
      selectedTitle: tab.title || 'ChatGPT',
      selectedUrl: tab.url,
      bridgeReady: Boolean(bridge.composer),
      conversation: bridge.conversation || []
    };
  } catch (error) {
    return {
      open: true,
      tabs,
      selectedTabId: tab.id,
      selectedTitle: tab.title || 'ChatGPT',
      selectedUrl: tab.url,
      bridgeReady: false,
      error: error?.message || String(error)
    };
  }
}

async function openNewChatGptTab(active = false) {
  const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: Boolean(active) });
  if (!tab.id) throw new Error('chatgpt_tab_create_failed');
  await chrome.storage.local.set({ chatgptTabId: tab.id });
  await waitForTabReady(tab.id);
  const bridge = await ensureChatGptBridge(tab.id);
  return { tab: await chrome.tabs.get(tab.id), bridge };
}

async function handleChatGptMessage(message) {
  switch (message.type) {
    case 'chatgpt.status':
      return chatGptStatus(message.tabId);

    case 'chatgpt.select': {
      const tab = await chrome.tabs.get(Number(message.tabId));
      if (!isChatGptUrl(tab.url)) throw new Error('not_a_chatgpt_tab');
      await chrome.storage.local.set({ chatgptTabId: tab.id });
      return chatGptStatus(tab.id);
    }

    case 'chatgpt.open': {
      const existing = await resolveChatGptTab();
      if (existing) {
        if (message.active !== false) {
          await chrome.tabs.update(existing.id, { active: true });
          await chrome.windows.update(existing.windowId, { focused: true });
        }
        return chatGptStatus(existing.id);
      }
      await openNewChatGptTab(message.active !== false);
      return chatGptStatus();
    }

    case 'chatgpt.new':
      await openNewChatGptTab(Boolean(message.active));
      return chatGptStatus();

    case 'chatgpt.sync': {
      const tab = await resolveChatGptTab(message.tabId);
      if (!tab) throw new Error('chatgpt_tab_not_found');
      const response = await sendBridgeMessage(tab.id, {
        type: 'chatgpt.bridge.sync',
        limit: message.limit || 30
      });
      if (!response?.ok) throw new Error(response?.error || 'chatgpt_sync_failed');
      return { tabId: tab.id, conversation: response.conversation || [] };
    }

    case 'chatgpt.send': {
      const tab = await resolveChatGptTab(message.tabId);
      if (!tab) throw new Error('chatgpt_tab_not_found');
      const response = await sendBridgeMessage(tab.id, {
        type: 'chatgpt.bridge.send',
        text: message.text,
        timeoutMs: message.timeoutMs || 180000
      });
      if (!response?.ok) throw new Error(response?.error || 'chatgpt_send_failed');
      return {
        tabId: tab.id,
        text: response.text || '',
        conversation: response.conversation || [],
        timedOut: Boolean(response.timedOut)
      };
    }

    default:
      throw new Error('unsupported_chatgpt_message');
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !String(message.type || '').startsWith('chatgpt.')) return;
  handleChatGptMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);
enableSidePanel();
