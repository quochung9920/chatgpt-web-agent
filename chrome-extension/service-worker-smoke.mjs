const listeners = () => {
  const items = [];
  return {
    items,
    addListener(fn) { items.push(fn); },
    removeListener(fn) {
      const index = items.indexOf(fn);
      if (index >= 0) items.splice(index, 1);
    }
  };
};

const runtimeOnMessage = listeners();
const runtimeOnInstalled = listeners();
const runtimeOnStartup = listeners();
const storageOnChanged = listeners();
const tabsOnActivated = listeners();
const tabsOnCreated = listeners();
const tabsOnRemoved = listeners();
const tabsOnUpdated = listeners();
const tabGroupsOnUpdated = listeners();
const tabGroupsOnRemoved = listeners();
const sidePanelOnOpened = listeners();
const actionOnClicked = listeners();
const debuggerOnDetach = listeners();
const debuggerOnEvent = listeners();

const storage = new Map([
  ['agentGroupId', null],
  ['agentGroupWindowId', null],
  ['agentWorkingTabId', null],
  ['agentToken', ''],
  ['serverUrl', 'ws://localhost:8787'],
  ['agentId', 'desktop-chrome']
]);

function storageResult(defaults = {}) {
  const result = { ...defaults };
  for (const key of Object.keys(defaults || {})) {
    if (storage.has(key)) result[key] = storage.get(key);
  }
  return result;
}

async function dispatchRuntimeMessage(message) {
  for (const listener of runtimeOnMessage.items) {
    let settled = false;
    let responseValue;
    let resolveResponse;
    const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
    const sendResponse = (value) => {
      settled = true;
      responseValue = value;
      resolveResponse(value);
    };

    const returned = listener(message, {}, sendResponse);
    if (returned === true) {
      const response = await Promise.race([
        responsePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout:${message.type}`)), 1000))
      ]);
      if (response !== undefined) return response;
      continue;
    }
    if (returned && typeof returned.then === 'function') {
      const response = await returned;
      if (response !== undefined) return response;
    }
    if (settled && responseValue !== undefined) return responseValue;
  }
  return undefined;
}

globalThis.chrome = {
  runtime: {
    onMessage: runtimeOnMessage,
    onInstalled: runtimeOnInstalled,
    onStartup: runtimeOnStartup,
    async sendMessage() { return undefined; },
    openOptionsPage() {}
  },
  storage: {
    local: {
      async get(defaults = {}) { return storageResult(defaults); },
      async set(values = {}) {
        for (const [key, value] of Object.entries(values)) storage.set(key, value);
      }
    },
    onChanged: storageOnChanged
  },
  tabs: {
    onActivated: tabsOnActivated,
    onCreated: tabsOnCreated,
    onRemoved: tabsOnRemoved,
    onUpdated: tabsOnUpdated,
    async query() { return []; },
    async get() { throw new Error('tab_not_found'); },
    async create() { return { id: 1, url: 'https://chatgpt.com/', status: 'complete', groupId: -1, windowId: 1 }; },
    async update(id, changes) { return { id, ...changes, windowId: 1, groupId: -1 }; },
    async move(id) { return { id, windowId: 1, groupId: -1 }; },
    async group() { return 1; },
    async ungroup() {},
    async remove() {},
    async reload() {},
    async goBack() {},
    async goForward() {},
    async sendMessage() { return { ok: true, composer: true, conversation: [] }; }
  },
  tabGroups: {
    onUpdated: tabGroupsOnUpdated,
    onRemoved: tabGroupsOnRemoved,
    async get() { throw new Error('group_not_found'); },
    async update(id, changes) { return { id, windowId: 1, ...changes }; }
  },
  sidePanel: {
    onOpened: sidePanelOnOpened,
    async setPanelBehavior() {},
    async setOptions() {},
    async close() {},
    async open() {}
  },
  action: {
    onClicked: actionOnClicked,
    async setTitle() {}
  },
  scripting: {
    async executeScript() { return [{ result: null }]; }
  },
  debugger: {
    onDetach: debuggerOnDetach,
    onEvent: debuggerOnEvent,
    async attach() {},
    async detach() {},
    async sendCommand() { return {}; }
  },
  windows: {
    async update(id, changes) { return { id, ...changes }; }
  }
};

globalThis.WebSocket = class FakeWebSocket {
  static OPEN = 1;
  constructor() { this.readyState = 0; }
  close() {}
  send() {}
};

const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error));

await import('./service-worker-entry.js');
await new Promise((resolve) => setTimeout(resolve, 25));

if (unhandled.length) {
  throw new Error(`Unhandled service-worker rejection: ${unhandled.map((e) => e?.stack || e).join('\n')}`);
}

const groupStatus = await dispatchRuntimeMessage({ type: 'agent.group.status' });
if (!groupStatus?.ok || groupStatus.result?.active !== false) {
  throw new Error(`agent.group.status smoke failed: ${JSON.stringify(groupStatus)}`);
}

const chatStatus = await dispatchRuntimeMessage({ type: 'chatgpt.status' });
if (!chatStatus?.ok || chatStatus.result?.open !== false) {
  throw new Error(`chatgpt.status smoke failed: ${JSON.stringify(chatStatus)}`);
}

console.log('service-worker smoke passed', {
  runtimeListeners: runtimeOnMessage.items.length,
  groupStatus: groupStatus.result,
  chatStatus: chatStatus.result
});
