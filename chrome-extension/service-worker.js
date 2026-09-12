import './background.js';
import { executeLocalBrowserTool, isLocalAgentTool, LOCAL_AGENT_TOOLS } from './group-scoped-tools.js';
import { activateAgentGroupForTab, ensureAgentGroup, getAgentGroupStatus } from './tab-group-session.js';

const MAX_AGENT_STEPS = 24;
const activeRuns = new Map();

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
    } catch {}
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
    await new Promise((resolve) => setTimeout(resolve, 100));
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

function cleanAgentVisibleText(text) {
  return String(text || '')
    .replace(/<web_agent>[\s\S]*?<\/web_agent>/gi, '')
    .replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/gi, '')
    .trim();
}

function parseAgentDirective(text) {
  const source = String(text || '');
  const tagged = [...source.matchAll(/<web_agent>\s*([\s\S]*?)\s*<\/web_agent>/gi)].at(-1);
  const candidates = [];
  if (tagged?.[1]) candidates.push(tagged[1]);

  const fenced = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  for (const match of fenced.reverse()) candidates.push(match[1]);

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate.trim());
      if (data?.type === 'tool_call' && data.tool) return data;
      if (data?.type === 'final') return data;
    } catch {}
  }
  return null;
}

function safeJson(value, maxLength = 18000) {
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = JSON.stringify({ error: 'unserializable_result' });
  }
  if (serialized.length > maxLength) serialized = `${serialized.slice(0, maxLength)}\n...TRUNCATED...`;
  return serialized;
}

function describeTools() {
  return `Available browser tools:\n${LOCAL_AGENT_TOOLS.map((tool) => `- ${tool}`).join('\n')}\n\nImportant argument patterns:\n- tabs.switch/tabs.close: {"tabId": number}\n- tab.navigate: {"tabId": number, "url": "https://..."}\n- page.read/page.accessibility/page.screenshot: {"tabId": number}\n- page.inspect/page.type: {"tabId": number, "selector": "CSS", ...}\n- page.click: {"tabId": number, "selector": "CSS"} OR {"tabId": number, "x": number, "y": number}\n- page.drag: {"tabId": number, "fromX": number, "fromY": number, "toX": number, "toY": number}\n- page.viewport.set: {"tabId": number, "width": number, "height": number, "mobile": boolean}`;
}

function buildInitialAgentPrompt(task, tabs, activeTabId, group) {
  return `[WEB_AGENT_SYSTEM]\nYou are now operating the user's REAL Chrome browser through the ChatGPT Web Agent extension. You are not merely giving instructions. You can inspect tabs and directly perform browser actions.\n\nBROWSER SCOPE\nYou are sandboxed to ONE Chrome Tab Group named "${group?.title || 'ChatGPT Agent'}" (group id ${group?.groupId ?? 'unknown'}). The Tabs list below contains ONLY websites inside that group. You must never attempt to inspect or operate tabs outside this group. Any website you open with tabs.open is automatically placed inside this same group. The ChatGPT reasoning tab is deliberately outside the group and is not a browser work target.\n\nDo NOT ask the user to paste a URL, send a screenshot, or manually describe a page when the browser tools can inspect it. Do NOT claim an action succeeded until a tool result confirms it. Prefer DOM/accessibility inspection first; use screenshots when visual understanding is needed.\n\nCURRENT GROUP STATE\nWorking tab id: ${activeTabId ?? 'unknown'}\nGroup tabs:\n${safeJson(tabs, 12000)}\n\n${describeTools()}\n\nTOOL PROTOCOL\nWhen you need exactly one browser action, your response MUST end with exactly one block:\n<web_agent>\n{"type":"tool_call","tool":"page.read","args":{"tabId":123}}\n</web_agent>\n\nAfter the extension executes it, you will receive [WEB_AGENT_TOOL_RESULT]. Then decide the next action. Continue until the user's task is actually complete.\n\nWhen finished, end with:\n<web_agent>\n{"type":"final","message":"Concise completion summary"}\n</web_agent>\n\nIf an action fails, inspect the error/result and try a safer alternative instead of immediately asking the user. Keep each turn to ONE tool call.\n\nUSER TASK\n${String(task || '').trim()}`;
}

function buildToolResultPrompt(step, tool, args, result, error = null) {
  return `[WEB_AGENT_TOOL_RESULT]\nStep: ${step}\nTool: ${tool}\nArgs: ${safeJson(args, 5000)}\nStatus: ${error ? 'ERROR' : 'OK'}\nResult:\n${safeJson(error ? { error } : result, 16000)}\n\nContinue the browser task. Stay inside the active ChatGPT Agent tab group. Use one <web_agent> tool call, or return a final block only when the task is genuinely complete.`;
}

async function emitAgentEvent(event) {
  try {
    await chrome.runtime.sendMessage({ type: 'agent.event', event });
  } catch {}
}

function pickWorkingTab(tabs) {
  return tabs.find((tab) => tab.active) || tabs[0] || null;
}

function withDefaultTabId(tool, args, workingTabId) {
  const next = { ...(args || {}) };
  if (workingTabId && (tool.startsWith('page.') || ['tab.navigate', 'tab.reload', 'tab.back', 'tab.forward'].includes(tool)) && next.tabId == null) {
    next.tabId = workingTabId;
  }
  return next;
}

async function sendPromptThroughBridge(tabId, text, { imageDataUrl = '', timeoutMs = 180000 } = {}) {
  const response = await sendBridgeMessage(tabId, {
    type: 'chatgpt.bridge.send',
    text,
    imageDataUrl,
    timeoutMs
  });
  if (!response?.ok) throw new Error(response?.error || 'chatgpt_send_failed');
  return response;
}

