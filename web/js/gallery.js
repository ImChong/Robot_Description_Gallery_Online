/** The card grid — one section per category — its jump chips and the hero counters. */
import { groupRobots, stats } from './registry.js';
import { categoryLabel, t } from './i18n.js';

const el = (id) => document.getElementById(id);

/** How far below the section heading the chips consider it "the one being read". */
const SPY_SLACK = 12;

export class Gallery {
  /**
   * @param {object} data registry
   * @param {(id: string) => void} onOpen called when a card is activated
   */
  constructor(data, onOpen) {
    this.data = data;
    this.onOpen = onOpen;
    // `category` is the section the chips point at, not a filter: every
    // category stays on the page and the chips scroll between them.
    this.state = { category: 'all', query: '' };
    this.groups = [];
    /** Where a chip is scrolling the page to, while it is still on its way. */
    this.pending = null;

    this.gridEl = el('grid');
    this.emptyEl = el('empty');
    this.filtersEl = el('category-filters');
    this.headerEl = document.querySelector('.site-header');
    this.viewEl = this.gridEl.closest('.view');

    this.gridEl.addEventListener('click', (event) => {
      const card = event.target.closest('.card');
      if (!card) return;
      event.preventDefault();
      this.onOpen(card.dataset.id);
    });

    this.filtersEl.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) this.jumpTo(button.dataset.category);
    });

    const search = el('search');
    search.addEventListener('input', () => this.setState({ query: search.value }));

    // Reading the page is the other way to move between sections, so the chips
    // follow the scroll as well as drive it.
    let queued = false;
    const spy = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this.syncActive();
      });
    };
    window.addEventListener('scroll', spy, { passive: true });
    window.addEventListener('resize', spy);
    // Taking the wheel mid-jump hands the chips back to the scroll.
    for (const event of ['wheel', 'touchstart']) {
      window.addEventListener(event, () => this.settle(), { passive: true });
    }
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.render();
    if (this.onStateChange) this.onStateChange(this.state);
  }

  renderStats() {
    const s = stats(this.data);
    el('stat-robots').textContent = s.robots;
    el('stat-makers').textContent = s.makers;
    el('stat-categories').textContent = s.categories;
    el('stat-repos').textContent = s.repos;
  }

  renderFilters() {
    const total = this.groups.reduce((n, group) => n + group.robots.length, 0);
    const buttons = [
      { id: 'all', label: t('filters.all'), count: total, title: t('filters.allTitle') },
      ...this.groups.map((group) => {
        const label = categoryLabel(group.id, this.data.categories);
        return {
          id: group.id,
          label,
          count: group.robots.length,
          title: t('filters.jump').replace('{label}', label),
        };
      }),
    ];
    this.filtersEl.innerHTML = buttons
      .map(
        (b) => `<button data-category="${b.id}" title="${b.title}"
          aria-current="${b.id === this.state.category}">
          ${b.label}<span class="count">${b.count}</span></button>`,
      )
      .join('');
  }

  /** The visible list, in display order — used for detail-page prev/next. */
  visible() {
    return this.groups.flatMap((group) => group.robots);
  }

  render() {
    // Any jump still in flight was aimed at the layout about to be replaced.
    this.pending = null;
    clearTimeout(this.settleTimer);
    this.groups = groupRobots(this.data, this.state);
    // A search can retire the section the chips were pointing at.
    if (!this.groups.some((group) => group.id === this.state.category)) this.state.category = 'all';
    this.renderFilters();
    this.emptyEl.hidden = this.groups.length > 0;
    this.gridEl.innerHTML = this.groups.map((group) => this.section(group)).join('');
    this.syncActive();
  }

  section({ id, robots }) {
    const label = categoryLabel(id, this.data.categories);
    return `<section class="cat-section" id="cat-${id}" aria-labelledby="cat-${id}-h">
      <h2 class="cat-heading" id="cat-${id}-h">${label}<span class="count">${robots.length}</span></h2>
      <div class="grid">${robots.map((robot) => this.card(robot)).join('')}</div>
    </section>`;
  }

  /**
   * What a section has to clear to be readable: the fixed header plus the
   * sticky chip bar, whose height depends on whether the chips wrapped.
   */
  jumpOffset() {
    const header = this.headerEl?.getBoundingClientRect().height || 0;
    return header + this.filtersEl.getBoundingClientRect().height;
  }

  /** Scroll a category's section into view under the chip bar. `all` goes home. */
  jumpTo(category, { smooth = true } = {}) {
    const section = category === 'all' ? null : el(`cat-${category}`);
    if (category !== 'all' && !section) return;
    const doc = document.documentElement;
    const wanted = section
      ? window.scrollY + section.getBoundingClientRect().top - this.jumpOffset() - 8
      : 0;
    // Clamped to what the page can actually do, so the arrival below is
    // something the scroll position can reach exactly.
    this.pending = Math.min(Math.max(0, wanted), Math.max(0, doc.scrollHeight - window.innerHeight));
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.settle(), 1500);
    this.setActive(category);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const smoothly = smooth && !reduced;
    window.scrollTo({ top: this.pending, behavior: smoothly ? 'smooth' : 'auto' });
    if (!smoothly) this.settle(); // an instant scroll has already arrived
  }

  /** The jump is over — whether it arrived, was interrupted, or timed out. */
  settle() {
    if (this.pending === null) return;
    this.pending = null;
    clearTimeout(this.settleTimer);
    this.syncActive();
  }

  /** Mark whichever section the reader has reached. */
  syncActive() {
    if (!this.groups.length || this.viewEl?.hidden) return;
    // A long smooth jump flies past every section on the way; until it lands,
    // the chips answer to the click that started it.
    if (this.pending !== null) {
      if (Math.abs(window.scrollY - this.pending) > 2) return;
      this.settle();
      return;
    }
    const doc = document.documentElement;
    // The last section is often shorter than the viewport, so it can never
    // reach the line on its own; landing at the bottom of the page is what
    // "you are in the last section" looks like.
    if (window.scrollY + window.innerHeight >= doc.scrollHeight - 4) {
      this.setActive(this.groups[this.groups.length - 1].id);
      return;
    }
    const line = this.jumpOffset() + SPY_SLACK;
    let active = 'all';
    for (const group of this.groups) {
      const section = el(`cat-${group.id}`);
      if (section && section.getBoundingClientRect().top <= line) active = group.id;
    }
    this.setActive(active);
  }

  setActive(category) {
    if (this.state.category === category) return;
    this.state.category = category;
    let active = null;
    for (const button of this.filtersEl.querySelectorAll('button')) {
      const current = button.dataset.category === category;
      button.setAttribute('aria-current', String(current));
      if (current) active = button;
    }
    // On a phone the bar is one scrolling row, so the chip that just lit up can
    // be off the side of it. Scrolling the bar itself never moves the page.
    if (active && this.filtersEl.scrollWidth > this.filtersEl.clientWidth) {
      const left = active.offsetLeft - (this.filtersEl.clientWidth - active.offsetWidth) / 2;
      this.filtersEl.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    }
    if (this.onStateChange) this.onStateChange(this.state);
  }

  card(robot) {
    const thumb = `./thumbs/${robot.id}.webp`;
    const dof = robot.dof || robot.urdf.moving_joints;
    const height = robot.measured?.height_m;
    const versions = robot.variants?.length || 0;
    const tags = [
      dof ? `<span class="tag dof">${dof} ${t('unit.dof')}</span>` : '',
      // Measured from the meshes, so the gallery can be scanned by size.
      height ? `<span class="tag">${height < 1 ? `${Math.round(height * 100)} cm` : `${height.toFixed(2)} m`}</span>` : '',
      // One card per machine, so a machine upstream publishes several URDFs of
      // says so here — the numbers above are the one this card opens on.
      versions > 1 ? `<span class="tag versions">${t('unit.versions').replace('{n}', versions)}</span>` : '',
      robot.formats.includes('mjcf') ? `<span class="tag mjcf">MJCF</span>` : '',
    ].join('');
    return `<a class="card" href="#robot=${robot.id}" data-id="${robot.id}">
      <figure class="card-figure">
        <img src="${thumb}" alt="${robot.name}" loading="lazy" decoding="async"
             onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'placeholder',textContent:'🖼️'}))">
        <span class="card-cat">${categoryLabel(robot.category, this.data.categories)}</span>
      </figure>
      <div class="card-body">
        <span class="card-name">${robot.name}</span>
        <span class="card-maker">${robot.maker || '—'}</span>
        <span class="card-meta">${tags}</span>
      </div>
    </a>`;
  }
}
