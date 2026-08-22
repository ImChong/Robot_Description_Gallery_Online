/** The detail view: 3D stage, overlay toggles, joint sliders, spec table. */
import { RobotViewer, THEMES } from './viewer.js';
import { formatBytes, urdfUrl } from './registry.js';
import { categoryLabel, lang, t } from './i18n.js';
import { downloadBundle, downloadRos2, downloadUrdf, ros2PackageName } from './download.js';
import { icon } from './icons.js';
import { onThemeChange, theme } from './theme.js';

const el = (id) => document.getElementById(id);

/**
 * `swatch` names the palette entry the dot borrows, rather than a colour: the
 * overlays are drawn in whichever studio the stage is currently lit for, and
 * the legend has to move with them.
 */
const OVERLAYS = [
  { key: 'visual', swatch: null },
  { key: 'collision', swatch: 'collision' },
  { key: 'axes', swatch: 'axis' },
  { key: 'frames', swatch: null },
  { key: 'com', swatch: 'com' },
  { key: 'inertia', swatch: 'inertia' },
];

const hex = (color) => `#${color.toString(16).padStart(6, '0')}`;

/**
 * Native fullscreen, through both spellings and prepared for neither: Safari
 * only dropped the `webkit` prefix in 16.4, and the iPhone has never had
 * element fullscreen at all. Every call here may therefore come to nothing,
 * which is why the mode itself is a class the CSS acts on rather than
 * `:fullscreen` — a refused request still gets the big stage, minus the
 * browser's own chrome.
 */
const fsElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

function fsRequest(node) {
  const request = node.requestFullscreen ?? node.webkitRequestFullscreen;
  if (!request) return Promise.reject(new Error('no element fullscreen here'));
  return Promise.resolve(request.call(node, { navigationUI: 'hide' }));
}

function fsExit() {
  const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
  return exit ? Promise.resolve(exit.call(document)) : Promise.resolve();
}

/**
 * Fullscreen lifts the joint tree — sliders and all — onto the render as a
 * floating column, sized for a glance at it. A deep chain, or the joint names a
 * generated URDF tends to carry, wants more than a glance, so on a desktop the
 * inner edge of the column is a handle: drag it and the column grows, as far as
 * half the page.
 *
 * The width is written onto the detail view as a pixel variable the fullscreen
 * rules read: they inset the render by it, so widening the column narrows the
 * render rather than covering it, and the robot stays centred in what is left.
 * The numbers below are the ones css/app.css falls back to when nobody has
 * dragged anything — the floor of its `clamp()`, and its `22vw` ceiling of
 * `340px`.
 */
const PANEL_MIN_W = 240;
const PANEL_VAR = { tree: '--fs-tree-w' };
const PANEL_W_KEY = 'cl-fs-panel-w';

/**
 * What the column may never close over: the 14px it sits in from its own edge
 * of the screen and the 14px between it and the render, and a strip of render
 * wide enough to still be showing a robot. Only a window far narrower than
 * fullscreen is ever meant for brings this bound into play; half the page is
 * what stops the drag on any real screen.
 */
const PANEL_GUTTERS = 28;
const PANEL_MIN_RENDER = 320;

/** Half the page: as wide as the column may be dragged. */
const panelMaxW = () => Math.round(window.innerWidth / 2);

/** As far as the column can actually be dragged — that same half, unless the
 *  window is too narrow to spare it and still be showing the robot. */
function panelCeilingW() {
  const half = panelMaxW();
  return Math.max(
    Math.min(PANEL_MIN_W, half),
    Math.min(half, window.innerWidth - PANEL_GUTTERS - PANEL_MIN_RENDER),
  );
}

/** What the column is worth before anyone drags it. */
const panelDefaultW = () =>
  Math.round(Math.min(340, Math.max(PANEL_MIN_W, window.innerWidth * 0.22)));

/** Never past the ceiling, never under the floor — and on a window too narrow
 *  for both bounds to hold at once, the ceiling is the one that wins. */
function clampPanelW(px) {
  const max = panelCeilingW();
  return Math.round(Math.min(Math.max(px, Math.min(PANEL_MIN_W, max)), max));
}

/**
 * The column as it can actually be shown: what it was dragged to, within what
 * this window allows it. Nothing is written back to the dragged width, so a
 * column the window has brought in opens out again the moment there is room.
 */
function resolvePanelWidths(widths) {
  const out = {};
  for (const key of Object.keys(PANEL_VAR)) {
    out[key] = clampPanelW(widths[key] ?? panelDefaultW());
  }
  return out;
}

/**
 * Dragged widths survive the visit, next to the theme and the angle unit: a
 * column widened to read a long branch is a preference about this reader's
 * screen, not about the robot that happened to be open.
 */
function storedPanelWidths() {
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL_W_KEY) || '{}');
    const out = {};
    for (const key of Object.keys(PANEL_VAR)) {
      if (Number.isFinite(raw?.[key])) out[key] = raw[key];
    }
    return out;
  } catch {
    return {}; // private mode, or something else wrote that key
  }
}

function savePanelWidths(widths) {
  try {
    localStorage.setItem(PANEL_W_KEY, JSON.stringify(widths));
  } catch {
    /* private mode — the widths just will not persist */
  }
}

/**
 * Angles are radians everywhere below the UI — that is what the URDF declares
 * and what the viewer is driven with. Degrees are only ever a rendering of
 * them, so switching units re-labels the panel and never touches the pose.
 * The choice is remembered, next to the theme and the language.
 */
const ANGLE_UNITS = ['deg', 'rad'];
const DEG = 180 / Math.PI;
let angleUnit = storedAngleUnit();