async function runAgentTask(message) {
  const task = String(message.task || '').trim();
  if (!task) throw new Error('empty_agent_task');

  const chatTab = await resolveChatGptTab(message.tabId);
  if (!chatTab) throw new Error('chatgpt_tab_not_found');
  await ensureChatGptBridge(chatTab.id);

  const group = await ensureAgentGroup(message.seedTabId ?? null, { forceNewIfOutside: false });
  const runId = crypto.randomUUID();
  const state = { cancelled: false, chatgptTabId: chatTab.id, workingTabId: group.workingTabId || null };
  activeRuns.set(runId, state);

  try {
    const tabs = await executeLocalBrowserTool('tabs.list', {});
    const working = pickWorkingTab(tabs);
    state.workingTabId = working?.id || state.workingTabId;

    await emitAgentEvent({ runId, kind: 'start', message: `Agent locked to group: ${group.title}`, workingTabId: state.workingTabId, groupId: group.groupId });
    await emitAgentEvent({ runId, kind: 'observe', message: `Found ${tabs.length} website tab${tabs.length === 1 ? '' : 's'} in the agent group` });

    let assistant = await sendPromptThroughBridge(chatTab.id, buildInitialAgentPrompt(task, tabs, state.workingTabId, group));
    let lastText = assistant.text || '';

    for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
      if (state.cancelled) throw new Error('agent_stopped');

      const directive = parseAgentDirective(lastText);
      const visibleText = cleanAgentVisibleText(lastText);
      if (visibleText) await emitAgentEvent({ runId, kind: 'reasoning', message: visibleText.slice(0, 600) });

      if (!directive) {
        await emitAgentEvent({ runId, kind: 'final', message: visibleText || 'ChatGPT finished without requesting another browser action.' });
        return { runId, tabId: chatTab.id, text: visibleText || lastText, steps: step - 1, groupId: group.groupId };
      }

      if (directive.type === 'final') {
        const finalText = String(directive.message || visibleText || 'Task complete.').trim();
        await emitAgentEvent({ runId, kind: 'final', message: finalText });
        return { runId, tabId: chatTab.id, text: finalText, steps: step - 1, groupId: group.groupId };
      }

      const tool = String(directive.tool || '');
      if (!isLocalAgentTool(tool)) {
        lastText = (await sendPromptThroughBridge(chatTab.id, buildToolResultPrompt(step, tool, directive.args || {}, null, 'tool_not_allowed'))).text || '';
        continue;
      }

      const args = withDefaultTabId(tool, directive.args || {}, state.workingTabId);
      await emitAgentEvent({ runId, kind: 'tool', step, tool, message: `${tool}${args.tabId ? ` · tab ${args.tabId}` : ''}` });

      let result;
      let error = null;
      try {
        result = await executeLocalBrowserTool(tool, args);
        if (tool === 'tabs.switch' && result?.id) state.workingTabId = result.id;
        if (tool === 'tabs.open' && result?.id) state.workingTabId = result.id;
        if (tool === 'tab.navigate' && result?.id) state.workingTabId = result.id;
        await emitAgentEvent({ runId, kind: 'tool_result', step, tool, ok: true, message: `${tool} completed` });
      } catch (toolError) {
        error = toolError?.message || String(toolError);
        await emitAgentEvent({ runId, kind: 'tool_result', step, tool, ok: false, message: `${tool}: ${error}` });
      }

      if (state.cancelled) throw new Error('agent_stopped');

      let imageDataUrl = '';
      let resultForModel = result;
      if (!error && tool === 'page.screenshot' && result?.dataUrl) {
        imageDataUrl = result.dataUrl;
        resultForModel = { ...result, dataUrl: '[SCREENSHOT_ATTACHED_TO_THIS_MESSAGE]' };
        await emitAgentEvent({ runId, kind: 'observe', step, message: 'Screenshot captured and sent to ChatGPT vision' });
      }

      const nextPrompt = buildToolResultPrompt(step, tool, args, resultForModel, error);
      assistant = await sendPromptThroughBridge(chatTab.id, nextPrompt, { imageDataUrl });
      lastText = assistant.text || '';
    }

    throw new Error('agent_max_steps_reached');
  } finally {
    activeRuns.delete(runId);
  }
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
      const response = await sendBridgeMessage(tab.id, { type: 'chatgpt.bridge.sync', limit: message.limit || 30 });
      if (!response?.ok) throw new Error(response?.error || 'chatgpt_sync_failed');
      return { tabId: tab.id, conversation: response.conversation || [] };
    }

    case 'chatgpt.send': {
      const tab = await resolveChatGptTab(message.tabId);
      if (!tab) throw new Error('chatgpt_tab_not_found');
      const response = await sendPromptThroughBridge(tab.id, message.text, { timeoutMs: message.timeoutMs || 180000 });
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

async function handleAgentMessage(message) {
  switch (message.type) {
    case 'agent.group.ensure':
      return ensureAgentGroup(message.seedTabId ?? null, { forceNewIfOutside: Boolean(message.forceNewIfOutside) });
    case 'agent.group.status':
      return getAgentGroupStatus();
    case 'agent.group.new':
      return activateAgentGroupForTab(message.seedTabId, { forceNewIfOutside: true });
    case 'agent.run':
      return runAgentTask(message);
    case 'agent.stop': {
      for (const state of activeRuns.values()) state.cancelled = true;
      await emitAgentEvent({ kind: 'stopped', message: 'Stopping agent…' });
      return { stopped: true };
    }
    default:
      throw new Error('unsupported_agent_message');
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type || message.type === 'agent.event') return;

  let handler = null;
  if (String(message.type).startsWith('chatgpt.')) handler = handleChatGptMessage;
  if (String(message.type).startsWith('agent.')) handler = handleAgentMessage;
  if (!handler) return;

  handler(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);
enableSidePanel();
