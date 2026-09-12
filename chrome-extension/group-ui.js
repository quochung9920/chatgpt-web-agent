const groupDot = document.querySelector('#groupDot');
const groupName = document.querySelector('#groupName');
const groupMeta = document.querySelector('#groupMeta');
const useCurrentTabButton = document.querySelector('#useCurrentTab');

function isEligibleWebsiteUrl(url) {
  const value = String(url || '');
  return /^https?:\/\//i.test(value) && !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(value);
}

async function runtimeRequest(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || `${type}_failed`);
  return response.result;
}

function renderGroup(state) {
  if (!state?.active) {
    groupDot.className = 'status-dot offline';
    groupName.textContent = 'No agent group';
    groupMeta.textContent = 'Open the panel on a website to create one';
    return;
  }

  groupDot.className = 'status-dot online';
  groupName.textContent = state.title || 'ChatGPT Agent';
  groupMeta.textContent = `${state.tabCount || 0} website tab${state.tabCount === 1 ? '' : 's'} · group ${state.groupId}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function refreshGroup() {
  try {
    renderGroup(await runtimeRequest('agent.group.status'));
  } catch (error) {
    groupDot.className = 'status-dot offline';
    groupName.textContent = 'Group unavailable';
    groupMeta.textContent = error?.message || String(error);
  }
}

async function initializeGroup() {
  try {
    const tab = await getActiveTab();
    if (tab?.id && isEligibleWebsiteUrl(tab.url)) {
      const state = await runtimeRequest('agent.group.ensure', {
        seedTabId: tab.id,
        forceNewIfOutside: true
      });
      renderGroup(state);
      return;
    }
    await refreshGroup();
  } catch (error) {
    groupDot.className = 'status-dot offline';
    groupName.textContent = 'No agent group';
    groupMeta.textContent = error?.message || 'Open the panel on a website';
  }
}

useCurrentTabButton.addEventListener('click', async () => {
  useCurrentTabButton.disabled = true;
  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isEligibleWebsiteUrl(tab.url)) throw new Error('Current tab is not a website');
    renderGroup(await runtimeRequest('agent.group.new', { seedTabId: tab.id }));
  } catch (error) {
    groupDot.className = 'status-dot offline';
    groupName.textContent = 'Cannot use current tab';
    groupMeta.textContent = error?.message || String(error);
  } finally {
    useCurrentTabButton.disabled = false;
  }
});

chrome.tabs.onRemoved.addListener(() => setTimeout(refreshGroup, 100));
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') setTimeout(refreshGroup, 100);
});

initializeGroup();
setInterval(refreshGroup, 4000);