function storedAngleUnit() {
  try {
    const stored = localStorage.getItem('cl-angle-unit');
    if (ANGLE_UNITS.includes(stored)) return stored;
  } catch {
    /* private mode — fall through to the default */
  }
  return 'deg';
}

function setAngleUnit(unit) {
  angleUnit = ANGLE_UNITS.includes(unit) ? unit : 'deg';
  try {
    localStorage.setItem('cl-angle-unit', angleUnit);
  } catch {
    /* private mode — the choice just will not persist */
  }
}

const SNIPPETS = {
  // Most entries come from robot_descriptions.py and load in one call. The
  // ones curated straight from a repository have no key to pass it, so they
  // get the equivalent: pinocchio pointed at the checkout the git tab clones.
  python: (r) =>
    r.source.description
      ? `# pip install robot_descriptions
from robot_descriptions.loaders.pinocchio import load_robot_description

robot = load_robot_description("${r.source.description}")
print(robot.model.nq, "DOF")`
      : `# pip install pin
# ${r.name} has no robot_descriptions entry — load it from the checkout
# the git tab makes.
import pinocchio

robot = pinocchio.RobotWrapper.BuildFromURDF(
    "${repoDir(r)}/${r.assets.urdf}",${packageDirs(r).length ? `\n    [${packageDirs(r).map((d) => `"${d}"`).join(', ')}],` : ''}
)
print(robot.model.nq, "DOF")`,
  // Same split as `python` above, with a third case: a curated entry can ship
  // an MJCF next to its URDF without robot_descriptions having a key for it,
  // and pointing at the checkout is the only way to load that one.
  mujoco: (r) =>
    r.formats.includes('mjcf') && r.source.description
      ? `# pip install robot_descriptions mujoco
import mujoco
from robot_descriptions import ${mjKey(r)}

model = mujoco.MjModel.from_xml_path(${mjKey(r)}.MJCF_PATH)
data = mujoco.MjData(model)`
      : r.source.mjcf
        ? `# pip install mujoco
# ${r.name} has no robot_descriptions entry — load its MJCF from the checkout
# the git tab makes.
import mujoco

model = mujoco.MjModel.from_xml_path("${repoDir(r)}/${r.source.mjcf}")
data = mujoco.MjData(model)`
        : `# ${r.name} has no MJCF${r.source.description ? ' in robot_descriptions' : ' upstream'}.
# Convert the URDF with MuJoCo's compiler:
#   python -m mujoco.urdf2mjcf ${r.assets.urdf.split('/').pop()}`,
  git: (r) => `git clone ${r.source.repo_url}.git
cd ${repoDir(r)}
git checkout ${r.source.commit}
# URDF: ${r.assets.urdf}`,
  url: (r) => urdfUrl(r),
};

function mjKey(robot) {
  return robot.source.description.replace('_description', '_mj_description');
}

/** The directory `git clone` drops the upstream repository into. */
function repoDir(robot) {
  return robot.source.github.split('/')[1];
}

/**
 * Roots a URDF loader needs on its package path to resolve this model's
 * `package://` references: the parent of each directory the build step matched
 * a package to, relative to the clone. Models whose meshes are all relative
 * need none.
 */
function packageDirs(robot) {
  const dirs = Object.values(robot.assets.packages || {}).map((dir) => {
    const parent = dir.split('/').slice(0, -1).join('/');
    return parent ? `${repoDir(robot)}/${parent}` : repoDir(robot);
  });
  return [...new Set(dirs)];
}

