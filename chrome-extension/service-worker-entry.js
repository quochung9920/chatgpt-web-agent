import './background.js';
import { installRuntimeControl } from './runtime-control.js';
import { installTabScopedSidePanel } from './sidepanel-scope.js';
import { installStreamModelBridge } from './stream-model-bridge.js';
import { installHybridAgentRuntime } from './hybrid-agent-runtime.js';

installRuntimeControl();
installStreamModelBridge();
installHybridAgentRuntime();

installTabScopedSidePanel().catch((error) => {
  console.error('Failed to initialize tab-scoped side panel:', error);
});
