/**
 * RobotViewer — a three.js scene that loads a URDF straight from the CDN and
 * exposes the inspection overlays the gallery needs (collision geometry, joint
 * axes, link frames, centres of mass, inertia boxes).
 *
 * Nothing in here knows about the registry or the DOM outside its container,
 * so the same class backs the detail page and the offline thumbnail renderer.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import URDFLoader from 'urdf-loader';
import { applyMeshRewrite } from './registry.js';
import { loadMJCF } from './mjcf.js';
import { URDFRobot, URDFVisual } from '../vendor/urdf-loader/URDFClasses.js';

const UP_Z = -Math.PI / 2; // URDF is Z-up, three.js is Y-up.

/**
 * The first bytes of the two USD containers, and of the one this cannot read.
 *
 * `PXR-USDC` is USD's binary crate format, which three.js ships a parser stub
 * for that returns an empty scene; refusing it is the difference between an
 * error a visitor can act on and a stage that renders nothing for no stated
 * reason. `PK\x03\x04` is a zip, which is what a `.usdz` is.
 */
const USD_CRATE = [0x50, 0x58, 0x52, 0x2d, 0x55, 0x53, 0x44, 0x43];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/**
 * The scheme a locally picked model is loaded through.
 *
 * A file the visitor chose off their own disk is reachable only as a `blob:`
 * URL, which carries neither a directory nor a file name — so a URDF handed to
 * the parser that way loses both the path its `package://` and relative
 * references resolve against and the extension that picks a mesh loader. The
 * parser is therefore given the paths the URDF itself writes, under this
 * scheme, and the loading manager swaps in the blob at fetch time. js/custom.js
 * builds the other half.
 */
export const LOCAL_URL_PREFIX = 'urdfgallery-local://';

/**
 * Joints that take more than one value. urdf-loader expects every component to
 * be passed at once — `setJointValue(name, 0)` on a floating joint leaves five
 * arguments undefined and turns the entire subtree's transform into NaN — and
 * they describe a free-floating base rather than something to actuate, so the
 * viewer sets them to zero once and keeps them out of the joint sliders.
 */
const MULTI_DOF = { floating: 6, planar: 3 };

/**
 * How hard the loop solver is allowed to work per pose. A loop that has to be
 * re-closed after every slider move is on the interaction path, so the budget
 * is small — two knees converge in three or four passes from the pose they were
 * last closed at, and the cap only ever bites on the first solve of a jump.
 *
 * `LOOP_STEP` keeps one pass from throwing a joint across a singular
 * configuration (a leg exactly straight, where a small move of the toe wants a
 * large move of the knee) and out to the far branch of the mechanism; the pass
 * after it picks up the rest. `LOOP_SETTLED` is in radians, not metres: what
 * closure is worth is what it costs to hold, and the constraint the URDF cannot
 * state is itself only approximate — Minitaur's two toes are drawn 25 µm apart
 * across the leg plane, which no knee angle can take out.
 */
const LOOP_PASSES = 12;
const LOOP_STEP = 0.4;
const LOOP_SETTLED = 1e-7;
/** Levenberg damping, relative to the largest column of the Jacobian, so a
 *  loop that goes singular slows down instead of firing a joint off. */
const LOOP_DAMPING = 1e-6;

/** Scratch for the loop solver; see `_stepLoop`. */
const _loopGap = new THREE.Vector3();
const _loopPoint = new THREE.Vector3();
const _loopArm = new THREE.Vector3();
const _loopPivot = new THREE.Vector3();

/** Whether `node` hangs below `ancestor` in the scene graph (or is it). */
function isUnder(node, ancestor) {
  for (let walk = node; walk; walk = walk.parent) {
    if (walk === ancestor) return true;
  }
  return false;
}

/**
 * Solve `A x = b` in place for a small dense `A`, by Gaussian elimination with
 * partial pivoting; `b` comes back holding `x`. `n` is how many joints one loop
 * is closed with — two, for a Minitaur leg — so nothing cleverer earns its
 * bytes here.
 *
 * @returns {boolean} false when the system is singular even after damping, in
 *   which case `b` is not to be read
 */
function solveSmall(A, b, n) {
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    if (!(Math.abs(A[pivot][col]) > 1e-14)) return false;
    if (pivot !== col) {
      [A[pivot], A[col]] = [A[col], A[pivot]];
      [b[pivot], b[col]] = [b[col], b[pivot]];
    }
    for (let row = col + 1; row < n; row += 1) {
      const factor = A[row][col] / A[col][col];
      if (!factor) continue;
      for (let k = col; k < n; k += 1) A[row][k] -= factor * A[col][k];
      b[row] -= factor * b[col];
    }
  }
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row];
    for (let k = row + 1; k < n; k += 1) sum -= A[row][k] * b[k];
    b[row] = sum / A[row][row];
  }
  return true;
}

/**
 * Two studios, one per site theme. The stage is not just a background swap:
 * the overlay colours are re-picked rather than dimmed, because the neon cyan
 * and green that carry a dark stage go pastel and unreadable on a bright one,
 * and the default mesh grey has to move the other way — pale enough to stand
 * out of the dark, dark enough to stand out of the light.
 *
 * Lighting travels with the palette too: the strong rim light exists to lift a
 * matte-black robot off a dark backdrop, and on a bright stage it only blows
 * out the highlights, so it is turned most of the way down.
 *
 * `background` is the one value here the stylesheet also holds: css/app.css
 * paints the stage around the canvas in `--studio`, and in fullscreen that
 * surface is most of the window — the band under the render, the strip behind
 * the joint tree. The two have to stay equal or the canvas edge shows as a
 * seam, so change them together.
 *
 * Each studio floor is the same shade as that theme's `--card-stage-bottom`,
 * so a robot on the detail stage sits on the same tone as its homepage card.
 */
export const THEMES = {
  dark: {
    background: 0x191b1f,
    grid: 0x2a3340,
    gridAccent: 0x3d4a5c,
    visual: 0xb9c2cf,
    collision: 0x4ac3ff,
    com: 0xffc857,
    inertia: 0xff6b9d,
    axis: 0x7ee787,
    highlight: 0x5b9cf6,
    exposure: 1.05,
    shadowOpacity: 0.32,
    hemi: { sky: 0xd7e3f4, ground: 0x1b1f27, intensity: 1.15 },
    key: { color: 0xffffff, intensity: 2.0 },
    fill: { color: 0x9fb6d4, intensity: 0.8 },
    rim: { color: 0xdce8ff, intensity: 1.6 },
  },
  light: {
    background: 0xeceef2,
    grid: 0xa9b2c0,
    gridAccent: 0x7f8998,
    visual: 0x98a2b1,
    collision: 0x0f7cc4,
    com: 0xb87400,
    inertia: 0xd11b6a,
    axis: 0x18894a,
    highlight: 0x2d74da,
    exposure: 0.98,
    shadowOpacity: 0.22,
    hemi: { sky: 0xffffff, ground: 0xbcc4d0, intensity: 1.35 },
    key: { color: 0xffffff, intensity: 2.1 },
    fill: { color: 0xd8e3f2, intensity: 0.7 },
    rim: { color: 0x93a8c4, intensity: 0.5 },
  },
};

/** @param {string} name @returns {'dark'|'light'} the palette key, defaulting to dark */
function themeName(name) {
  return name === 'light' ? 'light' : 'dark';
}

/**
 * Mesh files are not always only geometry. Several Collada exports still carry
 * the authoring scene around them — the Unitree A1 and Aliengo trunks ship
 * Blender's default lamp at `color 1000 1000 1000` plus its camera — and
 * ColladaLoader faithfully instantiates both. One such lamp inside a link lights
 * the whole scene and burns the robot out to a flat white silhouette, so
 * everything that is not geometry is dropped on the way in.
 *
 * @returns {number} how many objects were removed
 */
function stripNonGeometry(object) {
  if (!object) return 0;
  const doomed = [];
  object.traverse?.((child) => {
    if (child.isLight || child.isCamera) doomed.push(child);
  });
  for (const child of doomed) child.removeFromParent();
  return doomed.length;
}

/**
 * Drop `<axis>` elements that carry no `xyz`.
 *
 * The attribute is not optional, and urdf-loader reads it without looking:
 * `axisNode.getAttribute('xyz').split(...)` throws on the bare `<axis/>` that
 * Galbot One Golf writes into four of its fixed mount joints, and one of those
 * takes the whole robot down before a single mesh is requested. Removing the
 * element leaves urdf-loader on the URDF default axis of `1 0 0` — which is
 * what an empty `<axis>` means anyway, and what a fixed joint does not use.
 */
function dropAxesWithoutXyz(xml) {
  return xml.replace(/<axis\b[^>]*>(\s*<\/axis>)?/g, (tag) => (/\bxyz\s*=/.test(tag) ? tag : ''));
}

/**
 * Drop `<joint>` elements whose child link the file never defines.
 *
 * A joint's child is the link it moves, so a name that matches no `<link>`
 * describes nothing. urdf-loader looks the name up and adds the result without
 * checking, so `THREE.Object3D.add: object not an instance of THREE.Object3D.
 * undefined` lands in the console for every visitor — Inspire's RH56F1 has one
 * such joint, for an index force sensor whose link went missing on the way out
 * of xacro. Removing the joint costs nothing: there was no link on the far side
 * of it to reach.
 */
function dropJointsWithoutChildLink(xml) {
  const links = new Set();
  for (const [, name] of xml.matchAll(/<link\b[^>]*\bname\s*=\s*["']([^"']*)["']/g)) links.add(name);
  return xml.replace(/<joint\b[^>]*>[\s\S]*?<\/joint>/g, (joint) => {
    const child = joint.match(/<child\b[^>]*\blink\s*=\s*["']([^"']*)["']/);
    return child && !links.has(child[1]) ? '' : joint;
  });
}

