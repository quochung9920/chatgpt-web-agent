const injectedTabs = new Set();

function isChatGptUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(String(url || ''));
}

async function ensureLiveBridge(tabId) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!tab?.id || !isChatGptUrl(tab.url)) throw new Error('not_a_chatgpt_tab');

  try {
    const ping = await chrome.tabs.sendMessage(tab.id, { type: 'webagent.live.ping' });
    if (ping?.ok) {
      injectedTabs.add(tab.id);
      return ping;
    }
  } catch {}

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['chatgpt-live-bridge.js']
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const ping = await chrome.tabs.sendMessage(tab.id, { type: 'webagent.live.ping' });
  if (!ping?.ok) throw new Error(ping?.error || 'chatgpt_live_bridge_unavailable');
  injectedTabs.add(tab.id);
  return ping;
}

async function sendLiveMessage(tabId, message) {
  await ensureLiveBridge(tabId);
  const response = await chrome.tabs.sendMessage(Number(tabId), message);
  if (!response?.ok) throw new Error(response?.error || 'chatgpt_live_bridge_failed');
  return response;
}

async function broadcastStream(sender, message) {
  const tabId = sender?.tab?.id;
  if (!tabId || !isChatGptUrl(sender.tab.url)) return;
  try {
    await chrome.runtime.sendMessage({
      type: 'webagent.stream',
      tabId,
      text: String(message.text || ''),
      done: Boolean(message.done),
      generating: Boolean(message.generating),
      href: message.href || sender.tab.url || '',
      title: message.title || sender.tab.title || '',
      at: message.at || Date.now()
    });
  } catch {}
}

function handleRequest(message, sender, sendResponse) {
  if (!message?.type) return;

  if (message.type === 'webagent.stream.raw') {
    broadcastStream(sender, message);
    return;
  }

  if (!String(message.type).startsWith('webagent.model.')) return;

  (async () => {
    const tabId = Number(message.tabId);
    if (!tabId) throw new Error('chatgpt_tab_id_required');

    switch (message.type) {
      case 'webagent.model.current':
        return sendLiveMessage(tabId, { type: 'webagent.live.model.current' });
      case 'webagent.model.list':
        return sendLiveMessage(tabId, { type: 'webagent.live.models' });
      case 'webagent.model.select':
        return sendLiveMessage(tabId, { type: 'webagent.live.model.select', label: message.label });
      default:
        throw new Error('unsupported_model_message');
    }
  })()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
}

export function installStreamModelBridge() {
  chrome.runtime.onMessage.addListener(handleRequest);

  chrome.tabs.onRemoved.addListener((tabId) => injectedTabs.delete(Number(tabId)));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !isChatGptUrl(tab?.url)) return;
    ensureLiveBridge(tabId).catch(() => {});
  });

  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (tab?.id && isChatGptUrl(tab.url)) ensureLiveBridge(tab.id).catch(() => {});
    }
  }).catch(() => {});
}
