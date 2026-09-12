import { executeAgentTool as executeBaseAgentTool, isAgentTool, AGENT_TOOLS } from './agent-tools.js';

export { isAgentTool, AGENT_TOOLS };

function sanitizeInspectResult(result) {
  if (!result || typeof result !== 'object') return result;
  const attributes = { ...(result.attributes || {}) };
  const type = String(attributes.type || '').toLowerCase();
  if (type === 'password') {
    if ('value' in attributes) attributes.value = '[REDACTED_PASSWORD]';
    return { ...result, text: '[REDACTED_PASSWORD_FIELD]', attributes };
  }
  return { ...result, attributes };
}

function sanitizeGeneric(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeGeneric(item, depth + 1));
  if (typeof value !== 'object') return value;

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if ((lower === 'password' || lower === 'passcode') && typeof item === 'string') {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = sanitizeGeneric(item, depth + 1);
  }
  return output;
}

export async function executeAgentTool(tool, args = {}) {
  const result = await executeBaseAgentTool(tool, args);
  if (String(tool || '') === 'page.inspect') return sanitizeInspectResult(result);
  return sanitizeGeneric(result);
}
