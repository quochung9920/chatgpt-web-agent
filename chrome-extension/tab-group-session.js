const GROUP_TITLE = 'ChatGPT Agent';
const GROUP_COLOR = 'orange';
const STORAGE_DEFAULTS = {
  agentGroupId: null,
  agentGroupWindowId: null,
  agentWorkingTabId: null
};

const pendingAutoGroupTabs = new Set();

function isWebUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function isChatGptUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(String(url || ''));
}

function isEligibleWebsiteTab(tab) {
  return Boolean(tab?.id && isWebUrl(tab.url) && !isChatGptUrl(tab.url));
}

function summarizeTab(tab) {
  return {
    id: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    active: Boolean(tab.active),
    windowId: tab.windowId,
    groupId: tab.groupId,
    pinned: Boolean(tab.pinned)
  };
}

async function getStoredState() {
  return chrome.storage.local.get(STORAGE_DEFAULTS);
}

async function clearStoredGroup() {
  await chrome.storage.local.set({
    agentGroupId: null,
    agentGroupWindowId: null,
    agentWorkingTabId: null
  });
}

async function getGroupIfValid(groupId) {
  const id = Number(groupId);
  if (!Number.isInteger(id) || id < 0) return null;
  try {
    return await chrome.tabGroups.get(id);
  } catch {
    return null;
  }
}

async function getTabsInGroup(groupId) {
  if (!Number.isInteger(Number(groupId)) || Number(groupId) < 0) return [];
  return chrome.tabs.query({ groupId: Number(groupId) });
}

async function saveGroup(group, workingTabId = null) {
  await chrome.storage.local.set({
    agentGroupId: group.id,
    agentGroupWindowId: group.windowId,
    agentWorkingTabId: workingTabId ?? null
  });
}

async function formatSession(group, tabs, workingTabId = null) {
  const websiteTabs = tabs.filter((tab) => isWebUrl(tab.url) && !isChatGptUrl(tab.url));
  const preferred = websiteTabs.find((tab) => tab.id === Number(workingTabId))
    || websiteTabs.find((tab) => tab.active)
    || websiteTabs[0]
    || null;

  return {
    active: true,
    groupId: group.id,
    windowId: group.windowId,
    title: group.title || GROUP_TITLE,
    color: group.color || GROUP_COLOR,
    collapsed: Boolean(group.collapsed),
    tabCount: websiteTabs.length,
    workingTabId: preferred?.id || null,
    tabs: websiteTabs.map(summarizeTab)
  };
}

export async function getAgentGroupStatus({ createIfMissing = false } = {}) {
  const stored = await getStoredState();
  const group = await getGroupIfValid(stored.agentGroupId);

  if (!group) {
    if (stored.agentGroupId != null) await clearStoredGroup();
    if (createIfMissing) return ensureAgentGroup();
    return {
      active: false,
      groupId: null,
      windowId: null,
      title: GROUP_TITLE,
      color: GROUP_COLOR,
      tabCount: 0,
      workingTabId: null,
      tabs: []
    };
  }

  const tabs = await getTabsInGroup(group.id);
  if (!tabs.length) {
    await clearStoredGroup();
    if (createIfMissing) return ensureAgentGroup();
    return {
      active: false,
      groupId: null,
      windowId: null,
      title: GROUP_TITLE,
      color: GROUP_COLOR,
      tabCount: 0,
      workingTabId: null,
      tabs: []
    };
  }

  return formatSession(group, tabs, stored.agentWorkingTabId);
}

async function createAgentGroupFromTab(tab) {
  if (!isEligibleWebsiteTab(tab)) throw new Error('agent_group_requires_website_tab');

  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  const group = await chrome.tabGroups.update(groupId, {
    title: GROUP_TITLE,
    color: GROUP_COLOR,
    collapsed: false
  });
  await saveGroup(group, tab.id);
  return formatSession(group, [await chrome.tabs.get(tab.id)], tab.id);
}

export async function activateAgentGroupForTab(tabId, { forceNewIfOutside = true } = {}) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!isEligibleWebsiteTab(tab)) throw new Error('agent_group_requires_website_tab');

  const stored = await getStoredState();
  const currentGroup = await getGroupIfValid(stored.agentGroupId);
  if (currentGroup) {
    const currentTabs = await getTabsInGroup(currentGroup.id);
    if (currentTabs.some((item) => item.id === tab.id)) {
      await saveGroup(currentGroup, tab.id);
      return formatSession(currentGroup, currentTabs, tab.id);
    }
    if (!forceNewIfOutside) return formatSession(currentGroup, currentTabs, stored.agentWorkingTabId);
  }

  if (tab.groupId != null && tab.groupId >= 0) {
    const existingGroup = await getGroupIfValid(tab.groupId);
    if (existingGroup?.title === GROUP_TITLE) {
      const tabs = await getTabsInGroup(existingGroup.id);
      await saveGroup(existingGroup, tab.id);
      return formatSession(existingGroup, tabs, tab.id);
    }
  }

  return createAgentGroupFromTab(tab);
}

