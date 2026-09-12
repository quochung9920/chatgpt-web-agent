(() => {
  const errorEl = document.querySelector('#chatError');
  const badge = document.querySelector('#chatgptBadge');
  let lastHealthMessage = '';

  function showHealthError(message) {
    if (!errorEl) return;
    lastHealthMessage = String(message || '');
    errorEl.textContent = lastHealthMessage;
    errorEl.classList.toggle('hidden', !lastHealthMessage);
  }

  async function checkHealth() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'runtime.health' });
      if (!response?.ok || !response.result) {
        showHealthError('Service worker core unavailable. Reload the extension.');
        if (badge) badge.textContent = 'Worker unavailable';
        return;
      }

      const modules = response.result.modules || {};
      const failed = Object.entries(modules)
        .filter(([, value]) => value?.status === 'error')
        .map(([name, value]) => `${name}: ${value.error || 'load failed'}`);

      if (failed.length) {
        showHealthError(`Worker module error — ${failed.join(' | ')}`);
        if (badge) badge.textContent = 'Runtime degraded';
        return;
      }

      if (lastHealthMessage.startsWith('Service worker core unavailable') || lastHealthMessage.startsWith('Worker module error')) {
        showHealthError('');
      }
    } catch (error) {
      showHealthError(`Service worker unavailable — ${error?.message || String(error)}`);
      if (badge) badge.textContent = 'Worker unavailable';
    }
  }

  checkHealth();
  setInterval(checkHealth, 3000);
})();
