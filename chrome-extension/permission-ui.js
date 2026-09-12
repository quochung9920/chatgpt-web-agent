const modeSelect = document.querySelector('#permissionMode');
const approvalCard = document.querySelector('#approvalCard');
const approvalTitle = document.querySelector('#approvalTitle');
const approvalDetail = document.querySelector('#approvalDetail');
const approveButton = document.querySelector('#approveAction');
const denyButton = document.querySelector('#denyAction');

let pendingApprovalId = null;
let pendingResponseType = 'agent.approval';

async function runtimeRequest(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || `${type}_failed`);
  return response.result;
}

function hideApproval() {
  pendingApprovalId = null;
  pendingResponseType = 'agent.approval';
  approvalCard.classList.add('hidden');
  approveButton.disabled = false;
  denyButton.disabled = false;
}

function showApproval(event) {
  pendingApprovalId = event.approvalId;
  pendingResponseType = event.responseType || 'agent.approval';
  approvalTitle.textContent = event.risk === 'high' ? 'Sensitive action requires approval' : 'Approve browser action';
  approvalDetail.textContent = `${event.tool || 'Browser action'}${event.detail ? ` — ${event.detail}` : ''}`;
  approvalCard.classList.remove('hidden');
}

async function initMode() {
  try {
    const { mode } = await runtimeRequest('agent.mode.get');
    modeSelect.value = mode || 'auto';
  } catch {
    modeSelect.value = 'auto';
  }
}

modeSelect.addEventListener('change', async () => {
  modeSelect.disabled = true;
  try {
    const { mode } = await runtimeRequest('agent.mode.set', { mode: modeSelect.value });
    modeSelect.value = mode;
  } catch {
    await initMode();
  } finally {
    modeSelect.disabled = false;
  }
});

approveButton.addEventListener('click', async () => {
  if (!pendingApprovalId) return;
  const approvalId = pendingApprovalId;
  const responseType = pendingResponseType;
  approveButton.disabled = true;
  denyButton.disabled = true;
  try {
    await runtimeRequest(responseType, { approvalId, allow: true });
    hideApproval();
  } catch {
    approveButton.disabled = false;
    denyButton.disabled = false;
  }
});

denyButton.addEventListener('click', async () => {
  if (!pendingApprovalId) return;
  const approvalId = pendingApprovalId;
  const responseType = pendingResponseType;
  approveButton.disabled = true;
  denyButton.disabled = true;
  try {
    await runtimeRequest(responseType, { approvalId, allow: false });
    hideApproval();
  } catch {
    approveButton.disabled = false;
    denyButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'agent.event' || !message.event) return;
  const event = message.event;
  if (event.kind === 'approval_required') showApproval(event);
  if (['approval_granted', 'blocked', 'final', 'stopped'].includes(event.kind)) {
    hideApproval();
  }
});

initMode();
