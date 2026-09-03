/**
 * Apply the saved language before the rest of the app (and three.js) evaluate.
 * Loaded as its own module so it does not wait on the viewer; the <html>
 * `i18n-pending` class hides the body until this has run, so a stored English
 * preference never paints the Chinese HTML, and vice versa.
 */
import { applyChrome, detectLang, pageTitle, revealLang, setLang, t } from './i18n.js';

try {
  setLang(detectLang());
  applyChrome();
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (params.has('compare')) document.title = pageTitle(t('compare.title'));
  else if (!params.get('robot') && !params.has('custom')) document.title = pageTitle();
} finally {
  revealLang();
}
