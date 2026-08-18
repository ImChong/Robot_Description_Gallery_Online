/** Bootstrap: hash routing between the gallery and the detail view. */
import { loadRegistry, byId } from './registry.js';
import { Gallery } from './gallery.js';
import { Detail } from './detail.js';
import { applyStatic, detectLang, setLang, lang, LANGS } from './i18n.js';
import { theme, toggleTheme } from './theme.js';

const views = {
  gallery: document.getElementById('view-gallery'),
  detail: document.getElementById('view-detail'),
};

function parseHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return {
    robot: params.get('robot'),
    category: params.get('category') || 'all',
    q: params.get('q') || '',
  };
}

/** The address for a state: a robot, or the gallery at a section and a query. */
function hashFor({ robot, category, q }) {
  const params = new URLSearchParams();
  if (robot) params.set('robot', robot);
  else {
    if (category && category !== 'all') params.set('category', category);
    if (q) params.set('q', q);
  }
  return params.toString();
}

function writeHash(state) {
  const hash = hashFor(state);
  const next = hash ? `#${hash}` : location.pathname;
  if (next !== location.hash && !(hash === '' && location.hash === '')) {
    history.replaceState(null, '', next);
  }
}

/**
 * Theme is stamped on <html> before first paint by js/theme-init.js; this only
 * handles the toggle. js/theme.js owns the switch itself, so the 3D stage can
 * hear about it without knowing this button exists.
 */
function setupTheme() {
  const button = document.getElementById('theme-toggle');
  const render = () => {
    // Show the theme you would switch *to*, with the reference site's glyphs.
    button.textContent = theme() === 'light' ? '🌙' : '☀️';
  };
  render();
  button.addEventListener('click', () => {
    toggleTheme();
    render();
  });
}

/**
 * One button that names the language you would switch *to*, as on
 * Humanoid_Robot_Learning_Paper_Notebooks.
 */
function setupLang() {
  const button = document.getElementById('lang-toggle');
  const label = button.querySelector('.lang-label');
  label.textContent = lang() === 'zh' ? 'English' : '中文';
  button.addEventListener('click', () => {
    setLang(lang() === 'zh' ? 'en' : 'zh');
    location.reload(); // simplest way to re-render every rendered string
  });
}

async function main() {
  setupTheme();
  setLang(detectLang());
  applyStatic();
  setupLang();
  for (const el of document.querySelectorAll('[data-year]')) {
    el.textContent = String(new Date().getFullYear());
  }

  let data;
  try {
    data = await loadRegistry();
  } catch (err) {
    document.getElementById('grid').innerHTML =
      `<p class="empty">Could not load data/robots.json — run <code>npm run registry</code>.<br><small>${err.message}</small></p>`;
    return;
  }

  const gallery = new Gallery(data, (id) => {
    location.hash = `robot=${id}`;
  });
  let detail = null;

  const initial = parseHash();
  gallery.state.query = initial.q;
  document.getElementById('search').value = initial.q;
  gallery.renderStats();
  gallery.render();
  gallery.onStateChange = (state) => {
    if (!parseHash().robot) writeHash({ category: state.category, q: state.query });
  };
  // The gallery is long now that every category is on it at once, so coming
  // back from a detail page returns to the card that was clicked, not the top.
  let galleryScroll = 0;

  async function route() {
    const { robot: id, category } = parseHash();
    if (!id) {
      views.detail.hidden = true;
      views.gallery.hidden = false;
      document.title = 'Robot URDF Gallery · 机器人 URDF 合集';
      // `#category=quadruped` is a link to a section of the page: honour it on
      // the first load and whenever the address bar names a section other than
      // the one being read. Coming back from a robot it names that same
      // section, and then the remembered scroll is the better answer — it
      // returns to the card that was clicked rather than the section's top.
      if (category !== gallery.state.category) gallery.jumpTo(category, { smooth: false });
      else window.scrollTo({ top: galleryScroll });
      writeHash(gallery.state);
      return;
    }
    const robot = byId(data, id);
    if (!robot) {
      location.hash = '';
      return;
    }
    if (!views.gallery.hidden) galleryScroll = window.scrollY;
    views.gallery.hidden = true;
    views.detail.hidden = false;
    window.scrollTo({ top: 0 });
    detail = detail || new Detail(data);
    detail.relayout();
    setupNeighbours(robot);
    await detail.show(robot);
  }

  function setupNeighbours(robot) {
    const list = gallery.visible();
    const index = list.findIndex((r) => r.id === robot.id);
    const pool = index === -1 ? data.robots : list;
    const at = index === -1 ? pool.findIndex((r) => r.id === robot.id) : index;
    const prev = pool[(at - 1 + pool.length) % pool.length];
    const next = pool[(at + 1) % pool.length];
    const prevBtn = document.getElementById('prev-robot');
    const nextBtn = document.getElementById('next-robot');
    prevBtn.onclick = () => (location.hash = `robot=${prev.id}`);
    nextBtn.onclick = () => (location.hash = `robot=${next.id}`);
    prevBtn.title = prev.name;
    nextBtn.title = next.name;
  }

  // Leaving a robot returns to the gallery as it was — same section, same
  // search — rather than to a bare address that reads as "start from the top".
  const toGallery = () => {
    location.hash = hashFor(gallery.state);
  };
  document.getElementById('back-btn').addEventListener('click', toGallery);

  window.addEventListener('hashchange', route);
  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'Escape' && parseHash().robot) toGallery();
    if (event.key === 'ArrowLeft') document.getElementById('prev-robot')?.click();
    if (event.key === 'ArrowRight') document.getElementById('next-robot')?.click();
    if (event.key === '/') {
      event.preventDefault();
      document.getElementById('search').focus();
    }
  });

  await route();
}

main();

// Expose the language list for the console / debugging.
window.__rug = { LANGS };
