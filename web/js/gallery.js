/** The card grid — one section per category — its jump chips and the hero counters. */
import { descriptionOf, groupRobots, stats } from './registry.js';
import { categoryLabel, t } from './i18n.js';

const el = (id) => document.getElementById(id);

/** How far below the section heading the chips consider it "the one being read". */
const SPY_SLACK = 12;

/**
 * How many columns a grid is laid out in right now.
 *
 * Only the resolved value answers that: it is one pixel length per track —
 * `235.2px 235.2px 235.2px` — so the tracks can be counted. A grid the browser
 * is not laying out has nothing to resolve and reports the value as written
 * instead, `repeat(auto-fill, minmax(224px, 1fr))`, whose three space-separated
 * pieces are not three columns. Anything that is not a list of lengths is
 * therefore not an answer, and says so with 0.
 */
function columnCount(grid) {
  const tracks = getComputedStyle(grid)
    .gridTemplateColumns.trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tracks.length || !tracks.every((track) => track.endsWith('px'))) return 0;
  return tracks.length;
}

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
    window.addEventListener('resize', () => {
      this.syncMakerSpans();
      spy();
    });
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
    this.syncMakerSpans();
    this.syncActive();
  }

  section({ id, robots, makers }) {
    const label = categoryLabel(id, this.data.categories);
    return `<section class="cat-section" id="cat-${id}" aria-labelledby="cat-${id}-h">
      <h2 class="cat-heading" id="cat-${id}-h">${label}<span class="count">${robots.length}</span></h2>
      <div class="maker-groups">
        ${makers.map((group, index) => this.makerSection(id, group, index)).join('')}
      </div>
    </section>`;
  }

  /** One manufacturer's robots within a category. */
  makerSection(category, { maker, robots }, index) {
    const heading = `maker-${category}-${index}`;
    return `<section class="maker-group" aria-labelledby="${heading}" data-size="${robots.length}">
      <h3 class="maker-heading" id="${heading}">${maker}<span class="count">${robots.length}</span></h3>
      <div class="grid">${robots.map((robot) => this.card(robot)).join('')}</div>
    </section>`;
  }

  /**
   * Let short maker groups share a row without ever splitting a group that
   * started part-way across it. A group occupies one parent-grid column per
   * robot, capped at the number of columns currently available; CSS Grid then
   * moves the whole group to the next row when its span will not fit.
   */
  syncMakerSpans() {
    // A grid of no width is a grid the browser is not laying out — the gallery
    // is hidden behind a robot's page or a comparison — and there is nothing on
    // it to measure: the tracks resolve to the `repeat(auto-fill, ...)` they
    // were written as, whose three space-separated pieces were read as three
    // columns and froze every group three cards wide for the rest of the visit.
    // The spans already on the page, the last ones measured for real, are the
    // better answer until `relayout()` can take a real measurement.
    if (!this.gridEl.clientWidth) return;
    for (const groups of this.gridEl.querySelectorAll('.maker-groups')) {
      const makers = [...groups.querySelectorAll('.maker-group')];
      // Clear spans first: after a viewport becomes narrower, an old wider
      // span would create implicit columns and make the measured count wrong.
      for (const maker of makers) maker.style.removeProperty('--maker-span');
      const columns = Math.max(1, columnCount(groups));
      for (const maker of makers) {
        const size = Number.parseInt(maker.dataset.size, 10) || 1;
        maker.style.setProperty('--maker-span', Math.min(size, columns));
      }
    }
  }

  /**
   * Back on screen. The search box is in the header, so the gallery re-renders
   * behind a robot's page and behind a comparison, where its grid cannot be
   * measured — and nothing else is coming: leaving a stage fires no resize. So
   * the spans are taken again here, before the frame the reader sees.
   */
  relayout() {
    this.syncMakerSpans();
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
    const thumb = robot.assets.thumbnail || `./thumbs/${robot.id}.webp`;
    const dof = robot.dof || descriptionOf(robot)?.moving_joints;
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
    // A card whose thumbnail has not been rendered yet falls back to whatever
    // preview image upstream publishes — Menagerie ships one per model — and
    // only then to the placeholder glyph.
    const fallback = robot.assets.upstream_thumbnail;
    const onError = fallback
      ? `if(this.dataset.retried){this.replaceWith(Object.assign(document.createElement('span'),{className:'placeholder',textContent:'🖼️'}))}else{this.dataset.retried='1';this.src='${fallback}'}`
      : `this.replaceWith(Object.assign(document.createElement('span'),{className:'placeholder',textContent:'🖼️'}))`;
    return `<a class="card" href="#robot=${robot.id}" data-id="${robot.id}">
      <figure class="card-figure">
        <img src="${thumb}" alt="${robot.name}" loading="lazy" decoding="async"
             onerror="${onError}">
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
