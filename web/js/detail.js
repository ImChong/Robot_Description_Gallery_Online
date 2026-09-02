/** The detail view: 3D stage, overlay toggles, joint sliders, spec table. */
import { RobotViewer, THEMES } from './viewer.js';
import {
  descriptionKind,
  descriptionOf,
  descriptionPath,
  descriptionUrl,
  formatBytes,
  urdfUrl,
  variantView,
} from './registry.js';
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
 * floating column. It opens on a third of the window: a humanoid's joint names
 * are long, and a column narrow enough to clip every one of them is a list
 * nobody can read while posing. The other two thirds are still more render than
 * the page itself ever gives. A deep chain, or the names a generated URDF tends
 * to carry, can want more still, so on a desktop the inner edge of the column
 * is a handle: drag it and the column grows, as far as half the page.
 *
 * The width is written onto the detail view as a pixel variable the fullscreen
 * rules read: they inset the render by it, so widening the column narrows the
 * render rather than covering it, and the robot stays centred in what is left.
 * The numbers below are the ones css/app.css falls back to when nobody has
 * dragged anything — the floor of its `clamp()`, and its `33.3333vw` middle.
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

/**
 * How far the pointer may travel between press and release and still count as a
 * click on the render rather than an orbit of it. A drag that ends on a link is
 * a camera move: the visitor was aiming the stage, not picking a part of it.
 */
const CLICK_SLOP = 4;

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

/** What the column is worth before anyone drags it: a third of the window, on
 *  any screen. `clampPanelW` is what holds it to the floor on a window too
 *  narrow for a third to be worth reading, and to the ceiling — never reached
 *  by a third, which is the point of picking one. */
const panelDefaultW = () => Math.round(window.innerWidth / 3);

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
 * The joint tour: how long one joint's turn lasts, start to finish — out to its
 * upper limit, across to its lower one, and back to where it stood. A second is
 * long enough to read what the joint does and short enough that a humanoid's
 * sixty of them are a minute rather than an afternoon.
 */
const SWEEP_MS = 1000;

/** Under this the whole turn is a joint standing still — a range the URDF
 *  pins shut — and the tour spends its second on the next joint instead. */
const SWEEP_EPS = 1e-6;

/** Ease in and out across the whole of one joint's turn, so it sets off and
 *  arrives the way a joint driven by a controller would rather than snapping
 *  into motion at full speed. The three legs of the turn share the second in
 *  proportion to how far each one travels, so the speed is one speed. */
const sweepEase = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

/**
 * Where one joint stands part-way through its turn. `legs` is the path — out,
 * across, home — and `spans` how long each of them is; the eased progress is
 * distance along the whole path, so it is walked leg by leg until it runs out.
 */
function sweepValue(step, u) {
  let left = sweepEase(u) * step.total;
  for (let i = 0; i < step.legs.length; i += 1) {
    const [from, to] = step.legs[i];
    const span = step.spans[i];
    if (left <= span || i === step.legs.length - 1) {
      return span ? from + (to - from) * clamp01(left / span) : to;
    }
    left -= span;
  }
  return step.from;
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
    descriptionKind(r) === 'mjcf'
      ? `# A model with no URDF: pinocchio has nothing to read here.
# The mujoco tab is the one that loads ${r.name}.`
      : r.source.description
      ? `# pip install robot_descriptions
from robot_descriptions.loaders.pinocchio import load_robot_description

robot = load_robot_description("${r.source.description}")
print(robot.model.nq, "DOF")`
      : r.source.mirror
        ? `# pip install pin
# ${r.name} has no upstream repository — unzip the gallery's bundle and
# load it from there.
import pinocchio

robot = pinocchio.RobotWrapper.BuildFromURDF(
    "${repoDir(r)}/${r.assets.urdf}",${packageDirs(r).length ? `\n    [${packageDirs(r).map((d) => `"${d}"`).join(', ')}],` : ''}
)
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
    r.source.mjcf && r.source.description
      ? `# pip install robot_descriptions mujoco
import mujoco
from robot_descriptions import ${mjKey(r)}

model = mujoco.MjModel.from_xml_path(${mjKey(r)}.MJCF_PATH)
data = mujoco.MjData(model)`
      : r.source.mjcf
        ? `# pip install mujoco
# ${r.name} has no robot_descriptions entry — load its MJCF from ${
            r.source.mirror ? "the gallery's bundle" : 'the checkout\n# the git tab makes'
          }.
import mujoco

model = mujoco.MjModel.from_xml_path("${repoDir(r)}/${r.source.mjcf}")
data = mujoco.MjData(model)`
        : r.source.mjcf_external
          ? `# pip install mujoco
import mujoco

# Pinned MuJoCo Menagerie scene.
# git clone https://github.com/${r.source.mjcf_external.github}.git
# git checkout ${r.source.mjcf_external.commit}
model = mujoco.MjModel.from_xml_path("mujoco_menagerie/${r.source.mjcf_external.path}")
data = mujoco.MjData(model)`
        : `# ${r.name} has no MJCF${r.source.description ? ' in robot_descriptions' : ' upstream'}.
# Convert the URDF with MuJoCo's compiler:
#   python -m mujoco.urdf2mjcf ${r.assets.urdf.split('/').pop()}`,
  // Nothing to clone for a mirrored entry: the archive it comes from serves
  // files over HTTP and publishes no repository. Fetching the URDF and the
  // meshes it still has is the equivalent, and it is what the gallery does.
  git: (r) =>
    r.source.mirror
      ? `# ${r.name} has no upstream repository — ${r.source.mirror.host} re-hosts it over
# HTTP, with no revision to pin. This is the copy the gallery reads:
curl -O '${descriptionUrl(r)}'
# meshes resolve below ${r.assets.base}
# — or use the gallery's zip button, which collects them for you.`
      : `git clone ${r.source.repo_url}.git
cd ${repoDir(r)}
git checkout ${r.source.commit}
# ${descriptionKind(r).toUpperCase()}: ${descriptionPath(r)}`,
  url: (r) => descriptionUrl(r),
};

function mjKey(robot) {
  return robot.source.description.replace('_description', '_mj_description');
}

/**
 * The directory the model's files end up in locally: what `git clone` names the
 * repository, or — for a mirrored entry, which has no repository to clone — the
 * gallery id, which is what its zip unpacks into.
 */
