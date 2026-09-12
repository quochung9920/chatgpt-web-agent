import { installRuntimeControl, reportRuntimeModule } from './runtime-control.js';

installRuntimeControl();
reportRuntimeModule('service-worker-entry', 'ready');

async function loadModule(name, path, installerName = null) {
  reportRuntimeModule(name, 'loading');
  try {
    const mod = await import(path);
    if (installerName) {
      const installer = mod?.[installerName];
      if (typeof installer !== 'function') throw new Error(`missing_installer:${installerName}`);
      await installer();
    }
    reportRuntimeModule(name, 'ready');
    return mod;
  } catch (error) {
    const message = error?.stack || error?.message || String(error);
    reportRuntimeModule(name, 'error', message);
    console.error(`Failed to load ${name}:`, error);
    return null;
  }
}

// Optional/heavier subsystems are intentionally loaded after the core message
// router. A failure in Hybrid/CDP/stream/remote modules must never remove
// agent.group.status, chatgpt.status or runtime.health from the service worker.
void loadModule('sidepanel-scope', './sidepanel-scope.js', 'installTabScopedSidePanel');
void loadModule('stream-model-bridge', './stream-model-bridge.js', 'installStreamModelBridge');
void loadModule('hybrid-agent-runtime', './hybrid-agent-runtime.js', 'installHybridAgentRuntime');
void loadModule('remote-background', './background.js');