export class Detail {
  constructor(data) {
    this.data = data;
    this.snippetKind = 'python';
    this.viewer = new RobotViewer(el('canvas-host'), { theme: theme() });

    el('overlay-toggles').innerHTML = OVERLAYS.map(
      (o) => `<button data-overlay="${o.key}" aria-pressed="${o.key === 'visual'}">
        ${o.swatch ? `<span class="swatch" data-swatch="${o.swatch}"></span>` : ''}
        <span data-i18n="overlay.${o.key}">${t(`overlay.${o.key}`)}</span></button>`,
    ).join('');
    this.renderSwatches();

    // The stage is part of the page, not a picture pasted onto it: flipping the
    // header's theme switch relights it in place, keeping the pose, the camera
    // and the loaded meshes exactly where the visitor left them.
    onThemeChange((name) => {
      this.viewer.setTheme(name);
      this.renderSwatches();
    });

    el('overlay-toggles').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const key = button.dataset.overlay;
      const next = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(next));
      this.viewer.setOverlay(key, next);
    });

    el('stage-toolbar').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const { action } = button.dataset;
      if (action === 'reset') {
        this.viewer.resetJoints();
        this.syncTreeValues();
      } else if (action === 'rotate') {
        this.viewer.autoRotate = !this.viewer.autoRotate;
        button.setAttribute('aria-pressed', String(!!this.viewer.autoRotate));
      } else if (action === 'frame') {
        this.viewer.frameCamera();
      } else if (action === 'snapshot') {
        this.download();
      } else if (action === 'fullscreen') {
        this.toggleFullscreen();
      }
    });

    // Fullscreen can also be left without touching that button — Escape, F11,
    // switching tabs — so the class follows the document, not the click.
    for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
      document.addEventListener(event, () => {
        if (!fsElement() && this.isFullscreen()) this.applyFullscreen(false);
      });
    }

    el('joints-reset').addEventListener('click', () => {
      this.viewer.resetJoints();
      this.syncTreeValues();
    });

    this.renderUnitToggle();
    el('joint-unit').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-unit]');
      if (!button || button.dataset.unit === angleUnit) return;
      setAngleUnit(button.dataset.unit);
      this.renderUnitToggle();
      this.renderTree();
    });

    // The card that stands where the tree used to be on the page, saying where
    // it went. Its button is the same door the toolbar's expand icon opens.
    el('pose-fullscreen').addEventListener('click', () => this.toggleFullscreen());

    el('snippet-copy').addEventListener('click', async () => {
      await navigator.clipboard?.writeText(el('snippet-code').textContent);
      const button = el('snippet-copy');
      button.textContent = t('panel.copied');
      setTimeout(() => (button.textContent = t('panel.copy')), 1400);
    });

    el('snippet-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      this.snippetKind = button.dataset.kind;
      this.renderSnippet();
    });

    el('d-downloads').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-download]');
      if (button) this.runDownload(button);
    });

    this.bindTree();
    this.bindPanelResize();
  }

  /**
   * The joint tree drives the stage: the link under the pointer lights up,
   * hovering is a preview — leaving the tree puts the pinned link back — and
   * clicking pins. The sliders live in the tree too, and they are the one part
   * of a row that is not the row: a drag along one is not a click on the joint
   * it belongs to, and its arrow keys are its own, not the tree's.
   */
  bindTree() {
    const tree = el('d-tree');
    const onSlider = (event) => !!event.target.closest('.tree-slider');

    tree.addEventListener('click', (event) => {
      if (onSlider(event)) return;
      const twisty = event.target.closest('.tree-twisty');
      const node = event.target.closest('.tree-node');
      if (!node) return;
      if (twisty) this.toggleTreeNode(node);
      else this.selectTreeNode(node);
    });

    // Every slider in the tree, read off the row it sits under.
    tree.addEventListener('input', (event) => {
      const input = event.target;
      if (input.type !== 'range') return;
      const name = decodeURIComponent(input.dataset.joint);
      const value = parseFloat(input.value);
      this.viewer.setJoint(name, value);
      const cell = this.treeValues?.get(name);
      if (cell) cell.textContent = fmt(value, input.dataset.rot === 'true');
    });

    tree.addEventListener('pointerover', (event) => {
      const node = event.target.closest('.tree-node');
      if (node) this.viewer.highlightLink(node.dataset.link);
    });
    tree.addEventListener('pointerleave', () => {
      this.viewer.highlightLink(this.pinnedLink || null);
    });
    // Keyboard focus is the other way to walk the tree, and it lights the same
    // link the pointer would.
    tree.addEventListener('focusin', (event) => {
      const node = event.target.closest('.tree-node');
      if (node) this.viewer.highlightLink(node.dataset.link);
    });

    tree.addEventListener('keydown', (event) => {
      if (onSlider(event)) return;
      this.onTreeKey(event);
    });

    el('tree-expand').addEventListener('click', () => this.setTreeExpanded(true));
    el('tree-collapse').addEventListener('click', () => this.setTreeExpanded(false));
  }

  /** Paint the overlay legend dots in the palette the stage is currently using. */
  renderSwatches() {
    const palette = THEMES[theme()];
    for (const dot of el('overlay-toggles').querySelectorAll('.swatch[data-swatch]')) {
      dot.style.color = hex(palette[dot.dataset.swatch]);
    }
  }

  /**
   * Fetch and save a model. Every variant streams from the CDN in the visitor's
   * browser — there is no server here to zip anything up — so the button doubles
   * as the progress indicator.
   */
  async runDownload(button) {
    const kind = button.dataset.download;
    const robot = this.robot;
    const label = button.querySelector('.dl-main');
    const sub = button.querySelector('.dl-sub');
    const fill = button.querySelector('.dl-fill');
    const original = { label: label.textContent, sub: sub.textContent };

    const onProgress = (done, total) => {
      const pct = total ? Math.round((done / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      sub.textContent = `${done}/${total} · ${pct}%`;
    };

    button.disabled = true;
    sub.textContent = t('dl.working');
    try {
      if (kind === 'bundle') {
        await downloadBundle(robot, onProgress);
      } else if (kind === 'ros2') {
        await downloadRos2(robot, onProgress);
      } else {
        await downloadUrdf(robot);
      }
      sub.textContent = original.sub;
    } catch (err) {
      sub.textContent = `${t('dl.failed')}: ${err.message || err}`;
    } finally {
      button.disabled = false;
      if (fill) fill.style.width = '0';
    }
  }

  /**
   * The three archives, smallest payload first: the .urdf on its own, then the
   * same file with every mesh beside it, then that bundle wrapped as a ROS 2
   * package. Each row adds to the one above it, so the list reads as one scale
   * rather than three unrelated options — and each carries the same download
   * mark, since what differs between them is the payload, not the action.
   */
  renderDownloads() {
    const r = this.robot;
    const meshes = r.assets.mesh_files;
    const bundleSize = formatBytes(r.assets.mesh_bytes + r.urdf.bytes);
    const rows = [
      {
        kind: 'urdf',
        main: t('dl.urdf'),
        sub: t('dl.urdfSub'),
        size: formatBytes(r.urdf.bytes),
      },
      {
        kind: 'bundle',
        main: t('dl.bundle'),
        sub: `${t('dl.bundleSub')} · ${meshes} ${meshes === 1 ? 'mesh' : 'meshes'}`,
        size: bundleSize,
      },
      {
        kind: 'ros2',
        main: t('dl.ros2'),
        sub: t('dl.ros2Sub'),
        size: bundleSize,
        title: ros2PackageName(r),
      },
    ];
    el('d-downloads').innerHTML = rows
      .map(
        (row) => `
      <button class="dl-btn" data-download="${row.kind}"${row.title ? ` title="${row.title}"` : ''}>
        <i class="dl-fill"></i>
        <span class="dl-icon">${icon('download')}</span>
        <span class="dl-text">
          <span class="dl-main">${row.main}</span>
          <span class="dl-sub">${row.sub}</span>
        </span>
        <span class="dl-size">${row.size}</span>
      </button>`,
      )
      .join('');
  }

  download() {
    const url = this.viewer.snapshot();
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.robot.id}.png`;
    link.click();
  }

  /** @param {object} robot registry entry */
  async show(robot) {
    // Loads are asynchronous and a visitor can click through robots faster than
    // the meshes arrive, so every load carries a token and a superseded load
    // stops touching the DOM as soon as it notices it is stale.
    const token = Symbol(robot.id);
    this._token = token;
    const isStale = () => this._token !== token;

    const stage = el('canvas-host').parentElement;
    delete stage.dataset.loaded;
    this.robot = robot;
    el('d-name').textContent = robot.name;
    el('d-sub').textContent = [robot.maker, categoryLabel(robot.category, this.data.categories)]
      .filter(Boolean)
      .join(' · ');
    el('stage-title').textContent = [robot.name, robot.maker].filter(Boolean).join(' · ');
    document.title = `${robot.name} · Robot URDF Gallery`;

    this.renderSpecs();
    this.renderDownloads();
    this.renderResources();
    this.renderSnippet();
    el('joint-unit').hidden = true;
    this.clearTree();

    const loading = el('stage-loading');
    const bar = el('loading-bar');
    const error = el('stage-error');
    error.hidden = true;
    loading.hidden = false;
    bar.style.width = '4%';

    // Inertial data and the effort/velocity limits are in the raw XML but not in
    // what urdf-loader hands back, so the file is fetched a second time — from
    // the browser cache, since the loader has just asked for the same URL. Kicked
    // off alongside the meshes so it is ready by the time they are.
    const xmlText = fetch(urdfUrl(robot))
      .then((response) => (response.ok ? response.text() : null))
      .catch(() => null);

    try {
      await this.viewer.load(robot, (done, total) => {
        if (isStale()) return;
        bar.style.width = `${total ? Math.max(4, Math.round((done / total) * 100)) : 8}%`;
      });
      if (isStale()) return;
      // Same starting pose as the gallery card, so clicking a card does not
      // change what the robot looks like — the reset matters for joints whose
      // range excludes zero (panda_joint4 is -176°..-4°), which the loader
      // otherwise leaves parked outside their own limits.
      this.viewer.poseForPortrait(robot.pose);
      const xml = await xmlText;
      if (isStale()) return;
      if (xml) {
        this.viewer.setInertialData(xml);
        this.viewer.setJointMeta(xml);
      }
      loading.hidden = true;
      this.renderTree();
      this.renderSpecs(); // fills in the measured height
      // Published for the headless scripts: how much geometry arrived, and how
      // big it measured. A robot with meshes but no measurable size means the
      // scene is broken (NaN transforms, for instance).
      stage.dataset.meshes = String(this.viewer.stats?.visual ?? 0);
      stage.dataset.height = String(this.viewer.measured?.height_m ?? '');
      stage.dataset.loaded = robot.id;
    } catch (err) {
      if (isStale()) return;
      loading.hidden = true;
      error.hidden = false;
      error.innerHTML = `<strong>${t('viewer.failed')}</strong><code>${String(err.message || err)}</code>`;
      stage.dataset.failed = robot.id;
    }
  }

  renderSpecs() {
    const r = this.robot;
    const joints = Object.entries(r.urdf.joints || {})
      .map(([type, n]) => `${n}×${type}`)
      .join(', ');
    // Prefer the live measurement; fall back to the value recorded at build time
    // so the panel is populated before the meshes arrive.
    const measured = this.viewer.measured || r.measured;
    const rows = [
      [t('spec.maker'), r.maker || '—'],
      [t('spec.category'), categoryLabel(r.category, this.data.categories)],
      [t('spec.dof'), r.dof || r.urdf.moving_joints || '—'],
      [t('spec.links'), r.urdf.links],
      [t('spec.joints'), `<span class="sub">${joints || '—'}</span>`],
      [t('spec.mass'), massCell(r)],
      [
        t('spec.height'),
        measured
          ? `${measured.height_m.toFixed(3)} m<br><span class="sub">${t('height.measured')}</span>`
          : '—',
      ],
      [t('spec.formats'), r.formats.map((f) => f.toUpperCase()).join(' / ')],
      [t('spec.license'), r.license || '—'],
      [t('spec.assets'), `${r.assets.mesh_files} × ${r.assets.mesh_formats.join('/')}<br><span class="sub">${formatBytes(r.assets.mesh_bytes)}</span>`],
      [t('spec.commit'), `<span class="sub">${r.source.commit.slice(0, 10)}</span>`],
    ];
    const note = lang() === 'zh' ? r.notes_zh || r.notes : r.notes;
    el('d-specs').innerHTML =
      rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') +
      (note ? `<dd class="full sub" style="text-align:left">${note}</dd>` : '');
  }

  renderResources() {
    const r = this.robot;
    const items = [
      ['res.repo', r.source.repo_url, r.source.github],
      ['res.tree', r.source.tree_url, 'tree'],
      ['res.urdf', urdfUrl(r), r.assets.urdf.split('/').pop()],
      r.source.mjcf ? ['res.mjcf', r.assets.base + r.source.mjcf, r.source.mjcf.split('/').pop()] : null,
      r.source.license_url ? ['res.license', r.source.license_url, r.license || 'licence'] : null,
      r.links.official ? ['res.official', r.links.official, host(r.links.official)] : null,
      r.links.docs ? ['res.docs', r.links.docs, host(r.links.docs)] : null,
      r.links.paper ? ['res.paper', r.links.paper, host(r.links.paper)] : null,
      r.source.description
        ? [
            'res.descriptions',
            `https://github.com/robot-descriptions/robot_descriptions.py/blob/main/robot_descriptions/${r.source.description}.py`,
            r.source.description,
          ]
        : null,
    ].filter(Boolean);

    el('d-resources').innerHTML = items
      .map(
        ([key, url, kind]) =>
          `<li><a href="${url}" target="_blank" rel="noopener" title="${kind}">` +
          `<span class="res-label">${t(key)}</span><span class="kind">${kind}</span></a></li>`,
      )
      .join('');
  }

  renderSnippet() {
    const kinds = Object.keys(SNIPPETS);
    el('snippet-tabs').innerHTML = kinds
      .map(
        (kind) =>
          `<button data-kind="${kind}" aria-pressed="${kind === this.snippetKind}">${kind}</button>`,
      )
      .join('');
    el('snippet-code').textContent = SNIPPETS[this.snippetKind](this.robot);
  }

  /** Which of the two units is in force, on the segmented control. */
  renderUnitToggle() {
    for (const button of el('joint-unit').querySelectorAll('button[data-unit]')) {
      button.setAttribute('aria-pressed', String(button.dataset.unit === angleUnit));
    }
  }

  // ------------------------------------------------------------- joint tree

  clearTree() {
    el('d-tree').innerHTML = '';
    el('tree-summary').textContent = '';
    this.treeValues = new Map();
    this.treeSliders = new Map();
    this.pinnedLink = null;
  }

  /**
   * The kinematic tree, and the pose. One row per joint with the link it
   * carries, and under every row that moves, the slider that moves it and what
   * the URDF declares about it: travel, top speed, top effort.
   *
   * The two used to be separate panels, a flat list of sliders beside a tree
   * that could only scroll to them. Together they read as one thing — four of
   * these sliders are a leg, and the slider is where the eye already is when it
   * has found the joint it wants.
   */
  renderTree() {
    this.clearTree();
    const root = this.viewer.kinematicTree();
    const host = el('d-tree');
    if (!root) return;

    const joints = this.viewer.jointList();
    // Nothing to switch on a robot whose only joints slide rather than turn.
    el('joint-unit').hidden = !joints.some((joint) => joint.type !== 'prismatic');
    el('joints-reset').hidden = !joints.length;

    const counts = { links: 0, joints: 0 };
    countTree(root, counts);
    el('tree-summary').textContent = t('tree.summary')
      .replace('{links}', counts.links)
      .replace('{joints}', counts.joints);

    if (!root.children.length) {
      host.innerHTML = `<p class="muted" style="font-size:12.5px">${t('tree.none')}</p>`;
      return;
    }

    // The tree carries a joint's name and type; its travel and its limits are
    // in the flat list, so the two are read together to build a row.
    const byName = new Map(joints.map((joint) => [joint.name, joint]));
    host.innerHTML =
      // A robot whose joints are all fixed has a tree and not one slider in it;
      // said once at the top, rather than left to be inferred from the absence.
      (joints.length ? '' : `<p class="tree-none">${t('joints.none')}</p>`) +
      `<ul class="tree" role="tree" aria-label="${t('tree.aria')}">${treeNode(root, true, byName)}</ul>`;
    // The rows carry a roving tabindex: one stop for the whole tree, arrow keys
    // to move inside it, rather than sixty tab stops on a humanoid.
    host.querySelector('.tree-node')?.setAttribute('tabindex', '0');
    for (const cell of host.querySelectorAll('[data-tree-value]')) {
      this.treeValues.set(cell.dataset.treeValue, cell);
    }
    for (const input of host.querySelectorAll('input[data-joint]')) {
      this.treeSliders.set(decodeURIComponent(input.dataset.joint), input);
    }
    this.syncTreeValues();
  }

  /** Repaint the tree from the pose the viewer is actually in — the readout on
   *  every row, and the slider under the ones that move. A reset moves the
   *  robot and nothing else; this is what puts the panel back in step. */
  syncTreeValues() {
    if (!this.treeValues?.size && !this.treeSliders?.size) return;
    for (const joint of this.viewer.jointList()) {
      const cell = this.treeValues.get(joint.name);
      if (cell) cell.textContent = fmt(joint.value, joint.type !== 'prismatic');
      const input = this.treeSliders.get(joint.name);
      if (input) input.value = String(joint.value);
    }
  }

  toggleTreeNode(node) {
    const expanded = node.getAttribute('aria-expanded');
    if (expanded === null) return; // a leaf has nothing to fold
    node.setAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true');
  }

  /** Fold or unfold the whole tree. The root stays open — folding it hides everything. */
  setTreeExpanded(open) {
    for (const node of el('d-tree').querySelectorAll('.tree-node[aria-expanded]')) {
      if (!open && node.classList.contains('is-root')) continue;
      node.setAttribute('aria-expanded', String(open));
    }
  }

  /**
   * Pin a row: its link stays lit on the stage after the pointer leaves.
   * Clicking the pinned row again lets go.
   */
  selectTreeNode(node) {
    const host = el('d-tree');
    const wasPinned = node.getAttribute('aria-selected') === 'true';
    for (const other of host.querySelectorAll('.tree-node[aria-selected="true"]')) {
      other.removeAttribute('aria-selected');
    }
    for (const other of host.querySelectorAll('.tree-node[tabindex="0"]')) {
      other.setAttribute('tabindex', '-1');
    }
    node.setAttribute('tabindex', '0');
    if (wasPinned) {
      this.pinnedLink = null;
    } else {
      node.setAttribute('aria-selected', 'true');
      this.pinnedLink = node.dataset.link;
    }
    this.viewer.highlightLink(this.pinnedLink);
  }

  /** Arrow-key navigation, as a tree widget is expected to have. */
  onTreeKey(event) {
    const node = event.target.closest('.tree-node');
    if (!node) return;
    const open = node.getAttribute('aria-expanded');
    const move = (target) => {
      if (!target) return;
      node.setAttribute('tabindex', '-1');
      target.setAttribute('tabindex', '0');
      target.focus();
    };
    const rows = [...el('d-tree').querySelectorAll('.tree-node')].filter((n) => n.offsetParent);
    const at = rows.indexOf(node);

    switch (event.key) {
      case 'ArrowDown': move(rows[at + 1]); break;
      case 'ArrowUp': move(rows[at - 1]); break;
      case 'ArrowRight':
        if (open === 'false') node.setAttribute('aria-expanded', 'true');
        else if (open === 'true') move(node.querySelector('.tree-node'));
        break;
      case 'ArrowLeft':
        if (open === 'true') node.setAttribute('aria-expanded', 'false');
        else move(node.parentElement?.closest('.tree-node'));
        break;
      case 'Home': move(rows[0]); break;
      case 'End': move(rows[rows.length - 1]); break;
      case 'Enter': case ' ': this.selectTreeNode(node); break;
      default: return;
    }
    event.preventDefault();
  }

  // ------------------------------------------------------------- fullscreen

  isFullscreen() {
    return el('view-detail').classList.contains('stage-fullscreen');
  }

  toggleFullscreen() {
    if (this.isFullscreen()) this.exitFullscreen();
    else this.enterFullscreen();
  }

  /**
   * The whole detail view goes fullscreen rather than the stage alone: the two
   * panels that stay on screen are elsewhere in the markup, and a native
   * fullscreen renders nothing outside the element it was asked for.
   */
  async enterFullscreen() {
    try {
      await fsRequest(el('view-detail'));
    } catch {
      /* refused, or a browser without it — the class alone covers the page */
    }
    this.applyFullscreen(true);
  }

  async exitFullscreen() {
    if (fsElement()) {
      try {
        await fsExit();
      } catch {
        /* already on the way out */
      }
    }
    this.applyFullscreen(false);
  }

  /** Enter or leave the mode. Called again on the way back from the document's
   * own `fullscreenchange`, so it has to be safe to repeat. */
  applyFullscreen(on) {
    el('view-detail').classList.toggle('stage-fullscreen', on);
    document.body.classList.toggle('stage-fullscreen-open', on);

    const button = el('stage-toolbar').querySelector('[data-action="fullscreen"]');
    const name = on ? 'minimize' : 'expand';
    const key = on ? 'viewer.exitFullscreen' : 'viewer.fullscreen';
    button.setAttribute('aria-pressed', String(on));
    button.dataset.icon = name;
    button.innerHTML = icon(name);
    // Both the live attributes and the keys a language switch re-reads them
    // from: the button says what the next press will do, in either mode.
    button.dataset.i18nTitle = key;
    button.dataset.i18nAriaLabel = key;
    button.title = t(key);
    button.setAttribute('aria-label', t(key));

    // The canvas host has just changed size; the viewer's own ResizeObserver
    // does the resizing, this only asks for the frame that shows it.
    this.viewer.invalidate();
  }

  // -------------------------------------------------- fullscreen panel width

  /**
   * The width handle on each of the two floating columns. Whether there is one
   * to grab is the stylesheet's call — it withholds the handle on phones and
   * touch screens, where the columns are a bottom row the width of the screen —
   * so nothing here has to ask what kind of screen this is: a handle that is
   * not on screen is neither clickable nor tabbable.
   */
  bindPanelResize() {
    this.panelWidths = storedPanelWidths();
    this.resizers = {};

    for (const handle of document.querySelectorAll('.panel-resize')) {
      const key = handle.dataset.resize;
      const panel = handle.closest('.panel-block');
      if (!panel || !PANEL_VAR[key]) continue;
      // The left column grows to the right and the right column to the left, so
      // both handles follow the pointer instead of one of them mirroring it.
      const grow = key === 'tree' ? 1 : -1;
      this.resizers[key] = { handle, panel };

      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const startX = event.clientX;
        const startWidth = panel.getBoundingClientRect().width;
        // The pointer leaves a 12px strip almost immediately; capturing it
        // keeps every move of the drag on this handle — and off the stage
        // behind it, which would otherwise read the same drag as an orbit.
        handle.setPointerCapture(event.pointerId);
        handle.classList.add('is-dragging');
        document.body.classList.add('panel-resizing');

        // Offset from where the drag started rather than the pointer's own
        // position: the column then keeps whatever grip it was taken by.
        const move = (e) => this.setPanelWidth(key, startWidth + grow * (e.clientX - startX));
        const done = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', done);
          handle.removeEventListener('pointercancel', done);
          handle.classList.remove('is-dragging');
          document.body.classList.remove('panel-resizing');
          savePanelWidths(this.panelWidths);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', done);
        handle.addEventListener('pointercancel', done);
        // Or the drag selects the text of the panel it started on.
        event.preventDefault();
      });

      // The way back, for a column dragged somewhere it should not have gone.
      handle.addEventListener('dblclick', () => {
        this.resetPanelWidth(key);
        savePanelWidths(this.panelWidths);
      });

      handle.addEventListener('keydown', (event) => this.onPanelResizeKey(event, key, grow));
    }

    // A narrower window is a lower ceiling: the column comes down to it, and
    // goes back out to the width it was dragged to once the room returns.
    window.addEventListener('resize', () => this.syncPanelWidths());
    this.syncPanelWidths();
  }

  /**
   * Arrows widen and narrow — with Shift, faster — Home and End go to the two
   * bounds, and Enter restores the default. Every one of them stops at the
   * handle: on a detail page the left and right arrows are the previous and the
   * next robot, which is not what the reader holding this edge is asking for.
   */
  onPanelResizeKey(event, key, grow) {
    const width = this.resizers[key].panel.getBoundingClientRect().width;
    const step = event.shiftKey ? 48 : 16;
    switch (event.key) {
      case 'ArrowLeft': this.setPanelWidth(key, width - grow * step); break;
      case 'ArrowRight': this.setPanelWidth(key, width + grow * step); break;
      case 'Home': this.setPanelWidth(key, PANEL_MIN_W); break;
      case 'End': this.setPanelWidth(key, panelCeilingW()); break;
      case 'Enter': this.resetPanelWidth(key); break;
      default: return;
    }
    savePanelWidths(this.panelWidths);
    event.preventDefault();
    event.stopPropagation();
  }

  /** Give one column a width in pixels, within what the window allows. */
  setPanelWidth(key, px) {
    this.panelWidths[key] = clampPanelW(px);
    this.syncPanelWidths();
  }

  /** Hand one column back to the width it has when nobody has dragged it. */
  resetPanelWidth(key) {
    delete this.panelWidths[key];
    this.syncPanelWidths();
  }

  /** The column against the window as it is now. A dragged width is kept as it
   *  was dragged — only what it is allowed to be moves with the window. */
  syncPanelWidths() {
    const widths = resolvePanelWidths(this.panelWidths);
    for (const key of Object.keys(this.resizers)) this.applyPanelWidth(key, widths[key]);
    return widths;
  }

  /** Write a width onto the view for the fullscreen rules to read, and tell the
   *  handle where it now stands — a separator reports its position the way a
   *  slider does, and both bounds move with the window. */
  applyPanelWidth(key, width) {
    const { handle } = this.resizers[key];
    el('view-detail').style.setProperty(PANEL_VAR[key], `${width}px`);
    handle.setAttribute('aria-valuemin', String(Math.min(PANEL_MIN_W, panelCeilingW())));
    handle.setAttribute('aria-valuemax', String(panelCeilingW()));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', `${width}px`);
  }

  relayout() {
    this.viewer.invalidate();
  }
}

