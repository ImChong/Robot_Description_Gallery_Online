/** The card grid, its category filters and the hero counters. */
import { categoriesWithCounts, filterRobots, stats } from './registry.js';
import { categoryLabel, t } from './i18n.js';

const el = (id) => document.getElementById(id);

export class Gallery {
  /**
   * @param {object} data registry
   * @param {(id: string) => void} onOpen called when a card is activated
   */
  constructor(data, onOpen) {
    this.data = data;
    this.onOpen = onOpen;
    this.state = { category: 'all', query: '' };

    this.gridEl = el('grid');
    this.emptyEl = el('empty');
    this.filtersEl = el('category-filters');

    this.gridEl.addEventListener('click', (event) => {
      const card = event.target.closest('.card');
      if (!card) return;
      event.preventDefault();
      this.onOpen(card.dataset.id);
    });

    this.filtersEl.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) this.setState({ category: button.dataset.category });
    });

    const search = el('search');
    search.addEventListener('input', () => this.setState({ query: search.value }));
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
    el('stat-joints').textContent = s.joints;
    el('stat-repos').textContent = s.repos;
    if (this.data.generated) {
      el('footer-generated').textContent = `${this.data.generator} · ${this.data.generated}`;
    }
  }

  renderFilters() {
    const cats = categoriesWithCounts(this.data);
    const buttons = [
      { id: 'all', label: t('filters.all'), count: this.data.robots.length },
      ...cats.map((c) => ({ id: c.id, label: categoryLabel(c.id, this.data.categories), count: c.count })),
    ];
    this.filtersEl.innerHTML = buttons
      .map(
        (b) => `<button data-category="${b.id}" aria-pressed="${b.id === this.state.category}">
          ${b.label}<span class="count">${b.count}</span></button>`,
      )
      .join('');
  }

  /** The visible list, in display order — used for detail-page prev/next. */
  visible() {
    return filterRobots(this.data, this.state);
  }

  render() {
    this.renderFilters();
    const robots = this.visible();
    this.emptyEl.hidden = robots.length > 0;
    this.gridEl.innerHTML = robots.map((robot) => this.card(robot)).join('');
  }

  card(robot) {
    const thumb = `./thumbs/${robot.id}.webp`;
    const dof = robot.dof || robot.urdf.moving_joints;
    const height = robot.measured?.height_m;
    const tags = [
      dof ? `<span class="tag dof">${dof} ${t('unit.dof')}</span>` : '',
      // Measured from the meshes, so the gallery can be scanned by size.
      height ? `<span class="tag">${height < 1 ? `${Math.round(height * 100)} cm` : `${height.toFixed(2)} m`}</span>` : '',
      robot.formats.includes('mjcf') ? `<span class="tag mjcf">MJCF</span>` : '',
    ].join('');
    return `<a class="card" href="#robot=${robot.id}" data-id="${robot.id}">
      <figure class="card-figure">
        <img src="${thumb}" alt="${robot.name}" loading="lazy" decoding="async"
             onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'placeholder',textContent:'🦾'}))">
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
