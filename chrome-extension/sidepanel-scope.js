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

function groupTabIds(status) {
  return new Set(
    status?.active
      ? (status.tabs || []).filter((tab) => isEligibleWebsiteTab(tab)).map((tab) => Number(tab.id))
      : []
  );
}

async function disableGlobalPanelDefault() {
  try {
    // The manifest declares a default_path so Chrome recognizes the extension as a
    // side-panel extension. Override that global default at runtime. Only explicit
    // tab-specific options for the current ChatGPT Agent group are enabled below.
    await chrome.sidePanel.setOptions({ enabled: false });
  } catch {}
}

async function closePanelInWindow(windowId) {
  if (!Number.isFinite(Number(windowId)) || typeof chrome.sidePanel.close !== 'function') return;
  try {
    await chrome.sidePanel.close({ windowId: Number(windowId) });
  } catch {}
}

async function closePanelForTab(tabId) {
  if (!Number.isFinite(Number(tabId)) || typeof chrome.sidePanel.close !== 'function') return;
  try {
    await chrome.sidePanel.close({ tabId: Number(tabId) });
  } catch {}
}

async function configureScopedBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch {}
  await disableGlobalPanelDefault();
  await syncSidePanelVisibility().catch(() => {});
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

async function closePanelsOutsideActiveGroup(status, tabs) {
  const enabledTabIds = groupTabIds(status);
  const activeTabs = tabs.filter((tab) => tab?.id && tab.active);

  await Promise.allSettled(activeTabs.map(async (tab) => {
    if (enabledTabIds.has(Number(tab.id))) return;

    // Close both possible contexts. A panel opened by an older extension version
    // may still be a global/window panel; a newer one may be tab-specific.
    await closePanelForTab(tab.id);
    await closePanelInWindow(tab.windowId);
  }));
}

export async function syncSidePanelVisibility() {
  const [status, tabs] = await Promise.all([
    getAgentGroupStatus().catch(() => ({ active: false, tabs: [] })),
    chrome.tabs.query({})
  ]);

  await disableGlobalPanelDefault();

  const enabledTabIds = groupTabIds(status);

  await Promise.allSettled(
    tabs.filter((tab) => tab.id).map((tab) => setTabPanelState(tab, enabledTabIds.has(Number(tab.id))))
  );

  await closePanelsOutsideActiveGroup(status, tabs);

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

async function enforceOpenedPanelScope(info) {
  const status = await getAgentGroupStatus().catch(() => ({ active: false, tabs: [] }));
  const enabledTabIds = groupTabIds(status);

  if (info?.tabId != null) {
    if (!enabledTabIds.has(Number(info.tabId))) {
      await closePanelForTab(info.tabId);
      if (info.windowId != null) await closePanelInWindow(info.windowId);
    }
    return;
  }

  // A panel with no tabId is a global/window panel. Global panels are never part
  // of an Agent group, so close legacy/stale instances immediately.
  if (info?.windowId != null) await closePanelInWindow(info.windowId);
}

export async function installTabScopedSidePanel() {
  if (installed) return;
  installed = true;

  await configureScopedBehavior();

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

  if (chrome.sidePanel?.onOpened) {
    chrome.sidePanel.onOpened.addListener((info) => {
      enforceOpenedPanelScope(info).catch(() => {});
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.agentGroupId || changes.agentGroupWindowId || changes.agentWorkingTabId) scheduleSync(0);
  });

  chrome.runtime.onInstalled.addListener(() => configureScopedBehavior());
  chrome.runtime.onStartup.addListener(() => configureScopedBehavior());
}
