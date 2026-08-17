/**
 * Apply the saved theme before first paint, so a light-theme visitor does not
 * see a dark flash. Loaded as a classic script in <head> for that reason —
 * module scripts are deferred.
 *
 * Keys match imchong.github.io (`cl-theme`, `cl-lang`) so the two sites behave
 * the same way and use the same vocabulary.
 */
(function () {
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem('cl-theme');
    root.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
    var lang = localStorage.getItem('cl-lang');
    if (!lang) {
      lang = /\bzh\b|zh-/i.test((navigator.languages || [navigator.language || 'en']).join(','))
        ? 'zh'
        : 'en';
    }
    root.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
  } catch (err) {
    root.setAttribute('data-theme', 'dark');
  }
})();
