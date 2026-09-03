/**
 * The compare view's shared stage: every picked machine on one floor.
 *
 * The tables beside it answer "how do these compare" in numbers, and numbers
 * are what a comparison is mostly made of — but a row reading 1.32 m against
 * 1.80 m is not the same as seeing the two stand next to each other, and no
 * amount of columns says what a five-fingered hand looks like beside a
 * two-finger gripper. So the same descriptions the tables are read from are
 * also loaded as geometry, into one scene, standing on one floor: the reader
 * orbits the group rather than flicking between six detail pages.
 *
 * Four things follow from putting six robots where the rest of the site puts
 * one:
 *
 *   - It is asked for rather than assumed. The compare page's whole premise is
 *     that a URDF is a few tens of kilobytes and the meshes are the twenty
 *     megabytes, so six machines cost less than opening one of them — and that
 *     is only true for as long as nobody fetches the meshes. This stage is what
 *     fetches them, so it stays behind a button, and the button says so.
 *   - They stand side by side at true scale, feet on the same floor, in the
 *     order the table's columns are in. Scale is the one comparison a picture
 *     makes better than a number, and it is lost the moment each robot is
 *     framed on its own.
 *   - A pose belongs to one machine. Clicking a robot — or its name tag —
 *     brings up that machine's joints in a window floating over the render, and
 *     the sliders in it drive that machine and nothing else. Six sets of
 *     sliders down a page would be unreadable; one, aimed by a click, is the
 *     same gesture the detail page's tree already answers to.
 *   - And where each of them stands is the reader's to set. A row is the right
 *     default and the wrong arrangement for half the questions worth asking —
 *     two hands facing each other, an arm reaching over a quadruped, a machine
 *     turned to be read side-on. So a machine can be slid across the floor and
 *     turned about the vertical, in the plane the floor is: the height is the
 *     comparison and is never the reader's to fake, so it stays measured. The
 *     moves land on the floor grid's own lines when snapping is on, which is
 *     what makes two machines actually a metre apart rather than nearly.
 *
 * The stage itself is a RobotViewer, which holds a cast of descriptions rather
 * than one and can be asked which of them a click landed on.
 */
import * as THREE from 'three';
import { boundingBox, RobotViewer } from './viewer.js';
import { angleUnit, formatAngle, setAngleUnit } from './angle-unit.js';
import { t } from './i18n.js';
import { onThemeChange, theme } from './theme.js';

const el = (id) => document.getElementById(id);

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

/**
 * How far a pointer may travel between press and release and still count as a
 * click on the render rather than an orbit of it, as on the detail stage.
 */
const CLICK_SLOP = 4;

/** The gap between two machines, as a share of what they average in width. */
const SPACING = 0.22;

/**
 * Where the camera stands over a row of machines, rather than over one.
 *
 * The detail page's default is a three-quarter view, which is the flattering
 * angle for a single robot and the wrong one for six: down a row, it stacks
 * the far end behind the near one and the comparison the row exists to make —
 * this one is a head taller than that one — is the first thing it costs. So
 * the stage sits nearly square on, with just enough turn and rise left to keep
 * the floor reading as a floor.
 */
const ROW_VIEW = { azimuth: Math.PI * 0.07, elevation: 0.17, padding: 1.1 };

/**
 * How far from the middle a machine may be placed, beyond what the row itself
 * takes: a floor, not a fence.
 *
 * A drag is read against a level plane, and a stage looked at nearly side-on —
 * which is how a row is looked at — maps the last few pixels before the
 * horizon onto an enormous stretch of that plane. A slip there would otherwise
 * put a machine a kilometre away and out of every subsequent fit. This keeps
 * the worst case somewhere a reader can still see it and drag it back.
 */
const PLACE_MARGIN = 6;

/**
 * How far a turn snaps to: twelve positions around the circle.
 *
 * Fine enough to face a machine at a shelf or a partner, coarse enough that
 * the quarter turns — the ones anybody actually reaches for — are exact.
 */
const YAW_SNAP = Math.PI / 12;

/**
 * The plane a drag is read against: level with the floor, at whatever height
 * the drag is happening at.
 *
 * Not the floor itself, though it is parallel to it and gives the same answer.
 * A ray only meets a level plane if it points below the horizon, and the
 * horizon of every level plane is the same line — so on a stage looked at
 * nearly side-on, which is how a row is looked at, a press anywhere on a
 * humanoid's upper half meets no floor at all. Reading the drag at the height
 * it was grabbed at fixes that by construction: the ray that took hold of the
 * machine met the geometry there, so it certainly meets a plane through the
 * same point, and the machine follows the pointer exactly.
 */
const DRAG_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/**
 * The axis a machine turns about, in the frame it is placed in.
 *
 * That frame is the world group's, which is Z-up because a URDF is: the axis a
 * reader means by "turn it round" is the same +Z the description's own world
 * is measured against, not the scene's +Y.
 */
const UP = new THREE.Vector3(0, 0, 1);

/** Native fullscreen, through both spellings; see js/detail.js for why the
 *  mode is a class rather than `:fullscreen` — a refused request still gets
 *  the big stage, minus the browser's own chrome. */
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

/** A joint's position, in whichever unit the window is switched to. */
function readout(joint) {
  if (!Number.isFinite(joint.value)) return '—';
  return joint.type === 'prismatic' ? `${joint.value.toFixed(3)} m` : formatAngle(joint.value);
}

/** What a slider may travel over: the declared limits, or a sensible full turn
 *  where the description declares none. Same reading as the detail page's. */
function sliderRange(joint) {
  if (joint.hasLimits) return [joint.lower, joint.upper];
  return joint.type === 'prismatic' ? [-0.5, 0.5] : [-Math.PI, Math.PI];
}

function sliderStep(joint) {
  if (joint.type === 'prismatic') return 0.001;
  return angleUnit() === 'rad' ? 0.001 : Math.PI / 1800;
}

/** Round to the nearest multiple of `step`, or leave alone when not snapping. */
function snapped(value, step) {
  return step > 0 ? Math.round(value / step) * step : value;
}