function repoDir(robot) {
  return robot.source.github ? robot.source.github.split('/')[1] : robot.id;
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
      // MJCF authors conventionally put render and contact geometry in
      // separate geom groups. Showing both at once turns that separation back
      // into the opaque pile the groups were meant to avoid, so those two
      // choices behave as an exclusive view for MJCF. URDF keeps the useful
      // collision-over-visual inspection mode it has always offered.
      if (
        next &&
        (key === 'visual' || key === 'collision') &&
        descriptionKind(this.robot) === 'mjcf'
      ) {
        this.setOverlay(key === 'visual' ? 'collision' : 'visual', false);
      }
      this.setOverlay(key, next);
    });

    el('stage-toolbar').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const { action } = button.dataset;
      if (action === 'reset') {
        this.stopJointSweep();
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
      // A pose the tour is half-way through borrowing is not the pose the
      // reader is asking to be rid of: it hands its joint back first.
      this.stopJointSweep();
      this.viewer.resetJoints();
      this.syncTreeValues();
    });

    el('joints-play').addEventListener('click', () => this.toggleJointSweep());

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

    // Picking a version is a navigation, not a widget changing its own value:
    // it goes through the address so the browser's back button walks the
    // versions and a link can name one.
    el('version-select').addEventListener('change', (event) => {
      if (this.onPickVersion) this.onPickVersion(event.target.value);
    });
    el('version-filter').addEventListener('input', () => this.renderVersionOptions());

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
    this.bindStage();
    this.bindPanelResize();
    this.watchToolbarHeight();
  }

  /** Keep the button and the scene graph on the same overlay state. */
  setOverlay(key, enabled) {
    const button = el('overlay-toggles').querySelector(`[data-overlay="${key}"]`);
    button?.setAttribute('aria-pressed', String(enabled));
    this.viewer.setOverlay(key, enabled);
  }

  /**
   * A visitor can arrive from a URDF with its visual and collision overlays
   * both enabled. MJCF treats those as alternative geom-group views, so enter
   * it on the visual group rather than carrying the mixed URDF view across.
   */
  applyOverlayPolicy(robot) {
    if (
      descriptionKind(robot) === 'mjcf' &&
      this.viewer.overlays.visual &&
      this.viewer.overlays.collision
    ) {
      this.setOverlay('collision', false);
    }
  }

  /**
   * How much room the bar under the render takes, written onto the view for the
   * fullscreen rules to read. They stop the render's floor above the bar rather
   * than behind it, and how tall it is is a rendered fact rather than a number
   * a stylesheet can know: one row on a wide screen, two on a phone, and two
   * again wherever the legend outgrows the width beside the icons — in whatever
   * language the labels are in. So it is measured, and the render clears it on
   * any screen without either side having guessed.
   */
  watchToolbarHeight() {
    const bar = el('stage-toolbar');
    const write = () => {
      const { height } = bar.getBoundingClientRect();
      if (height) el('view-detail').style.setProperty('--fs-bar-h', `${Math.round(height)}px`);
    };
    new ResizeObserver(write).observe(bar);
    write();
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

    // Every slider in the tree, read off the row it sits under. The whole panel
    // is repainted from the pose that results, not just the row dragged: a
    // joint that mimics this one has no slider of its own, and its readout is
    // only right if it follows the drag the way the model does.
    tree.addEventListener('input', (event) => {
      const input = event.target;
      if (input.type !== 'range') return;
      // A hand on a slider is the end of the tour: it stops first, so the joint
      // it had borrowed goes home before this one is moved — and so a drag on
      // the very joint being toured is not fought by the frame after it.
      this.stopJointSweep();
      this.viewer.setJoint(decodeURIComponent(input.dataset.joint), parseFloat(input.value));
      this.syncTreeValues(input);
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

    this.bindSliderTouch(tree);

    el('tree-expand').addEventListener('click', () => this.setTreeExpanded(true));
    el('tree-collapse').addEventListener('click', () => this.setTreeExpanded(false));
  }

  /**
   * A slider a thumb can work. A range input hands a touch one target and one
   * only — the thumb itself — and a touch that lands on the groove beside it
   * moves nothing at all: iOS has always behaved this way, and a tap on the
   * track does not carry on Android either. On a phone that makes posing a
   * joint a matter of hitting a 16px circle, four times over for one leg, in a
   * panel that is scrolling under the finger. The strip is wider and the thumb
   * is bigger on a touch screen (see the coarse-pointer block in app.css), but
   * size alone still leaves the groove dead, so this makes the whole of it
   * live: a tap puts the joint where it was tapped, and a drag carries it from
   * wherever it began.
   *
   * A mouse is left alone — clicking a track already moves the thumb there, and
   * a second opinion would only fight the first.
   *
   * Two things keep this from taking gestures that were not meant for it:
   *
   * - The finger has to go sideways before the drag is claimed. `touch-action:
   *   pan-y` lets a vertical swipe scroll the tree past a slider, and the first
   *   few pixels are read here the same way, so a scroll that begins on a
   *   slider is still a scroll. Once claimed, the pointer is captured: the rest
   *   of the drag belongs to this joint however far off the strip it wanders.
   *
   * - Where the press lands on the thumb, the offset it lands at is kept for
   *   the whole drag, exactly as the browser would keep it. That way the two
   *   never disagree about where the joint should be on a platform where the
   *   browser is dragging the thumb too, and the value written below is the one
   *   it was going to write anyway.
   */
  bindSliderTouch(tree) {
    let held = null;
    // A phone stops a scroll it has thrown by being touched, and that touch
    // lands on whatever the list had arrived at — a slider, more often than
    // not, in a panel that is mostly sliders. So a tap that follows a scroll
    // this closely is read as the brake it was, and only a tap on a list that
    // has come to rest poses a joint. A drag is not held to this: a finger that
    // sets off sideways along a strip has said what it wants.
    let scrolledAt = -Infinity;
    tree.addEventListener('scroll', () => { scrolledAt = performance.now(); }, { passive: true });

    tree.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      const input = event.target.closest(".tree-slider input[type='range']");
      if (!input) return;
      const thumb = sliderThumbWidth(input);
      // Beyond the thumb the offset is dropped rather than carried: a press on
      // the bare groove means the joint comes to the finger, not that it keeps
      // half a strip of distance from it.
      const offset = event.clientX - sliderThumbCentre(input, thumb);
      held = {
        input,
        thumb,
        id: event.pointerId,
        grab: Math.abs(offset) <= thumb / 2 ? offset : 0,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
      };
    });

    tree.addEventListener('pointermove', (event) => {
      if (!held || event.pointerId !== held.id) return;
      if (!held.dragging) {
        const dx = Math.abs(event.clientX - held.x);
        const dy = Math.abs(event.clientY - held.y);
        if (dy > dx && dy > TOUCH_SLOP) { held = null; return; } // a scroll, not a pose
        if (dx <= TOUCH_SLOP) return; // still too early to tell
        held.dragging = true;
        // Capture is what keeps a drag on its own joint once the finger leaves
        // the strip; a pointer the browser has already let go of cannot be
        // captured, and the moves still arrive here either way.
        try { held.input.setPointerCapture(event.pointerId); } catch { /* nothing to capture */ }
      }
      setSliderFromX(held.input, event.clientX - held.grab, held.thumb);
    });

    tree.addEventListener('pointerup', (event) => {
      if (!held || event.pointerId !== held.id) return;
      // A tap that never became a drag is an instruction all the same: put the
      // joint where the finger came down. On the thumb it lands where it
      // already was, and nothing moves.
      const braking = performance.now() - scrolledAt < SCROLL_SETTLE;
      if (!held.dragging && !braking) setSliderFromX(held.input, event.clientX - held.grab, held.thumb);
      held = null;
    });

    // The browser took the gesture for a scroll after all.
    tree.addEventListener('pointercancel', () => { held = null; });
  }

  /**
   * And the stage drives the tree: a click that lands on the model selects the
   * row for the link it hit — the same selection a click on the row makes, so
   * the link stays lit, the joint that carries it is on screen with its slider,
   * and the branch it hangs off is unfolded to show it. A click that lands on
   * the backdrop lets the selection go.
   *
   * An orbit is a click that moved, so the two are told apart by how far the
   * pointer went while it was down rather than by the button alone — how far it
   * went, not where it ended up: an orbit that comes back round to where it
   * started is still an orbit, and releasing it would otherwise pick whatever
   * the camera had been dragged onto.
   *
   * OrbitControls captures the pointer on the canvas for the duration of a
   * drag, which retargets the moves and the release but does not stop them
   * reaching the host — so the whole gesture is read here, whether or not the
   * camera moved in between.
   */
  bindStage() {
    const host = el('canvas-host');
    let from = null;

    host.addEventListener('pointerdown', (event) => {
      // The middle and right buttons belong to the camera; so does a second
      // finger, which is a pinch rather than a tap.
      from =
        event.button === 0 && event.isPrimary
          ? { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false }
          : null;
    });
    host.addEventListener('pointermove', (event) => {
      if (!from || event.pointerId !== from.id || from.moved) return;
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > CLICK_SLOP) from.moved = true;
    });
    host.addEventListener('pointerup', (event) => {
      const start = from;
      from = null;
      if (!start || start.moved || event.pointerId !== start.id || event.button !== 0) return;
      this.pickOnStage(event.clientX, event.clientY);
    });
    host.addEventListener('pointercancel', () => {
      from = null;
    });
  }

  /**
   * A click on the render, resolved against the model. Off the model is how the
   * stage lets a selection go — the backdrop is a big target, and on the page
   * it is the only one, since the tree is not on screen to be clicked.
   *
   * Clicking a link that is already pinned keeps it, where clicking its row
   * again would let it go: from the stage a second click on the same part is
   * aim rather than a second thought, and there is already a gesture for
   * letting go that does not ask the visitor to hit anything.
   */
  pickOnStage(clientX, clientY) {
    const link = this.viewer.linkAt(clientX, clientY);
    const node = link ? this.treeNodeFor(link) : null;
    if (!node) {
      this.clearTreeSelection();
      return;
    }
    if (node.dataset.link !== this.pinnedLink) this.selectTreeNode(node);
    this.revealTreeNode(node);
  }

  /**
   * Nothing selected, nothing lit. The roving tab stop stays where it is: the
   * tree keeps its one way in whether or not a row is pinned.
   */
  clearTreeSelection() {
    if (!this.pinnedLink && !el('d-tree').querySelector('.tree-node[aria-selected="true"]')) return;
    for (const node of el('d-tree').querySelectorAll('.tree-node[aria-selected="true"]')) {
      node.removeAttribute('aria-selected');
    }
    this.pinnedLink = null;
    this.viewer.highlightLink(null);
  }

  /** The row a link name belongs to. Read off the rows rather than queried, so
   *  a name carrying whatever punctuation an upstream URDF likes needs no
   *  escaping to be looked up with. */
  treeNodeFor(link) {
    for (const node of el('d-tree').querySelectorAll('.tree-node')) {
      if (node.dataset.link === link) return node;
    }
    return null;
  }

  /**
   * Bring a row into view: unfold whatever branch it hangs off, then scroll it
   * to the nearest edge of whatever is doing the scrolling — the column when
   * the tree is open in fullscreen, the page when it is a card on it.
   *
   * The row rather than the item it sits in: the item carries its whole subtree,
   * and scrolling a branch taller than the panel into view would put the top of
   * the branch on screen instead of the row that was picked.
   */
  revealTreeNode(node) {
    const above = (row) => row.parentElement?.closest('.tree-node') ?? null;
    for (let up = above(node); up; up = above(up)) {
      if (up.getAttribute('aria-expanded') === 'false') up.setAttribute('aria-expanded', 'true');
    }
    const row = node.querySelector(':scope > .tree-row');
    // The tree is a fullscreen tool: on the page it is in the markup but not
    // rendered, and there is nothing to scroll to until fullscreen opens it.
    if (!row?.offsetParent) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }

  /** The pinned row, brought into view wherever the tree currently is. This is
   *  what fullscreen owes a link picked on the page: it was selected in a tree
   *  that was not being rendered, so nothing could scroll to it at the time. */
  revealTreeSelection() {
    const node = el('d-tree').querySelector('.tree-node[aria-selected="true"]');
    if (node) this.revealTreeNode(node);
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
    const isMjcf = descriptionKind(r) === 'mjcf';
    const bundleSize = formatBytes(r.assets.mesh_bytes + descriptionOf(r).bytes);
    const rows = [
      {
        kind: 'urdf',
        main: t(isMjcf ? 'dl.mjcf' : 'dl.urdf'),
        sub: t(isMjcf ? 'dl.mjcfSub' : 'dl.urdfSub'),
        size: formatBytes(descriptionOf(r).bytes),
      },
      {
        kind: 'bundle',
        main: t('dl.bundle'),
        sub: `${t(isMjcf ? 'dl.bundleMjcfSub' : 'dl.bundleSub')} · ${meshes} ${meshes === 1 ? 'mesh' : 'meshes'}`,
        size: bundleSize,
      },
      // A ROS 2 package is a URDF thing: nothing in the ROS toolchain reads an
      // MJCF, so a package built around one would only look like it worked.
      ...(isMjcf
        ? []
        : [
            {
              kind: 'ros2',
              main: t('dl.ros2'),
              sub: t('dl.ros2Sub'),
              size: bundleSize,
              title: ros2PackageName(r),
            },
          ]),
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

  /**
   * @param {object} entry registry entry — the machine, not one of its files
   * @param {string} [variantId] which of its versions to open on
   */
  async show(entry, variantId) {
    // A machine upstream publishes as several URDFs arrives here as the whole
    // machine; everything below this line works on the one version picked, in
    // the shape a single-file entry already has.
    const robot = variantView(entry, variantId);
    this.model = entry;
    // Loads are asynchronous and a visitor can click through robots faster than
    // the meshes arrive, so every load carries a token and a superseded load
    // stops touching the DOM as soon as it notices it is stale.
    const token = Symbol(robot.id);
    this._token = token;
    const isStale = () => this._token !== token;

    const stage = el('canvas-host').parentElement;
    delete stage.dataset.loaded;
    this.robot = robot;
    this.applyOverlayPolicy(robot);
    // A file the visitor picked off their own disk has no maker, no upstream
    // and nothing to download that they do not already have, so those panels
    // step aside for one that says what was read and where it stayed.
    const custom = robot.local === true;
    const local = custom && robot.source.remote !== true;
    el('d-name').textContent = robot.modelName || robot.name;
    el('d-sub').textContent = local
      ? robot.source.fileName
      : custom
        ? `${robot.source.github} · GitHub`
        : [robot.maker, categoryLabel(robot.category, this.data.categories)]
            .filter(Boolean)
            .join(' · ');
    el('stage-title').textContent = custom
      ? robot.name
      : [robot.name, robot.maker].filter(Boolean).join(' · ');
    document.title = `${robot.name} · Robot Description Gallery Online`;
    el('d-local-badge').hidden = !local;
    el('panel-local').hidden = !local;
    for (const id of ['panel-download', 'panel-resources', 'panel-reuse']) el(id).hidden = local;
    // Two cards fill the row the gallery's three leave, rather than one card
    // and a third of a band of empty surface.
    document.querySelector('.stage-extra').dataset.mode = local ? 'local' : 'registry';
    // Prev/next walk the gallery; the local model is not in it. The compare
    // button stays: a file off a disk is exactly the thing worth reading beside
    // the machines it is meant to be like.
    el('prev-robot').hidden = custom;
    el('next-robot').hidden = custom;
    this.renderLiveLink();

    this.renderVersions();
    this.renderSpecs();
    if (local) {
      this.renderLocalFiles();
    } else {
      this.renderDownloads();
      this.renderResources();
      this.renderSnippet();
    }
    el('joint-unit').hidden = true;
    this.clearTree();

    const loading = el('stage-loading');
    const bar = el('loading-bar');
    const error = el('stage-error');
    error.hidden = true;
    loading.hidden = false;
    bar.style.width = '4%';

    // Inertial data is in the raw XML but not in what urdf-loader hands back, so
    // the file is fetched a second time — from the browser cache, since the
    // loader has just asked for the same URL. Kicked off alongside the meshes so
    // it is ready by the time they are. (The joint limits the loader also drops
    // are read by the viewer itself, at load: the pose it applies below depends
    // on them.)
    //
    // An MJCF needs none of this: js/mjcf.js reads the whole document itself and
    // hands the viewer the inertias along with the geometry.
    const xmlText =
      descriptionKind(robot) === 'mjcf'
        ? Promise.resolve(null)
        : fetch(urdfUrl(robot))
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
      // The registry's height and bounding box come from rendering each model
      // once at build time; a file off the visitor's own disk has never been
      // rendered by anyone, so the numbers are taken here, where the meshes
      // are — at the same pose and by the same reading as the registry's, so
      // the two are comparable in the table that puts them side by side. It is
      // the picked entry itself that is written to (a model with no versions
      // passes through `variantView` unchanged), which is how the compare view
      // gets the measurement without knowing a stage exists.
      //
      // Only when everything the description references actually arrived:
      // half a robot measures half a robot, and a wrong height is worse than
      // an honest blank.
      if (local && !robot.assets.missing.length) robot.measured = this.viewer.measure();
      const xml = await xmlText;
      if (isStale()) return;
      if (xml) this.viewer.setInertialData(xml);
      loading.hidden = true;
      this.renderTree();
      this.renderSpecs(); // fills in the measured height
      // Published for the headless scripts: how much geometry arrived, and how
      // big it measured. A robot with meshes but no measurable size means the
      // scene is broken (NaN transforms, for instance).
      stage.dataset.meshes = String(this.viewer.stats?.visual ?? 0);
      stage.dataset.collision = String(this.viewer.stats?.collision ?? 0);
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
    const description = descriptionOf(r);
    const joints = Object.entries(description.joints || {})
      .map(([type, n]) => `${n}×${type}`)
      .join(', ');
    // Prefer the live measurement; fall back to the value recorded at build time
    // so the panel is populated before the meshes arrive.
    const measured = this.viewer.measured || r.measured;
    // The provenance rows — who made it, under what licence, at which commit —
    // are the registry's answers. A local file has none of them, and blank rows
    // saying so would only pad the card.
    // A mirrored entry has no commit to quote, because the archive it is read
    // from publishes none. Saying which host it came from is the honest row in
    // that slot, and the one a visitor needs to judge the model's provenance.
    const browserLocal = r.local && r.source.remote !== true;
    const upstream = browserLocal
      ? []
      : [
          [t('spec.license'), r.license || '—'],
          r.source.mirror
            ? [t('spec.mirror'), `<span class="sub">${esc(r.source.mirror.host)}</span>`]
            : [t('spec.commit'), `<span class="sub">${r.source.commit.slice(0, 10)}</span>`],
        ];
    const rows = [
      ...(browserLocal ? [] : [[t('spec.maker'), r.maker || '—']]),
      [t('spec.category'), categoryLabel(r.category, this.data.categories)],
      [t('spec.dof'), r.dof || description.moving_joints || '—'],
      [t('spec.links'), description.links],
      [t('spec.joints'), `<span class="sub">${joints || '—'}</span>`],
      [t('spec.mass'), massCell(r)],
      [
        t('spec.height'),
        measured
          ? `${measured.height_m.toFixed(3)} m<br><span class="sub">${t('height.measured')}</span>`
          : '—',
      ],
      [t('spec.formats'), r.formats.map((f) => f.toUpperCase()).join(' / ')],
      [t('spec.assets'), assetsCell(r)],
      ...upstream,
    ];
    const note = lang() === 'zh' ? r.notes_zh || r.notes : r.notes;
    el('d-specs').innerHTML =
      rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') +
      (note ? `<dd class="full sub" style="text-align:left">${note}</dd>` : '');
  }

  /**
   * What the visitor handed over, for a model that came off their own disk: the
   * description, how much of what it references was found, and how many files
   * were read in all. The missing count is the one that earns its place — a
   * robot with holes in it is almost always a folder picked one level too deep,
   * and the number says so before the render has to be puzzled over.
   */
  renderLocalFiles() {
    const r = this.robot;
    const missing = r.assets.missing?.length || 0;
    const rows = [
      [t('local.urdfFile'), `<span class="sub">${esc(r.source.file)}</span>`],
      // A description built out of primitives references no meshes, and a row
      // reading "0 / 0" is a row about nothing.
      ...(r.assets.referenced
        ? [
            [
              t('local.meshes'),
              `${r.assets.mesh_files} / ${r.assets.referenced}` +
                (missing
                  ? `<br><span class="sub warn">${t(missing === 1 ? 'local.missing1' : 'local.missing').replace('{n}', missing)}</span>`
                  : ''),
            ],
          ]
        : []),
      [
        t('local.picked'),
        `${r.source.picked}<br><span class="sub">${formatBytes(r.source.picked_bytes)}</span>`,
      ],
    ];
    el('d-local').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  /**
   * The way out to MuJoCo Live, where the model has a pinned Menagerie scene.
   *
   * MJCF-only cards used to *be* this link: clicking one left the gallery for
   * MuJoCo's viewer, which meant the whole detail page — joint sliders,
   * collision hulls, inertia boxes, the spec table, the downloads — existed for
   * URDF models and nowhere else. The description is rendered here now, and the
   * link is what it should have been: one more thing on the page, next to the
   * compare button, for the reader who wants the physics and the room too.
   */
  renderLiveLink() {
    const live = this.robot.source?.mjcf_external?.live_url;
    const link = el('mujoco-live');
    link.hidden = !live;
    if (live) link.href = live;
  }

  renderResources() {
    const r = this.robot;
    const items = [
      // A mirrored entry has no repository and no tree; the archive's own page
      // is what stands in for both.
      r.source.mirror
        ? ['res.mirror', r.source.mirror.site, r.source.mirror.host]
        : ['res.repo', r.source.repo_url, r.source.github],
      r.source.tree_url ? ['res.tree', r.source.tree_url, 'tree'] : null,
      r.assets.urdf ? ['res.urdf', urdfUrl(r), r.assets.urdf.split('/').pop()] : null,
      r.source.mjcf ? ['res.mjcf', r.assets.base + r.source.mjcf, r.source.mjcf.split('/').pop()] : null,
      // The file the stage actually renders, where a scene is not it: MuJoCo
      // Live opens the room, and this is the robot inside it.
      r.assets.mjcf_model && r.assets.mjcf_model !== r.source.mjcf
        ? ['res.mjcfModel', r.assets.base + r.assets.mjcf_model, r.assets.mjcf_model.split('/').pop()]
        : null,
      r.source.mjcf_external
        ? ['res.mjcfMenagerie', r.source.mjcf_external.url, r.source.mjcf_external.path.split('/').pop()]
        : null,
      r.source.mjcf_external
        ? ['res.mjcfLive', r.source.mjcf_external.live_url, 'live.mujoco.org']
        : null,
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

  // ---------------------------------------------------------------- versions

  /**
   * The version row: which of a machine's upstream URDFs the page is about.
   *
   * Hidden for the great majority of the registry, where the machine and the
   * file are the same thing, and for a model read off the visitor's own disk.
   */
  renderVersions() {
    const bar = el('version-bar');
    const variants = this.robot.local ? [] : this.model?.variants || [];
    bar.hidden = variants.length < 2;
    if (bar.hidden) return;
    // A filter left over from the last robot would hide most of this one.
    el('version-filter').value = '';
    this.renderVersionOptions();
  }

  /**
   * The options themselves, narrowed to what the filter box matches. Upstream
   * keeps superseded files around for the machines still running them, so the
   * two groups are worth telling apart before one is picked rather than after.
   *
   * The version on the stage is always an option, filtered out or not: a select
   * has to be able to show its own value.
   */
  renderVersionOptions() {
    const variants = this.model?.variants || [];
    if (variants.length < 2) return;
    const current = this.robot.variant?.id;
    const needle = el('version-filter').value.trim().toLowerCase();
    const hits = needle ? variants.filter((v) => v.name.toLowerCase().includes(needle)) : variants;
    // The version on the stage stays an option whether it matched or not: a
    // select has to be able to show its own value.
    const matches = hits.some((v) => v.id === current)
      ? hits
      : [...variants.filter((v) => v.id === current), ...hits];
    const group = (label, list) =>
      list.length
        ? `<optgroup label="${label}">${list
            .map(
              (v) =>
                `<option value="${v.id}"${v.id === current ? ' selected' : ''}>` +
                `${v.name} · ${v.dof} ${t('unit.dof')}</option>`,
            )
            .join('')}</optgroup>`
        : '';
    el('version-select').innerHTML =
      group(t('version.current'), matches.filter((v) => !v.deprecated)) +
      group(t('version.deprecated'), matches.filter((v) => v.deprecated));

    // Nothing matched: say so, rather than leave a list that looks as though it
    // lost its contents when all it holds is the version already on the stage.
    const empty = hits.length === 0;
    el('version-bar').dataset.empty = String(empty);
    // On a phone the box collapses to its icon when it is not in use, and a
    // filter still narrowing the list from behind an icon would be a list that
    // had lost options for no reason on screen.
    el('version-bar').dataset.filtering = String(needle !== '');
    const old = variants.filter((v) => v.deprecated).length;
    el('version-count').textContent = empty
      ? t('version.none')
      : t('version.count')
          .replace('{n}', variants.length)
          .replace('{shown}', variants.length - old)
          .replace('{old}', old);
  }

  /** Which of the two units is in force, on the segmented control. */
  renderUnitToggle() {
    for (const button of el('joint-unit').querySelectorAll('button[data-unit]')) {
      button.setAttribute('aria-pressed', String(button.dataset.unit === angleUnit));
    }
  }

  // ------------------------------------------------------------- joint tree

  clearTree() {
    // Before the rows go: the tour hands its joint back through them, and a
    // tour left running against a tree that no longer exists would drive a
    // robot nobody can see.
    this.stopJointSweep();
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
    // The tour drives sliders, not joints: a description whose movable joints
    // all mimic another one has a panel of readouts and nothing to tour. Taken
    // back below, once the sliders that were actually built are counted.
    el('joints-play').hidden = true;

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
    el('joints-play').hidden = !this.treeSliders.size;
    this.syncTreeValues();
  }

  /** Repaint the tree from the pose the viewer is actually in — the readout on
   *  every row, and the slider under the ones that move. A reset moves the
   *  robot and nothing else; this is what puts the panel back in step.
   *
   *  `dragging`, when a slider is being held, is left alone: the thumb is where
   *  the hand put it, and writing a clamped value back under the pointer would
   *  fight the drag. */
  syncTreeValues(dragging = null) {
    if (!this.treeValues?.size && !this.treeSliders?.size) return;
    for (const joint of this.viewer.jointList()) {
      const cell = this.treeValues.get(joint.name);
      if (cell) cell.textContent = fmt(joint.value, joint.type !== 'prismatic');
      const input = this.treeSliders.get(joint.name);
      if (input && input !== dragging) input.value = String(joint.value);
    }
  }

  // ------------------------------------------------------------- joint tour

  /**
   * The tour: every joint the panel has a slider for, in the order the panel
   * lists them, each one driven out to its upper limit, across to its lower one
   * and back to where it stood — about a second apiece.
   *
   * It is what a still render cannot say: which joint on a chain of sixty is
   * the shoulder roll and which the wrist, and how far each of them is allowed
   * to go. Watching a description move through its own limits is the fastest
   * reading of it there is, and it asks nothing of the reader but one press.
   *
   * The pose is borrowed, not spent: every joint is handed back the value it
   * held when its turn began, so the robot the tour finishes on is the robot it
   * started from — and so is the one it is stopped on part-way.
   */
  toggleJointSweep() {
    if (this._sweep) this.stopJointSweep();
    else this.startJointSweep();
  }

  startJointSweep() {
    if (this._sweep) return;
    // The panel's own order, which is the tree's: reading down a branch is
    // reading down the chain, so the tour walks the robot rather than whatever
    // order the URDF happened to declare its joints in.
    const names = [...(this.treeSliders?.keys() ?? [])];
    if (!names.length) return;
    // A folded branch is not skipped — every slider in the panel gets its turn,
    // and `markSweepRow` unfolds the one whose turn it is. Unfolding the whole
    // tree up front would throw away a reader's own folding to show them rows
    // the tour may not reach for another minute.
    this._sweep = { names, index: -1, frame: 0, step: null };
    this.renderSweepButton();
    this.runSweep();
  }

  /**
   * Stop, wherever the tour has got to. The joint in flight is put back first:
   * it was borrowed for the length of its turn, and a tour stopped half-way
   * through one would otherwise leave the robot in a pose nobody chose.
   */
  stopJointSweep() {
    const sweep = this._sweep;
    if (!sweep) return;
    this._sweep = null;
    if (sweep.frame) cancelAnimationFrame(sweep.frame);
    if (sweep.step) this.restoreSweepStep(sweep.step);
    this.markSweepRow(null);
    this.syncTreeValues();
    this.renderSweepButton();
  }

  /**
   * One joint's turn, then the next. Each turn schedules its own frames and
   * hands over at the end of them, so the tour is a chain of animations rather
   * than one timer that has to know where every joint is.
   */
  runSweep() {
    const sweep = this._sweep;
    const step = this.nextSweepStep();
    if (!step) {
      this.stopJointSweep();
      return;
    }
    sweep.step = step;
    this.markSweepRow(step.name);
    const start = performance.now();
    const tick = (now) => {
      // A tour that was stopped, or replaced by a newer one, no longer owns
      // this frame: the pose has already been handed back by whoever stopped it.
      if (this._sweep !== sweep) return;
      const u = Math.min(1, (now - start) / SWEEP_MS);
      this.viewer.setJoint(step.name, sweepValue(step, u));
      // The whole panel, not just this row: a joint that mimics this one moves
      // with it in the model, and its readout is only honest if it says so.
      this.syncTreeValues();
      if (u < 1) {
        sweep.frame = requestAnimationFrame(tick);
      } else {
        // The joint is home by now — `sweepValue` ends where it began — but the
        // loop it belongs to, if any, is not, and that is what this puts back.
        this.restoreSweepStep(step);
        this.syncTreeValues();
        sweep.frame = 0;
        this.runSweep();
      }
    };
    sweep.frame = requestAnimationFrame(tick);
  }

  /**
   * The next joint worth a turn, and the path its turn takes: out to the upper
   * limit, across to the lower one, home again. The bounds are the slider's own
   * rather than the URDF's, so the tour goes exactly as far as a hand dragging
   * that slider could — a continuous joint gets its full turn, and one whose
   * description declares no limit at all gets the working range the panel
   * invents for it instead of freezing at zero.
   *
   * A joint with nowhere to go is passed over rather than given a second of
   * stillness: a range pinned shut says all it has to say in the panel.
   */
  nextSweepStep() {
    const sweep = this._sweep;
    const joints = new Map(this.viewer.jointList().map((joint) => [joint.name, joint]));
    while ((sweep.index += 1) < sweep.names.length) {
      const name = sweep.names[sweep.index];
      const input = this.treeSliders.get(name);
      const joint = joints.get(name);
      if (!input || !joint) continue;
      const lower = Number(input.min);
      const upper = Number(input.max);
      if (!Number.isFinite(lower) || !Number.isFinite(upper)) continue;
      // Where it stands now, held inside its own travel: the loader can park a
      // joint outside the limits its description declares, and the tour has no
      // business ending it up somewhere its slider cannot reach.
      const from = Math.min(Math.max(joint.value, lower), upper);
      if (!Number.isFinite(from)) continue;
      const legs = [
        [from, upper],
        [upper, lower],
        [lower, from],
      ];
      const spans = legs.map(([a, b]) => Math.abs(b - a));
      const total = spans.reduce((sum, span) => sum + span, 0);
      if (total < SWEEP_EPS) continue;
      // Where the joints a closed loop solves for stand as this turn begins.
      // They are moved by this one without being driven by it, and a turn that
      // carries a five-bar leg through the configuration where it is exactly
      // straight comes back down the other branch of the mechanism — so the
      // tour hands them back too, or a robot it has finished with is not the
      // robot it started on.
      return { name, input, from, legs, spans, total, loop: this.loopPose() };
    }
    return null;
  }

  /**
   * Where every joint a closed loop solves for stands right now — the half of
   * the pose no slider writes. Null when the robot has no closed loop, which
   * is every robot in the gallery but one.
   */
  loopPose() {
    const pose = {};
    for (const joint of this.viewer.jointList()) {
      if (joint.loop) pose[joint.name] = joint.value;
    }
    return Object.keys(pose).length ? pose : null;
  }

  /** Put one turn's joint — and the loop it moved on the way — back where the
   *  turn found them. */
  restoreSweepStep(step) {
    this.viewer.setJoint(step.name, step.from);
    if (step.loop) this.viewer.applyPose(step.loop);
  }

  /**
   * Which joint the tour is on, said in both places at once: the row is marked
   * and scrolled into view in the panel, and the link that joint carries is lit
   * on the render. Sixty sliders scroll past in a minute, and without this the
   * one that is moving is whichever one the reader happens to be looking at.
   *
   * A pinned row keeps its pin — the tour lights links, it does not select
   * them — so letting go puts the stage back on whatever the reader had pinned.
   */
  markSweepRow(name) {
    const host = el('d-tree');
    for (const row of host.querySelectorAll('.tree-node.is-sweeping')) {
      row.classList.remove('is-sweeping');
    }
    const node = name ? this.treeSliders.get(name)?.closest('.tree-node') : null;
    if (!node) {
      this.viewer.highlightLink(this.pinnedLink || null);
      return;
    }
    node.classList.add('is-sweeping');
    this.revealTreeNode(node);
    this.viewer.highlightLink(node.dataset.link);
  }

  /** The button says what the next press will do, and stays lit while the tour
   *  runs — the same way the fullscreen button carries its own mode. */
  renderSweepButton() {
    const button = el('joints-play');
    const running = !!this._sweep;
    const key = running ? 'joints.stop' : 'joints.play';
    const hint = running ? 'joints.stopHint' : 'joints.playHint';
    button.setAttribute('aria-pressed', String(running));
    const label = button.querySelector('span:not(.play-mark)');
    label.dataset.i18n = key;
    label.textContent = t(key);
    // The label is one word; what the press will actually do is on the button's
    // title and, for a reader who never sees a tooltip, its name.
    button.dataset.i18nTitle = hint;
    button.dataset.i18nAriaLabel = hint;
    button.title = t(hint);
    button.setAttribute('aria-label', t(hint));
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
    // The tree is on screen now, so a row picked off the render while it was
    // not can finally be scrolled to. On the way out it stops being rendered,
    // and a link left lit on the page would be a selection with nothing on
    // screen to say what it is or how to let it go — so the stage goes back to
    // nothing lit, and the page starts clean.
    if (on) {
      this.revealTreeSelection();
    } else {
      // The panel is not rendered on the page, so a tour would go on posing the
      // robot with nothing on screen to say which joint was moving or how to
      // stop it.
      this.stopJointSweep();
      this.clearTreeSelection();
    }
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
      (joint.loop
        ? `<span class="jt loop" title="${t('limit.loopFull')}">${t('limit.loop')}</span>`
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
    (moving ? jointBlock(moving) : '') +
    children +
    '</li>'
  );
}

/**
 * What a joint that moves carries under its row. Folding the row folds the
 * branch below it, never this — the block belongs to the joint on the row, not
 * to its children.
 *
 * A joint whose value is not its own to set gets no slider — one that mimics
 * another, and one a closed loop solves for. The rest get the slider that moves
 * them.
 */
function jointBlock(joint) {
  if (joint.mimic?.joint) return followBlock(joint);
  if (joint.loop) return loopBlock(joint);
  return sliderBlock(joint);
}

/**
 * The slider that moves one joint, the angle it is at, and what the URDF
 * declares about it.
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
 * What a joint that follows another carries instead: where it stands, and the
 * joint it takes that from. A mimic joint has no travel of its own — its value
 * is rewritten as multiplier × source + offset every time the joint it follows
 * moves — so a slider here would be a control that undoes itself, and hands a
 * reader a pose the description cannot hold. The number stays, in the column
 * the sliders keep theirs in, and moves when the source does.
 */
function followBlock(joint) {
  return (
    '<div class="tree-slider is-follow">' +
    `<div class="slider-line" title="${t('limit.mimicDriven')}">` +
    `<span class="tree-follow"><i aria-hidden="true">↳</i>${esc(mimicText(joint.mimic))}</span>` +
    `<span class="tree-value" data-tree-value="${esc(joint.name)}">—</span>` +
    '</div>' +
    // The relation is on the line above, so it is not repeated in the chips.
    limitsRow(joint, false) +
    '</div>'
  );
}

/**
 * What a joint inside a closed loop carries instead: where it stands, and the
 * fact that the loop, not the reader, is what puts it there. Two branches of a
 * five-bar leg meet at a point the URDF has no way to write down, and the
 * viewer holds them together by solving these joints every time the ones above
 * them move — so a slider here would be a control the next redraw undoes.
 */
function loopBlock(joint) {
  return (
    // `is-follow` for the look — a readout where a slider would be, which is
    // the same thing this is — and `is-loop` for what it actually is.
    '<div class="tree-slider is-follow is-loop">' +
    `<div class="slider-line" title="${t('limit.loopDriven')}">` +
    `<span class="tree-follow"><i aria-hidden="true">↺</i>${t('limit.loopSolved')}</span>` +
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
/**
 * The mesh count, and — for a mirrored entry — how many meshes the URDF asks
 * for that the host does not have. Those are skipped rather than requested, so
 * the number is the difference between what the description describes and what
 * this page can show, which is worth a line of its own.
 */
function assetsCell(robot) {
  const { mesh_files: files, mesh_formats: formats, mesh_bytes: bytes } = robot.assets;
  const skipped = robot.assets.skip_meshes?.length || 0;
  return (
    `${files} × ${formats.join('/') || '—'}` +
    `<br><span class="sub">${formatBytes(bytes)}</span>` +
    (skipped
      ? `<br><span class="sub warn">${t(skipped === 1 ? 'assets.skipped1' : 'assets.skipped').replace('{n}', skipped)}</span>`
      : '')
  );
}

function massCell(robot) {
  const mass = descriptionOf(robot)?.mass_kg;
  if (!mass) return '—';
  const suspect = mass > 2000;
  return (
    `${mass.toFixed(2)} kg${suspect ? ` <abbr title="${t('mass.suspect')}">?</abbr>` : ''}` +
    `<br><span class="sub">${t(descriptionKind(robot) === 'mjcf' ? 'mass.fromMjcf' : 'mass.fromUrdf')}</span>`
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

/** How far a finger may wander before it has said which gesture it is: a few
 *  pixels of travel are a press held still, not a drag and not a scroll. */
const TOUCH_SLOP = 4;

/** How long after the tree last moved under a finger a tap still counts as the
 *  brake on that movement rather than as an instruction to a slider. */
const SCROLL_SETTLE = 200;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** How much of the strip the thumb takes. The stylesheet is the one that knows
 *  — it grows the thumb on a touch screen — so it is asked, and the 16px it
 *  declares for a pointer stands in wherever the variable does not resolve. */
function sliderThumbWidth(input) {
  const declared = parseFloat(getComputedStyle(input).getPropertyValue('--tree-thumb'));
  return Number.isFinite(declared) && declared > 0 ? declared : 16;
}

/** Where the thumb is sitting right now. A range input's thumb travels between
 *  the two ends of the strip inset by half its own width — it never hangs off
 *  either end — so that is the span its value maps onto, here and below. */
function sliderThumbCentre(input, thumb) {
  const rect = input.getBoundingClientRect();
  const min = Number(input.min);
  const max = Number(input.max);
  const ratio = max > min ? (Number(input.value) - min) / (max - min) : 0;
  return rect.left + thumb / 2 + clamp01(ratio) * (rect.width - thumb);
}

/**
 * Move a joint to the point on its strip a finger is holding. The value is
 * written raw: an `<input type="range">` snaps whatever it is given to its own
 * step and clamps it to its own limits, so the arithmetic here only has to find
 * the fraction of the travel — and reading the value back afterwards is what
 * says whether anything actually moved.
 *
 * Nothing is dispatched when it did not. The event is what drives the model, so
 * a platform whose browser is dragging the thumb natively as well would
 * otherwise pose the robot twice for every move of the finger.
 */
function setSliderFromX(input, x, thumb) {
  const rect = input.getBoundingClientRect();
  const span = rect.width - thumb;
  if (span <= 0) return;
  const min = Number(input.min);
  const max = Number(input.max);
  const before = input.value;
  input.value = String(min + clamp01((x - rect.left - thumb / 2) / span) * (max - min));
  if (input.value === before) return;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * The limits the URDF declares for one joint: travel, and the effort and
 * velocity ceilings a controller is supposed to respect. Shown as-is —
 * `effort="0"` means the upstream file left it at zero, not that the joint is
 * unlimited. A mimic joint adds what it follows, unless the block above these
 * chips is already saying it.
 */
function limitsRow(joint, withMimic = true) {
  const isRot = joint.type !== 'prismatic';
  const chips = [
    chip(t('limit.range'), rangeText(joint), rangeTitle(joint)),
    chip(t('limit.velocity'), velocityText(joint), velocityTitle(joint)),
    chip(
      t('limit.effort'),
      joint.effort === null ? '—' : `${num(joint.effort)} ${isRot ? 'N·m' : 'N'}`,
      t('limit.effortFull'),
    ),
  ];
  if (withMimic && joint.mimic?.joint) {
    chips.push(chip(t('limit.mimic'), esc(mimicText(joint.mimic)), t('limit.mimicFull')));
  }
  return `<div class="joint-limits">${chips.join('')}</div>`;
}

/** The mimic relation as the URDF declares it: `source ×multiplier +offset`,
 *  with the offset left off when there is none to state. */
function mimicText({ joint: source, multiplier, offset }) {
  const shift = offset ? ` ${offset > 0 ? '+' : '−'}${num(Math.abs(offset))}` : '';
  return `${source} ×${num(multiplier)}${shift}`;
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

/**
 * Top speed, in the same unit as the travel chip above it and the readout on
 * the slider: the URDF declares an angular limit in rad/s, and degree mode
 * renders it as °/s. A prismatic joint's ceiling is a linear speed, which
 * neither angle unit applies to.
 */
function velocityText(joint) {
  if (joint.velocity === null) return '—';
  if (joint.type === 'prismatic') return `${num(joint.velocity)} m/s`;
  return angleUnit === 'rad'
    ? `${num(joint.velocity)} rad/s`
    : `${num(joint.velocity * DEG, 1)}°/s`;
}

/** Hover text for the top-speed chip: the same speed in the unit not on show. */
function velocityTitle(joint) {
  const full = t('limit.velocityFull');
  if (joint.velocity === null || joint.type === 'prismatic') return full;
  return angleUnit === 'rad'
    ? `${full}: ${num(joint.velocity * DEG, 1)}°/s`
    : `${full}: ${num(joint.velocity)} rad/s`;
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
