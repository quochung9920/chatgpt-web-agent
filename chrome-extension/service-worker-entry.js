import './service-worker.js';
import { installTabScopedSidePanel } from './sidepanel-scope.js';
import { installStreamModelBridge } from './stream-model-bridge.js';

installStreamModelBridge();

installTabScopedSidePanel().catch((error) => {
  console.error('Failed to initialize tab-scoped side panel:', error);
});
