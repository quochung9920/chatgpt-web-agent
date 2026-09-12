import { installRuntimeControl, reportRuntimeModule } from './runtime-control.js';
import { installTabScopedSidePanel } from './sidepanel-scope.js';
import { installStreamModelBridge } from './stream-model-bridge.js';
import { installHybridAgentRuntime } from './hybrid-agent-runtime.js';
import { installRemoteBackground } from './background.js';

installRuntimeControl();
reportRuntimeModule('service-worker-entry', 'ready');

function reportInstallError(name, error) {
  const message = error?.stack || error?.message || String(error);
  reportRuntimeModule(name, 'error', message);
  console.error(`Failed to initialize ${name}:`, error);
}

function installSubsystem(name, installer) {
  reportRuntimeModule(name, 'loading');
  try {
    const result = installer();
    if (result && typeof result.then === 'function') {
      result
        .then(() => reportRuntimeModule(name, 'ready'))
        .catch((error) => reportInstallError(name, error));
    } else {
      reportRuntimeModule(name, 'ready');
    }
  } catch (error) {
    reportInstallError(name, error);
  }
}

// MV3 extension service workers support static ES module imports only.
// Keep all imports static, then isolate runtime initialization failures here.
installSubsystem('sidepanel-scope', installTabScopedSidePanel);
installSubsystem('stream-model-bridge', installStreamModelBridge);
installSubsystem('hybrid-agent-runtime', installHybridAgentRuntime);
installSubsystem('remote-background', installRemoteBackground);