/**
 * One node of the joint tree, and everything under it. Each row is the joint
 * that attaches this link to its parent plus the link itself, so reading down a
 * branch reads the chain the way the URDF declares it; the root has no joint
 * above it and says so. A joint that moves also carries its slider, from
 * `joints` — the flat list, which is where the travel and the limits are.
 *
 * Names come out of an upstream URDF, so they are escaped on the way into the
 * markup and into the attributes the panel reads them back out of.
 */
function treeNode(node, isRoot = false, joints = null) {
  const { joint } = node;
  const children = node.children.length
    ? `<ul role="group">${node.children.map((child) => treeNode(child, false, joints)).join('')}</ul>`
    : '';
  const type = joint ? joint.type : null;
  const label = joint
    ? `<span class="tree-joint">${esc(joint.name)}</span>` +
      `<span class="jt" data-jt="${esc(type)}" title="${esc(type)}">${jointTypeLabel(type)}</span>` +
      (joint.mimic?.joint
        ? `<span class="jt mimic" title="${t('limit.mimicFull')}">${t('limit.mimic')}</span>`
        : '') +
      `<span class="tree-to" aria-hidden="true">→</span>`
    : `<span class="jt root">${t('tree.root')}</span>`;
  // A link with no geometry of its own is usually a frame the description
  // carries for reference; saying so explains why highlighting it lights
  // nothing up on the stage.
  const bare = node.meshes.visual === 0 && node.meshes.collision === 0;

  const moving = joint?.movable ? joints?.get(joint.name) : null;

  return (
    `<li class="tree-node${isRoot ? ' is-root' : ''}" role="treeitem" tabindex="-1"` +
    `${node.children.length ? ' aria-expanded="true"' : ''}` +
    // The row's own name, pinned: a slider and three chips of small print hang
    // inside this item, and without it they would all be read as its label.
    ` aria-label="${joint ? `${esc(joint.name)} → ` : ''}${esc(node.link)}"` +
    ` data-link="${esc(node.link)}"` +
    (joint ? ` data-joint="${esc(joint.name)}" data-movable="${joint.movable}"` : '') +
    '>' +
    '<span class="tree-row">' +
    `<span class="tree-twisty" aria-hidden="true"></span>` +
    label +
    `<span class="tree-link"${bare ? ` title="${t('tree.noMesh')}"` : ''}>${esc(node.link)}` +
    `${bare ? '<i class="tree-bare" aria-hidden="true">∅</i>' : ''}</span>` +
    '</span>' +
    (moving ? sliderBlock(moving) : '') +
    children +
    '</li>'
  );
}