/**
 * Rewrite `<color rgba="...">` from sRGB into linear-sRGB before parsing.
 *
 * urdf-loader assigns those channels with a bare `setRGB`, which lands them in
 * three.js' working colour space — linear-sRGB — while every other tool that
 * reads a URDF (RViz, Gazebo, MuJoCo) treats them as ordinary sRGB. The gap is
 * not subtle: the ROS orange `1 0.42 0.04` renders as #ffae38 gold instead of
 * #ff6c0a, so LimX's orange robots come out looking gold-plated and every
 * authored colour reads washed out. Converting the text is the one place where
 * the fix applies to exactly the URDF's own colours and leaves colours that came
 * out of a mesh file — where Collada's linear channels are already right — alone.
 *
 * A few descriptions also write 0-255 channels where the spec asks for 0-1
 * (LimX: `rgba="255 108 10 255"`); those are rescaled on the way through.
 */
function urdfColorsToLinear(xml, scratch = new THREE.Color()) {
  return xml.replace(/(<color\b[^>]*\brgba\s*=\s*(["']))(.*?)(\2)/g, (whole, head, _q, body, tail) => {
    const channels = body.trim().split(/[\s,]+/).map(Number);
    if (channels.length < 3 || channels.some((v) => !Number.isFinite(v))) return whole;
    let [r, g, b, a = 1] = channels;
    if (Math.max(r, g, b) > 1) {
      [r, g, b] = [r / 255, g / 255, b / 255];
      if (a > 1) a /= 255;
    }
    scratch.setRGB(r, g, b, THREE.SRGBColorSpace);
    return `${head}${scratch.r} ${scratch.g} ${scratch.b} ${a}${tail}`;
  });
}

/**
 * Force a visual material to render solid.
 *
 * Upstream hands out translucency freely and rarely on purpose: Booster T1's
 * URDF paints its whole body `rgba="… 0.2"`, Baxter's arms come in at 0.3,
 * Upkie's chassis and the Dex5-1 palm at 0.8 and 0.7. urdf-loader honours the
 * alpha and switches depth writing off with it, so the robot arrives as a
 * ghost with its own far side and its internals showing through — and against
 * the transparent canvas the thumbnails render on, the card background shows
 * through too. This is a gallery of shapes, not of glass.
 *
 * Two things are deliberately out of reach:
 *
 * - Materials that never asked to be blended. An opaque material with depth
 *   writing switched off is a decal that has to win against the surface it
 *   is laid on — ANYmal's logo panel, the labels on Atlas and Valkyrie —
 *   and turning depth writing back on makes it lose the z-fight and vanish.
 * - Texture-driven alpha (`alphaTest`, `alphaMap`, or a `map` whose alpha
 *   channel does the cutting). There the alpha carves a shape out of the
 *   surface instead of making it see-through, so clearing `transparent`
 *   paints the cut-away pixels back in.
 *
 * Collision shells and the overlay helpers author their own transparency and
 * never come through here.
 */
function makeOpaque(material) {
  for (const one of Array.isArray(material) ? material : [material]) {
    if (!one?.transparent) continue;
    if (one.alphaTest > 0 || one.alphaMap || one.map) continue;
    one.transparent = false;
    one.opacity = 1;
    one.depthWrite = true;
    one.needsUpdate = true;
  }
}

/** True only if the object and every ancestor up to the root is visible. */
function effectivelyVisible(object, root) {
  for (let node = object; node && node !== root.parent; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

/**
 * The geometry one link owns: its own `<visual>` and `<collision>` meshes, and
 * nothing from the links hanging off it — the walk stops at every joint, which
 * is what makes "this link" a thing that can be counted or lit up on its own.
 * Overlay helpers parked on the link (frame axes, CoM dots, inertia boxes) are
 * skipped: they belong to the stage, not to the model.
 *
 * @param {import('three').Object3D} link
 * @param {(mesh: import('three').Mesh, isCollision: boolean) => void} visit
 */
function ownGeometry(link, visit) {
  const walk = (node, collision) => {
    if (node.userData?.helper) return;
    const isCollision = collision || node.isURDFCollider === true || node.type === 'URDFCollider';
    if (node.isMesh) visit(node, isCollision);
    for (const child of node.children) {
      if (child.isURDFJoint) continue;
      walk(child, isCollision);
    }
  };
  for (const child of link.children || []) {
    if (child.isURDFJoint) continue;
    walk(child, false);
  }
}

/**
 * The link a mesh belongs to, for a mesh the raycaster just handed back: the
 * nearest link above it in the scene graph, or null when the mesh is not the
 * model's to pick — an overlay helper parked on a link, or geometry that is not
 * currently being drawn.
 *
 * Both exclusions have to be checked the whole way up. An overlay is switched
 * off by hiding the URDFVisual or URDFCollider that holds the meshes rather
 * than the meshes themselves, and a raycaster walks the graph without asking
 * either of them whether they are visible.
 *
 * @param {import('three').Object3D} mesh
 * @param {import('three').Object3D} robot
 * @returns {?import('three').Object3D}
 */
function pickedLink(mesh, robot) {
  let link = null;
  for (let node = mesh; node; node = node.parent) {
    if (!node.visible || node.userData?.helper) return null;
    if (!link && node.isURDFLink) link = node;
    // URDFRobot is itself the root link, so the walk always ends on a link.
    if (node === robot) return link;
  }
  return null; // a hit from outside the robot; nothing here owns it
}

/**
 * Bounding box of what is actually on screen. Ancestor visibility matters:
 * collision geometry is hidden by switching off its URDFCollider parent, and
 * counting it here would both mis-measure the robot and hide the case where the
 * visual meshes failed to load.
 *
 * Exported because the compare stage lines its robots up by their own widths,
 * and what a robot is wide is what is drawn of it.
 */
export function boundingBox(root) {
  const box = new THREE.Box3();
  const scratch = new THREE.Box3();
  root.traverse((child) => {
    if (child.isMesh && child.geometry && effectivelyVisible(child, root)) {
      child.updateWorldMatrix(true, false);
      child.geometry.computeBoundingBox();
      scratch.copy(child.geometry.boundingBox).applyMatrix4(child.matrixWorld);
      // Some upstream meshes contain NaN vertices; one of them would poison the
      // whole box and leave the camera pointing at nothing.
      if (
        Number.isFinite(scratch.min.x) && Number.isFinite(scratch.min.y) &&
        Number.isFinite(scratch.min.z) && Number.isFinite(scratch.max.x) &&
        Number.isFinite(scratch.max.y) && Number.isFinite(scratch.max.z)
      ) {
        box.union(scratch);
      }
    }
  });
  return box;
}

/**
 * Put one robot's joints at their neutral positions: zero where the limits
 * allow it, otherwise the middle of the range, so a joint whose range excludes
 * zero does not sit against a hard stop. Loops are left for the caller to
 * close, once, over whatever it has just reset.
 */
function restRobot(robot) {
  for (const joint of Object.values(robot.joints)) {
    const arity = MULTI_DOF[joint.jointType];
    if (arity) {
      robot.setJointValue(joint.name, ...new Array(arity).fill(0));
      continue;
    }
    if (joint.jointType === 'fixed') continue;
    // A joint that mimics another has no rest position of its own: the joint
    // it follows writes its value, and does so below in this same pass.
    // Giving it one here would only hold until that joint next moves.
    const source = joint.mimicJoint ? robot.joints[joint.mimicJoint] : null;
    if (source && source.jointType !== 'fixed') continue;
    const lower = Number.isFinite(joint.limit?.lower) ? joint.limit.lower : null;
    const upper = Number.isFinite(joint.limit?.upper) ? joint.limit.upper : null;
    let rest = 0;
    if (joint.jointType !== 'continuous' && lower !== null && upper !== null) {
      rest = lower <= 0 && upper >= 0 ? 0 : (lower + upper) / 2;
    }
    robot.setJointValue(joint.name, rest);
  }
}

/** Every material hanging off one robot, however many each mesh carries. */
function materialsOf(robot) {
  const found = new Set();
  robot.traverse((child) => {
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (material) found.add(material);
    }
  });
  return found;
}

/** Take one robot off the stage and free the geometry and materials it owns. */
function disposeRobot(robot) {
  robot.removeFromParent();
  robot.traverse((child) => {
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of materials) {
      m?.map?.dispose?.();
      m?.dispose?.();
    }
  });
}

/**
 * Unit axes of the model's own root frame, spelled the way
 * data/curation.json's `preview_frame` writes them.
 */
const AXIS_LETTERS = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
};

/**
 * The rotation that stands a hand up the same way as every other hand.
 *
 * Nothing in URDF says which way a description has to face, and the hands prove
 * it: Allegro grows its fingers along +Z, the Unitree Dex hands along +X or +Y,
 * LEAP lies flat with its palm looking down -Z. Left to themselves the cards
 * come out as ten unrelated objects — one hand standing, one on its back, one
 * seen edge-on — and no two of them can be compared at a glance.
 *
 * So an entry may name the two axes that give its own frame meaning, and the
 * gallery turns them onto the same pair of world axes for every hand: the palm
 * faces world +X, and the fingers point along world +Z. `palm` is the direction
 * the palm looks — the way a fingertip travels when the finger flexes — and
 * `fingers` is the direction the four fingers grow. For a gripper, which has no
 * palm to speak of, the same two directions read as the axis the jaws reach
 * along and the side you see them spread across.
 *
 * The third axis follows from the two, so the frame is fully determined and the
 * hands keep their own handedness: after the turn a right hand's thumb sits on
 * the +Y side and a left hand's on -Y, which is the one thing about a hand that
 * is not ours to normalise.
 *
 * @param {{palm: string, fingers: string}} [frame] as carried in the registry
 * @returns {import('three').Quaternion|null} null when the entry has no frame
 */
function previewRotation(frame) {
  const palm = AXIS_LETTERS[frame?.palm];
  const fingers = AXIS_LETTERS[frame?.fingers];
  // Two axes on the same line describe no frame at all; the registry build
  // rejects that, and a hand-edited file is not worth a NaN robot.
  if (!palm || !fingers || palm.findIndex(Boolean) === fingers.findIndex(Boolean)) return null;
  const u = new THREE.Vector3().fromArray(palm);
  const v = new THREE.Vector3().fromArray(fingers);
  const model = new THREE.Matrix4().makeBasis(u, v, new THREE.Vector3().crossVectors(u, v));
  // The target basis (+X, +Z, +X×+Z) is a quarter turn about X, so the rotation
  // that carries the model's frame onto it is that turn times the model basis
  // inverted — and an orthonormal basis inverts by transposing.
  const target = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  return new THREE.Quaternion().setFromRotationMatrix(target.multiply(model.transpose()));
}

/**
 * Thrown by a load whose stage was cleared while it was still fetching.
 *
 * A visitor clicks through robots faster than 20 MB of meshes arrive, and the
 * page they left goes on loading: its URDF lands after the next one's, and a
 * loader that only knows how to finish would put it on a stage that is now
 * about a different machine — a G1 standing behind a Robotiq gripper, and a
 * joint panel listing the G1's legs. `clear()` is what says the stage has
 * moved on, so it is what invalidates the loads in flight for it.
 */
export class StaleLoad extends Error {
  constructor(id) {
    super(`load of ${id} was superseded`);
    this.name = 'StaleLoad';
  }
}

/**
 * One description on the stage, and everything about it the object graph
 * urdf-loader hands back does not carry: the joint limits read off the raw
 * XML, the closed loops the registry states, the inertias, the pose the entry
 * curates.
 *
 * A viewer was a viewer of one robot for as long as there was one place to
 * stand — the detail page shows a machine, the thumbnail renderer renders it.
 * The compare stage stands two to six of them on one floor, and every one of
 * those readings is per description rather than per stage: six machines have
 * six sets of joint limits and six poses, not the last one loaded.
 *
 * So the viewer holds a cast of these with one of them focused, and the
 * single-description half of its API — `robot`, `jointList`, `kinematicTree`,
 * `setJoint`, `highlightLink` — is about the focused one. `focus()` is what a
 * click on one robot of six goes through to make the panel about that one.
 */
class StageMember {
  constructor(entry, robot) {
    this.entry = entry;
    this.robot = robot;
    this.jointMeta = undefined;
    this.inertials = undefined;
    this.loops = [];
    this.loopJoints = undefined;
    this.homePose = null;
    this.mjcf = null;
    this.loadedMeshes = null;
    this.stripped = 0;
  }
}

export class RobotViewer {
  /**
   * @param {HTMLElement} container
   * @param {{shadows?: boolean, grid?: boolean, antialias?: boolean, alpha?: boolean,
   *          theme?: 'dark'|'light'}} options
   */
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      shadows: true,
      grid: true,
      antialias: true,
      alpha: false,
      theme: 'dark',
      loadTimeout: 120000,
      ...options,
    };
    /** Every description on the stage, in the order they were mounted. */
    this.cast = [];
    /** Bumped by `clear()`; see StaleLoad. */
    this._epoch = 0;
    /** Which of them the single-description API is about; see StageMember. */
    this.focused = null;
    this.overlays = { collision: false, visual: true, frames: false, axes: false, com: false, inertia: false };
    this._helpers = { frames: [], axes: [], com: [], inertia: [] };
    this._disposables = [];
    // Materials the viewer authored itself, kept so a theme switch can recolour
    // them in place instead of reloading the robot. Colours that came out of the
    // URDF or a mesh file are the model's own and are never touched.
    this._themed = { visual: [], collision: [] };
    // One link at a time may be lit up for the tree panel: the meshes whose
    // material was swapped for a tinted copy, and the originals to put back.
    this._highlight = [];
    this._highlighted = null;
    // Picking a link off the render. Both are held rather than made per click:
    // a raycaster carries the ray it was last set from and nothing else.
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._raf = null;
    this._needsRender = true;

    this.themeName = themeName(this.options.theme);
    this.theme = THEMES[this.themeName];

    this.scene = new THREE.Scene();
    if (!this.options.alpha) this.scene.background = new THREE.Color(this.theme.background);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
    this.camera.position.set(1.6, 1.2, 1.9);

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.options.antialias,
      alpha: this.options.alpha,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = this.options.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.theme.exposure;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener('change', () => this.invalidate());

    this._buildEnvironment();
    this._observeResize();
    this._loop();
  }

  /* ------------------------------------------------------------- the cast */

  /**
   * The focused description's robot: what the single-description API reads and
   * writes. On a stage holding one — the detail page, the thumbnail renderer —
   * it is simply the robot, which is why nothing outside had to learn the word
   * "focus".
   */
  get robot() {
    return this.focused?.robot || null;
  }

  /** The registry entry the focused robot was loaded from. */
  get entry() {
    return this.focused?.entry || null;
  }

  get homePose() {
    return this.focused?.homePose || null;
  }
  set homePose(value) {
    if (this.focused) this.focused.homePose = value;
  }

  get mjcf() {
    return this.focused?.mjcf || null;
  }
  set mjcf(value) {
    if (this.focused) this.focused.mjcf = value;
  }

  get loadedMeshes() {
    return this.focused?.loadedMeshes || null;
  }
  set loadedMeshes(value) {
    if (this.focused) this.focused.loadedMeshes = value;
  }

  get _jointMeta() {
    return this.focused?.jointMeta;
  }
  set _jointMeta(value) {
    if (this.focused) this.focused.jointMeta = value;
  }

  get _inertials() {
    return this.focused?.inertials;
  }
  set _inertials(value) {
    if (this.focused) this.focused.inertials = value;
  }

  get _loops() {
    return this.focused?.loops || [];
  }
  set _loops(value) {
    if (this.focused) this.focused.loops = value;
  }

  get _loopJoints() {
    return this.focused?.loopJoints;
  }
  set _loopJoints(value) {
    if (this.focused) this.focused.loopJoints = value;
  }

  get _stripped() {
    return this.focused?.stripped || 0;
  }
  set _stripped(value) {
    if (this.focused) this.focused.stripped = value;
  }

  /**
   * Point the single-description API at one of the robots on the stage.
   *
   * @param {?import('../vendor/urdf-loader/URDFClasses.js').URDFRobot} robot
   *   one the stage is holding, or null for none of them
   * @returns {boolean} whether the focus moved
   */
  focus(robot) {
    const next = robot ? this.cast.find((member) => member.robot === robot) || null : null;
    if (next === this.focused) return false;
    // The highlight is the focused description's — tinted copies of its own
    // materials — so it is put back before the focus moves off it.
    this.highlightLink(null);
    this.focused = next;
    return true;
  }

  /** Whether this robot is one of the ones on the stage. */
  holds(robot) {
    return this.cast.some((member) => member.robot === robot);
  }

  /**
   * Take one description off the stage and free what it brought with it,
   * leaving the rest of the cast where it stands. Dropping a column from a
   * comparison should not cost the other five their meshes.
   */
  removeRobot(robot) {
    const index = this.cast.findIndex((member) => member.robot === robot);
    if (index === -1) return;
    if (this.focused === this.cast[index]) this.focus(null);
    this.cast.splice(index, 1);
    // The studio materials this robot was given are the stage's, not the
    // model's: they are held so a theme switch can recolour them in place, and
    // a robot that has left has to take its own out of those lists or the next
    // switch would write colours into materials nothing is drawing.
    const mine = materialsOf(robot);
    this._disposables = this._disposables.filter((one) => !mine.has(one));
    this._themed.visual = this._themed.visual.filter((one) => !mine.has(one));
    this._themed.collision = this._themed.collision.filter((one) => !mine.has(one));
    disposeRobot(robot);
    this.invalidate();
  }

  _buildEnvironment() {
    const t = this.theme;
    const hemi = new THREE.HemisphereLight(t.hemi.sky, t.hemi.ground, t.hemi.intensity);
    this.scene.add(hemi);
    this.hemiLight = hemi;

    const key = new THREE.DirectionalLight(t.key.color, t.key.intensity);
    key.position.set(2.4, 4.2, 2.8);
    key.castShadow = this.options.shadows;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    const d = 3;
    Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 0.1, far: 20 });
    this.scene.add(key);
    this.keyLight = key;

    const fill = new THREE.DirectionalLight(t.fill.color, t.fill.intensity);
    fill.position.set(-2.5, 1.6, -2.0);
    this.scene.add(fill);
    this.fillLight = fill;

    // Rim light from behind: several of these robots are matte black (H1, Atlas)
    // and would otherwise read as a flat silhouette on a dark stage.
    const rim = new THREE.DirectionalLight(t.rim.color, t.rim.intensity);
    rim.position.set(-1.8, 2.4, -3.4);
    this.scene.add(rim);
    this.rimLight = rim;

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.ShadowMaterial({ opacity: t.shadowOpacity }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    // ShadowMaterial only darkens where a shadow lands, so with the shadow map
    // off the plane would tint the whole frame instead of disappearing.
    this.ground.visible = this.options.shadows;
    this.scene.add(this.ground);

    this._installGrid(20, 40);

    this.world = new THREE.Group(); // holds the robot, rotated into Y-up
    this.world.rotation.x = UP_Z;
    this.scene.add(this.world);
  }

  /**
   * Swap the stage between the dark and light studios without reloading the
   * robot: the scene is rebuilt only where the palette actually reaches — the
   * backdrop, the lights, the grid, the materials the viewer authored, and the
   * inspection overlays, whose colours are baked into their geometry.
   *
   * @param {'dark'|'light'} name
   */
  setTheme(name) {
    const next = themeName(name);
    if (next === this.themeName) return;
    this.themeName = next;
    const t = (this.theme = THEMES[next]);
    // The highlight holds tinted copies of the model's materials; hand the
    // originals back so the recolouring below reaches them, then light the same
    // link again in the new palette.
    const highlighted = this._highlighted;
    this.highlightLink(null);

    if (!this.options.alpha) this.scene.background = new THREE.Color(t.background);
    this.renderer.toneMappingExposure = t.exposure;

    this.hemiLight.color.setHex(t.hemi.sky);
    this.hemiLight.groundColor.setHex(t.hemi.ground);
    this.hemiLight.intensity = t.hemi.intensity;
    for (const [light, spec] of [
      [this.keyLight, t.key],
      [this.fillLight, t.fill],
      [this.rimLight, t.rim],
    ]) {
      light.color.setHex(spec.color);
      light.intensity = spec.intensity;
    }
    this.ground.material.opacity = t.shadowOpacity;

    // GridHelper bakes its two colours into a vertex attribute, so recolouring
    // it means building it again — at whatever size the current robot asked for.
    this._installGrid(this._grid.size, this._grid.divisions);

    for (const material of this._themed.visual) material.color.setHex(t.visual);
    for (const material of this._themed.collision) material.color.setHex(t.collision);
    this._rebuildHelpers();
    this.highlightLink(highlighted);
    this.invalidate();
  }

  /**
   * Put a fresh grid on the stage in the current palette, inheriting the
   * position of the one it replaces.
   */
  _installGrid(size, divisions) {
    const previous = this.grid;
    const grid = new THREE.GridHelper(size, divisions, this.theme.gridAccent, this.theme.grid);
    grid.material.transparent = true;
    grid.material.opacity = 0.4;
    grid.visible = this.options.grid;
    if (previous) {
      grid.position.copy(previous.position);
      previous.removeFromParent();
      previous.geometry.dispose();
      previous.material.dispose();
    }
    this.grid = grid;
    this._grid = { size, divisions };
    this.scene.add(grid);
  }

  /**
   * How far apart the floor grid's lines are, in metres.
   *
   * The grid is sized so a cell is a round number of centimetres, which is
   * what makes it readable as a scale — and therefore the only step worth
   * snapping a machine's placement to: a snap that lands somewhere other than
   * on a line the reader can see is not a snap, it is a rounding error.
   */
  get gridStep() {
    return this._grid.size / this._grid.divisions;
  }

  /**
   * The floor grid is rebuilt per robot: cells land on a round number of
   * centimetres, so the spacing doubles as a scale reference.
   */
  _rebuildGrid(span, floorY, center) {
    const target = span * 0.4;
    const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1].reduce((best, candidate) =>
      Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best,
    );
    const divisions = Math.min(Math.max(Math.round((span * 6) / step), 8), 60);
    const size = step * divisions;
    if (this._grid.size !== size || this._grid.divisions !== divisions) {
      this._installGrid(size, divisions);
    }
    this.grid.position.set(center.x, floorY, center.z);
  }

  _observeResize() {
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = this.container;
      if (!w || !h) return;
      // updateStyle must stay on: without it the canvas lays out at its device
      // pixel size, so on a 2× display it covers twice the intended box.
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.invalidate();
      // After the aspect, so a listener that wants to re-fit is fitting to the
      // frame that now exists rather than to the one that just went.
      this.onResize?.(w, h);
    };
    this._resizeObserver = new ResizeObserver(resize);
    this._resizeObserver.observe(this.container);
    resize();
  }

  invalidate() {
    this._needsRender = true;
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const damping = this.controls.update();
    if (this.autoRotate) {
      this.world.rotation.z += 0.004;
      this._needsRender = true;
    }
    if (this._needsRender || damping) {
      this.renderer.render(this.scene, this.camera);
      this._needsRender = false;
      // Anything pinned to where the robots land on screen — the compare
      // stage's name tags — follows the frames rather than polling for them.
      this.onRender?.();
    }
  }

  /**
   * Load a robot described by a registry entry.
   *
   * Two kinds of description arrive here and only one stage receives them. A
   * URDF goes through urdf-loader; an MJCF goes through js/mjcf.js, which reads
   * MuJoCo's XML into the same object graph out of the same classes — so the
   * joint tree, the overlays, the loop solver, the link picker and the
   * thumbnail crop are one implementation rather than two.
   *
   * @param {object} entry registry entry (see data/robots.json)
   * @param {(loaded: number, total: number) => void} [onProgress]
   */
  async load(entry, onProgress) {
    this.clear();
    const robot = await this.addRobot(entry, onProgress);
    this.frameCamera();
    return robot;
  }

  /**
   * Load one more description onto the stage without clearing it, and focus it.
   *
   * The camera is deliberately left where it is: a stage filling up one robot
   * at a time would otherwise re-frame on every arrival, and what it should
   * end up framing is all of them. The caller says when, with `frameCamera`.
   *
   * @param {object} entry registry entry (see data/robots.json)
   * @param {(loaded: number, total: number) => void} [onProgress]
   */
  async addRobot(entry, onProgress) {
    const robot = entry.assets.urdf
      ? await this._loadUrdf(entry, onProgress)
      : entry.assets.mjcf
        ? await this._loadMjcf(entry, onProgress)
        : await this._loadUsd(entry, onProgress);
    this._styleAll();
    this._applyOverlays();
    this.stats = this.meshStats();
    return robot;
  }

  /**
   * Stop a load the stage has moved on from, at the two points where it comes
   * back from the network: before anything of the robot's has reached the
   * scene, where there is nothing to take back, and after its meshes, where
   * `clear()` will already have disposed of what was mounted — `removeRobot`
   * is there for the robot that somehow outlived it.
   *
   * @param {number} epoch what `this._epoch` was when the load began
   */
  _abandonIfStale(epoch, entry, robot = null) {
    if (epoch === this._epoch) return;
    if (robot) this.removeRobot(robot);
    throw new StaleLoad(entry.id);
  }

  /**
   * Put a parsed robot on the stage, in the frame the entry asks to see it in.
   *
   * On the way in rather than at portrait time, because everything after this
   * measures the robot where it leaves it: the camera fit at the end of the
   * load, the bounding box the card image is cropped to, and the height the
   * detail page quotes. Joint moves never touch the root, so the card and the
   * detail page agree on which way the hand faces.
   *
   * @returns {StageMember} the record the rest of the load writes into
   */
  _mount(entry, robot) {
    const member = new StageMember(entry, robot);
    this.cast.push(member);
    this.focused = member;
    this.world.add(robot);
    const upright = previewRotation(entry.preview_frame);
    if (upright) robot.quaternion.copy(upright);
    return member;
  }

  /**
   * An MJCF entry, read by js/mjcf.js.
   *
   * A Menagerie scene file is a robot plus a room — a ground plane, a light,
   * sometimes a table — so the registry records which of the files it includes
   * is the robot itself, and that is what the stage shows. The gallery brings
   * its own studio; the room would only be measured as part of the model.
   */
  async _loadMjcf(entry, onProgress) {
    const epoch = this._epoch;
    const base = entry.assets.base;
    // A model the visitor picked off their own disk answers paths out of the
    // files they handed over rather than out of a CDN. See js/custom.js.
    const local = entry.assets.local || null;
    const path = entry.assets.mjcf_model || entry.assets.mjcf;
    const manager = new THREE.LoadingManager();
    // Files jsDelivr refuses as too large are remapped to GitHub raw in
    // `assets.mesh_alt`; everything else stays on the CDN base.
    const alt = entry.assets.mesh_alt || {};
    // A mesh no picked file answers to gets a URL that cannot resolve, which
    // three.js' loaders report as a failed load — the same hole in the robot a
    // missing mesh leaves on the URDF path, rather than a request to nowhere.
    const resolve = local
      ? (rel) => local.urlOf(rel) || `${LOCAL_URL_PREFIX}missing/${rel}`
      : (rel) => alt[rel] || base + rel;
    const readXml = local
      ? (rel) => local.readText(rel)
      : async (rel) => {
          const response = await fetch(base + rel);
          return response.ok ? await response.text() : null;
        };
    const text = await readXml(path);
    if (text === null || text === undefined) throw new Error(`MJCF not found: ${path}`);

    const result = await loadMJCF({
      text,
      path,
      resolve,
      readXml,
      manager,
      onProgress,
      skip: entry.assets.skip_meshes,
    });
    this._abandonIfStale(epoch, entry);
    this._mount(entry, result.robot);
    // Both of these come out of the parse rather than a second read of the
    // file: MJCF states a joint's travel and a body's inertia in the same
    // document the geometry is in, so there is nothing left to fetch.
    this._jointMeta = result.jointMeta;
    this._inertials = result.inertials;
    this._configureJointLimits();
    this._prepareLoops(entry.loops);
    this.closeLoops();
    // The stance the description nominates for itself — `<key name="home">` —
    // which for a quadruped is the difference between a dog and a table.
    this.homePose = result.home;
    this.mjcf = result;
    this._stripped = 0;
    return result.robot;
  }

  /**
   * A USD stage, read by three.js' own USDLoader.
   *
   * USD describes a scene, not a mechanism: it has geometry, transforms and
   * materials, and articulation only where a file also carries UsdPhysics
   * joints, which nothing in three.js reads. So this arrives as one link with
   * everything under it — the stage can be turned, measured, screenshotted and
   * compared, and the joint panel honestly has nothing to show.
   *
   * The other difference is which way is up. USD's default is +Y and this
   * stage's is +Z (which is what a URDF and an MJCF both mean), so a file that
   * does not say otherwise is turned a quarter of a turn on the way in;
   * js/custom.js reads `upAxis` out of an ASCII stage and says so.
   */
  async _loadUsd(entry, onProgress) {
    const epoch = this._epoch;
    const local = entry.assets.local || null;
    const path = entry.assets.usd;
    const url = local ? local.urlOf(path) : entry.assets.base + path;
    if (!url) throw new Error(`USD not found: ${path}`);
    const manager = new THREE.LoadingManager();
    // On demand: the registry holds no USD, so the gallery never pays for this.
    const { USDLoader } = await import('three/addons/loaders/USDLoader.js');
    onProgress?.(0, 1);
    // The file is read here rather than by the loader, and handed to `parse`
    // according to what it turns out to be: USDLoader's own `load` always
    // fetches bytes and reads anything that is not a crate file as a zip, so a
    // plain `.usda` handed to it comes back as a broken archive. A string is
    // the one thing it parses as ASCII.
    const response = await fetch(url);
    if (!response.ok) throw new Error(`USD ${response.status} ${path}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const starts = (magic) => magic.every((byte, index) => bytes[index] === byte);
    if (starts(USD_CRATE)) throw new Error(`USD crate files are not supported: ${path}`);
    const stage = new USDLoader(manager).parse(
      starts(ZIP) ? bytes.buffer : new TextDecoder().decode(bytes),
    );
    onProgress?.(1, 1);

    const robot = new URDFRobot();
    robot.robotName = entry.name || 'usd';
    robot.name = robot.robotName;
    robot.urdfName = 'stage';
    robot.links = { stage: robot };
    robot.joints = {};
    robot.colliders = {};
    robot.visual = {};
    const visual = new URDFVisual();
    visual.urdfName = 'stage';
    visual.name = 'stage';
    if (entry.assets.usd_up !== 'Z') visual.rotation.x = Math.PI / 2;
    visual.add(stage);
    robot.add(visual);
    robot.visual.stage = visual;
    robot.frames = { ...robot.visual, ...robot.links };

    this._abandonIfStale(epoch, entry);
    this._mount(entry, robot);
    this._jointMeta = new Map();
    this._inertials = new Map();
    this.homePose = null;
    this._stripped = stripNonGeometry(stage);
    this.loadedMeshes = { done: 1, total: 1 };
    return robot;
  }

  async _loadUrdf(entry, onProgress) {
    const epoch = this._epoch;
    const base = entry.assets.base;
    // A model the visitor picked off their own disk carries a file set instead
    // of a base URL: it resolves the paths the URDF writes against the files
    // they handed over, and answers in `blob:` URLs. See js/custom.js.
    const local = entry.assets.local || null;
    // Two corrections a mirrored entry carries, both the archive's doing: the
    // substitutions that undo the mesh tree it flattened, and the meshes it
    // never kept. Skipping the latter is not an optimisation — the archive
    // answers a path it does not have with 200 and an HTML page, so the request
    // would come back as a mesh loader choking on markup.
    const rewrite = entry.assets.mesh_rewrite || [];
    const skip = new Set((entry.assets.skip_meshes || []).map((path) => base + path));
    const altByUrl = new Map(
      Object.entries(entry.assets.mesh_alt || {}).map(([rel, url]) => [base + rel, url]),
    );
    // Every request either loader makes goes through this manager, which is
    // what lets `outstanding` below see the loads the mesh counter cannot —
    // and, for a local model, what puts the blob in front of the scheme.
    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);
    loader.parseCollision = true;
    if (local) {
      loader.packages = (pkg) => `${LOCAL_URL_PREFIX}pkg/${pkg}`;
      loader.workingPath = `${LOCAL_URL_PREFIX}rel/${local.dir}`;
      // Catches what the mesh callback below never sees: the textures a Collada
      // file asks for once it has been parsed, resolved by its own parser
      // against the path it was handed.
      manager.setURLModifier((url) => local.resolve(url) || url);
    } else {
      // urdf-loader joins with '/', so package roots must not end in one — a
      // package mapped to the repository root would otherwise produce '//meshes'.
      loader.packages = Object.fromEntries(
        Object.entries(entry.assets.packages).map(([name, root]) => [
          name,
          (base + root).replace(/\/+$/, ''),
        ]),
      );
      // Meshes referenced without a package:// prefix are relative to the URDF
      // file, which is not where this page lives.
      loader.workingPath = base + entry.assets.urdf.replace(/[^/]+$/, '');
    }

    // urdf-loader handles STL and DAE; OBJ and glTF need to be plugged in.
    // Galbot ships its visual meshes as .glb, and urdf-loader answers a format
    // it does not know by logging a warning and never calling back — which
    // would leave the load counter one short of `total` forever.
    // Both take the manager: for a local model that is what applies the URL
    // rewrite above, and for a hosted one it only means these loads are counted
    // alongside every other request the page makes.
    const objLoader = new OBJLoader(manager);
    const gltfLoader = new GLTFLoader(manager);
    const defaultLoad = loader.loadMeshCb.bind(loader);

    // urdf-loader calls loadMeshCb synchronously while parsing, so once parse()
    // returns, `total` is the exact number of mesh loads this robot needs. That
    // makes "fully loaded" a counter comparison instead of a guess — waiting for
    // a quiet period would declare a 70 MB robot finished mid-download and
    // measure half a model.
    let total = 0;
    let done = 0;
    let stripped = 0;
    let parsed = false;
    let markSettled;
    const settled = new Promise((resolve) => (markSettled = resolve));

    // The mesh counter is not the whole story: a Collada file asks for textures
    // of its own once it is parsed, and those loads are nobody's mesh. Waiting
    // on the counter alone screenshots ANYmal before its logo decal arrives —
    // intermittently, which is worse than never. The loading manager sees both
    // kinds of request, and it only starts a texture while the .dae that wants
    // it is still open, so `outstanding` never dips to zero in between.
    let outstanding = 0;
    const check = () => {
      if (parsed && done >= total && outstanding === 0) markSettled();
    };
    const { itemStart, itemEnd } = manager;
    manager.itemStart = (url) => {
      outstanding += 1;
      itemStart.call(manager, url);
    };
    manager.itemEnd = (url) => {
      itemEnd.call(manager, url);
      outstanding -= 1;
      check();
    };
    const tick = () => onProgress && onProgress(done, total);

    loader.loadMeshCb = (rawPath, manager, onComplete) => {
      const path = applyMeshRewrite(rawPath, rewrite);
      // Not counted, because it is not a load: `total` stays the number of
      // requests this robot makes, which is what the progress bar is about and
      // what `assets.mesh_files` records. Answered without an error, too — the
      // build step already knows this mesh is not there and said so in the
      // registry, so urdf-loader logging it again is noise in every console
      // that opens the page.
      if (skip.has(path)) {
        onComplete(null);
        return;
      }
      total += 1;
      tick();
      const finish = (obj, err) => {
        done += 1;
        stripped += stripNonGeometry(obj);
        tick();
        try {
          onComplete(obj, err);
        } finally {
          check();
        }
      };
      // A mesh the visitor did not hand over is failed here rather than
      // requested: three.js' STL and Collada loaders are called without an
      // error callback, so a request that cannot succeed would never call back
      // at all and the counter below would wait for it until the timeout.
      if (local && !local.resolve(path)) {
        finish(null, new Error(`mesh not among the picked files: ${path}`));
        return;
      }
      const fetchPath = altByUrl.get(path) || path;
      const lower = path.toLowerCase();
      if (lower.endsWith('.obj')) {
        objLoader.load(fetchPath, (obj) => finish(obj), undefined, (err) => finish(null, err));
      } else if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
        // No Y-up correction here: a glTF written as a URDF mesh carries the
        // link frame the URDF expects, and rotating it would lay the robot on
        // its side. GLTFLoader resolves its textures before calling back, so a
        // finished .glb is a finished mesh.
        gltfLoader.load(fetchPath, (gltf) => finish(gltf.scene), undefined, (err) => finish(null, err));
      } else {
        defaultLoad(fetchPath, manager, (obj, err) => finish(obj, err));
      }
    };

    const url = base + entry.assets.urdf;
    const text = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`URDF ${r.status} ${url}`);
      return r.text();
    });

    this._abandonIfStale(epoch, entry);
    const robot = loader.parse(
      dropJointsWithoutChildLink(dropAxesWithoutXyz(urdfColorsToLinear(text))),
    );
    parsed = true;
    const member = this._mount(entry, robot);
    // Two things urdf-loader cannot tell on its own, both read off the XML it
    // has just been handed: which joints were given no travel to work with, and
    // which of them a closed loop drives rather than a slider.
    this.setJointMeta(text);
    this._configureJointLimits();
    this._prepareLoops(entry.loops);
    this.closeLoops();
    // A URDF states no pose of its own; whatever the entry curates is it.
    this.homePose = entry.pose || null;
    // Primitive geometry (<box>, <cylinder>, <sphere>) exists immediately;
    // mesh files arrive over the network, so styling runs again after they land.
    this._styleAll();
    this._applyOverlays();
    check(); // a URDF made only of primitives has nothing to wait for

    // A single unreachable mesh should degrade to a partial robot, not a page
    // that never finishes loading.
    await Promise.race([settled, new Promise((r) => setTimeout(r, this.options.loadTimeout))]);
    this._abandonIfStale(epoch, entry, robot);
    // Written to the member rather than through the focused-description
    // accessors: on a stage holding several, the focus may have moved on to
    // whichever one arrived while this one's meshes were still coming.
    member.loadedMeshes = { done, total };
    member.stripped = stripped;
    return robot;
  }

  /** Apply the studio look to every mesh that has not been styled yet. */
  _styleAll() {
    for (const member of this.cast) {
      member.robot.traverse((child) => {
        if (!child.isMesh || child.userData.styled) return;
        child.userData.styled = true;
        child.castShadow = true;
        child.receiveShadow = true;
        this._styleMesh(child, this._isCollision(child));
      });
    }
  }

  /** Collision geometry can sit several groups below its URDFCollider. */
  _isCollision(object) {
    for (let node = object; node && node !== this.world; node = node.parent) {
      if (node.type === 'URDFCollider') return true;
    }
    return false;
  }

  /** Count the meshes on the stage, split by visual vs collision geometry. */
  meshStats() {
    const stats = { visual: 0, collision: 0, textured: 0, stripped: 0 };
    for (const member of this.cast) {
      stats.stripped += member.stripped || 0;
      member.robot.traverse((child) => {
        if (!child.isMesh) return;
        stats[this._isCollision(child) ? 'collision' : 'visual'] += 1;
        const material = Array.isArray(child.material) ? child.material[0] : child.material;
        if (material?.map) stats.textured += 1;
      });
    }
    return stats;
  }


  _styleMesh(mesh, isCollision) {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (isCollision) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // A shaded, semi-transparent shell rather than a wireframe: the faces
      // catch the stage lights, so the hull keeps its form, and depth writing
      // stays off so the visual mesh it wraps still reads through it.
      mesh.material = new THREE.MeshStandardMaterial({
        color: this.theme.collision,
        metalness: 0,
        roughness: 0.75,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this._disposables.push(mesh.material);
      this._themed.collision.push(mesh.material);
      return;
    }
    // Keep authored colours where the URDF or mesh provides them, but give
    // untextured grey meshes a consistent studio look. A white base colour on a
    // textured mesh is the usual way of saying "the texture is the colour", so
    // that case keeps its material instead of being painted over.
    const untouched =
      !material ||
      !material.color ||
      (material.color.r === 1 &&
        material.color.g === 1 &&
        material.color.b === 1 &&
        !material.map);
    if (untouched) {
      mesh.material = new THREE.MeshStandardMaterial({
        color: this.theme.visual,
        metalness: 0.25,
        roughness: 0.55,
      });
      this._disposables.push(mesh.material);
      this._themed.visual.push(mesh.material);
    } else if (material.isMeshBasicMaterial || material.isMeshLambertMaterial) {
      const upgraded = new THREE.MeshStandardMaterial({
        color: material.color.clone(),
        map: material.map || null,
        metalness: 0.2,
        roughness: 0.6,
      });
      mesh.material = upgraded;
      this._disposables.push(upgraded);
    }
    makeOpaque(mesh.material);
  }

  /**
   * Frame the robot: unwind the turntable, place the camera on an orbit around
   * the visible geometry, then fit and centre it against the actual frustum.
   *
   * @param {number} azimuth orbit angle around the vertical axis, radians
   * @param {number} elevation angle above the horizon, radians
   * @param {number} padding 1 = geometry exactly touches the frame edges
   */
  frameCamera(azimuth = Math.PI * 0.22, elevation = 0.28, padding = 1.16) {
    if (!this.cast.length) return;
    // Fitting the view restores the pose the robot arrived in, so the turntable
    // spin unwinds with the camera: a model left facing away would otherwise
    // stay facing away, and the fit would measure the silhouette the spin
    // happened to stop on rather than the robot's own. Auto rotate keeps
    // running if it is on — it just starts over from the front.
    this.world.rotation.z = 0;
    this.world.updateWorldMatrix(true, true);
    const box = boundingBox(this.world);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const halfV = Math.tan((this.camera.fov * Math.PI) / 360);
    const halfH = halfV * this.camera.aspect;
    const direction = new THREE.Vector3(
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.cos(azimuth),
    );

    // Start from a bounding-sphere fit, then iterate: each pass re-aims at the
    // middle of the box as seen from the camera and moves along the view axis
    // until every corner of the box satisfies its own frustum test. A corner at
    // view-space (x, y) and depth d is inside when |x| <= d·halfH and
    // |y| <= d·halfV, and moving back by Δ adds Δ to every depth — so the pass
    // just takes the largest Δ any corner asks for. Fitting the sphere alone
    // would leave a humanoid occupying a third of the frame.
    let distance = (size.length() * 0.5) / Math.min(halfV, halfH) + 0.01;
    const target = center.clone();
    const corner = new THREE.Vector3();

    for (let pass = 0; pass < 4; pass += 1) {
      const eye = target.clone().addScaledVector(direction, distance);
      const view = new THREE.Matrix4().lookAt(eye, target, this.camera.up);
      const right = new THREE.Vector3().setFromMatrixColumn(view, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(view, 1);
      const back = new THREE.Vector3().setFromMatrixColumn(view, 2);

      let xMin = Infinity, xMax = -Infinity;
      let yMin = Infinity, yMax = -Infinity;
      let push = -Infinity;
      for (let i = 0; i < 8; i += 1) {
        corner
          .set(
            i & 1 ? box.max.x : box.min.x,
            i & 2 ? box.max.y : box.min.y,
            i & 4 ? box.max.z : box.min.z,
          )
          .sub(eye);
        const x = corner.dot(right);
        const y = corner.dot(up);
        const depth = -corner.dot(back);
        xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
        yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
        push = Math.max(
          push,
          (Math.abs(x) * padding) / halfH - depth,
          (Math.abs(y) * padding) / halfV - depth,
        );
      }

      target
        .addScaledVector(right, (xMin + xMax) / 2)
        .addScaledVector(up, (yMin + yMax) / 2);
      distance = Math.max(distance + push, size.length() * 0.05);
    }

    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(direction, distance);
    this.camera.near = Math.max(distance / 500, 0.002);
    this.camera.far = distance * 40;
    this.camera.updateProjectionMatrix();
    this.controls.update();

    // Sit the grid and shadow catcher on the robot's feet, and scale the grid to
    // the robot so a 20 cm gripper and a 2 m humanoid both get a useful floor.
    this.ground.position.y = box.min.y;
    this._rebuildGrid(Math.max(size.x, size.z, size.y * 0.6), box.min.y, center);
    const shadowSpan = Math.max(size.x, size.z) * 3 + 1;
    Object.assign(this.keyLight.shadow.camera, {
      left: -shadowSpan, right: shadowSpan, top: shadowSpan, bottom: -shadowSpan,
    });
    this.keyLight.shadow.camera.updateProjectionMatrix();
    this.keyLight.position.set(shadowSpan, shadowSpan * 1.6, shadowSpan * 0.9);
    this.measure();
    this.invalidate();
    return this.measured;
  }

  /**
   * How big the robot is, in metres, taken from the geometry that is actually
   * on screen — which is the only place the answer exists: no URDF declares a
   * height, and a description is not its meshes until they arrive.
   *
   * The turntable is unwound for the reading and put back afterwards, since an
   * axis-aligned box around a model stopped mid-spin measures its diagonal. y
   * is up here, so `height_m` is the height.
   *
   * Null when there is nothing visible to measure: a description whose meshes
   * did not load measures nothing, and zero is not an answer to how tall it is.
   *
   * @returns {?{size: {x: number, y: number, z: number}, height_m: number}}
   */
  measure() {
    if (!this.cast.length) return null;
    const spin = this.world.rotation.z;
    this.world.rotation.z = 0;
    this.world.updateWorldMatrix(true, true);
    const box = boundingBox(this.world);
    this.world.rotation.z = spin;
    this.world.updateWorldMatrix(true, true);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    this.measured = {
      size: { x: +size.x.toFixed(4), y: +size.y.toFixed(4), z: +size.z.toFixed(4) },
      height_m: +size.y.toFixed(4),
    };
    return this.measured;
  }

  /**
   * Where the robot lands on screen, in CSS pixels relative to the canvas.
   * The thumbnail renderer crops to this so a tall humanoid and a wide
   * quadruped both fill their card instead of floating in dead space.
   */
  screenBounds(margin = 0.03) {
    if (!this.cast.length) return null;
    this.world.updateWorldMatrix(true, true);
    const box = boundingBox(this.world);
    if (box.isEmpty()) return null;
    const { clientWidth: w, clientHeight: h } = this.container;
    const point = new THREE.Vector3();
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < 8; i += 1) {
      point
        .set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        )
        .project(this.camera);
      const x = ((point.x + 1) / 2) * w;
      const y = ((1 - point.y) / 2) * h;
      xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    const padX = (xMax - xMin) * margin;
    const padY = (yMax - yMin) * margin;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const x = clamp(xMin - padX, 0, w);
    const y = clamp(yMin - padY, 0, h);
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(clamp(xMax + padX, 0, w) - x),
      height: Math.round(clamp(yMax + padY, 0, h) - y),
    };
  }

  // ---------------------------------------------------------------- overlays

  setOverlay(name, enabled) {
    this.overlays[name] = enabled;
    this._applyOverlays();
  }

  _applyOverlays() {
    if (!this.cast.length) return;
    const { visual, collision } = this.overlays;
    for (const member of this.cast) {
      member.robot.traverse((child) => {
        if (child.type === 'URDFVisual') child.visible = visual;
        if (child.type === 'URDFCollider') child.visible = collision;
      });
    }
    this._rebuildHelpers();
    this.invalidate();
  }

  _clearHelpers() {
    for (const group of Object.values(this._helpers)) {
      for (const helper of group) {
        helper.removeFromParent();
        helper.traverse?.((c) => {
          c.geometry?.dispose?.();
          if (c.material && c.material !== helper.material) c.material.dispose?.();
        });
        helper.geometry?.dispose?.();
        helper.material?.dispose?.();
      }
      group.length = 0;
    }
  }

  _rebuildHelpers() {
    this._clearHelpers();
    if (!this.cast.length) return;
    const scale = this._helperScale();

    for (const member of this.cast) this._helpersFor(member, scale);

    // Helpers live inside the links and joints they annotate, so anything that
    // walks the robot looking for the model's own geometry needs to be able to
    // tell them apart from it.
    for (const group of Object.values(this._helpers)) {
      for (const helper of group) helper.userData.helper = true;
    }
  }

  /** The overlays one description carries, at the scale the stage sets. */
  _helpersFor(member, scale) {
    const robot = member.robot;
    if (this.overlays.frames) {
      for (const link of Object.values(robot.links)) {
        const axes = new THREE.AxesHelper(scale);
        axes.material.depthTest = false;
        axes.renderOrder = 10;
        link.add(axes);
        this._helpers.frames.push(axes);
      }
    }

    if (this.overlays.axes) {
      for (const joint of Object.values(robot.joints)) {
        if (joint.jointType === 'fixed') continue;
        const dir = joint.axis.clone().normalize();
        const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), scale * 2.2, this.theme.axis, scale * 0.5, scale * 0.28);
        arrow.line.material.depthTest = false;
        arrow.cone.material.depthTest = false;
        arrow.renderOrder = 11;
        joint.add(arrow);
        this._helpers.axes.push(arrow);
      }
    }

    if (this.overlays.com || this.overlays.inertia) {
      for (const link of Object.values(robot.links)) {
        const inertial = member.inertials?.get(link.name) || null;
        if (!inertial) continue;
        if (this.overlays.com) {
          const radius = Math.max(scale * 0.22 * Math.cbrt(Math.max(inertial.mass, 1e-3)), scale * 0.12);
          const dot = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 16, 12),
            new THREE.MeshBasicMaterial({ color: this.theme.com, depthTest: false }),
          );
          dot.position.fromArray(inertial.origin);
          dot.renderOrder = 12;
          link.add(dot);
          this._helpers.com.push(dot);
        }
        if (this.overlays.inertia && inertial.box) {
          const box = new THREE.Mesh(
            new THREE.BoxGeometry(...inertial.box),
            // A translucent solid rather than a wireframe: lit, so the faces
            // read as a box, front-facing only and faint, so a whole robot's
            // worth of boxes layered over the model does not bury it.
            new THREE.MeshStandardMaterial({
              color: this.theme.inertia,
              metalness: 0,
              roughness: 0.8,
              transparent: true,
              opacity: 0.24,
              depthWrite: false,
              depthTest: false,
            }),
          );
          box.position.fromArray(inertial.origin);
          box.renderOrder = 12;
          link.add(box);
          this._helpers.inertia.push(box);
        }
      }
    }
  }

  _helperScale() {
    const box = boundingBox(this.world);
    const span = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length();
    return Math.max(span * 0.035, 0.01);
  }

  /**
   * Inertial data is not exposed by urdf-loader, so it is read out of the raw
   * XML once and cached: mass, CoM offset, and the equivalent solid box that
   * reproduces the diagonal inertia tensor.
   */
  setInertialData(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const map = new Map();
    for (const link of doc.querySelectorAll('robot > link')) {
      const inertial = link.querySelector(':scope > inertial');
      if (!inertial) continue;
      const mass = parseFloat(inertial.querySelector('mass')?.getAttribute('value') || '0');
      const xyz = (inertial.querySelector('origin')?.getAttribute('xyz') || '0 0 0')
        .trim()
        .split(/\s+/)
        .map(Number);
      const i = inertial.querySelector('inertia');
      let box = null;
      if (i && mass > 0) {
        const ixx = parseFloat(i.getAttribute('ixx') || '0');
        const iyy = parseFloat(i.getAttribute('iyy') || '0');
        const izz = parseFloat(i.getAttribute('izz') || '0');
        // Solve the solid-cuboid inertia formulas for the side lengths.
        const sx = (6 / mass) * (-ixx + iyy + izz);
        const sy = (6 / mass) * (ixx - iyy + izz);
        const sz = (6 / mass) * (ixx + iyy - izz);
        if (sx > 0 && sy > 0 && sz > 0) box = [Math.sqrt(sx), Math.sqrt(sy), Math.sqrt(sz)];
      }
      map.set(link.getAttribute('name'), { mass, origin: xyz.length === 3 ? xyz : [0, 0, 0], box });
    }
    this._inertials = map;
    if (this.overlays.com || this.overlays.inertia) this._rebuildHelpers();
    return map;
  }

  _inertialOf(linkName) {
    return this._inertials?.get(linkName) || null;
  }

  /**
   * The parts of `<joint>` urdf-loader throws away: the effort and velocity
   * limits, whether a position limit was declared at all (the loader defaults a
   * missing one to 0..0, which is indistinguishable from a joint genuinely
   * pinned at zero), and mimic relations. Read from the raw XML once and cached
   * alongside the inertial data.
   */
  setJointMeta(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const map = new Map();
    const num = (node, attr) => {
      const raw = node?.getAttribute(attr);
      if (raw === null || raw === undefined || raw.trim() === '') return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    for (const joint of doc.querySelectorAll('robot > joint')) {
      const name = joint.getAttribute('name');
      if (!name) continue;
      const limit = joint.querySelector(':scope > limit');
      const mimic = joint.querySelector(':scope > mimic');
      map.set(name, {
        type: joint.getAttribute('type') || '',
        lower: num(limit, 'lower'),
        upper: num(limit, 'upper'),
        effort: num(limit, 'effort'),
        velocity: num(limit, 'velocity'),
        mimic: mimic
          ? {
              joint: mimic.getAttribute('joint') || '',
              multiplier: num(mimic, 'multiplier') ?? 1,
              offset: num(mimic, 'offset') ?? 0,
            }
          : null,
      });
    }
    this._jointMeta = map;
    return map;
  }

  /**
   * Configure the joints whose declared limits cannot be applied literally.
   *
   * A `<limit>` that carries only `effort` and `velocity` is legal, and several
   * descriptions write one — Minitaur's knees, SigmaBan's whole upper body,
   * Upkie's wheels. urdf-loader reads the two missing attributes as its own
   * 0..0 default and then clamps the joint to exactly zero for the life of the
   * page, so the joint is not merely unlimited, it is welded. The panel already
   * reads a missing limit for what it is and offers such a joint a full turn,
   * and `pose` in the registry may be counting on it moving, so the clamp goes.
   *
   * Only a limit that declares neither end counts: `lower="0" upper="0"` is a
   * description saying, in as many words, that this joint does not move.
   *
   * A mimic joint is different: its position is not an independent command to
   * clamp, but exactly `multiplier * source + offset`. Some otherwise useful
   * descriptions still give the follower a range that contradicts that
   * equation — Robotiq 2F-85 declares three negative followers as 0..0.8757,
   * for example. urdf-loader clamps those followers to zero and breaks the
   * linkage. The source joint already bounds the only slider the mechanism
   * exposes, so followers keep the relation the URDF declares and do not apply
   * a second, potentially contradictory clamp.
   */
  _configureJointLimits() {
    if (!this.robot) return;
    for (const joint of Object.values(this.robot.joints)) {
      if (joint.jointType !== 'revolute' && joint.jointType !== 'prismatic') continue;
      if (joint.mimicJoint) {
        joint.ignoreLimits = true;
        continue;
      }
      const meta = this._jointMeta?.get(joint.urdfName || joint.name);
      if (!meta || meta.lower !== null || meta.upper !== null) continue;
      joint.ignoreLimits = true;
    }
  }

  // ------------------------------------------------------------------ joints

  /**
   * The actuated joints, each with the limits the URDF declares for it.
   * `lower`/`upper` come from the loader (which is what the viewer clamps to);
   * `effort`, `velocity` and `mimic` need the raw XML, so they stay null until
   * `setJointMeta` has been handed it; `hasLimits` falls back to what the loader
   * can tell until then.
   *
   * @returns {Array<{name: string, type: string, lower: number, upper: number,
   *   value: number, effort: ?number, velocity: ?number, hasLimits: boolean,
   *   mimic: ?object, loop: boolean}>}
   */
  jointList() {
    if (!this.robot) return [];
    return Object.values(this.robot.joints)
      .filter((j) => j.jointType !== 'fixed' && !(j.jointType in MULTI_DOF))
      .map((j) => {
        const meta = this._jointMeta?.get(j.name) || null;
        // Without the XML, a 0..0 range is the loader's "no <limit> here".
        const declared = meta
          ? meta.lower !== null || meta.upper !== null
          : j.limit?.lower !== 0 || j.limit?.upper !== 0;
        return {
          name: j.name,
          type: j.jointType,
          lower: j.limit?.lower ?? -Math.PI,
          upper: j.limit?.upper ?? Math.PI,
          value: Array.isArray(j.angle) ? j.angle[0] : j.angle,
          effort: meta?.effort ?? null,
          velocity: meta?.velocity ?? null,
          mimic: meta?.mimic ?? null,
          hasLimits: j.jointType !== 'continuous' && declared,
          loop: this.isLoopDriven(j.urdfName || j.name),
        };
      });
  }

  // --------------------------------------------------------------- structure

  /**
   * The kinematic tree, as the URDF declares it: the root link, and under it
   * one node per joint carrying the link it moves. Read off the scene graph
   * urdf-loader built rather than off the XML, so what the tree shows is what
   * is actually on the stage — the same objects the sliders drive and
   * `highlightLink` lights up.
   *
   * `meshes` counts only the geometry the link owns, which is what makes the
   * difference between a link that is a real body and one that exists to hold a
   * frame visible in the panel.
   *
   * @returns {?{link: string, joint: ?{name: string, type: string, movable: boolean,
   *   axis: ?number[], mimic: ?object, loop: boolean}, meshes: {visual: number, collision: number},
   *   mass: ?number, children: Array<object>}}
   */
  kinematicTree() {
    if (!this.robot) return null;
    // A URDF is a tree, but a malformed one can name a loop; the guard keeps
    // that a missing branch rather than a stack overflow.
    const seen = new Set();
    const node = (link, joint) => {
      if (seen.has(link)) return null;
      seen.add(link);
      const meshes = { visual: 0, collision: 0 };
      ownGeometry(link, (_mesh, isCollision) => {
        meshes[isCollision ? 'collision' : 'visual'] += 1;
      });
      const name = link.urdfName || link.name;
      const jointName = joint && (joint.urdfName || joint.name);
      return {
        link: name,
        joint: joint
          ? {
              name: jointName,
              type: joint.jointType,
              movable: joint.jointType !== 'fixed' && !(joint.jointType in MULTI_DOF),
              axis: joint.axis ? joint.axis.toArray().map((v) => +v.toFixed(4)) : null,
              mimic: this._jointMeta?.get(jointName)?.mimic ?? null,
              loop: this.isLoopDriven(jointName),
            }
          : null,
        meshes,
        mass: this._inertialOf(name)?.mass ?? null,
        children: (link.children || [])
          .filter((child) => child.isURDFJoint)
          .map((child) => {
            const childLink = child.children.find((c) => c.isURDFLink);
            return childLink ? node(childLink, child) : null;
          })
          .filter(Boolean),
      };
    };
    // URDFRobot *is* the root link, so the walk starts on the robot itself.
    return node(this.robot, null);
  }

  /**
   * Light one link up on the stage — how the tree panel points at the model.
   * The link's materials are cloned and tinted rather than edited, so a colour
   * that came out of the URDF or a mesh file survives being highlighted, and
   * clearing puts the original material objects straight back on the meshes.
   *
   * @param {?string} name link name, or null to clear the highlight
   */
  highlightLink(name) {
    const next = name || null;
    if (next === this._highlighted) return;
    this._clearHighlight();
    this._highlighted = next;
    const link = next ? this.robot?.links?.[next] : null;
    if (link) {
      const color = this.theme.highlight;
      ownGeometry(link, (mesh) => {
        const original = mesh.material;
        const materials = (Array.isArray(original) ? original : [original]).filter(Boolean);
        if (!materials.length) return;
        const tinted = materials.map((material) => {
          const clone = material.clone();
          // Standard materials glow; anything without an emissive channel of
          // its own takes the colour directly.
          if (clone.emissive) {
            clone.emissive.setHex(color);
            clone.emissiveIntensity = 0.75;
          } else if (clone.color) {
            clone.color.setHex(color);
          }
          return clone;
        });
        mesh.material = Array.isArray(original) ? tinted : tinted[0];
        this._highlight.push({ mesh, original, tinted });
      });
    }
    this.invalidate();
  }

  /**
   * The link drawn at a point on the canvas: how a click on the model finds its
   * way back to the row that describes it. Page coordinates in — a pointer
   * event's `clientX`/`clientY` — link name out, or null where the ray misses
   * the robot.
   *
   * What is pickable is what is on screen, so the answer is always the thing
   * the visitor thinks they clicked: with the visual meshes switched off, the
   * collision hull under the pointer answers instead, and an inspection overlay
   * in front of a link steps aside rather than swallowing the click.
   *
   * @param {number} clientX
   * @param {number} clientY
   * @returns {?string} link name
   */
  linkAt(clientX, clientY) {
    return this.pickAt(clientX, clientY)?.link || null;
  }

  /**
   * The same pick, said in full: which description was hit as well as which of
   * its links. A stage holding one robot has only ever had one answer to the
   * first half; a stage holding six is where the question starts to matter —
   * clicking one of them is how the compare page's joint window is aimed.
   *
   * @param {number} clientX
   * @param {number} clientY
   * @returns {?{robot: object, link: string, point: import('three').Vector3}}
   *   `point` is where the ray met the geometry, in world space — which is
   *   what a drag needs to know to work out what plane it is dragging in.
   */
  pickAt(clientX, clientY) {
    if (!this.cast.length) return null;
    const { left, top, width, height } = this.renderer.domElement.getBoundingClientRect();
    if (!width || !height) return null;
    this._pointer.set(((clientX - left) / width) * 2 - 1, -((clientY - top) / height) * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this.camera);
    // Hits arrive nearest first, and the nearest that belongs to a model wins —
    // whichever model that is, so a robot standing in front of another takes
    // the click rather than the one the panel happens to be about.
    for (const hit of this._raycaster.intersectObjects(this.cast.map((m) => m.robot), true)) {
      for (const member of this.cast) {
        const link = pickedLink(hit.object, member.robot);
        if (link) {
          return { robot: member.robot, link: link.urdfName || link.name, point: hit.point.clone() };
        }
      }
    }
    return null;
  }

  /** Which link is lit, if any. */
  highlightedLink() {
    return this._highlighted;
  }

  _clearHighlight() {
    for (const { mesh, original, tinted } of this._highlight) {
      mesh.material = original;
      for (const material of tinted) material.dispose();
    }
    this._highlight.length = 0;
    this._highlighted = null;
  }

  // ------------------------------------------------------------------ joints

  setJoint(name, value) {
    if (!this._writeJoint(name, value)) return;
    this.closeLoops();
    this.invalidate();
  }

  /**
   * Write one joint value and stop there. Whatever closed loops the robot has
   * are left open, because a pose written a joint at a time is open in the
   * middle of being written whatever this does — the caller closes them once,
   * at the end.
   *
   * @returns {boolean} whether the robot has such a joint to write
   */
  _writeJoint(name, value) {
    const joint = this.robot?.joints[name];
    if (!joint || joint.jointType in MULTI_DOF || !Number.isFinite(value)) return false;
    this.robot.setJointValue(name, value);
    return true;
  }

  /**
   * Put joints at their neutral positions: zero when the limits allow it,
   * otherwise the middle of the range, so a joint whose range excludes zero does
   * not sit against a hard stop.
   *
   * @param {object} [robot] just this one of the stage's; every one of them by
   *   default, which on a stage holding one is the same thing
   */
  resetJoints(robot = null) {
    for (const member of this.cast) {
      if (robot && member.robot !== robot) continue;
      restRobot(member.robot);
    }
    this.closeLoops();
    this.invalidate();
  }

  /**
   * Apply a joint configuration, e.g. the optional `pose` a registry entry
   * carries. Most URDFs look natural at zero, but a few (the Unitree
   * quadrupeds, say) define zero as fully extended legs, which reads as a
   * broken robot on a gallery card.
   * @param {Record<string, number>} pose joint name → position
   */
  applyPose(pose) {
    if (!this.robot || !pose) return;
    for (const [name, value] of Object.entries(pose)) {
      this._writeJoint(name, value);
    }
    // Once, with the whole pose written: a loop whose joints the pose names is
    // closed by the pose itself, and re-closing it after each one in turn would
    // only be the solver chasing a half-written configuration.
    this.closeLoops();
    this.invalidate();
  }

  /**
   * Pose used for still frames: the entry's curated pose where it has one,
   * otherwise whatever the description nominates for itself — an MJCF's
   * `<key name="home">` — and failing both, the zero pose.
   */
  poseForPortrait(pose) {
    // The focused description only: on a stage holding several, posing the one
    // that has just arrived is not a reason to straighten out the five beside
    // it that a reader may already have moved.
    this.resetJoints(this.robot);
    this.applyPose(pose || this.homePose);
  }

  // ------------------------------------------------------------ closed loops

  /**
   * Loops the description cannot state, and the joints that hold them shut.
   *
   * URDF is a tree: every link has exactly one parent, so a mechanism that
   * closes back on itself has to be cut somewhere and published as two branches
   * that happen to meet. Nothing in the file says they meet, so a viewer that
   * only reads the file lets them come apart the moment a joint moves —
   * Minitaur's five-bar legs split into two halves that swing through each
   * other, which is the same picture every URDF tool shows and none of them
   * mean. MJCF says the missing half out loud, as an `<equality><connect>`
   * between two bodies, and that is the shape the registry borrows: each loop
   * names the two points that are one point, and the joints free to move so
   * they stay one point.
   *
   * @param {Array<{connect: Array<{link: string, point: number[]}>, solve: string[]}>} [specs]
   */
  _prepareLoops(specs) {
    this._loops = [];
    this._loopJoints = new Set();
    if (!this.robot || !Array.isArray(specs)) return;
    for (const spec of specs) {
      const ends = (spec.connect || []).map((end) => {
        const link = this.robot.links[end?.link];
        return link ? { link, point: new THREE.Vector3().fromArray(end.point || []) } : null;
      });
      if (ends.length !== 2 || !ends[0] || !ends[1]) continue;
      const joints = [];
      for (const name of spec.solve || []) {
        const joint = this.robot.joints[name];
        if (!joint || joint.jointType === 'fixed' || joint.jointType in MULTI_DOF) continue;
        // Which half of the loop the joint moves — and, for a joint above the
        // cut, neither: it carries both points at once and can no more open the
        // loop than close it, so it is not one of the unknowns.
        const first = isUnder(ends[0].link, joint);
        const second = isUnder(ends[1].link, joint);
        if (first === second) continue;
        joints.push({ joint, end: first ? 0 : 1, sign: first ? 1 : -1 });
      }
      if (!joints.length) continue;
      this._loops.push({
        ends,
        joints,
        // Scratch, allocated with the loop: `closeLoops` runs on the
        // interaction path and allocates nothing per pass.
        columns: joints.map(() => new THREE.Vector3()),
        matrix: joints.map(() => joints.map(() => 0)),
        rhs: joints.map(() => 0),
      });
      for (const { joint } of joints) this._loopJoints.add(joint.urdfName || joint.name);
    }
  }

  /** Whether a joint's value is the loop solver's to write rather than a
   *  slider's. */
  isLoopDriven(name) {
    return this._loopJoints?.has(name) ?? false;
  }

  /**
   * Put every declared loop back together, by Gauss-Newton on the joints it
   * nominates: the residual is the gap between the two points that should be
   * one, and the Jacobian is how each joint moves it.
   *
   * Started from where the joints already are, so a drag tracks the branch of
   * the mechanism it is on — a knee that is bent forwards stays bent forwards —
   * rather than flipping to the mirror solution halfway across a slider.
   */
  closeLoops() {
    const held = this.cast.filter((member) => member.loops.length);
    if (!held.length) return;
    for (let pass = 0; pass < LOOP_PASSES; pass += 1) {
      let step = 0;
      for (const member of held) {
        member.robot.updateMatrixWorld(true);
        for (const loop of member.loops) step = Math.max(step, this._stepLoop(loop));
      }
      if (step < LOOP_SETTLED) break;
    }
  }

  /**
   * One Gauss-Newton pass over one loop.
   *
   * Everything is read in world space, which is not the robot's frame — the
   * stage turns the model, and the turntable turns it further. It does not
   * matter: the gap and the Jacobian are carried by the same rigid transform,
   * so the joint angles that come out of them are the same either way, and
   * reading `matrixWorld` is what `updateMatrixWorld` has just paid for.
   *
   * @returns {number} the largest angle this pass moved a joint by
   */
  _stepLoop(loop) {
    _loopGap.copy(loop.ends[0].point).applyMatrix4(loop.ends[0].link.matrixWorld);
    _loopGap.sub(_loopPoint.copy(loop.ends[1].point).applyMatrix4(loop.ends[1].link.matrixWorld));
    const n = loop.joints.length;
    let scale = 0;
    for (let i = 0; i < n; i += 1) {
      const { joint, sign, end } = loop.joints[i];
      const column = loop.columns[i];
      if (joint.jointType === 'prismatic') {
        column.copy(joint.axis).transformDirection(joint.matrixWorld);
      } else {
        // The axis a joint turns about is written in the frame its <origin>
        // leaves behind, and turning about it does not move it, so the joint's
        // own world matrix carries it whatever the joint is set to.
        _loopArm.copy(loop.ends[end].point).applyMatrix4(loop.ends[end].link.matrixWorld);
        _loopArm.sub(_loopPivot.setFromMatrixPosition(joint.matrixWorld));
        column.copy(joint.axis).transformDirection(joint.matrixWorld).cross(_loopArm);
      }
      column.multiplyScalar(sign);
      scale = Math.max(scale, column.lengthSq());
    }
    if (scale === 0) return 0;
    const damping = LOOP_DAMPING * scale;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) loop.matrix[i][j] = loop.columns[i].dot(loop.columns[j]);
      loop.matrix[i][i] += damping;
      loop.rhs[i] = -loop.columns[i].dot(_loopGap);
    }
    if (!solveSmall(loop.matrix, loop.rhs, n)) return 0;
    let step = 0;
    for (let i = 0; i < n; i += 1) step = Math.max(step, Math.abs(loop.rhs[i]));
    if (!Number.isFinite(step)) return 0;
    const brake = step > LOOP_STEP ? LOOP_STEP / step : 1;
    for (let i = 0; i < n; i += 1) {
      const { joint } = loop.joints[i];
      joint.setJointValue(joint.angle + loop.rhs[i] * brake);
    }
    return step * brake;
  }

  snapshot(mime = 'image/png') {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL(mime);
  }

  clear() {
    // Anything still being fetched for the stage this empties is no longer
    // wanted: it belongs to a page the visitor has left.
    this._epoch += 1;
    this._clearHelpers();
    // Before the robots' materials are disposed of, so the tinted copies go and
    // the originals — which is what the meshes still own — are what is freed.
    this.highlightLink(null);
    for (const member of this.cast) disposeRobot(member.robot);
    this.cast.length = 0;
    this.focused = null;
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
    this._themed.visual.length = 0;
    this._themed.collision.length = 0;
    this.invalidate();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._resizeObserver?.disconnect();
    this.clear();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
