import {
  activateAgentGroupForTab,
  getAgentGroupStatus
} from './tab-group-session.js';
import { ensureChatGptForGroup } from './runtime-control.js';

const PANEL_PATH = 'sidepanel.html';
const ACTIVE_RUN_STATUSES = new Set(['running', 'awaiting_approval']);

let syncTimer = null;
let installed = false;
const pendingUserGestureTabs = new Set();

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

async function setTabPanelState(tab, enabled, inAgentGroup = false) {
  try {
    if (enabled) {
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: PANEL_PATH,
        enabled: true
      });
      await chrome.action.setTitle({
        tabId: tab.id,
        title: inAgentGroup
          ? 'Open ChatGPT Web Agent'
          : 'Start ChatGPT Web Agent on this website'
      });
      return;
    }

    await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: 'ChatGPT Web Agent is unavailable on this page'
    });
  } catch {}
}

async function closePanelsOutsideActiveGroup(status, tabs) {
  const enabledTabIds = groupTabIds(status);
  const activeTabs = tabs.filter((tab) => tab?.id && tab.active);

  await Promise.allSettled(activeTabs.map(async (tab) => {
    if (enabledTabIds.has(Number(tab.id))) return;
    if (pendingUserGestureTabs.has(Number(tab.id))) return;
    await closePanelForTab(tab.id);
    await closePanelInWindow(tab.windowId);
  }));
}

async function closeIfOutsideActiveGroup(tabId, windowId) {
  const status = await getAgentGroupStatus().catch(() => ({ active: false, tabs: [] }));
  const ids = groupTabIds(status);
  if (ids.has(Number(tabId)) || pendingUserGestureTabs.has(Number(tabId))) return;
  await closePanelForTab(tabId);
  await closePanelInWindow(windowId);
}

export async function syncSidePanelVisibility() {
  const [status, tabs] = await Promise.all([
    getAgentGroupStatus().catch(() => ({ active: false, tabs: [] })),
    chrome.tabs.query({})
  ]);

  await disableGlobalPanelDefault();
  const agentTabIds = groupTabIds(status);

  await Promise.allSettled(
    tabs.filter((tab) => tab.id).map((tab) => {
      const eligible = isEligibleWebsiteTab(tab);
      return setTabPanelState(tab, eligible, agentTabIds.has(Number(tab.id)));
    })
  );

  await closePanelsOutsideActiveGroup(status, tabs);

  return {
    groupId: status?.groupId ?? null,
    enabledTabIds: [...agentTabIds]
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

  await ensureChatGptForGroup(status.groupId, {
    forceNew: false,
    active: false,
    windowId: status.windowId
  }).catch(() => {});

  const tab = await chrome.tabs.get(preferred.id);
  await setTabPanelState(tab, true, true);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
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
      return currentStatus;
    }
  }

  const nextStatus = alreadyInActiveGroup
    ? await activateAgentGroupForTab(tab.id, { forceNewIfOutside: false })
    : await activateAgentGroupForTab(tab.id, { forceNewIfOutside: true });

  // A newly started browser workspace gets a fresh ChatGPT reasoning tab.
  // Reopening the same Agent group reuses its bound ChatGPT tab if it still exists.
  await ensureChatGptForGroup(nextStatus.groupId, {
    forceNew: !alreadyInActiveGroup,
    active: false,
    windowId: nextStatus.windowId
  });

  await syncSidePanelVisibility();
  return nextStatus;
}

function openPanelFromUserGesture(tab) {
  if (!isEligibleWebsiteTab(tab)) return;

  const tabId = Number(tab.id);
  pendingUserGestureTabs.add(tabId);

  chrome.sidePanel.setOptions({
    tabId,
    path: PANEL_PATH,
    enabled: true
  }).catch(() => {});

  try {
    const opening = chrome.sidePanel.open({ tabId });
    if (opening?.catch) {
      opening.catch((error) => console.error('Failed to open scoped side panel from user gesture:', error));
    }
  } catch (error) {
    console.error('Failed to open scoped side panel from user gesture:', error);
  }

  handleActionClick(tab)
    .catch(async (error) => {
      console.error('Failed to prepare scoped side panel:', error);
      await closePanelForTab(tabId);
      if (tab.windowId != null) await closePanelInWindow(tab.windowId);
    })
    .finally(() => {
      setTimeout(() => {
        pendingUserGestureTabs.delete(tabId);
        scheduleSync(0);
      }, 500);
    });
}

async function enforceOpenedPanelScope(info) {
  if (info?.tabId != null && pendingUserGestureTabs.has(Number(info.tabId))) return;

  const status = await getAgentGroupStatus().catch(() => ({ active: false, tabs: [] }));
  const enabledTabIds = groupTabIds(status);

  if (info?.tabId != null) {
    if (!enabledTabIds.has(Number(info.tabId))) {
      await closePanelForTab(info.tabId);
      if (info.windowId != null) await closePanelInWindow(info.windowId);
    }
    return;
  }

  if (info?.windowId != null) await closePanelInWindow(info.windowId);
}

export async function installTabScopedSidePanel() {
  if (installed) return;
  installed = true;

  await configureScopedBehavior();

  chrome.action.onClicked.addListener((tab) => {
    openPanelFromUserGesture(tab);
  });

  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    closeIfOutsideActiveGroup(tabId, windowId).catch(() => {});
    scheduleSync(0);
  });
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
