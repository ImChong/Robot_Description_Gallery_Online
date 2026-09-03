/**
 * Apply the saved theme (and language) before first paint, so a light-theme
 * visitor does not see a dark flash, and so css/app.css can hide the body
 * until js/i18n-boot.js swaps the static strings. Loaded as a classic script
 * in <head> for that reason — module scripts are deferred.
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
    if (lang !== 'zh' && lang !== 'en') {
      lang = /\bzh\b|zh-/i.test((navigator.languages || [navigator.language || 'en']).join(','))
        ? 'zh'
        : 'en';
    }
    root.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    document.title = lang === 'zh' ? '机器人3D模型在线合集' : 'Robot Description Gallery Online';
  } catch (err) {
    root.setAttribute('data-theme', 'dark');
  }
  root.classList.add('i18n-pending');
  // If the module boot script never runs, do not leave the page blank.
  setTimeout(function () {
    root.classList.remove('i18n-pending');
  }, 8000);
})();
