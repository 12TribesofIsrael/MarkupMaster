/* Hash router. Loaded last — boots the app. */
(function () {
  const routes = [
    [/^#?\/?$/, () => Views.clients()],
    [/^#\/clients$/, () => Views.clients()],
    [/^#\/client\/(\d+)$/, m => Views.clientDetail(m[1])],
    [/^#\/campaign\/(\d+)$/, m => Views.campaign(m[1])],
    [/^#\/campaign\/(\d+)\/analyze$/, m => Views.analyze(Number(m[1]))],
    [/^#\/campaign\/(\d+)\/round\/(\d+)$/, m => Views.round(m[1], m[2])],
    [/^#\/campaign\/(\d+)\/chronology$/, m => Views.chronology(m[1])],
    [/^#\/campaign\/(\d+)\/intake$/, m => Views.intake ? Views.intake(Number(m[1])) : Views.campaign(m[1])],
    [/^#\/quick$/, () => Views.analyze(null)],
  ];

  async function route() {
    clearError();
    const hash = location.hash || '#/clients';
    for (const [re, fn] of routes) {
      const m = hash.match(re);
      if (m) {
        try { await fn(m); } catch (e) { showError(e.message || String(e)); }
        return;
      }
    }
    location.hash = '#/clients';
  }

  window.addEventListener('hashchange', route);
  route();
})();
