/** The detail view: 3D stage, overlay toggles, joint sliders, spec table. */
import { RobotViewer, THEMES } from './viewer.js';
import { formatBytes, urdfUrl } from './registry.js';
import { categoryLabel, lang, t } from './i18n.js';
import { downloadBundle, downloadRos2, downloadUrdf, ros2PackageName } from './download.js';
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
  python: (r) => `# pip install robot_descriptions
from robot_descriptions.loaders.pinocchio import load_robot_description

robot = load_robot_description("${r.source.description}")
print(robot.model.nq, "DOF")`,
  mujoco: (r) =>
    r.formats.includes('mjcf')
      ? `# pip install robot_descriptions mujoco
import mujoco
from robot_descriptions import ${mjKey(r)}

model = mujoco.MjModel.from_xml_path(${mjKey(r)}.MJCF_PATH)
data = mujoco.MjData(model)`
      : `# ${r.name} has no MJCF in robot_descriptions.
# Convert the URDF with MuJoCo's compiler:
#   python -m mujoco.urdf2mjcf ${r.assets.urdf.split('/').pop()}`,
  git: (r) => `git clone ${r.source.repo_url}.git
cd ${r.source.github.split('/')[1]}
git checkout ${r.source.commit}
# URDF: ${r.assets.urdf}`,
  url: (r) => urdfUrl(r),
};

function mjKey(robot) {
  return robot.source.description.replace('_description', '_mj_description');
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
        this.renderJoints();
      } else if (action === 'rotate') {
        this.viewer.autoRotate = !this.viewer.autoRotate;
        button.setAttribute('aria-pressed', String(!!this.viewer.autoRotate));
      } else if (action === 'frame') {
        this.viewer.frameCamera();
      } else if (action === 'snapshot') {
        this.download();
      }
    });

    el('joints-reset').addEventListener('click', () => {
      this.viewer.resetJoints();
      this.renderJoints();
    });

    this.renderUnitToggle();
    el('joint-unit').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-unit]');
      if (!button || button.dataset.unit === angleUnit) return;
      setAngleUnit(button.dataset.unit);
      this.renderUnitToggle();
      this.renderJoints();
    });

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

  renderDownloads() {
    const r = this.robot;
    const meshes = r.assets.mesh_files;
    const bundleSize = formatBytes(r.assets.mesh_bytes + r.urdf.bytes);
    el('d-downloads').innerHTML = `
      <button class="dl-btn primary" data-download="bundle">
        <i class="dl-fill"></i>
        <span class="dl-icon" aria-hidden="true">⬇</span>
        <span class="dl-text">
          <span class="dl-main">${t('dl.bundle')}</span>
          <span class="dl-sub">${t('dl.bundleSub')} · ${meshes} ${
            meshes === 1 ? 'mesh' : 'meshes'
          }</span>
        </span>
        <span class="dl-size">${bundleSize}</span>
      </button>
      <button class="dl-btn" data-download="ros2" title="${ros2PackageName(r)}">
        <i class="dl-fill"></i>
        <span class="dl-icon" aria-hidden="true">📦</span>
        <span class="dl-text">
          <span class="dl-main">${t('dl.ros2')}</span>
          <span class="dl-sub">${t('dl.ros2Sub')}</span>
        </span>
        <span class="dl-size">${bundleSize}</span>
      </button>
      <button class="dl-btn" data-download="urdf">
        <i class="dl-fill"></i>
        <span class="dl-icon" aria-hidden="true">⬇</span>
        <span class="dl-text">
          <span class="dl-main">${t('dl.urdf')}</span>
          <span class="dl-sub">${t('dl.urdfSub')}</span>
        </span>
        <span class="dl-size">${formatBytes(r.urdf.bytes)}</span>
      </button>`;
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
    document.title = `${robot.name} · Robot URDF Gallery`;

    this.renderSpecs();
    this.renderDownloads();
    this.renderResources();
    this.renderSnippet();
    el('d-joints').innerHTML = '';
    el('joint-unit').hidden = true;

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
      this.renderJoints();
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
      [
        'res.descriptions',
        `https://github.com/robot-descriptions/robot_descriptions.py/blob/main/robot_descriptions/${r.source.description}.py`,
        r.source.description,
      ],
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

  renderJoints() {
    const joints = this.viewer.jointList();
    const host = el('d-joints');
    // Nothing to switch on a robot whose only joints slide rather than turn.
    el('joint-unit').hidden = !joints.some((joint) => joint.type !== 'prismatic');
    if (!joints.length) {
      host.innerHTML = `<p class="muted" style="font-size:12.5px">${t('joints.none')}</p>`;
      return;
    }
    host.innerHTML = joints
      .map((joint, index) => {
        const isRot = joint.type !== 'prismatic';
        const [lower, upper] = sliderRange(joint);
        return `<div class="joint" data-index="${index}">
          <div class="joint-head">
            <span class="joint-name" title="${joint.name}">${joint.name}</span>
            <span class="joint-value" data-value>${fmt(joint.value, isRot)}</span>
          </div>
          <input type="range" min="${lower}" max="${upper}" step="${sliderStep(isRot)}" value="${joint.value}"
                 data-joint="${encodeURIComponent(joint.name)}" data-rot="${isRot}">
          ${limitsRow(joint)}
        </div>`;
      })
      .join('');

    host.oninput = (event) => {
      const input = event.target;
      if (input.type !== 'range') return;
      const name = decodeURIComponent(input.dataset.joint);
      const value = parseFloat(input.value);
      this.viewer.setJoint(name, value);
      input.closest('.joint').querySelector('[data-value]').textContent =
        fmt(value, input.dataset.rot === 'true');
    };
  }

  relayout() {
    this.viewer.invalidate();
  }
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
