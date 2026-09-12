import {
  activateAgentGroupForTab,
  getAgentGroupStatus
} from './tab-group-session.js';

const PANEL_PATH = 'sidepanel.html';
const ACTIVE_RUN_STATUSES = new Set(['running', 'awaiting_approval']);

let syncTimer = null;
let installed = false;

function isChatGptUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(String(url || ''));
}

function isEligibleWebsiteTab(tab) {
  return Boolean(tab?.id && /^https?:\/\//i.test(String(tab.url || '')) && !isChatGptUrl(tab.url));
}

async function setTabPanelState(tab, enabled) {
  try {
    if (enabled) {
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: PANEL_PATH,
        enabled: true
      });
      await chrome.action.setTitle({ tabId: tab.id, title: 'Open ChatGPT Web Agent' });
      return;
    }

    await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: isEligibleWebsiteTab(tab)
        ? 'Start ChatGPT Web Agent on this website'
        : 'ChatGPT Web Agent is unavailable on this page'
    });
  } catch {}
}

export async function syncSidePanelVisibility() {
  const [status, tabs] = await Promise.all([
    getAgentGroupStatus().catch(() => ({ active: false, tabs: [] })),
    chrome.tabs.query({})
  ]);

  const enabledTabIds = new Set(
    status?.active
      ? (status.tabs || []).filter((tab) => isEligibleWebsiteTab(tab)).map((tab) => Number(tab.id))
      : []
  );

  await Promise.allSettled(
    tabs.filter((tab) => tab.id).map((tab) => setTabPanelState(tab, enabledTabIds.has(Number(tab.id))))
  );

  return {
    groupId: status?.groupId ?? null,
    enabledTabIds: [...enabledTabIds]
  };
}

function scheduleSync(delay = 60) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncSidePanelVisibility().catch(() => {});
  }, delay);
}

async function getRunningState() {
  const stored = await chrome.storage.local.get({ agentRunState: null });
  return stored.agentRunState || null;
}

async function focusExistingAgentGroup(status) {
  const preferred = (status.tabs || []).find((tab) => tab.id === status.workingTabId)
    || (status.tabs || []).find((tab) => tab.active)
    || (status.tabs || [])[0];
  if (!preferred?.id) return false;

  const tab = await chrome.tabs.get(preferred.id);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await setTabPanelState(tab, true);
  await chrome.sidePanel.open({ tabId: tab.id });
  return true;
}

async function handleActionClick(tab) {
  if (!isEligibleWebsiteTab(tab)) return;

  const currentStatus = await getAgentGroupStatus().catch(() => ({ active: false, tabs: [] }));
  const alreadyInActiveGroup = Boolean(
    currentStatus?.active && (currentStatus.tabs || []).some((item) => Number(item.id) === Number(tab.id))
  );

  if (!alreadyInActiveGroup) {
    const runState = await getRunningState();
    if (runState && ACTIVE_RUN_STATUSES.has(String(runState.status || '')) && currentStatus?.active) {
      await focusExistingAgentGroup(currentStatus);
      return;
    }
  }

  const nextStatus = alreadyInActiveGroup
    ? await activateAgentGroupForTab(tab.id, { forceNewIfOutside: false })
    : await activateAgentGroupForTab(tab.id, { forceNewIfOutside: true });

  await syncSidePanelVisibility();
  const refreshed = await chrome.tabs.get(tab.id);
  await setTabPanelState(refreshed, true);
  await chrome.sidePanel.open({ tabId: tab.id });

  return nextStatus;
}

export async function installTabScopedSidePanel() {
  if (installed) return;
  installed = true;

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch {}

  chrome.action.onClicked.addListener((tab) => {
    handleActionClick(tab).catch((error) => console.error('Failed to open scoped side panel:', error));
  });

  chrome.tabs.onActivated.addListener(() => scheduleSync(0));
  chrome.tabs.onCreated.addListener(() => scheduleSync());
  chrome.tabs.onRemoved.addListener(() => scheduleSync());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === 'complete') scheduleSync();
  });

  if (chrome.tabGroups?.onUpdated) chrome.tabGroups.onUpdated.addListener(() => scheduleSync());
  if (chrome.tabGroups?.onRemoved) chrome.tabGroups.onRemoved.addListener(() => scheduleSync());

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.agentGroupId || changes.agentGroupWindowId || changes.agentWorkingTabId) scheduleSync(0);
  });

  await syncSidePanelVisibility();
}
