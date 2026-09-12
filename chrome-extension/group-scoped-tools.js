import {
  executeLocalBrowserTool as executeRawBrowserTool,
  isLocalAgentTool,
  LOCAL_AGENT_TOOLS
} from './local-browser-tools.js';
import {
  assertTabInAgentGroup,
  createTabInAgentGroup,
  ensureAgentGroup,
  getAgentGroupStatus,
  getPreferredAgentTab,
  setAgentWorkingTab
} from './tab-group-session.js';

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

function needsWebsiteTab(tool) {
  return tool.startsWith('page.') || [
    'tab.active',
    'tab.navigate',
    'tab.reload',
    'tab.back',
    'tab.forward',
    'tabs.switch',
    'tabs.close'
  ].includes(tool);
}

async function scopeArgs(tool, args = {}) {
  const next = { ...(args || {}) };
  if (!needsWebsiteTab(tool)) return next;

  if (next.tabId == null) {
    const preferred = await getPreferredAgentTab();
    next.tabId = preferred.id;
  }

  await assertTabInAgentGroup(next.tabId);
  return next;
}

function sanitizeScopedResult(tool, result) {
  if (tool !== 'page.inspect' || !result || typeof result !== 'object') return result;
  const attributes = { ...(result.attributes || {}) };
  if (String(attributes.type || '').toLowerCase() === 'password') {
    if ('value' in attributes) attributes.value = '[REDACTED_PASSWORD]';
    return { ...result, text: '[REDACTED_PASSWORD_FIELD]', attributes };
  }
  return result;
}

export { LOCAL_AGENT_TOOLS, isLocalAgentTool };

export async function executeLocalBrowserTool(tool, args = {}) {
  await ensureAgentGroup();

  switch (tool) {
    case 'tabs.list': {
      const status = await getAgentGroupStatus({ createIfMissing: true });
      return status.tabs;
    }

    case 'tabs.open': {
      const tab = await createTabInAgentGroup(args.url, { active: args.active !== false });
      if (args.wait !== false) {
        try {
          await executeRawBrowserTool('page.wait', { tabId: tab.id, timeoutMs: args.timeoutMs });
        } catch {}
      }
      return summarizeTab(await chrome.tabs.get(tab.id));
    }

    case 'tab.active': {
      const tab = await getPreferredAgentTab();
      return summarizeTab(tab);
    }

    case 'tabs.switch': {
      const scoped = await scopeArgs(tool, args);
      const result = await executeRawBrowserTool(tool, scoped);
      if (result?.id) await setAgentWorkingTab(result.id);
      return result;
    }

    case 'tabs.close': {
      const scoped = await scopeArgs(tool, args);
      return executeRawBrowserTool(tool, scoped);
    }

    case 'tab.navigate': {
      const scoped = await scopeArgs(tool, args);
      const result = await executeRawBrowserTool(tool, scoped);
      if (result?.id) await setAgentWorkingTab(result.id);
      else if (scoped.tabId) await setAgentWorkingTab(scoped.tabId);
      return result;
    }

    default: {
      const scoped = await scopeArgs(tool, args);
      const result = await executeRawBrowserTool(tool, scoped);
      return sanitizeScopedResult(tool, result);
    }
  }
}