/** Degrees, wrapped to (-180, 180] — how a heading reads. */
function yawDegrees(yaw) {
  const wrapped = (((yaw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.round(wrapped * (180 / Math.PI) * 10) / 10;
}

export class CompareStage {
  constructor() {
    /** Whether the reader has asked for the meshes. Nothing loads before. */
    this.open = false;
    /** column key -> {entry, robot, error}: what is actually on the floor. */
    this.members = new Map();
    /** The picked columns, in the order the tables read them across. */
    this.wanted = [];
    /** The robot the joint window is about. */
    this.selected = null;
    /** Whether a drag on a machine slides it rather than orbiting the stage. */
    this.arranging = false;
    /** Whether a move or a turn lands on the floor grid's own lines. */
    this.snapping = true;
    this.viewer = null;
    this.bound = false;
    /** Loads in flight, so the last one to land takes the veil down. */
    this.loading = 0;
    /** column key -> {node, w, h}: the name tags, and what each measures. */
    this.tags = new Map();
    /** joint name -> the slider that moves it, and the cell that reads it. */
    this._sliders = new Map();
    this._values = new Map();
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  setup() {
    if (this.bound) return;
    this.bound = true;

    el('cmp-stage-open').addEventListener('click', () => this.start());

    el('cmp-stage-toolbar').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button || !this.viewer) return;
      const { action } = button.dataset;
      if (action === 'reset') {
        this.viewer.resetJoints();
        this.layout();
        this.syncJointValues();
      } else if (action === 'rotate') {
        this.viewer.autoRotate = !this.viewer.autoRotate;
        button.setAttribute('aria-pressed', String(!!this.viewer.autoRotate));
      } else if (action === 'frame') {
        this.frame();
      } else if (action === 'fullscreen') {
        this.toggleFullscreen();
      } else if (action === 'arrange') {
        this.setArranging(!this.arranging);
      } else if (action === 'snap') {
        this.snapping = !this.snapping;
        button.setAttribute('aria-pressed', String(this.snapping));
        this.renderJointPanel();
      } else if (action === 'relayout') {
        this.relayout();
      } else if (action === 'close') {
        this.stop();
      }
    });

    // A tag is the other way to aim the joint window: on a stage of six, the
    // hand at the end of the row is a small target and its name is not.
    el('cmp-stage-tags').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-key]');
      if (button) this.select(this.members.get(button.dataset.key)?.robot || null);
    });

    el('cmp-joint-panel').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-panel]');
      if (!button) return;
      const what = button.dataset.panel;
      if (what === 'close') this.select(null);
      else if (what === 'reset') {
        this.viewer?.resetJoints(this.selected);
        this.syncJointValues();
      } else if (what === 'unit') {
        setAngleUnit(button.dataset.unit);
        this.renderJointPanel();
      } else if (what === 'unpin') {
        // Back into the row with the others, which is where it was before
        // anybody moved it.
        const member = this.memberOf(this.selected);
        if (member) member.pinned = false;
        el('cmp-stage-relayout').hidden = !this.arranged;
        this.layout();
        this.renderTags();
        this.renderPlacement();
      }
    });

    // A placement typed rather than dragged. `change` and not `input`, so a
    // half-typed number — the minus sign of a negative one — is not read as a
    // placement and does not send the machine to the origin between keys.
    el('cmp-joint-panel').addEventListener('change', (event) => {
      const input = event.target.closest('input[data-place]');
      if (!input) return;
      const member = this.memberOf(this.selected);
      const value = Number(input.value);
      if (!member || !Number.isFinite(value)) {
        this.renderPlacement();
        return;
      }
      const key = input.dataset.place;
      this.placeAt(member, {
        [key]: key === 'yaw' ? (value * Math.PI) / 180 : value,
      });
    });

    el('cmp-joint-panel').addEventListener('input', (event) => {
      const input = event.target.closest('input[type="range"][data-joint]');
      if (!input || !this.viewer || !this.selected) return;
      // The viewer's joint API is about whichever description it is focused
      // on, and a machine arriving on the floor takes the focus as it lands.
      // A slider held while that happens must still drive its own robot.
      this.viewer.focus(this.selected);
      this.viewer.setJoint(decodeURIComponent(input.dataset.joint), Number(input.value));
      this.syncJointValues(input);
    });

    // Snapping is on to begin with — an arrangement made of round numbers is
    // the one worth having — so the button says so before anybody presses it.
    el('cmp-stage-toolbar')
      .querySelector('[data-action="snap"]')
      ?.setAttribute('aria-pressed', String(this.snapping));

    this.bindDrag();
    this.bindStage();
    this.watchToolbarHeight();
    this.watchPanelHeight();

    // Fullscreen can also be left without touching the button — Escape, F11,
    // switching tabs — so the class follows the document, not the click.
    for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
      document.addEventListener(event, () => {
        if (!fsElement() && this.isFullscreen()) this.applyFullscreen(false);
      });
    }
  }

  /**
   * How much room the bar of controls takes, written onto the stage for the
   * stylesheet to read. The joint window stops above it rather than over it,
   * and how tall the bar is is a rendered fact rather than a number a
   * stylesheet can know: one row on a wide screen, two on a phone, in whichever
   * language the labels are in. So it is measured, and the window clears it on
   * any screen without either side having guessed.
   */
  watchToolbarHeight() {
    const bar = el('cmp-stage-toolbar');
    const write = () => {
      const { height } = bar.getBoundingClientRect();
      if (height) el('cmp-stage').style.setProperty('--cmp-bar-h', `${Math.round(height)}px`);
    };
    new ResizeObserver(write).observe(bar);
    write();
  }

  /**
   * How tall the joint window stands, written onto the stage the same way.
   *
   * On a wide screen it floats in a corner of a render with room to spare, and
   * nothing needs to know. On a phone it is docked across the foot of the
   * stage and takes nearly half of it, and a render fitted to the whole stage
   * puts half the row behind it — so there the stylesheet stops the render
   * above the window, and the fit follows the canvas rather than the box.
   */
  watchPanelHeight() {
    const panel = el('cmp-joint-panel');
    const write = () => {
      const height = panel.hidden ? 0 : Math.round(panel.getBoundingClientRect().height);
      el('cmp-stage').style.setProperty('--cmp-panel-h', `${height}px`);
    };
    new ResizeObserver(write).observe(panel);
    write();
  }

  /**
   * What the compare page knows and this stage needs: the columns, in the
   * order they are read across. Called on every selection change, whether or
   * not the stage has been opened — an unopened one only updates its invitation.
   *
   * @param {{key: string, model: object, robot: object}[]} entries
   */
  async sync(entries) {
    this.setup();
    // A description with no URDF, MJCF or USD of its own cannot be put on a
    // floor; the tables read such a column from the numbers alone.
    this.wanted = entries.filter((entry) => entry.robot?.assets);
    this.renderInvitation();
    if (!this.open) return;
    await this.reconcile();
  }

  /** The reader asked for the meshes. */
  async start() {
    this.open = true;
    el('cmp-stage').hidden = false;
    if (!this.viewer) {
      this.viewer = new RobotViewer(el('cmp-canvas-host'), { theme: theme() });
      // The stage is part of the page: the header's theme switch relights it
      // where it stands, keeping every pose and the camera.
      this._offTheme = onThemeChange((name) => {
        this.viewer?.setTheme(name);
        this.paintRing();
      });
      this.viewer.onRender = () => this.placeTags();
      // A row is the one arrangement an aspect change really costs: going
      // fullscreen on a phone turns a landscape frame into a portrait one, and
      // the row that filled the first is cropped at both ends in the second.
      // The canvas is resized by its own observer a frame or two after the
      // class lands, so the re-fit waits for that rather than racing it.
      this.viewer.onResize = () => {
        if (!this._refitOnResize) return;
        this._refitOnResize = false;
        this.frame();
      };
    }
    this.renderInvitation();
    // The button that opens this is above a page of tables, and the stage it
    // opens is 700px of render below it: without this the reader presses it
    // and nothing appears to happen.
    el('cmp-stage').scrollIntoView({ block: 'center', behavior: 'smooth' });
    await this.reconcile();
  }

  /** Put the meshes down again, leaving the tables as they were. */
  stop() {
    if (this.isFullscreen()) this.exitFullscreen();
    this.open = false;
    this.selected = null;
    this.members.clear();
    this.clearRing();
    this.viewer?.dispose();
    this.viewer = null;
    this._offTheme?.();
    this._offTheme = null;
    this.setArranging(false);
    const stage = el('cmp-stage');
    stage.hidden = true;
    delete stage.dataset.span;
    el('cmp-stage-relayout').hidden = true;
    el('cmp-stage-tags').innerHTML = '';
    this.tags.clear();
    // Empties the joint window rather than only hiding it, so nothing here
    // still holds nodes for a robot that has left, and puts the toolbar's one
    // sticky control back down: a new stage starts with the turntable off.
    this.renderJointPanel();
    el('cmp-stage-toolbar')
      .querySelector('[data-action="rotate"]')
      ?.setAttribute('aria-pressed', 'false');
    this.renderInvitation();
  }

  /** Leaving the compare view entirely. */
  close() {
    if (this.open) this.stop();
  }

  /* ── what is on the floor ──────────────────────────────────────────────── */

  /**
   * Bring the floor into line with the picked columns: drop what has gone,
   * fetch what has arrived, and leave everything that was already standing
   * exactly where — and posed how — the reader left it.
   */
  async reconcile() {
    if (!this.viewer) return;
    const wanted = new Map(this.wanted.map((entry) => [entry.key, entry]));

    for (const [key, member] of [...this.members]) {
      if (wanted.has(key)) continue;
      this.members.delete(key);
      if (member.robot) {
        if (this.selected === member.robot) this.select(null);
        this.viewer.removeRobot(member.robot);
      }
    }

    const missing = [...wanted.values()].filter((entry) => !this.members.has(entry.key));
    if (missing.length) {
      // Claimed before the first byte, so two quick selections do not both
      // decide the same description is missing and fetch it twice.
      for (const entry of missing) this.members.set(entry.key, { entry, robot: null, error: null });
      this.loading += 1;
      this.paintProgress(0, missing.length);
      let done = 0;
      const step = (loaded, total) =>
        this.paintProgress(done + (total ? loaded / total : 0), missing.length);
      // One at a time rather than all at once: six robots is a hundred-odd
      // mesh requests apiece, and a browser that starts all of them together
      // finishes none of them first — the reader watches an empty floor
      // instead of a filling one.
      for (const entry of missing) {
        if (!this.viewer || !this.members.has(entry.key)) continue;
        try {
          const robot = await this.viewer.addRobot(entry.robot, step);
          if (!this.members.has(entry.key)) {
            // Dropped from the comparison while its meshes were arriving.
            this.viewer.removeRobot(robot);
          } else {
            this.viewer.focus(robot);
            this.viewer.poseForPortrait(entry.robot.pose);
            this.members.set(entry.key, {
              entry,
              robot,
              error: null,
              // The turn the registry asks for — the one that stands every hand
              // up the same way. A reader's own turn is composed in front of
              // it rather than replacing it, so arranging a hand does not lay
              // it back down.
              upright: robot.quaternion.clone(),
            });
          }
        } catch (err) {
          if (this.members.has(entry.key)) {
            this.members.set(entry.key, { entry, robot: null, error: String(err.message || err) });
          }
        }
        done += 1;
        this.paintProgress(done, missing.length);
        this.layout();
        // Each machine gets its name as it lands, rather than the row staying
        // anonymous until the last of them arrives.
        this.renderTags();
        this.renderInvitation();
      }
      this.loading -= 1;
      if (!this.loading) el('cmp-stage-loading').hidden = true;
    }

    this.layout();
    this.viewer.focus(this.selected);
    this.renderTags();
    this.renderInvitation();
    this.renderJointPanel();
  }

  /** Every machine actually on the floor, in the order the tables read them. */
  standing() {
    return this.wanted
      .map((entry) => this.members.get(entry.key))
      .filter((member) => member?.robot);
  }

  /**
   * Measure each machine as it is drawn, once, with nothing applied to it.
   *
   * No URDF declares how wide a machine is any more than it declares how tall,
   * so everything downstream — the row, the floor it stands on, where its name
   * tag hangs, how big its ring is — is read off the geometry that actually
   * arrived. A robot whose meshes half failed takes the width it has rather
   * than the width it should have had.
   *
   * The measurement is in the model's own upright orientation and at the
   * origin, so it survives being moved and turned: a turn about the vertical
   * cannot change how tall something is, and a slide cannot change how wide.
   */
  measureAll(standing) {
    // With the turntable unwound, as everything that measures this stage is: an
    // axis-aligned box around a row stopped mid-spin is a box around its
    // diagonal. `frameCamera` leaves it at zero, which is where it is put back.
    this.viewer.world.rotation.z = 0;
    for (const member of standing) {
      member.robot.position.set(0, 0, 0);
      member.robot.quaternion.copy(member.upright);
    }
    this.viewer.world.updateMatrixWorld(true);
    for (const member of standing) {
      const box = boundingBox(member.robot);
      member.box = box;
      member.local = box.isEmpty()
        ? null
        : {
            // The floor-plane centre of the machine, relative to the point its
            // own origin sits at: where the tag hangs and the ring is drawn.
            cx: (box.min.x + box.max.x) / 2,
            cz: (box.min.z + box.max.z) / 2,
            // How far its origin has to be lifted for its lowest point to be
            // on the floor. Most URDFs put the origin at the base and this is
            // nearly nothing; some put it at the waist.
            lift: -box.min.y,
            width: box.max.x - box.min.x,
            depth: box.max.z - box.min.z,
          };
      // What the row is actually standing it at, measured rather than declared
      // — the same reading the registry records per robot. Published on the tag
      // for the headless check, which is how "at true scale" is a test rather
      // than a claim.
      member.height = box.isEmpty() ? 0 : box.max.y - box.min.y;
    }
  }

  /**
   * Stand them in a row, at true scale and on one floor — every machine the
   * reader has not placed themselves.
   *
   * A row is the default arrangement and the one the stage opens on: it is
   * what makes the heights readable against each other. A machine the reader
   * has moved keeps where they put it and takes no slot in the row, so adding
   * a seventh column does not sweep an arrangement away.
   *
   * The world group is Z-up (that is what a URDF means) while the scene is
   * Y-up, so a machine's own +X is the row, +Y is depth and +Z is up.
   */
  layout() {
    if (!this.viewer) return;
    const standing = this.standing();
    if (!standing.length) return;
    this.measureAll(standing);

    const row = standing.filter((member) => member.local && !member.pinned);
    const widths = row.map((member) => member.local.width).filter((width) => width > 0);
    const gap = widths.length
      ? Math.max((widths.reduce((a, b) => a + b, 0) / widths.length) * SPACING, 0.02)
      : 0.1;

    let cursor = 0;
    for (const member of row) {
      // Laid out by their edges, so the gap between two machines is a gap
      // rather than a distance between two origins that may be anywhere.
      member.slot = cursor - member.box.min.x;
      cursor = member.slot + member.box.max.x + gap;
    }
    const centre = (cursor - gap) / 2;
    for (const member of row) {
      // Along the row, and on the centre line: a placement names where a
      // machine's own middle stands, so "on the line" is y = 0 whatever its
      // description put its origin at.
      member.place = { x: member.slot - centre + member.local.cx, y: 0, yaw: 0 };
    }

    for (const member of standing) this.applyPlacement(member);
    const stage = el('cmp-stage');
    stage.dataset.span = (cursor - gap).toFixed(4);
    el('cmp-stage-relayout').hidden = !this.arranged;
    this.frame();
    // After the fit, which is what sizes the grid a snap lands on.
    stage.dataset.step = String(this.viewer.gridStep);
  }

  /**
   * Put one machine where its placement says.
   *
   * A placement is written in the world frame a URDF means — x and y across
   * the floor, and a yaw about the vertical — and it names where the machine's
   * own middle stands, not where its origin does. Descriptions put their origin
   * wherever they like (a base, a waist, a palm), and a reader arranging a
   * floor is arranging machines rather than origins: turning one should turn it
   * where it stands, and its coordinates should not jump when it does.
   *
   * There is no z in a placement, because the height is the comparison: every
   * machine stands on the one floor, and how far above it each reaches is
   * measured rather than set.
   */
  applyPlacement(member) {
    const place = member.place;
    if (!place || !member.local) return;
    const cos = Math.cos(place.yaw);
    const sin = Math.sin(place.yaw);
    // The offset from the origin to the middle, in world floor coordinates
    // (scene +Z is world −Y), turned by the yaw and taken back off: what is
    // left is where the origin has to be for the middle to land on the mark.
    const ox = member.local.cx;
    const oy = -member.local.cz;
    member.robot.position.set(
      place.x - (ox * cos - oy * sin),
      place.y - (ox * sin + oy * cos),
      member.local.lift,
    );
    // Composed in front of the entry's own upright turn rather than replacing
    // it: arranging a hand must not lay it back down.
    member.robot.quaternion.setFromAxisAngle(UP, place.yaw).multiply(member.upright);

    // Where the tag hangs and the ring is drawn: straight over the mark, at
    // the machine's full height. No re-measuring — a drag asks for this on
    // every frame — and no matrix update either, since three.js does one per
    // render anyway.
    member.anchor = new THREE.Vector3(place.x, member.height, -place.y);
    member.radius = Math.max(member.local.width, member.local.depth) * 0.62;
    this.markTagPlace(member);
    if (member.robot === this.selected) this.paintRing();
    this.viewer.invalidate();
  }

  /**
   * Where a machine stands, written onto its name tag. Published for the
   * headless check — a drag that moves the render and nothing else would look
   * exactly right in a screenshot — and written on the tag it already has
   * rather than by rebuilding the row of them, since a drag asks for this
   * sixty times a second.
   */
  markTagPlace(member) {
    const tag = this.tags.get(member.entry.key)?.node;
    if (!tag || !member.place) return;
    tag.dataset.x = member.place.x.toFixed(4);
    tag.dataset.y = member.place.y.toFixed(4);
    tag.dataset.yaw = member.place.yaw.toFixed(4);
    tag.dataset.pinned = String(!!member.pinned);
  }

  /** Fit the whole row in the frame, from where a row is read. */
  frame() {
    this.viewer?.frameCamera(ROW_VIEW.azimuth, ROW_VIEW.elevation, ROW_VIEW.padding);
  }

  /* ── where each of them stands ─────────────────────────────────────────── */

  /**
   * Move or turn one machine, and remember that a reader chose this rather
   * than the row: from here on the row leaves it alone.
   *
   * @param {object} member
   * @param {{x?: number, y?: number, yaw?: number}} next
   */
  placeAt(member, next) {
    if (!member?.place) return;
    const wasPinned = member.pinned;
    const reach = (Number(el('cmp-stage').dataset.span) || 0) + PLACE_MARGIN;
    const hold = (value) => Math.min(Math.max(value, -reach), reach);
    member.place = { ...member.place, ...next };
    member.place.x = hold(member.place.x);
    member.place.y = hold(member.place.y);
    member.pinned = true;
    this.applyPlacement(member);
    // A drag asks for this on every frame, so it writes the numbers into the
    // fields rather than rebuilding them — except the once, when being moved
    // for the first time gives the machine its way back into the row.
    if (wasPinned) this.syncPlacement();
    else this.renderPlacement();
    el('cmp-stage-relayout').hidden = false;
  }

  /** Everyone back in the row, in the order the columns are in. */
  relayout() {
    for (const member of this.members.values()) member.pinned = false;
    el('cmp-stage-relayout').hidden = true;
    this.layout();
    this.renderTags();
    this.renderPlacement();
  }

  /** Whether anyone has been moved off the row. */
  get arranged() {
    return [...this.members.values()].some((member) => member.pinned);
  }

  /** The step a move lands on: the floor grid's own spacing, or nothing. */
  get moveStep() {
    return this.snapping ? this.viewer?.gridStep || 0 : 0;
  }

  setArranging(on) {
    this.arranging = on;
    el('cmp-stage').classList.toggle('is-arranging', on);
    el('cmp-stage-toolbar')
      .querySelector('[data-action="arrange"]')
      ?.setAttribute('aria-pressed', String(on));
    el('cmp-stage-hint').textContent = t(on ? 'compare.arrangeHint' : 'compare.stageHint');
  }

  /* ── who the window is about ───────────────────────────────────────────── */

  /**
   * What a press on the render means.
   *
   * A press that goes nowhere is a click, and a click picks the machine under
   * it — or, off every machine, puts the joint window down. A press that
   * travels is a drag, and what it drags depends on the mode: normally the
   * camera, and in arrange mode the machine it landed on, across the floor, or
   * — with shift held — round on the spot.
   */
  bindStage() {
    const host = el('cmp-canvas-host');
    /** The press in progress: where it started, and what it took hold of. */
    let press = null;

    const release = (event) => {
      const started = press;
      press = null;
      if (!started) return;
      if (started.grab) {
        // The camera was held still for the length of the drag; give it back.
        this.viewer.controls.enabled = true;
        host.releasePointerCapture?.(event.pointerId);
        host.classList.remove('is-dragging');
        this.renderTags();
        this.renderPlacement();
      }
      if (started.moved || event.pointerId !== started.id || event.button !== 0) return;
      const hit = this.viewer?.pickAt(event.clientX, event.clientY) || null;
      this.select(hit?.robot || null);
      if (hit) this.viewer.highlightLink(hit.link);
    };

    // Ahead of the OrbitControls listener on the canvas inside this element,
    // which is why this one is in the capture phase: taking hold of a machine
    // has to switch the camera off before the camera has started following the
    // same pointer, or one drag would be answered twice.
    host.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary || !this.viewer) {
        press = null;
        return;
      }
      press = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false, grab: null };
      if (!this.arranging) return;
      const hit = this.viewer.pickAt(event.clientX, event.clientY);
      const member = hit && this.memberOf(hit.robot);
      const height = hit?.point.y ?? 0;
      const from = member?.place && this.floorAt(event.clientX, event.clientY, height);
      if (!from) return;
      this.select(member.robot);
      press.grab = {
        member,
        // Where the pointer took hold, relative to the mark the machine stands
        // on, so it does not jump under the hand on the first move.
        offset: { x: member.place.x - from.x, y: member.place.y - from.y },
        // A turn is the same grab read as an angle: how far round the mark the
        // pointer has travelled since it took hold. The mark itself is where
        // the machine turns about, so it does not move under the gesture.
        pivot: { x: member.place.x, y: member.place.y },
        bearing: Math.atan2(from.y - member.place.y, from.x - member.place.x),
        yaw: member.place.yaw,
        height,
      };
      this.viewer.controls.enabled = false;
      host.setPointerCapture?.(event.pointerId);
      host.classList.add('is-dragging');
    }, true);

    host.addEventListener('pointermove', (event) => {
      if (!press || event.pointerId !== press.id) return;
      if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP) {
        press.moved = true;
      }
      if (!press.grab || !press.moved) return;
      const floor = this.floorAt(event.clientX, event.clientY, press.grab.height);
      // Above the horizon there is no level plane to read: the machine stays
      // where the last move left it rather than jumping somewhere arbitrary.
      if (!floor) return;
      const { member, offset, pivot, bearing, yaw } = press.grab;
      if (event.shiftKey) {
        const now = Math.atan2(floor.y - pivot.y, floor.x - pivot.x);
        this.placeAt(member, {
          yaw: snapped(yaw + now - bearing, this.snapping ? YAW_SNAP : 0),
        });
        return;
      }
      const step = this.moveStep;
      this.placeAt(member, {
        x: snapped(floor.x + offset.x, step),
        y: snapped(floor.y + offset.y, step),
      });
    });

    host.addEventListener('pointerup', release);
    host.addEventListener('pointercancel', release);
  }

  /**
   * Where a point on screen lands on the level plane at `planeY`, given in the
   * world frame a placement is written in. Two parallel level planes differ
   * only in height, and a placement has no height, so the answer is the same
   * floor position whichever one is read.
   *
   * Null when the ray never meets the plane — a pointer above the horizon,
   * which is not a place to stand.
   */
  floorAt(clientX, clientY, planeY = 0) {
    const canvas = this.viewer?.renderer.domElement;
    if (!canvas) return null;
    const { left, top, width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return null;
    const pointer = new THREE.Vector2(
      ((clientX - left) / width) * 2 - 1,
      -((clientY - top) / height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, this.viewer.camera);
    // `normal · p + constant = 0`, so a plane at y = planeY has -planeY.
    DRAG_PLANE.constant = -planeY;
    const at = ray.ray.intersectPlane(DRAG_PLANE, new THREE.Vector3());
    if (!at) return null;
    // The floor plane is the scene's, where the point comes out as (x, −z);
    // a placement is the world group's, which the turntable may have turned
    // against it, so the spin is taken back out.
    const spin = this.viewer.world.rotation.z;
    const cos = Math.cos(spin);
    const sin = Math.sin(spin);
    return { x: at.x * cos - at.z * sin, y: -at.x * sin - at.z * cos };
  }

  /** Aim the joint window at one of the machines on the floor, or at none. */
  select(robot) {
    const next = robot && this.viewer?.holds(robot) ? robot : null;
    this.selected = next;
    this.viewer?.focus(next);
    this.paintRing();
    this.markTags();
    this.renderJointPanel();
  }

  memberOf(robot) {
    for (const member of this.members.values()) if (member.robot === robot) return member;
    return null;
  }

  /* ── the marks on the render ───────────────────────────────────────────── */

  /**
   * A ring on the floor under whichever machine the window is about. Tinting
   * the robot itself would be lying about its colours in a view whose point is
   * comparing machines as they are, and a box around it would be one more
   * rectangle in a page already made of them.
   */
  paintRing() {
    if (!this.viewer) return;
    this.clearRing();
    const member = this.memberOf(this.selected);
    if (!member?.place || !member.local) return;
    const radius = Math.max(member.radius || 0.2, 0.05);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.94, radius, 64),
      new THREE.MeshBasicMaterial({
        color: this.viewer.theme.highlight,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    // Into the world group rather than the scene, so it turns with the robots
    // when the turntable is running. That group is the Z-up one, which is also
    // the ring's own plane and the one a placement is written in: it needs no
    // rotation of its own, and the floor the row stands on is z = 0 there. The
    // hair above it keeps the two from z-fighting along the whole circle.
    ring.position.set(member.place.x, member.place.y, 0.002);
    ring.renderOrder = 3;
    this.viewer.world.add(ring);
    this._ring = ring;
    this.viewer.invalidate();
  }

  clearRing() {
    if (!this._ring) return;
    this._ring.removeFromParent();
    this._ring.geometry.dispose();
    this._ring.material.dispose();
    this._ring = null;
  }

  /** One name tag per machine, so a row of six can be read as well as orbited. */
  renderTags() {
    const host = el('cmp-stage-tags');
    const standing = this.wanted
      .map((entry) => this.members.get(entry.key))
      .filter((member) => member?.robot);
    host.innerHTML = standing
      .map((member) => {
        const on = member.robot === this.selected;
        const name = member.entry.model?.name || member.entry.robot.name;
        const place = member.place || { x: 0, y: 0, yaw: 0 };
        return `<button type="button" class="cmp-tag" data-key="${esc(member.entry.key)}"
          data-height="${(member.height || 0).toFixed(4)}"
          data-x="${place.x.toFixed(4)}" data-y="${place.y.toFixed(4)}"
          data-yaw="${place.yaw.toFixed(4)}" data-pinned="${!!member.pinned}"
          aria-pressed="${on}">${esc(name)}</button>`;
      })
      .join('');
    this.tags.clear();
    for (const node of host.querySelectorAll('.cmp-tag')) {
      // Measured here rather than per frame: a tag's size changes when its
      // name or its language does, both of which come back through here, and
      // `placeTags` runs on every rendered frame.
      this.tags.set(node.dataset.key, { node, w: node.offsetWidth, h: node.offsetHeight });
    }
    this.markTags();
    this.placeTags();
  }

  /** Which tag is lit. Selection is a click away from every one of them, so it
   *  moves the mark rather than rebuilding the row under the pointer. */
  markTags() {
    for (const [key, tag] of this.tags) {
      const member = this.members.get(key);
      tag.node.setAttribute('aria-pressed', String(!!member && member.robot === this.selected));
    }
  }

  /**
   * Put each tag where its machine is, once per rendered frame. The projection
   * is the camera's own, so a tag tracks its robot through every orbit and
   * zoom rather than being parked at a guess.
   */
  placeTags() {
    if (!this.viewer || !this.tags.size) return;
    const { clientWidth: w, clientHeight: h } = el('cmp-canvas-host');
    if (!w || !h) return;
    const point = new THREE.Vector3();
    for (const [key, tag] of this.tags) {
      const { node } = tag;
      const member = this.members.get(key);
      if (!member?.anchor) {
        node.hidden = true;
        continue;
      }
      point.copy(member.anchor).project(this.viewer.camera);
      // Behind the camera, which projects to a point in front of it.
      if (point.z > 1) {
        node.hidden = true;
        continue;
      }
      node.hidden = false;
      // Held inside the render. A tag sits above the machine it names, and a
      // machine framed to fill the stage has its head at the top edge — where
      // an unheld tag would be half off it, which on a phone is most of them.
      // The tag is drawn centred on this point and 1.2 of its height above it.
      const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), Math.max(lo, hi));
      const x = clamp(((point.x + 1) / 2) * w, tag.w / 2 + 2, w - tag.w / 2 - 2);
      const y = clamp(((1 - point.y) / 2) * h, tag.h * 1.2 + 2, h - 2);
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
    }
  }

  /* ── the joint window ──────────────────────────────────────────────────── */

  renderJointPanel() {
    const panel = el('cmp-joint-panel');
    const member = this.memberOf(this.selected);
    this._sliders = new Map();
    this._values = new Map();
    if (!member) {
      panel.hidden = true;
      panel.innerHTML = '';
      return;
    }
    const joints = this.viewer.jointList();
    const name = member.entry.model?.name || member.entry.robot.name;
    const version = member.entry.robot.variant ? member.entry.robot.variant.name : '';
    const rotational = joints.some((joint) => joint.type !== 'prismatic');
    const unit = angleUnit();

    panel.hidden = false;
    panel.innerHTML =
      `<div class="cmp-joint-head" data-drag-handle>
         <div class="cmp-joint-title">
           <strong>${esc(name)}</strong>
           ${version ? `<span>${esc(version)}</span>` : ''}
         </div>
         <button type="button" class="icon-btn" data-panel="close"
                 title="${esc(t('compare.stageDeselect'))}"
                 aria-label="${esc(t('compare.stageDeselect'))}">✕</button>
       </div>
       <div class="cmp-joint-tools">
         <span class="tree-summary">${t('tree.summary')
           .replace('{links}', String(Object.keys(this.selected.links || {}).length))
           .replace('{joints}', String(joints.length))}</span>
         ${
           rotational
             ? `<div class="unit-toggle" role="group" aria-label="${esc(t('joints.unit'))}">
                  <button type="button" data-panel="unit" data-unit="deg"
                          aria-pressed="${unit === 'deg'}" title="${esc(t('joints.unitDeg'))}">deg</button>
                  <button type="button" data-panel="unit" data-unit="rad"
                          aria-pressed="${unit === 'rad'}" title="${esc(t('joints.unitRad'))}">rad</button>
                </div>`
             : ''
         }
         <button type="button" class="link-btn" data-panel="reset">${t('panel.resetAll')}</button>
       </div>
       <div class="cmp-place" id="cmp-place"></div>
       <div class="cmp-joint-list">${
         joints.length
           ? joints.map((joint) => this.jointRow(joint)).join('')
           : `<p class="tree-none">${t('joints.none')}</p>`
       }</div>`;
    this.renderPlacement();

    for (const cell of panel.querySelectorAll('[data-tree-value]')) {
      this._values.set(cell.dataset.treeValue, cell);
    }
    for (const input of panel.querySelectorAll('input[data-joint]')) {
      this._sliders.set(decodeURIComponent(input.dataset.joint), input);
    }
    this.syncJointValues();
    this.keepPanelInside();
  }

  /**
   * Where this machine stands, as three numbers the reader can also type.
   *
   * Dragging is the gesture, and it is the one most of this gets used through
   * — but a drag cannot say "exactly one metre apart" and cannot be done at
   * all with a keyboard, and turning by dragging needs a modifier held that a
   * touch screen has no way to offer. So the same placement is here as fields:
   * x and y across the floor in metres, and a heading in degrees.
   *
   * There is no z, and there is no scale. The height of a machine is the
   * comparison this stage exists to make, and neither is the reader's to set.
   */
  renderPlacement() {
    const host = el('cmp-place');
    const member = this.memberOf(this.selected);
    if (!host || !member?.place) return;
    const { x, y, yaw } = member.place;
    const step = this.moveStep || 0.01;
    const field = (key, value, unit, label, fieldStep) =>
      `<label class="cmp-place-field">
         <span>${label}</span>
         <input type="number" data-place="${key}" value="${value}" step="${fieldStep}"
                inputmode="decimal" autocomplete="off">
         <i aria-hidden="true">${unit}</i>
       </label>`;
    host.innerHTML =
      `<div class="cmp-place-row">
         ${field('x', x.toFixed(3), 'm', 'X', step)}
         ${field('y', y.toFixed(3), 'm', 'Y', step)}
         ${field('yaw', yawDegrees(yaw), '°', '↻', this.snapping ? 15 : 1)}
       </div>
       <div class="cmp-place-foot">
         <span class="tree-summary">${esc(t('compare.placeNote'))}</span>
         ${
           member.pinned
             ? `<button type="button" class="link-btn" data-panel="unpin">${t('compare.placeReset')}</button>`
             : ''
         }
       </div>`;
  }

  /** The three numbers, refreshed in place. The field under the cursor is left
   *  alone: rewriting it mid-edit would fight whoever is typing in it. */
  syncPlacement() {
    const member = this.memberOf(this.selected);
    if (!member?.place) return;
    const shown = {
      x: member.place.x.toFixed(3),
      y: member.place.y.toFixed(3),
      yaw: String(yawDegrees(member.place.yaw)),
    };
    for (const input of el('cmp-joint-panel').querySelectorAll('input[data-place]')) {
      if (input !== document.activeElement) input.value = shown[input.dataset.place];
    }
  }

  /**
   * One joint. A joint whose value is not its own to set — one that mimics
   * another, one a closed loop solves for — gets the readout without the
   * slider, the same as on the detail page: a control that the next redraw
   * undoes is worse than no control.
   */
  jointRow(joint) {
    const driven = !!joint.mimic?.joint || joint.loop;
    const [lower, upper] = sliderRange(joint);
    const control = driven
      ? `<span class="cmp-joint-driven" title="${esc(
          joint.loop ? t('limit.loopDriven') : t('limit.mimicDriven'),
        )}">${joint.loop ? t('limit.loopSolved') : t('limit.mimic')}</span>`
      : `<input type="range" min="${lower}" max="${upper}" step="${sliderStep(joint)}"
           value="${joint.value}" data-joint="${encodeURIComponent(joint.name)}"
           aria-label="${esc(joint.name)}">`;
    return `<div class="cmp-joint-row${driven ? ' is-driven' : ''}">
      <span class="cmp-joint-name" title="${esc(joint.name)}">${esc(joint.name)}</span>
      ${control}
      <span class="tree-value" data-tree-value="${esc(joint.name)}">—</span>
    </div>`;
  }

  /** Repaint the window from the pose the stage is actually in. The slider
   *  under the hand is left alone: writing a clamped value back under the
   *  pointer would fight the drag. */
  syncJointValues(dragging = null) {
    if (!this.viewer || !this.selected) return;
    this.viewer.focus(this.selected);
    for (const joint of this.viewer.jointList()) {
      const cell = this._values.get(joint.name);
      if (cell) cell.textContent = readout(joint);
      const input = this._sliders.get(joint.name);
      if (input && input !== dragging) input.value = String(joint.value);
    }
  }

  /**
   * The window is dragged by its head, and only inside the stage: a panel
   * pushed off the edge of a fullscreen render has nothing to bring it back.
   */
  bindDrag() {
    const panel = el('cmp-joint-panel');
    let from = null;
    panel.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('[data-drag-handle]') || event.button !== 0) return;
      if (event.target.closest('button')) return;
      const stage = el('cmp-stage').getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      from = { x: event.clientX, y: event.clientY, left: box.left - stage.left, top: box.top - stage.top };
      panel.setPointerCapture(event.pointerId);
      panel.classList.add('is-dragging');
    });
    panel.addEventListener('pointermove', (event) => {
      if (!from) return;
      this.movePanel(from.left + event.clientX - from.x, from.top + event.clientY - from.y);
    });
    const end = (event) => {
      if (!from) return;
      from = null;
      panel.releasePointerCapture?.(event.pointerId);
      panel.classList.remove('is-dragging');
    };
    panel.addEventListener('pointerup', end);
    panel.addEventListener('pointercancel', end);
  }

  movePanel(left, top) {
    const panel = el('cmp-joint-panel');
    const stage = el('cmp-stage').getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    // A strip of the head always stays reachable, whichever edge it is pushed at.
    const x = Math.min(Math.max(left, 8 - box.width + 64), stage.width - 64);
    const y = Math.min(Math.max(top, 8), stage.height - 40);
    panel.style.left = `${Math.round(x)}px`;
    panel.style.top = `${Math.round(y)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  /** After a resize — entering fullscreen, rotating a phone — a window that was
   *  dragged to one corner can be outside the new one. */
  keepPanelInside() {
    const panel = el('cmp-joint-panel');
    if (panel.hidden || !panel.style.left) return;
    this.movePanel(parseFloat(panel.style.left), parseFloat(panel.style.top));
  }

  /* ── chrome ────────────────────────────────────────────────────────────── */

  /** The line above the stage: what it will cost, or what is standing on it. */
  renderInvitation() {
    const count = this.wanted.length;
    el('cmp-stage-note').textContent = this.open ? t('compare.stageOnNote') : t('compare.stageNote');
    const openBtn = el('cmp-stage-open');
    openBtn.hidden = this.open;
    openBtn.textContent = t('compare.stageOpen').replace('{n}', String(count));
    openBtn.disabled = !count;
    const failed = [...this.members.values()].filter((member) => member.error);
    el('cmp-stage-failed').innerHTML = failed
      .map(
        (member) =>
          `<p class="warn-line">${esc(member.entry.robot.name)} — ${t('compare.failed')} <code>${esc(member.error)}</code></p>`,
      )
      .join('');
    el('cmp-stage').dataset.standing = String(
      [...this.members.values()].filter((member) => member.robot).length,
    );
    el('cmp-stage-status').textContent = this.open
      ? t('compare.stageStanding').replace(
          '{n}',
          String([...this.members.values()].filter((member) => member.robot).length),
        )
      : '';
  }

  /** @param {number} done may be fractional — one robot's meshes, part-way. */
  paintProgress(done, total) {
    el('cmp-stage-loading').hidden = false;
    el('cmp-stage-loading-text').textContent = t('compare.stageLoading')
      .replace('{done}', String(Math.min(Math.floor(done) + 1, total)))
      .replace('{total}', String(total));
    el('cmp-stage-bar').style.width = `${total ? Math.max(4, Math.round((done / total) * 100)) : 8}%`;
  }

  /* ── fullscreen ────────────────────────────────────────────────────────── */

  isFullscreen() {
    return el('cmp-stage').classList.contains('is-fullscreen');
  }

  toggleFullscreen() {
    if (this.isFullscreen()) this.exitFullscreen();
    else this.enterFullscreen();
  }

  async enterFullscreen() {
    this.applyFullscreen(true);
    try {
      await fsRequest(el('cmp-stage'));
    } catch {
      // Refused (an iPhone, a permissions policy): the class alone still gives
      // the big stage, minus the browser's own chrome.
    }
  }

  async exitFullscreen() {
    this.applyFullscreen(false);
    if (fsElement()) {
      try {
        await fsExit();
      } catch {
        /* already gone */
      }
    }
  }

  applyFullscreen(on) {
    el('cmp-stage').classList.toggle('is-fullscreen', on);
    document.body.classList.toggle('stage-fullscreen-open', on);
    const button = el('cmp-stage-toolbar').querySelector('[data-action="fullscreen"]');
    button?.setAttribute('aria-pressed', String(on));
    button?.setAttribute('title', t(on ? 'viewer.exitFullscreen' : 'viewer.fullscreen'));
    // The frame this mode opens on should be all of the row: re-fitting is
    // worth the orbit it discards, since a mode whose point is "show me this
    // bigger" should not open on less of it. The canvas resize is what the fit
    // waits for; see `onResize` above.
    this._refitOnResize = true;
    requestAnimationFrame(() => {
      this.keepPanelInside();
      this.placeTags();
    });
  }

  /* ── language ──────────────────────────────────────────────────────────── */

  applyLang() {
    if (!this.bound) return;
    this.renderInvitation();
    this.renderTags();
    this.renderJointPanel();
    // Both of these say something the markup's own data-i18n has just
    // overwritten with the other of the two things they say.
    this.setArranging(this.arranging);
    const button = el('cmp-stage-toolbar').querySelector('[data-action="fullscreen"]');
    button?.setAttribute('title', t(this.isFullscreen() ? 'viewer.exitFullscreen' : 'viewer.fullscreen'));
  }
}
