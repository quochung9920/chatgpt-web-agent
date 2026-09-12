const serverUrl = document.querySelector('#serverUrl');
const agentId = document.querySelector('#agentId');
const agentToken = document.querySelector('#agentToken');
const status = document.querySelector('#status');

async function load() {
  const config = await chrome.storage.local.get({
    serverUrl: 'ws://localhost:8787',
    agentId: 'desktop-chrome',
    agentToken: ''
  });
  serverUrl.value = config.serverUrl;
  agentId.value = config.agentId;
  agentToken.value = config.agentToken;
}

document.querySelector('#save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    serverUrl: serverUrl.value.trim(),
    agentId: agentId.value.trim(),
    agentToken: agentToken.value.trim()
  });
  status.textContent = 'Saved';
  setTimeout(() => (status.textContent = ''), 1500);
});

load();
