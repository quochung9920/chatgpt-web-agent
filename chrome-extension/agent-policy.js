export const AGENT_MODES = Object.freeze({
  AUTO: 'auto',
  ASK: 'ask',
  READ_ONLY: 'read_only'
});

const READ_ONLY_TOOLS = new Set([
  'tabs.list',
  'tab.active',
  'page.wait',
  'page.read',
  'page.accessibility',
  'page.inspect',
  'page.elements',
  'page.elementAt',
  'page.observe',
  'page.find',
  'page.viewport.get',
  'page.screenshot'
]);

const HIGH_RISK_TOOLS = new Set(['tabs.close']);
const HIGH_RISK_PATTERN = /\b(delete|remove|erase|destroy|publish|send|submit|pay|payment|purchase|buy|checkout|place\s+order|confirm\s+order|transfer|wire|withdraw|deposit|password|passcode|sign\s*out|log\s*out|logout|disconnect|revoke|cancel\s+(?:plan|subscription|account)|close\s+account|delete\s+account|factory\s+reset|wipe)\b/i;
const MEDIUM_RISK_PATTERN = /\b(save|update|apply|confirm|continue|next|install|enable|disable|connect|authorize|grant|upload|select|check|choose)\b/i;

function flattenSignals(value, output = []) {
  if (value == null) return output;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) flattenSignals(item, output);
    return output;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      output.push(String(key));
      flattenSignals(item, output);
    }
  }
  return output;
}

export function isReadOnlyTool(tool) {
  return READ_ONLY_TOOLS.has(String(tool || ''));
}

export function normalizeAgentMode(mode) {
  const value = String(mode || '').toLowerCase();
  if (Object.values(AGENT_MODES).includes(value)) return value;
  return AGENT_MODES.AUTO;
}

export function classifyAgentAction(tool, args = {}, targetContext = null) {
  const name = String(tool || '');
  if (isReadOnlyTool(name)) {
    return { level: 'read', requiresApproval: false, reason: 'read_only_action' };
  }

  const signals = flattenSignals({ tool: name, args, targetContext }).join(' ');
  if (HIGH_RISK_TOOLS.has(name) || HIGH_RISK_PATTERN.test(signals)) {
    return {
      level: 'high',
      requiresApproval: true,
      reason: HIGH_RISK_TOOLS.has(name) ? 'high_risk_tool' : 'sensitive_target_or_intent'
    };
  }

  if (MEDIUM_RISK_PATTERN.test(signals)) {
    return { level: 'medium', requiresApproval: false, reason: 'state_changing_action' };
  }

  return { level: 'low', requiresApproval: false, reason: 'ordinary_browser_action' };
}

export function decideAgentPermission(mode, classification) {
  const normalized = normalizeAgentMode(mode);
  const risk = classification || { level: 'low', requiresApproval: false };

  if (normalized === AGENT_MODES.READ_ONLY) {
    if (risk.level === 'read') return { decision: 'allow', reason: 'read_only_allowed' };
    return { decision: 'block', reason: 'read_only_mode' };
  }

  if (risk.level === 'high' || risk.requiresApproval) {
    return { decision: 'ask', reason: risk.reason || 'high_risk_action' };
  }

  if (normalized === AGENT_MODES.ASK && risk.level !== 'read') {
    return { decision: 'ask', reason: 'ask_before_actions_mode' };
  }

  return { decision: 'allow', reason: 'policy_allowed' };
}

export function isMutatingTool(tool) {
  const name = String(tool || '');
  return !isReadOnlyTool(name) && name !== 'tabs.switch' && name !== 'page.scroll' && name !== 'page.hover' && name !== 'page.focus';
}

export function shouldObserveAfter(tool) {
  return new Set([
    'tabs.open', 'tabs.switch', 'tabs.close',
    'tab.navigate', 'tab.reload', 'tab.back', 'tab.forward',
    'page.click', 'page.clickText', 'page.doubleClick', 'page.rightClick',
    'page.type', 'page.typeByLabel', 'page.key', 'page.hotkey', 'page.scroll', 'page.drag',
    'page.focus', 'page.selectOption', 'page.check', 'page.upload',
    'page.viewport.set', 'page.viewport.clear'
  ]).has(String(tool || ''));
}

export function shouldCaptureVisualAfter(tool) {
  return new Set([
    'tabs.open', 'tabs.switch',
    'tab.navigate', 'tab.reload', 'tab.back', 'tab.forward',
    'page.click', 'page.clickText', 'page.doubleClick',
    'page.type', 'page.typeByLabel', 'page.key', 'page.hotkey', 'page.scroll', 'page.drag',
    'page.selectOption', 'page.check', 'page.upload',
    'page.viewport.set', 'page.viewport.clear'
  ]).has(String(tool || ''));
}
