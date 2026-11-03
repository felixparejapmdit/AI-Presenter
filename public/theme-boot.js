// Runs synchronously before first paint to avoid a light flash in dark mode. It is a
// separate file because the production Content Security Policy forbids inline scripts.
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem('vanguard.theme');
  } catch (error) {
    stored = null;
  }
  var mode = stored === 'light' || stored === 'dark' ? stored : 'system';
  var dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