/**
 * What a joint that moves carries under its row: the slider that moves it, the
 * angle it is at, and what the URDF declares about it. Folding the row folds
 * the branch below it, never this — the slider belongs to the joint on the row,
 * not to its children.
 *
 * The readout sits beside the slider rather than up on the row: the row is
 * already carrying two names and a type, and a deep chain leaves it no width to
 * spare — while the number belongs next to the thing that changes it anyway.
 */
function sliderBlock(joint) {
  const isRot = joint.type !== 'prismatic';
  const [lower, upper] = sliderRange(joint);
  return (
    '<div class="tree-slider">' +
    '<div class="slider-line">' +
    `<input type="range" min="${lower}" max="${upper}" step="${sliderStep(isRot)}"` +
    ` value="${joint.value}" data-joint="${encodeURIComponent(joint.name)}" data-rot="${isRot}"` +
    ` aria-label="${esc(joint.name)}">` +
    `<span class="tree-value" data-tree-value="${esc(joint.name)}">—</span>` +
    '</div>' +
    limitsRow(joint) +
    '</div>'
  );
}

/**
 * The joint type in the reader's language, falling back to what the URDF wrote
 * for a type this UI has no name for — `t()` hands the key back for a miss.
 */
function jointTypeLabel(type) {
  const label = t(`jt.${type}`);
  return esc(label === `jt.${type}` ? type : label);
}

