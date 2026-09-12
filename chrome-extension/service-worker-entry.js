import './service-worker.js';
import { installTabScopedSidePanel } from './sidepanel-scope.js';

installTabScopedSidePanel().catch((error) => {
  console.error('Failed to initialize tab-scoped side panel:', error);
});
