/** The detail view: 3D stage, overlay toggles, joint sliders, spec table. */
import { RobotViewer, THEME } from './viewer.js';
import { formatBytes, urdfUrl } from './registry.js';
import { categoryLabel, lang, t } from './i18n.js';

const el = (id) => document.getElementById(id);

const OVERLAYS = [
  { key: 'visual', color: null },
  { key: 'collision', color: THEME.collision },
  { key: 'axes', color: THEME.axis },
  { key: 'frames', color: null },
  { key: 'com', color: THEME.com },
  { key: 'inertia', color: THEME.inertia },
];

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
    this.viewer = new RobotViewer(el('canvas-host'));

    el('overlay-toggles').innerHTML = OVERLAYS.map(
      (o) => `<button data-overlay="${o.key}" aria-pressed="${o.key === 'visual'}">
        ${o.color ? `<span class="swatch" style="color:#${o.color.toString(16).padStart(6, '0')}"></span>` : ''}
        <span data-i18n="overlay.${o.key}">${t(`overlay.${o.key}`)}</span></button>`,
    ).join('');

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
    this.renderResources();
    this.renderSnippet();
    el('d-joints').innerHTML = '';

    const loading = el('stage-loading');
    const bar = el('loading-bar');
    const error = el('stage-error');
    error.hidden = true;
    loading.hidden = false;
    bar.style.width = '4%';

    try {
      await this.viewer.load(robot, (done, total) => {
        if (isStale()) return;
        bar.style.width = `${total ? Math.max(4, Math.round((done / total) * 100)) : 8}%`;
      });
      if (isStale()) return;
      // Same starting pose as the gallery card, so clicking a card does not
      // change what the robot looks like.
      this.viewer.applyPose(robot.pose);
      // Inertial data comes from the raw XML (urdf-loader drops it).
      fetch(urdfUrl(robot))
        .then((r) => r.text())
        .then((xml) => !isStale() && this.viewer.setInertialData(xml))
        .catch(() => {});
      loading.hidden = true;
      this.renderJoints();
      this.renderSpecs(); // fills in the measured height
      // Published for the headless scripts: how much geometry actually arrived.
      stage.dataset.meshes = String(this.viewer.stats?.visual ?? 0);
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
    const measured = this.viewer.measured;
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
          `<li><a href="${url}" target="_blank" rel="noopener">${t(key)}<span class="kind">${kind}</span></a></li>`,
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

  renderJoints() {
    const joints = this.viewer.jointList();
    const host = el('d-joints');
    if (!joints.length) {
      host.innerHTML = `<p class="muted" style="font-size:12.5px">${t('joints.none')}</p>`;
      return;
    }
    host.innerHTML = joints
      .map((joint, index) => {
        const isRot = joint.type !== 'prismatic';
        const lower = joint.ignoreLimits ? -Math.PI : joint.lower;
        const upper = joint.ignoreLimits ? Math.PI : joint.upper;
        return `<div class="joint" data-index="${index}">
          <div class="joint-head">
            <span class="joint-name" title="${joint.name}">${joint.name}</span>
            <span class="joint-value" data-value>${fmt(joint.value, isRot)}</span>
          </div>
          <input type="range" min="${lower}" max="${upper}" step="0.001" value="${joint.value}"
                 data-joint="${encodeURIComponent(joint.name)}" data-rot="${isRot}">
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

function fmt(value, isRotational) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return isRotational
    ? `${((value * 180) / Math.PI).toFixed(1)}°`
    : `${value.toFixed(3)} m`;
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'link';
  }
}