export async function ensureAgentGroup(seedTabId = null, { forceNewIfOutside = false } = {}) {
  if (seedTabId != null) {
    return activateAgentGroupForTab(seedTabId, { forceNewIfOutside });
  }

  const status = await getAgentGroupStatus();
  if (status.active) return status;

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isEligibleWebsiteTab(active)) return createAgentGroupFromTab(active);

  const candidates = (await chrome.tabs.query({ currentWindow: true })).filter(isEligibleWebsiteTab);
  if (!candidates.length) throw new Error('no_website_tab_for_agent_group');
  return createAgentGroupFromTab(candidates[0]);
}

export async function assertTabInAgentGroup(tabId) {
  const status = await getAgentGroupStatus();
  if (!status.active) throw new Error('agent_group_not_ready');

  const id = Number(tabId);
  const tab = await chrome.tabs.get(id);
  if (tab.groupId !== status.groupId || tab.windowId !== status.windowId) {
    throw new Error('tab_outside_agent_group');
  }
  if (!isWebUrl(tab.url) || isChatGptUrl(tab.url)) throw new Error('tab_not_available_to_agent');
  return tab;
}

export async function getPreferredAgentTab() {
  const status = await getAgentGroupStatus({ createIfMissing: true });
  if (!status.tabs.length) throw new Error('agent_group_has_no_website_tabs');

  const preferred = status.tabs.find((tab) => tab.id === status.workingTabId)
    || status.tabs.find((tab) => tab.active)
    || status.tabs[0];
  return chrome.tabs.get(preferred.id);
}

export async function setAgentWorkingTab(tabId) {
  const tab = await assertTabInAgentGroup(tabId);
  await chrome.storage.local.set({ agentWorkingTabId: tab.id });
  return tab;
}

export async function addTabToAgentGroup(tabId) {
  const status = await getAgentGroupStatus({ createIfMissing: true });
  let tab = await chrome.tabs.get(Number(tabId));
  if (!isWebUrl(tab.url) || isChatGptUrl(tab.url)) return null;

  if (tab.windowId !== status.windowId) {
    tab = await chrome.tabs.move(tab.id, { windowId: status.windowId, index: -1 });
  }

  if (tab.groupId !== status.groupId) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: status.groupId });
  }
  await chrome.tabGroups.update(status.groupId, { collapsed: false });
  await chrome.storage.local.set({ agentWorkingTabId: tab.id });
  return chrome.tabs.get(tab.id);
}

export async function createTabInAgentGroup(url, { active = true } = {}) {
  const target = String(url || '');
  if (!isWebUrl(target)) throw new Error('invalid_url');
  if (isChatGptUrl(target)) throw new Error('chatgpt_tab_cannot_join_agent_group');

  const status = await getAgentGroupStatus({ createIfMissing: true });
  const tab = await chrome.tabs.create({
    url: target,
    active: Boolean(active),
    windowId: status.windowId
  });
  await chrome.tabs.group({ tabIds: [tab.id], groupId: status.groupId });
  await chrome.tabGroups.update(status.groupId, { collapsed: false });
  await chrome.storage.local.set({ agentWorkingTabId: tab.id });
  return chrome.tabs.get(tab.id);
}

async function shouldAutoCapture(tab) {
  const status = await getAgentGroupStatus();
  if (!status.active || tab.windowId !== status.windowId) return false;
  if (isChatGptUrl(tab.url)) return false;

  if (tab.openerTabId) {
    try {
      const opener = await chrome.tabs.get(tab.openerTabId);
      if (opener.groupId === status.groupId) return true;
    } catch {}
  }

  const stored = await getStoredState();
  if (!stored.agentWorkingTabId) return false;
  try {
    const working = await chrome.tabs.get(Number(stored.agentWorkingTabId));
    return working.groupId === status.groupId && working.windowId === tab.windowId;
  } catch {
    return false;
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const status = await getAgentGroupStatus();
    if (!status.active) return;
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId === status.groupId && isEligibleWebsiteTab(tab)) {
      await chrome.storage.local.set({ agentWorkingTabId: tab.id });
    }
  } catch {}
});

chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    if (!(await shouldAutoCapture(tab))) return;
    if (isEligibleWebsiteTab(tab)) {
      await addTabToAgentGroup(tab.id);
      return;
    }
    if (!isChatGptUrl(tab.url)) pendingAutoGroupTabs.add(tab.id);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!pendingAutoGroupTabs.has(tabId)) return;
  if (isChatGptUrl(tab.url)) {
    pendingAutoGroupTabs.delete(tabId);
    return;
  }
  if (!isWebUrl(tab.url)) return;

  pendingAutoGroupTabs.delete(tabId);
  try { await addTabToAgentGroup(tabId); } catch {}
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  pendingAutoGroupTabs.delete(tabId);
  try {
    const stored = await getStoredState();
    if (Number(stored.agentWorkingTabId) === Number(tabId)) {
      const status = await getAgentGroupStatus();
      const next = status.tabs[0]?.id || null;
      await chrome.storage.local.set({ agentWorkingTabId: next });
    }
  } catch {}
});

export { GROUP_TITLE, GROUP_COLOR };
