(() => {
  const groupDot = document.querySelector('#groupDot');
  const groupName = document.querySelector('#groupName');
  const groupMeta = document.querySelector('#groupMeta');
  const useCurrentTabButton = document.querySelector('#useCurrentTab');
  const BINDINGS_KEY = 'agentGroupChatBindings';

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

  async function getBindings() {
    const stored = await chrome.storage.local.get({ [BINDINGS_KEY]: {} });
    return stored[BINDINGS_KEY] && typeof stored[BINDINGS_KEY] === 'object' ? stored[BINDINGS_KEY] : {};
  }

  async function saveBinding(groupId, chatTabId) {
    if (groupId == null || chatTabId == null) return;
    const bindings = await getBindings();
    bindings[String(groupId)] = Number(chatTabId);
    await chrome.storage.local.set({ [BINDINGS_KEY]: bindings });
  }

  async function removeBinding(groupId) {
    const bindings = await getBindings();
    delete bindings[String(groupId)];
    await chrome.storage.local.set({ [BINDINGS_KEY]: bindings });
  }

  async function selectBoundConversation(groupId) {
    const bindings = await getBindings();
    const chatTabId = Number(bindings[String(groupId)] || 0);
    if (!chatTabId) return false;
    try {
      await runtimeRequest('chatgpt.select', { tabId: chatTabId });
      return true;
    } catch {
      await removeBinding(groupId);
      return false;
    }
  }

  async function createConversationForGroup(groupId) {
    const state = await runtimeRequest('chatgpt.new', { active: false });
    const chatTabId = Number(state?.selectedTabId || 0);
    if (!chatTabId) throw new Error('chatgpt_group_conversation_not_created');
    await saveBinding(groupId, chatTabId);
    return state;
  }

  async function ensureConversationForGroup(groupId) {
    if (await selectBoundConversation(groupId)) return;
    await createConversationForGroup(groupId);
  }

  async function refreshGroup() {
    try {
      const state = await runtimeRequest('agent.group.status');
      renderGroup(state);
      if (state?.active) await selectBoundConversation(state.groupId);
    } catch (error) {
      groupDot.className = 'status-dot offline';
      groupName.textContent = 'Group unavailable';
      groupMeta.textContent = error?.message || String(error);
    }
  }

  async function initializeGroup() {
    try {
      const previous = await runtimeRequest('agent.group.status').catch(() => null);
      const tab = await getActiveTab();
      if (tab?.id && isEligibleWebsiteUrl(tab.url)) {
        const alreadyInCurrentGroup = Boolean(previous?.active && previous.tabs?.some((item) => Number(item.id) === Number(tab.id)));
        const state = await runtimeRequest('agent.group.ensure', {
          seedTabId: tab.id,
          forceNewIfOutside: true
        });
        renderGroup(state);

        if (alreadyInCurrentGroup) {
          await ensureConversationForGroup(state.groupId);
        } else {
          await createConversationForGroup(state.groupId);
        }
        return;
      }

      if (previous?.active) {
        renderGroup(previous);
        await ensureConversationForGroup(previous.groupId);
      } else {
        await refreshGroup();
      }
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
      const state = await runtimeRequest('agent.group.new', { seedTabId: tab.id });
      renderGroup(state);
      await createConversationForGroup(state.groupId);
    } catch (error) {
      groupDot.className = 'status-dot offline';
      groupName.textContent = 'Cannot use current tab';
      groupMeta.textContent = error?.message || String(error);
    } finally {
      useCurrentTabButton.disabled = false;
    }
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const bindings = await getBindings();
    let changed = false;
    for (const [groupId, chatTabId] of Object.entries(bindings)) {
      if (Number(chatTabId) === Number(tabId)) {
        delete bindings[groupId];
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ [BINDINGS_KEY]: bindings });
    setTimeout(refreshGroup, 100);
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === 'complete') setTimeout(refreshGroup, 100);
  });

  initializeGroup();
  setInterval(refreshGroup, 4000);
})();
