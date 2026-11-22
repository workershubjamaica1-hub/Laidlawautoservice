// Many people say "Portmore" or "Spanish Town" and do not think of St. Catherine, so the St. Catherine choice in every parish list says what it includes.
// Only the words on screen change; the saved value stays "St. Catherine".
(function () {
  const LABEL = 'St. Catherine (includes Portmore, Spanish Town)';
  function fix(root) {
    root.querySelectorAll('option[value="St. Catherine"]').forEach(o => { if (o.textContent !== LABEL) o.textContent = LABEL; });
  }
  const start = () => { fix(document); new MutationObserver(() => fix(document)).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
