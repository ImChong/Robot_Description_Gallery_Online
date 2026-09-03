/**
 * The site theme, in one place.
 *
 * `data-theme` on <html> is the single source of truth — js/theme-init.js
 * stamps it before first paint, the CSS reads it, and everything that has to
 * follow the switch (the 3D stage, above all) subscribes here rather than
 * watching the header button. Storage key `cl-theme`, as on imchong.github.io.
 */

const KEY = 'cl-theme';
const EVENT = 'cl-theme-change';

/** @returns {'dark'|'light'} */
export function theme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Switch the theme, remember it, and tell everyone who is listening. */
export function setTheme(next) {
  const value = next === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', value);
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* private mode — the choice just will not persist */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
  return value;
}

export function toggleTheme() {
  return setTheme(theme() === 'light' ? 'dark' : 'light');
}

/**
 * @param {(theme: 'dark'|'light') => void} handler
 * @returns {() => void} unsubscribe — for a listener that outlives what it
 *   was relighting, such as the compare stage, which is torn down and rebuilt
 *   while the page it is on stays open
 */
export function onThemeChange(handler) {
  const listener = (event) => handler(event.detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
