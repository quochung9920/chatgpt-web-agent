const statusDot = document.querySelector('#statusDot');
const statusText = document.querySelector('#statusText');
const statusDetail = document.querySelector('#statusDetail');
const tabTitle = document.querySelector('#tabTitle');
const tabUrl = document.querySelector('#tabUrl');
const chatgptBadge = document.querySelector('#chatgptBadge');
const chatgptText = document.querySelector('#chatgptText');
const agentIdEl = document.querySelector('#agentId');

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

async function refreshServerStatus() {
  statusDot.className = 'status-dot checking';
  statusText.textContent = 'Checking server…';
  statusDetail.textContent = 'Verifying Web Agent gateway';

  const config = await getConfig();
  agentIdEl.textContent = config.agentId || 'desktop-chrome';

  if (!config.agentToken) {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Agent token missing';
    statusDetail.textContent = 'Open Settings and add AGENT_TOKEN.';
    return;
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
    statusText.textContent = 'Server online';
    statusDetail.textContent = `${config.serverUrl} · ${data.version ? `v${data.version}` : 'reachable'}`;
  } catch (error) {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Server unavailable';
    statusDetail.textContent = `${config.serverUrl} · ${error?.message || 'connection failed'}`;
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

async function findChatGptTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(tab.url || ''));
}

async function refreshChatGptState() {
  const tabs = await findChatGptTabs();
  if (tabs.length) {
    chatgptBadge.textContent = 'Open';
    chatgptBadge.classList.add('active');
    chatgptText.textContent = `Found ${tabs.length} ChatGPT tab${tabs.length > 1 ? 's' : ''} in this Chrome profile. The login session stays inside Chrome.`;
    document.querySelector('#openChatgpt').textContent = 'Switch to ChatGPT';
  } else {
    chatgptBadge.textContent = 'Not open';
    chatgptBadge.classList.remove('active');
    chatgptText.textContent = 'No ChatGPT tab is open in this Chrome profile yet.';
    document.querySelector('#openChatgpt').textContent = 'Open ChatGPT';
  }
}

async function refreshAll() {
  await Promise.all([
    refreshServerStatus(),
    refreshCurrentTab(),
    refreshChatGptState()
  ]);
}

document.querySelector('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.querySelector('#refresh').addEventListener('click', refreshAll);

document.querySelector('#reconnect').addEventListener('click', async () => {
  await chrome.storage.local.set({ reconnectPulse: Date.now() });
  statusDot.className = 'status-dot checking';
  statusText.textContent = 'Reconnect requested';
  statusDetail.textContent = 'Background agent is reconnecting…';
  setTimeout(refreshAll, 1200);
});

document.querySelector('#openChatgpt').addEventListener('click', async () => {
  const tabs = await findChatGptTabs();
  if (tabs.length) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
  }
});

chrome.tabs.onActivated.addListener(() => {
  refreshCurrentTab();
  refreshChatGptState();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    refreshCurrentTab();
    refreshChatGptState();
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverUrl || changes.agentId || changes.agentToken) refreshServerStatus();
});

refreshAll();
setInterval(refreshAll, 5000);