/** How much of a robot the tree is showing: links, and the joints between them. */
function countTree(node, counts) {
  counts.links += 1;
  for (const child of node.children) {
    counts.joints += 1;
    countTree(child, counts);
  }
  return counts;
}

/** Link and joint names are upstream text; they never reach the DOM unescaped. */
function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * Mass as declared upstream. A handful of URDFs carry obviously wrong values
 * (BarrettHand's links add up to 264 tonnes); they are shown as-is with a
 * marker rather than silently corrected, since the URDF is the source of truth.
 */
function massCell(robot) {
  const mass = robot.urdf.mass_kg;
  if (!mass) return '—';
  const suspect = mass > 2000;
  return (
    `${mass.toFixed(2)} kg${suspect ? ` <abbr title="${t('mass.suspect')}">?</abbr>` : ''}` +
    `<br><span class="sub">${t('mass.fromUrdf')}</span>`
  );
}

/**
 * How far the slider may travel. A joint with real limits uses them; a
 * continuous one gets a full turn, and one whose URDF declares no `<limit>` at
 * all would otherwise be handed the loader's 0..0 default and freeze — those get
 * a plausible working range instead, wide enough to see the joint move.
 */
function sliderRange(joint) {
  const isRot = joint.type !== 'prismatic';
  if (joint.hasLimits) return [joint.lower, joint.upper];
  return isRot ? [-Math.PI, Math.PI] : [-0.5, 0.5];
}

/**
 * The slider still travels in radians — only the readout changes unit — but its
 * step follows what is on screen, so one arrow key is a round 0.1° in degree
 * mode and 0.001 rad in radian mode rather than an odd number in either.
 */
function sliderStep(isRotational) {
  if (!isRotational) return 0.001;
  return angleUnit === 'rad' ? 0.001 : Math.PI / 1800;
}

/**
 * The limits the URDF declares for one joint: travel, and the effort and
 * velocity ceilings a controller is supposed to respect. Shown as-is —
 * `effort="0"` means the upstream file left it at zero, not that the joint is
 * unlimited.
 */
function limitsRow(joint) {
  const isRot = joint.type !== 'prismatic';
  const chips = [
    chip(t('limit.range'), rangeText(joint), rangeTitle(joint)),
    chip(
      t('limit.velocity'),
      joint.velocity === null ? '—' : `${num(joint.velocity)} ${isRot ? 'rad/s' : 'm/s'}`,
      t('limit.velocityFull'),
    ),
    chip(
      t('limit.effort'),
      joint.effort === null ? '—' : `${num(joint.effort)} ${isRot ? 'N·m' : 'N'}`,
      t('limit.effortFull'),
    ),
  ];
  if (joint.mimic?.joint) {
    const { joint: source, multiplier, offset } = joint.mimic;
    chips.push(
      chip(
        t('limit.mimic'),
        `${source} ×${num(multiplier)}${offset ? ` ${offset > 0 ? '+' : '−'}${num(Math.abs(offset))}` : ''}`,
        t('limit.mimicFull'),
      ),
    );
  }
  return `<div class="joint-limits">${chips.join('')}</div>`;
}

function chip(label, value, title) {
  return `<span class="lim" title="${title}"><i>${label}</i>${value}</span>`;
}

/**
 * Travel, in the same unit as the readout above the slider, written as the
 * closed interval it is — `[lower, upper]` — so the two ends read as a pair
 * rather than as one long run of digits.
 */
function rangeText(joint) {
  if (joint.type === 'continuous') return t('limit.continuous');
  if (!joint.hasLimits) return '—';
  if (joint.type === 'prismatic') return `[${num(joint.lower)}, ${num(joint.upper)}] m`;
  return angleUnit === 'rad'
    ? `[${num(joint.lower)}, ${num(joint.upper)}] rad`
    : `[${num(joint.lower * DEG, 1)}, ${num(joint.upper * DEG, 1)}]°`;
}

/** Hover text for the travel chip: the same travel in the unit not on show. */
function rangeTitle(joint) {
  if (joint.type === 'continuous') return `${t('limit.rangeFull')} · ${t('limit.continuous')}`;
  if (!joint.hasLimits) return `${t('limit.rangeFull')} · ${t('limit.none')}`;
  if (joint.type === 'prismatic') {
    return `${t('limit.rangeFull')}: [${num(joint.lower)}, ${num(joint.upper)}] m`;
  }
  return angleUnit === 'rad'
    ? `${t('limit.rangeFull')}: [${num(joint.lower * DEG, 1)}, ${num(joint.upper * DEG, 1)}]°`
    : `${t('limit.rangeFull')}: [${num(joint.lower)}, ${num(joint.upper)}] rad`;
}

/** Compact number: no trailing zeros, and no 14-digit float noise. */
function num(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e5)) return value.toExponential(1);
  return String(Number(value.toFixed(digits)));
}

/** The readout above a slider, in whichever unit the panel is switched to. */
function fmt(value, isRotational) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  if (!isRotational) return `${value.toFixed(3)} m`;
  return angleUnit === 'rad' ? `${value.toFixed(3)} rad` : `${(value * DEG).toFixed(1)}°`;
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'link';
  }
}
