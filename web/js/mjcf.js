/**
 * MJCF (MuJoCo XML) → a robot the URDF viewer can already drive.
 *
 * The gallery's stage, joint tree, overlays, thumbnail renderer and compare
 * page are all written against the object graph urdf-loader builds: a
 * `URDFRobot` that is itself the root link, `URDFJoint` nodes carrying the link
 * each one moves, and `URDFVisual` / `URDFCollider` wrappers around the meshes
 * so an overlay can switch one kind off without touching the other. So this
 * module does not introduce a second kind of robot — it reads MuJoCo's XML and
 * builds that same graph, out of urdf-loader's own classes.
 *
 * What MJCF says that URDF cannot, and what is done with it:
 *
 * - **A body may carry several joints.** URDF gives every link exactly one
 *   joint above it, and the joint tree in the panel is built on that. A body
 *   with two hinges therefore becomes two joints with a frame between them,
 *   named after the body and the joint it leads to — `wrist·wrist_pitch` is
 *   "the frame between the two wrist hinges", and the body's own name lands on
 *   the link that actually carries its geometry.
 * - **A joint has an anchor, not an origin.** `<joint pos>` names a point the
 *   joint turns about, in the body's own frame, rather than a frame the child
 *   hangs off. The two differ by a translation, which the link below the joint
 *   carries: see `attachBody`.
 * - **A ball joint is three degrees of freedom.** It is expanded into three
 *   hinges about the body's own axes, so the panel can drive it. MuJoCo stores
 *   such a joint as a quaternion, so this is a re-parameterisation rather than
 *   the same numbers under another name.
 * - **A free joint is six.** The gallery pins every robot the way a URDF root
 *   link is pinned, so a free joint becomes a fixed one — the base is where the
 *   description puts it and there is nothing to actuate.
 * - **Geometry says whether it is for looking at or for touching.** Authors
 *   normally separate render and contact shapes by geom group, but the group
 *   numbers are only labels — Menagerie mostly uses 2/3 while MS-Human-700
 *   uses 0/1 for bone meshes vs skin capsules. The mesh-rich group and any
 *   additional groups that are both non-contact *and* carry meshes form the
 *   visual view (xArm7 keeps finger meshes in a second visual group this way).
 *   A group of only non-contact primitives is a helper — MS-Human-700's group 3
 *   tendon wrapping cylinders — and is skipped rather than drawn as a second
 *   visual or a false collision hull. Everything else is the collision view.
 *
 * Nothing in here touches the DOM or the network directly: the caller supplies
 * a URL resolver and a loading manager, which is what lets the same code serve
 * the detail page, the thumbnail renderer and a file picked off a local disk.
 */
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import {
  URDFCollider,
  URDFJoint,
  URDFLink,
  URDFRobot,
  URDFVisual,
} from '../vendor/urdf-loader/URDFClasses.js';

/** MuJoCo's own default when `<compiler angle>` says nothing. Menagerie always
 *  writes `radian`, but a hand-written file that omits it means degrees. */
const DEFAULT_ANGLE = 'degree';

/** The grey MuJoCo paints a geom that names neither `rgba` nor a material. */
const DEFAULT_RGBA = [0.5, 0.5, 0.5, 1];

/** Geom types that describe the world rather than the robot, or that nothing
 *  here can draw: an infinite ground plane, a height field, a signed-distance
 *  volume. Skipped rather than approximated. */
const SKIPPED_GEOMS = new Set(['plane', 'hfield', 'sdf', 'none']);

/** Mesh files MuJoCo accepts that this module knows how to read. */
const MESH_FORMATS = new Set(['.stl', '.obj', '.msh']);

/** Elements whose attributes a `<default>` class may carry, and which this
 *  module reads back off it. */
const DEFAULTABLE = ['geom', 'joint', 'mesh', 'material', 'site'];

/**
 * Where a spliced-in section came from, stamped on it during include
 * expansion. MuJoCo writes the same thing onto the `<include>` element it
 * leaves behind, for the same reason: see `assetCandidates`.
 */
const SOURCE_DIR = 'mjcf-source-dir';

/** @param {?string} raw @returns {number[]} */
function nums(raw) {
  if (!raw) return [];
  return raw
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v));
}

/** Attribute as a number, or `fallback` when it is absent or unreadable. */
function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** MJCF booleans are `true`/`false`, and a missing one is the caller's default. */
function flag(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

/** Collapse `a/./b`, `a/../b` and doubled slashes so the paths handed to the
 *  resolver are the paths the CDN actually serves. */
function normalize(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function joinPath(dir, file) {
  if (!file) return '';
  // An absolute reference is the one case where the directory is not the
  // answer: MuJoCo reads it as-is, and so does the CDN.
  if (/^([a-z]+:)?\//i.test(file)) return file;
  return normalize(dir ? `${dir}/${file}` : file);
}

function dirOf(path) {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function extensionOf(path) {
  const name = path.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * A rotation, from whichever of MuJoCo's five spellings an element used.
 *
 * `quat` wins, then `axisangle`, then `xyaxes`, then `zaxis`, then `euler` —
 * MuJoCo's own order, and only one of them is ever meant to be present. The
 * angle-valued ones (`axisangle`, `euler`) are in whatever unit `<compiler
 * angle>` declared; the rest are pure geometry.
 *
 * @param {Element} node
 * @param {{toRadians: (v: number) => number, eulerOrder: string}} compiler
 * @returns {THREE.Quaternion}
 */
function readRotation(node, compiler) {
  const out = new THREE.Quaternion();

  const quat = nums(node.getAttribute('quat'));
  if (quat.length === 4) {
    // MJCF writes w first; three.js writes it last.
    return out.set(quat[1], quat[2], quat[3], quat[0]).normalize();
  }

  const axisAngle = nums(node.getAttribute('axisangle'));
  if (axisAngle.length === 4) {
    const axis = new THREE.Vector3(axisAngle[0], axisAngle[1], axisAngle[2]);
    if (axis.lengthSq() === 0) return out;
    return out.setFromAxisAngle(axis.normalize(), compiler.toRadians(axisAngle[3]));
  }

  // Two of the three axes, spelled out. The second is orthogonalised against
  // the first the way MuJoCo does it, so a hand-written pair that is only
  // roughly perpendicular still yields a rotation rather than a shear.
  const xy = nums(node.getAttribute('xyaxes'));
  if (xy.length === 6) {
    const x = new THREE.Vector3(xy[0], xy[1], xy[2]);
    const y = new THREE.Vector3(xy[3], xy[4], xy[5]);
    if (x.lengthSq() === 0 || y.lengthSq() === 0) return out;
    x.normalize();
    y.addScaledVector(x, -y.dot(x));
    if (y.lengthSq() === 0) return out;
    y.normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  }

  // The z axis alone: any rotation that takes +Z onto it will do, which is what
  // MuJoCo means by it too.
  const z = nums(node.getAttribute('zaxis'));
  if (z.length === 3) {
    const target = new THREE.Vector3(z[0], z[1], z[2]);
    if (target.lengthSq() === 0) return out;
    return out.setFromUnitVectors(new THREE.Vector3(0, 0, 1), target.normalize());
  }

  const euler = nums(node.getAttribute('euler'));
  if (euler.length === 3) {
    return out.setFromEuler(
      new THREE.Euler(
        compiler.toRadians(euler[0]),
        compiler.toRadians(euler[1]),
        compiler.toRadians(euler[2]),
        compiler.eulerOrder,
      ),
    );
  }
  return out;
}

/** `pos`, defaulting to the origin as MJCF does. */
function readPosition(node) {
  const pos = nums(node.getAttribute('pos'));
  return pos.length === 3 ? new THREE.Vector3(pos[0], pos[1], pos[2]) : new THREE.Vector3();
}

/**
 * MuJoCo's `<default>` classes, flattened.
 *
 * A class inherits every attribute of the class it is nested inside, so the
 * tree is walked top-down with the parent's values already merged in and each
 * class is recorded whole. The unnamed `<default>` at the top is the class
 * everything falls back to; MuJoCo calls it "main" and so does this.
 *
 * @param {Element[]} blocks the `<default>` elements, in document order
 * @returns {Map<string, Record<string, Record<string, string>>>}
 */
function readDefaults(blocks) {
  const classes = new Map();
  const MAIN = '';

  const merge = (into, from) => {
    for (const kind of DEFAULTABLE) {
      if (!from[kind]) continue;
      into[kind] = { ...(into[kind] || {}), ...from[kind] };
    }
    return into;
  };

  const own = (element) => {
    const attrs = {};
    for (const child of element.children) {
      const kind = child.tagName;
      if (!DEFAULTABLE.includes(kind)) continue;
      const bag = (attrs[kind] = attrs[kind] || {});
      for (const { name, value } of child.attributes) bag[name] = value;
    }
    return attrs;
  };

  const walk = (element, inherited) => {
    const name = element.getAttribute('class') ?? MAIN;
    // Several `<default>` blocks may name the same class — one per included
    // file — and MuJoCo merges them, so an existing class is added to rather
    // than replaced.
    const merged = merge(merge({}, inherited), classes.get(name) || {});
    merge(merged, own(element));
    classes.set(name, merged);
    for (const child of element.children) {
      if (child.tagName === 'default') walk(child, merged);
    }
  };

  for (const block of blocks) walk(block, classes.get(MAIN) || {});
  if (!classes.has(MAIN)) classes.set(MAIN, {});
  return classes;
}

/**
 * The attributes one element ends up with: its own, over its class's, over the
 * class the nearest enclosing body named with `childclass`, over main.
 *
 * @param {Element} node
 * @param {string} kind `geom`, `joint`, …
 * @param {Map<string, object>} classes from `readDefaults`
 * @param {string} childClass inherited down the body tree
 */
function withDefaults(node, kind, classes, childClass) {
  const named = node.getAttribute('class') || childClass || '';
  const bag = {
    ...(classes.get('')?.[kind] || {}),
    ...(named ? classes.get(named)?.[kind] || {} : {}),
  };
  for (const { name, value } of node.attributes) {
    if (name !== 'class') bag[name] = value;
  }
  return bag;
}

/**
 * MuJoCo's legacy binary mesh format: four counts, then the vertices, normals,
 * texture coordinates and triangles in that order, all little-endian.
 *
 * Menagerie ships `.stl` and `.obj` almost throughout, but `.msh` is what
 * MuJoCo's own tooling writes and a description that uses it would otherwise
 * arrive as a robot with holes in it. Anything that is not this format — the
 * Gmsh files MuJoCo also accepts, for deformable bodies the gallery has no way
 * to show — is refused rather than guessed at.
 *
 * @param {ArrayBuffer} buffer
 * @returns {THREE.BufferGeometry}
 */
export function parseMSH(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 16) throw new Error('.msh too short to hold its header');
  const nvert = view.getInt32(0, true);
  const nnormal = view.getInt32(4, true);
  const ntexcoord = view.getInt32(8, true);
  const nface = view.getInt32(12, true);
  const expected = 16 + 12 * nvert + 12 * nnormal + 8 * ntexcoord + 12 * nface;
  if (nvert <= 0 || nface < 0 || expected !== buffer.byteLength) {
    throw new Error('not a MuJoCo binary .msh');
  }
  let at = 16;
  const take = (count, stride) => {
    const values = new Float32Array(buffer.slice(at, at + count * stride * 4));
    at += count * stride * 4;
    return values;
  };
  const position = take(nvert, 3);
  const normal = nnormal ? take(nnormal, 3) : null;
  const uv = ntexcoord ? take(ntexcoord, 2) : null;
  const index = new Uint32Array(buffer.slice(at, at + nface * 12));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  if (normal && nnormal === nvert) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  }
  if (uv && ntexcoord === nvert) geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (nface) geometry.setIndex(new THREE.BufferAttribute(index, 1));
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  return geometry;
}

/**
 * The solid box whose inertia matches a diagonal tensor — the same reading the
 * URDF path takes, so the inertia overlay means the same thing on both.
 *
 * @returns {?number[]} side lengths, or null when the numbers describe no box
 */
function inertiaBox(mass, [ixx, iyy, izz]) {
  if (!(mass > 0)) return null;
  const sx = (6 / mass) * (-ixx + iyy + izz);
  const sy = (6 / mass) * (ixx - iyy + izz);
  const sz = (6 / mass) * (ixx + iyy - izz);
  if (!(sx > 0 && sy > 0 && sz > 0)) return null;
  return [Math.sqrt(sx), Math.sqrt(sy), Math.sqrt(sz)];
}

/**
 * How many numbers of a keyframe's `qpos` one joint takes, which is what makes
 * the flat vector readable at all.
 */
const QPOS_WIDTH = { free: 7, ball: 4, slide: 1, hinge: 1 };

export class MJCFDocument {
  /**
   * @param {object} options
   * @param {string} options.text the main document
   * @param {string} options.path its path, in whatever space `resolve` reads
   * @param {(path: string) => string} options.resolve path → URL
   * @param {(path: string) => Promise<?string>} options.readXml for `<include>`
   * @param {THREE.LoadingManager} [options.manager]
   * @param {string[]} [options.skip] asset paths not to request — jsDelivr
   *   refuses any single file over 20 MB, and asking for one of those comes
   *   back as a mesh loader choking on the words "File size exceeded"
   */
  constructor({ text, path, resolve, readXml, manager, skip }) {
    this.text = text;
    this.path = path;
    this.resolve = resolve;
    this.readXml = readXml;
    this.manager = manager || new THREE.LoadingManager();
    this.skip = new Set(skip || []);
    /** Mesh and texture paths this document referenced, in the order they were
     *  first asked for — what the registry records and the download writer needs. */
    this.assetPaths = new Set();
    /** Everything that could not be read, said once rather than per geom. */
    this.warnings = [];
  }

  // ------------------------------------------------------------------- parse

  /**
   * Read the document and everything it includes into one element tree.
   *
   * MuJoCo's `<include>` splices the children of the included `<mujoco>` in
   * where the include stood, and its `file` is relative to the file that wrote
   * it — while `<compiler meshdir>` and friends stay relative to the main
   * document. Both are tracked here so the rest of the module can work in one
   * path space: everything relative to the main document's directory.
   *
   * Each spliced section is stamped with the directory it came out of, because
   * an asset path is resolved against the main document *or* against the file
   * that declared it, whichever exists — see `assetCandidates`.
   */
  async flatten() {
    const parse = (text, where) => {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      const error = doc.querySelector('parsererror');
      if (error) throw new Error(`${where}: ${error.textContent.trim().split('\n')[0]}`);
      const root = doc.documentElement;
      if (root.tagName !== 'mujoco') throw new Error(`${where}: not an MJCF document`);
      return root;
    };

    const root = parse(this.text, this.path);
    const seen = new Set([normalize(this.path)]);
    /** Every file spliced in, so a download can carry the whole document. */
    this.included = [];

    const expand = async (element, dir, depth) => {
      if (depth > 12) throw new Error('MJCF includes nest too deeply');
      for (const include of [...element.querySelectorAll('include')]) {
        // Held before anything is removed, because where the include stood is
        // the whole answer: an `<include>` inside a `<body>` brings a limb, and
        // the same file spliced in at the top of the document instead is
        // outside every `<worldbody>` and part of no robot at all.
        const parent = include.parentNode;
        const file = include.getAttribute('file');
        const at = file ? joinPath(dir, file) : '';
        const text = at && !seen.has(at) ? await this.readXml(at) : null;
        if (at && !seen.has(at) && text === null) {
          this.warnings.push(`include not found: ${at}`);
        }
        // MuJoCo refuses a repeated include; so does this.
        if (at) seen.add(at);
        if (text !== null && text !== undefined) {
          this.included.push(at);
          const included = parse(text, at);
          await expand(included, dirOf(at), depth + 1);
          const from = dirOf(at);
          for (const child of [...included.children]) {
            // Only where a deeper include has not already answered: the stamp
            // names the file that wrote the section, not the one that reached it.
            if (!child.hasAttribute(SOURCE_DIR)) child.setAttribute(SOURCE_DIR, from);
            parent.insertBefore(child, include);
          }
        }
        parent.removeChild(include);
      }
    };

    await expand(root, dirOf(this.path), 0);
    this.root = root;
    this.modelName = root.getAttribute('model') || '';
    return root;
  }

  /** `<compiler>`, merged across every block that named an attribute. */
  readCompiler() {
    const attrs = {};
    for (const block of this.root.querySelectorAll('compiler')) {
      for (const { name, value } of block.attributes) attrs[name] = value;
    }
    const degrees = (attrs.angle || DEFAULT_ANGLE) === 'degree';
    const seq = (attrs.eulerseq || 'xyz').toLowerCase();
    const assetDir = attrs.assetdir || '';
    const compiler = {
      degrees,
      toRadians: degrees ? (v) => (v * Math.PI) / 180 : (v) => v,
      // MuJoCo's lowercase sequences rotate about the moving frame, which is
      // what three.js' Euler orders do; the uppercase (fixed-frame) spellings
      // are the reverse order read the same way.
      eulerOrder: /^[A-Z]+$/.test(attrs.eulerseq || '')
        ? seq.toUpperCase().split('').reverse().join('')
        : seq.toUpperCase(),
      // MuJoCo resolves an asset directory against the main model file rather
      // than against the file that declared it, so an included description
      // reaches the same `assets/` folder its scene does.
      meshDir: joinPath(dirOf(this.path), attrs.meshdir ?? assetDir),
      textureDir: joinPath(dirOf(this.path), attrs.texturedir ?? assetDir),
      // MuJoCo turned this on by default in 2.2.2: a joint that states a range
      // is limited unless it says otherwise.
      autolimits: flag(attrs.autolimits, true),
    };
    this.compiler = compiler;
    return compiler;
  }

  /**
   * Where one asset file might be, in the order MuJoCo looks for it.
   *
   * The documented rule is "the main model file's directory, plus `meshdir`,
   * plus the name" — but MuJoCo falls back to resolving the name against the
   * directory of the *included file that declared it* when the first answer is
   * not there, and descriptions rely on it: MS-Human-700 declares its bones as
   * `../geometry/sacrum.stl` from a file two directories down, which means
   * nothing at all read against the model's own folder.
   *
   * The two candidates are grouped by the pair of directories that produced
   * them rather than by file, so a document of two hundred meshes pays for the
   * discovery once instead of once per mesh.
   */
  assetCandidates(node, baseDir, file) {
    const primary = joinPath(baseDir, file);
    const source =
      node.closest?.(`[${SOURCE_DIR}]`)?.getAttribute(SOURCE_DIR) ?? dirOf(this.path);
    const fallback = joinPath(source, file);
    return {
      group: `${baseDir}»${source}`,
      candidates: fallback === primary ? [primary] : [primary, fallback],
    };
  }

  /** `<asset>`: the meshes, materials and textures the bodies below refer to. */
  readAssets() {
    const classes = this.classes;
    const meshes = new Map();
    const materials = new Map();
    const textures = new Map();

    for (const node of this.root.querySelectorAll('asset > texture')) {
      const attrs = withDefaults(node, 'texture', classes, '');
      const file = attrs.file;
      const name = attrs.name || (file ? file.split('/').pop().replace(/\.[^.]+$/, '') : '');
      if (!name) continue;
      // A skybox is the backdrop and a `builtin` is generated rather than
      // fetched; the gallery brings its own studio, so neither is loaded.
      if (attrs.type === 'skybox' || !file) continue;
      textures.set(name, { name, ...this.assetCandidates(node, this.compiler.textureDir, file) });
    }

    for (const node of this.root.querySelectorAll('asset > material')) {
      const attrs = withDefaults(node, 'material', classes, '');
      if (!attrs.name) continue;
      const rgba = nums(attrs.rgba);
      materials.set(attrs.name, {
        rgba: rgba.length >= 3 ? rgba : null,
        texture: attrs.texture || null,
        specular: num(attrs.specular, 0.5),
        shininess: num(attrs.shininess, 0.5),
        metallic: attrs.metallic !== undefined ? num(attrs.metallic, 0) : null,
        roughness: attrs.roughness !== undefined ? num(attrs.roughness, 0.5) : null,
      });
    }

    for (const node of this.root.querySelectorAll('asset > mesh')) {
      const attrs = withDefaults(node, 'mesh', classes, '');
      const file = attrs.file;
      const name = attrs.name || (file ? file.split('/').pop().replace(/\.[^.]+$/, '') : '');
      if (!name) continue;
      const scale = nums(attrs.scale);
      const refpos = nums(attrs.refpos);
      const refquat = nums(attrs.refquat);
      if (!file) {
        // Vertices spelled out in the XML rather than kept in a file. Rare, and
        // the gallery has never met one; saying so beats drawing nothing.
        this.warnings.push(`inline mesh not supported: ${name}`);
        continue;
      }
      meshes.set(name, {
        name,
        ...this.assetCandidates(node, this.compiler.meshDir, file),
        scale: scale.length === 3 ? scale : scale.length === 1 ? [scale[0], scale[0], scale[0]] : [1, 1, 1],
        refpos: refpos.length === 3 ? refpos : null,
        refquat: refquat.length === 4 ? refquat : null,
      });
    }

    this.meshes = meshes;
    this.materials = materials;
    this.textures = textures;
  }

  // ------------------------------------------------------------------- build

  /**
   * Read the document into a robot.
   *
   * Everything that touches the network happens in one place at the end: the
   * body tree is walked first, which is what makes the number of meshes to
   * fetch known before the first one is asked for, and the progress bar on the
   * detail page a fraction rather than a guess.
   *
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async build(onProgress) {
    await this.flatten();
    // MuJoCo 3's other way of composing models: `<asset><model file=…>` plus an
    // `<attach>` in the worldbody, which grafts one model's subtree into
    // another under a name prefix. The registry sidesteps it by pointing the
    // stage at the attached model directly; a file picked off a disk cannot be
    // redirected that way, so it is said out loud instead of drawn empty.
    if (this.root.querySelector('attach')) {
      this.warnings.push('<attach> is not supported: the attached model is not shown');
    }
    this.readCompiler();
    this.classes = readDefaults([...this.root.querySelectorAll('mujoco > default')]);
    this.readAssets();

    const robot = new URDFRobot();
    robot.robotName = this.modelName || 'mjcf';
    robot.name = robot.robotName;
    robot.urdfName = 'world';
    robot.links = { world: robot };
    robot.joints = {};
    robot.colliders = {};
    robot.visual = {};
    this.robot = robot;

    /** Names already taken, so an unnamed body or joint gets a fresh one. */
    this.taken = new Set(['world']);
    /** Link name → what `<inertial>` declared, for the CoM and inertia overlays. */
    this.inertials = new Map();
    /** Joint name → what the panel needs that the graph does not carry. */
    this.jointMeta = new Map();
    /** Joints in document order, with their MJCF type, so a keyframe's flat
     *  `qpos` vector can be read back into named joint values. */
    this.jointOrder = [];
    /** One entry per mesh file, however many geoms use it. */
    this.meshJobs = new Map();
    /** The same, for texture files and the materials that carry them. */
    this.textureJobs = new Map();
    this.mass = 0;
    this.geomCounts = { visual: 0, collision: 0 };
    const groups = this.geomGroups();
    this.visualGeomGroups = this.visualGeomGroupSet(groups);
    this.hiddenGeomGroups = this.hiddenGeomGroupSet(groups);

    for (const worldbody of this.root.querySelectorAll('mujoco > worldbody')) {
      for (const body of worldbody.children) {
        if (body.tagName === 'body') this.attachBody(body, robot, '');
      }
    }

    robot.frames = { ...robot.colliders, ...robot.visual, ...robot.links, ...robot.joints };
    await this.loadAssets(onProgress);
    return {
      robot,
      inertials: this.inertials,
      jointMeta: this.jointMeta,
      home: this.readKeyframe(),
      mass_kg: this.mass || null,
      links: Object.keys(robot.links).length,
      geoms: this.geomCounts,
      assets: [...this.assetPaths],
      warnings: this.warnings,
    };
  }

  /** A name nothing else has taken, from what the file offered. */
  unique(preferred, fallback) {
    let name = preferred || fallback;
    if (!this.taken.has(name)) {
      this.taken.add(name);
      return name;
    }
    for (let n = 2; ; n += 1) {
      const candidate = `${name}·${n}`;
      if (!this.taken.has(candidate)) {
        this.taken.add(candidate);
        return candidate;
      }
    }
  }

  /**
   * Hang one `<body>` off the link above it, then everything below it.
   *
   * The transform MuJoCo describes is
   *
   *     parent → T(pos)·R(quat) → Π over joints of [ T(p)·R(axis, θ)·T(-p) ]
   *
   * where `p` and `axis` are in the body's own frame. urdf-loader's joint node
   * gives `T(position)·R(axis, θ)` and nothing after it, so the trailing
   * `T(-p)` is carried by the link below — which is exactly right, because that
   * link's frame *is* the body frame, and it is where the geometry goes.
   *
   * The body's static transform folds into the first joint: a joint at
   * `pos + quat·p` with rotation `quat` composes to the same thing, and it
   * keeps one joint per link, which is what the panel's tree is built on.
   *
   * @param {Element} element
   * @param {URDFLink} parent
   * @param {string} inheritedClass the `childclass` in force here
   */
  attachBody(element, parent, inheritedClass) {
    const childClass = element.getAttribute('childclass') || inheritedClass;
    const bodyName = this.unique(element.getAttribute('name'), `body${this.taken.size}`);
    const staticPos = readPosition(element);
    const staticQuat = readRotation(element, this.compiler);

    const specs = this.readJoints(element, childClass, bodyName);
    let attach = parent;

    specs.forEach((spec, index) => {
      const joint = new URDFJoint();
      joint.urdfName = spec.name;
      joint.name = spec.name;
      joint.jointType = spec.jointType;
      joint.axis.copy(spec.axis);
      joint.limit = { lower: spec.lower, upper: spec.upper };
      if (index === 0) {
        joint.position.copy(spec.anchor).applyQuaternion(staticQuat).add(staticPos);
        joint.quaternion.copy(staticQuat);
      } else {
        joint.position.copy(spec.anchor);
      }
      attach.add(joint);
      this.robot.joints[spec.name] = joint;
      this.jointMeta.set(spec.name, spec.meta);
      if (spec.qpos) this.jointOrder.push(spec.qpos);

      // The last joint's link is the body; the ones before it are the frames
      // between a body's several joints, and they are named for that.
      const last = index === specs.length - 1;
      const link = new URDFLink();
      link.urdfName = last ? bodyName : this.unique(`${bodyName}·${specs[index + 1].name}`, bodyName);
      link.name = link.urdfName;
      link.position.copy(spec.anchor).negate();
      joint.add(link);
      this.robot.links[link.urdfName] = link;
      attach = link;
    });

    if (!specs.length) {
      // A welded body still gets a joint, so the tree reads as a chain and the
      // link below it sits where the description puts it.
      const joint = new URDFJoint();
      joint.urdfName = this.unique(`${bodyName}·fixed`, `${bodyName}·fixed`);
      joint.name = joint.urdfName;
      joint.jointType = 'fixed';
      joint.position.copy(staticPos);
      joint.quaternion.copy(staticQuat);
      parent.add(joint);
      this.robot.joints[joint.urdfName] = joint;
      const link = new URDFLink();
      link.urdfName = bodyName;
      link.name = bodyName;
      joint.add(link);
      this.robot.links[bodyName] = link;
      attach = link;
    }

    this.readInertial(element, attach.urdfName);
    for (const child of element.children) {
      if (child.tagName === 'geom') this.attachGeom(child, attach, childClass);
      else if (child.tagName === 'body') this.attachBody(child, attach, childClass);
    }
  }

  /**
   * A body's joints, in the order MuJoCo applies them.
   *
   * `<freejoint>` and `type="free"` come back as a single fixed joint: the
   * gallery pins every robot where its description puts it, exactly as a URDF
   * root link is pinned, and a base with nothing above it has no travel worth
   * a slider. A ball joint comes back as three hinges, since the panel drives
   * one number per joint and a quaternion is four.
   */
  readJoints(element, childClass, bodyName) {
    const specs = [];
    for (const node of element.children) {
      if (node.tagName === 'freejoint') {
        specs.push(this.jointSpec(node, childClass, bodyName, 'free'));
        continue;
      }
      if (node.tagName !== 'joint') continue;
      const attrs = withDefaults(node, 'joint', this.classes, childClass);
      const type = attrs.type || 'hinge';
      if (type === 'ball') {
        specs.push(...this.ballSpecs(node, attrs, bodyName));
        continue;
      }
      specs.push(this.jointSpec(node, childClass, bodyName, type, attrs));
    }
    return specs;
  }

  /** One hinge, slide or free joint, as the tree wants it. */
  jointSpec(node, childClass, bodyName, type, preset) {
    const attrs = preset || withDefaults(node, 'joint', this.classes, childClass);
    const axis = nums(attrs.axis);
    const anchor = nums(attrs.pos);
    const range = nums(attrs.range);
    const isAngle = type !== 'slide';
    const scale = isAngle ? this.compiler.toRadians : (v) => v;
    const limited =
      attrs.limited === 'auto' || attrs.limited === undefined || attrs.limited === null
        ? this.compiler.autolimits && range.length === 2 && (range[0] !== 0 || range[1] !== 0)
        : flag(attrs.limited);
    const lower = limited && range.length === 2 ? scale(range[0]) : 0;
    const upper = limited && range.length === 2 ? scale(range[1]) : 0;
    const name = this.unique(attrs.name, `${bodyName}·${type}`);
    return {
      name,
      // A free base is pinned, so it is a fixed joint here whatever MJCF calls it.
      jointType: type === 'free' ? 'fixed' : type === 'slide' ? 'prismatic' : 'revolute',
      axis: axis.length === 3 ? new THREE.Vector3(...axis) : new THREE.Vector3(0, 0, 1),
      anchor: anchor.length === 3 ? new THREE.Vector3(...anchor) : new THREE.Vector3(),
      lower,
      upper,
      qpos: { name, type, width: QPOS_WIDTH[type] ?? 1, angle: isAngle },
      meta: {
        type: type === 'free' ? 'free' : type === 'slide' ? 'prismatic' : 'revolute',
        // Null rather than zero where the description declares no travel:
        // that is what tells the panel to offer a working range instead of
        // freezing the joint, and the viewer to lift the loader's clamp.
        lower: limited ? lower : null,
        upper: limited ? upper : null,
        // MJCF states a joint's ceilings on its actuator, not on the joint, and
        // the two do not map onto each other cleanly enough to quote.
        effort: null,
        velocity: null,
        mimic: null,
      },
    };
  }

  /**
   * A ball joint as three hinges about the body's own axes.
   *
   * MuJoCo stores the orientation as a quaternion with a single limit on the
   * total angle, so this is a different parameterisation of the same freedom
   * rather than a translation of the numbers: each hinge is given the ball's
   * limit, and a pose written here is one of several that reach it.
   */
  ballSpecs(node, attrs, bodyName) {
    const base = attrs.name || `${bodyName}·ball`;
    const range = nums(attrs.range);
    const limited = range.length === 2 && (range[0] !== 0 || range[1] !== 0);
    // MuJoCo's ball range is the angle away from the reference orientation, so
    // the second number bounds it in both directions.
    const span = limited ? this.compiler.toRadians(Math.max(Math.abs(range[0]), Math.abs(range[1]))) : 0;
    const anchor = nums(attrs.pos);
    const at = anchor.length === 3 ? new THREE.Vector3(...anchor) : new THREE.Vector3();
    return ['x', 'y', 'z'].map((letter, index) => {
      const name = this.unique(`${base}·${letter}`, `${base}·${letter}`);
      return {
        name,
        jointType: 'revolute',
        axis: new THREE.Vector3(+(index === 0), +(index === 1), +(index === 2)),
        // Only the first of the three carries the anchor; the other two turn
        // about the same point, which the frames between them already are.
        anchor: index === 0 ? at : new THREE.Vector3(),
        lower: -span,
        upper: span,
        qpos: index === 0 ? { name: base, type: 'ball', width: 4, angle: true, ball: true } : null,
        meta: {
          type: 'revolute',
          lower: limited ? -span : null,
          upper: limited ? span : null,
          effort: null,
          velocity: null,
          mimic: null,
        },
      };
    });
  }

  /** `<inertial>`, for the mass total and the CoM and inertia overlays. */
  readInertial(element, linkName) {
    const node = [...element.children].find((child) => child.tagName === 'inertial');
    if (!node) return;
    const mass = num(node.getAttribute('mass'), 0);
    this.mass += mass;
    const pos = readPosition(node);
    const diag = nums(node.getAttribute('diaginertia'));
    const full = nums(node.getAttribute('fullinertia'));
    // `fullinertia` writes the six independent components as ixx iyy izz ixy
    // ixz iyz; only the diagonal reaches the equivalent-box reading.
    const principal = diag.length === 3 ? diag : full.length === 6 ? full.slice(0, 3) : null;
    this.inertials.set(linkName, {
      mass,
      origin: [pos.x, pos.y, pos.z],
      box: principal ? inertiaBox(mass, principal) : null,
    });
  }

  // -------------------------------------------------------------------- geoms

  /**
   * The effective geom groups used by robot bodies, with the clues that say
   * which one is meant to be looked at. Group numbers are not semantic: most
   * Menagerie models use 2 for meshes and 3 for contact hulls, while
   * MS-Human-700 uses 0 for bone meshes, 1 for capsule contact shapes, and 3
   * for tendon wrapping cylinders that MuJoCo itself hides by default.
   *
   * Includes are already flattened and defaults are already resolved here.
   * `childclass` still has to be carried down the body tree, exactly as it is
   * when the same geom is attached below.
   */
  geomGroups() {
    const groups = new Map();
    const walk = (body, inheritedClass) => {
      const childClass = body.getAttribute('childclass') || inheritedClass;
      for (const node of body.children) {
        if (node.tagName === 'body') {
          walk(node, childClass);
          continue;
        }
        if (node.tagName !== 'geom') continue;
        const attrs = withDefaults(node, 'geom', this.classes, childClass);
        const type = attrs.type || (attrs.mesh ? 'mesh' : 'sphere');
        if (SKIPPED_GEOMS.has(type)) continue;
        const group = num(attrs.group, 0);
        const facts = groups.get(group) || { group, geoms: 0, meshes: 0, nonContact: 0 };
        facts.geoms += 1;
        if (type === 'mesh') facts.meshes += 1;
        if (num(attrs.contype, 1) === 0 && num(attrs.conaffinity, 1) === 0) {
          facts.nonContact += 1;
        }
        groups.set(group, facts);
      }
    };
    for (const worldbody of this.root.querySelectorAll('mujoco > worldbody')) {
      for (const body of worldbody.children) {
        if (body.tagName === 'body') walk(body, '');
      }
    }
    return groups;
  }

  /**
   * Pick one group for the normal render. Mesh count is the strongest clue;
   * contact-disabled geoms are next. Group 2 only breaks a remaining tie so
   * the conventional 2/3 spelling stays conventional without being assumed.
   * A one-group model simply uses the group it has.
   */
  primaryVisualGeomGroup(groups = this.geomGroups()) {
    const ranked = [...groups.values()].sort(
      (a, b) =>
        b.meshes - a.meshes ||
        b.nonContact - a.nonContact ||
        Number(b.group === 2) - Number(a.group === 2) ||
        b.geoms - a.geoms ||
        a.group - b.group,
    );
    return ranked[0]?.group ?? 0;
  }

  /**
   * Every geom group that belongs in the normal render.
   *
   * A single primary group covers the common "complete visual mesh plus a
   * complete collision mesh" convention. Some models legitimately split the
   * visible robot across groups, though: xArm7 keeps the base and knuckles in
   * group 0 and marks only its finger meshes as the non-contact visual group
   * 2. Those extra groups have to carry meshes — a group of only non-contact
   * primitives is a wrapping surface, not a second drawing of the robot, and
   * folding it in is what put MS-Human-700's blue wrapping cylinders on the
   * visual stage.
   */
  visualGeomGroupSet(groups = this.geomGroups()) {
    const visual = new Set([this.primaryVisualGeomGroup(groups)]);
    for (const facts of groups.values()) {
      if (facts.meshes > 0 && facts.nonContact === facts.geoms) visual.add(facts.group);
    }
    return visual;
  }

  /**
   * Geom groups that are neither a render nor a contact hull.
   *
   * MuJoCo's default vis flags hide groups 3–5; authors put tendon wrapping
   * cylinders and similar helpers there, with contact disabled and no mesh.
   * Dropping them (rather than dumping them into the collision overlay) keeps
   * both views of a model like MS-Human-700 as the bone mesh and the skin
   * capsules, instead of a pile of wrapping geometry through the torso.
   */
  hiddenGeomGroupSet(groups = this.geomGroups()) {
    const visual = this.visualGeomGroupSet(groups);
    const hidden = new Set();
    for (const facts of groups.values()) {
      if (visual.has(facts.group)) continue;
      if (facts.geoms > 0 && facts.meshes === 0 && facts.nonContact === facts.geoms) {
        hidden.add(facts.group);
      }
    }
    return hidden;
  }

  /**
   * One `<geom>`, wrapped the way the overlay toggles expect: a `URDFVisual`
   * for one of the model's render groups, a `URDFCollider` for every other
   * group that is actually a contact hull. Helper groups (see
   * `hiddenGeomGroupSet`) are dropped. Keeping the two views separate prevents
   * alternative render/contact representations from being baked together in
   * cards and snapshots.
   */
  attachGeom(element, link, childClass) {
    const attrs = withDefaults(element, 'geom', this.classes, childClass);
    const type = attrs.type || (attrs.mesh ? 'mesh' : 'sphere');
    if (SKIPPED_GEOMS.has(type)) return;

    const group = num(attrs.group, 0);
    if (this.hiddenGeomGroups.has(group)) return;
    const isCollision = !this.visualGeomGroups.has(group);
    const wrapper = isCollision ? new URDFCollider() : new URDFVisual();
    const name = attrs.name || `${link.urdfName}·${type}`;
    wrapper.urdfName = name;
    wrapper.name = name;

    const placed = this.placeGeom(wrapper, element, attrs, type);
    if (!placed) return;
    link.add(wrapper);
    (isCollision ? this.robot.colliders : this.robot.visual)[name] = wrapper;
    this.geomCounts[isCollision ? 'collision' : 'visual'] += 1;
  }

  /**
   * Fill a geom wrapper with the shape MJCF describes, and put it where the
   * description says.
   *
   * MuJoCo's `size` is half-extents for a box and a radius plus a half-length
   * for the round shapes, along the geom's own +Z; three.js builds a cylinder
   * or a capsule along +Y, which is where the quarter turn below comes from.
   * `fromto` is the other spelling of the same thing — two endpoints instead of
   * a length and a frame — and it overrides `pos` and the rotation entirely.
   *
   * @returns {boolean} whether anything was added
   */
  placeGeom(wrapper, element, attrs, type) {
    const size = nums(attrs.size);
    const fromto = nums(attrs.fromto);
    const material = this.materialFor(attrs);

    wrapper.position.copy(readPosition(element));
    wrapper.quaternion.copy(readRotation(element, this.compiler));

    if (fromto.length === 6) {
      const a = new THREE.Vector3(fromto[0], fromto[1], fromto[2]);
      const b = new THREE.Vector3(fromto[3], fromto[4], fromto[5]);
      const along = new THREE.Vector3().subVectors(b, a);
      const length = along.length();
      if (!length) return false;
      wrapper.position.copy(a).addScaledVector(along, 0.5);
      wrapper.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        along.divideScalar(length),
      );
      const radius = size.length ? size[0] : 0;
      if (!radius) return false;
      const half = length / 2;
      if (type === 'box') return this.addPrimitive(wrapper, new THREE.BoxGeometry(radius * 2, radius * 2, length), material);
      if (type === 'capsule') return this.addRoundZ(wrapper, new THREE.CapsuleGeometry(radius, length, 8, 20), material);
      if (type === 'ellipsoid') return this.addEllipsoid(wrapper, [radius, radius, half], material);
      return this.addRoundZ(wrapper, new THREE.CylinderGeometry(radius, radius, length, 24), material);
    }

    switch (type) {
      case 'box': {
        const [x, y, z] = size.length >= 3 ? size : [size[0], size[0], size[0]];
        if (!(x > 0 && y > 0 && z > 0)) return false;
        return this.addPrimitive(wrapper, new THREE.BoxGeometry(x * 2, y * 2, z * 2), material);
      }
      case 'sphere': {
        const radius = size[0];
        if (!(radius > 0)) return false;
        return this.addPrimitive(wrapper, new THREE.SphereGeometry(radius, 24, 16), material);
      }
      case 'ellipsoid': {
        if (size.length < 3 || !size.every((v) => v > 0)) return false;
        return this.addEllipsoid(wrapper, size, material);
      }
      case 'capsule': {
        const [radius, half] = size;
        if (!(radius > 0 && half > 0)) return false;
        return this.addRoundZ(wrapper, new THREE.CapsuleGeometry(radius, half * 2, 8, 20), material);
      }
      case 'cylinder': {
        const [radius, half] = size;
        if (!(radius > 0 && half > 0)) return false;
        return this.addRoundZ(wrapper, new THREE.CylinderGeometry(radius, radius, half * 2, 24), material);
      }
      case 'mesh':
        return this.addMesh(wrapper, attrs.mesh, material);
      default:
        this.warnings.push(`geom type not supported: ${type}`);
        return false;
    }
  }

  addPrimitive(wrapper, geometry, material) {
    wrapper.add(new THREE.Mesh(geometry, material));
    return true;
  }

  /** A shape three.js builds along +Y, stood up along MJCF's +Z. */
  addRoundZ(wrapper, geometry, material) {
    geometry.rotateX(Math.PI / 2);
    wrapper.add(new THREE.Mesh(geometry, material));
    return true;
  }

  /** MuJoCo's three semi-axes, as a unit sphere scaled — which is what an
   *  ellipsoid is, and cheaper than tessellating one. */
  addEllipsoid(wrapper, [x, y, z], material) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material);
    mesh.scale.set(x, y, z);
    wrapper.add(mesh);
    return true;
  }

  /**
   * A geom that draws a mesh asset. The file is not fetched here: it is
   * recorded against the wrapper that wants it, so one file loads once however
   * many geoms name it and the count is known before the first request.
   */
  addMesh(wrapper, meshName, material) {
    const asset = meshName ? this.meshes.get(meshName) : null;
    if (!asset) {
      if (meshName) this.warnings.push(`geom names an unknown mesh: ${meshName}`);
      return false;
    }
    const extension = extensionOf(asset.candidates[0]);
    if (!MESH_FORMATS.has(extension)) {
      this.warnings.push(`mesh format not supported: ${asset.candidates[0]}`);
      return false;
    }
    // Not counted and not warned about: the build step already knows this file
    // is out of the CDN's reach and said so in the registry, so the geom is a
    // hole in the robot rather than a load that failed.
    if (asset.candidates.every((path) => this.skip.has(path))) return false;
    let job = this.meshJobs.get(asset.name);
    if (!job) {
      job = { kind: 'mesh', ...asset, extension, users: [] };
      this.meshJobs.set(asset.name, job);
    }
    job.users.push({ wrapper, asset, material });
    return true;
  }

  /**
   * The material one geom is painted with: what `<material>` declares, over
   * what the geom's own `rgba` says, over MuJoCo's grey.
   *
   * The channels are handed to three.js as sRGB, which is what every tool that
   * reads an MJCF treats them as — the same correction the URDF path makes on
   * the way in, for the same reason.
   */
  materialFor(attrs) {
    const named = attrs.material ? this.materials.get(attrs.material) : null;
    const own = nums(attrs.rgba);
    const rgba = own.length >= 3 ? own : named?.rgba || DEFAULT_RGBA;
    const material = new THREE.MeshStandardMaterial({
      metalness: named?.metallic ?? 0.25,
      roughness: named?.roughness ?? 0.55,
    });
    material.color.setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace);
    const alpha = rgba[3] ?? 1;
    if (alpha < 1) {
      material.transparent = true;
      material.opacity = alpha;
    }
    const texture = named?.texture ? this.textures.get(named.texture) : null;
    if (texture) {
      // Recorded rather than fetched, so a texture file goes through the same
      // resolution and counting as a mesh does; `loadAssets` hangs it on this
      // material once it arrives.
      let job = this.textureJobs.get(texture.name);
      if (!job) {
        job = { kind: 'texture', ...texture, users: [] };
        this.textureJobs.set(texture.name, job);
      }
      job.users.push({ material });
      // A texture is the colour; tinting it by the material's own rgba would
      // darken every model that states both.
      if (!(own.length >= 3)) material.color.setRGB(1, 1, 1);
    }
    return material;
  }

  // ------------------------------------------------------------------ meshes

  /**
   * Fetch every file the bodies asked for, and hand each one to whatever named
   * it — a mesh to its geoms, a texture to its materials. A mesh used by twelve
   * fingers is downloaded once: the first geom gets the object and the rest get
   * clones sharing its geometry.
   *
   * A file that cannot be read is a hole in the robot rather than a failed
   * load, the same way the URDF path treats an unreachable mesh, since a
   * partial model is more use than an error page.
   *
   * Files are grouped by which pair of directories their two candidate paths
   * came from (see `assetCandidates`) and each group's first file settles which
   * of the two the rest of the group uses, so a document that resolves the
   * unusual way pays for one wrong guess rather than two hundred.
   */
  async loadAssets(onProgress) {
    const jobs = [...this.meshJobs.values(), ...this.textureJobs.values()];
    const total = jobs.length;
    let done = 0;
    onProgress?.(0, total);

    const loaders = {
      '.stl': new STLLoader(this.manager),
      '.obj': new OBJLoader(this.manager),
      texture: new THREE.TextureLoader(this.manager),
    };

    /** One file, through whichever of its candidate paths answers. */
    const fetchOne = async (job, only) => {
      const candidates = only ? [only] : job.candidates;
      let last = null;
      for (const path of candidates) {
        try {
          const url = this.resolve(path);
          let value;
          if (job.kind === 'texture') value = await loaders.texture.loadAsync(url);
          else if (loaders[job.extension]) value = await loaders[job.extension].loadAsync(url);
          else {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            value = parseMSH(await response.arrayBuffer());
          }
          this.assetPaths.add(path);
          return { value, path };
        } catch (err) {
          last = err;
        }
      }
      this.warnings.push(
        `${job.kind} failed: ${job.candidates.join(' / ')} (${last?.message || last})`,
      );
      return { value: null, path: null };
    };

    const groups = new Map();
    for (const job of jobs) {
      if (!groups.has(job.group)) groups.set(job.group, []);
      groups.get(job.group).push(job);
    }

    const finish = (job, value) => {
      done += 1;
      onProgress?.(done, total);
      if (value) this.applyAsset(job, value);
    };

    await Promise.all(
      [...groups.values()].map(async ([first, ...rest]) => {
        const settled = await fetchOne(first);
        finish(first, settled.value);
        await Promise.all(
          rest.map(async (job) => {
            // The path that worked names a directory, not a file, so what is
            // reused across the group is which candidate index answered.
            const index = settled.path ? first.candidates.indexOf(settled.path) : -1;
            const only = index > 0 && job.candidates.length > index ? job.candidates[index] : null;
            finish(job, (await fetchOne(job, only)).value);
          }),
        );
      }),
    );
  }

  /** Hand one loaded file to everything that asked for it. */
  applyAsset(job, value) {
    if (job.kind === 'texture') {
      value.colorSpace = THREE.SRGBColorSpace;
      value.wrapS = THREE.RepeatWrapping;
      value.wrapT = THREE.RepeatWrapping;
      for (const { material } of job.users) {
        material.map = value;
        material.needsUpdate = true;
      }
      return;
    }
    job.users.forEach((user, index) => {
      const node = this.instantiate(value, index, user.material);
      if (!node) return;
      const [sx, sy, sz] = user.asset.scale;
      node.scale.set(sx, sy, sz);
      if (user.asset.refquat) {
        const [w, x, y, z] = user.asset.refquat;
        node.quaternion.copy(new THREE.Quaternion(x, y, z, w).invert());
      }
      if (user.asset.refpos) {
        const inner = new THREE.Object3D();
        inner.position.set(-user.asset.refpos[0], -user.asset.refpos[1], -user.asset.refpos[2]);
        inner.add(...node.children);
        node.add(inner);
      }
      user.wrapper.add(node);
    });
  }

  /**
   * One geom's copy of a loaded mesh file. STL and `.msh` arrive as geometry
   * and are given the geom's material; an OBJ arrives as a scene of its own,
   * whose materials MuJoCo ignores in favour of the geom's — so they are
   * replaced rather than kept.
   */
  instantiate(source, index, material) {
    if (source.isBufferGeometry) {
      const holder = new THREE.Object3D();
      holder.add(new THREE.Mesh(source, material));
      return holder;
    }
    if (source.isObject3D) {
      const copy = index === 0 ? source : source.clone();
      copy.traverse((child) => {
        if (child.isMesh) child.material = material;
      });
      return copy;
    }
    return null;
  }

  // --------------------------------------------------------------- keyframes

  /**
   * The pose a description nominates for itself.
   *
   * Nearly every Menagerie model carries a `<key name="home">` — the stance it
   * is meant to be seen in, which for a quadruped is the difference between a
   * dog and a table. `qpos` is one flat vector over the joints in the order
   * they were declared, so it is read back by walking the same order and
   * taking as many numbers as each joint's type is worth.
   *
   * A free base takes seven of them and a ball joint four; neither is a slider
   * here, so both are stepped over rather than translated.
   *
   * @returns {?Record<string, number>} joint name → value
   */
  readKeyframe() {
    const keys = [...this.root.querySelectorAll('keyframe > key')];
    if (!keys.length) return null;
    const key = keys.find((k) => (k.getAttribute('name') || '') === 'home') || keys[0];
    const qpos = nums(key.getAttribute('qpos'));
    if (!qpos.length) return null;
    const pose = {};
    let at = 0;
    for (const joint of this.jointOrder) {
      if (at + joint.width > qpos.length) break;
      if (joint.width === 1) pose[joint.name] = qpos[at];
      at += joint.width;
    }
    return Object.keys(pose).length ? pose : null;
  }
}

/**
 * Read an MJCF document into a robot the viewer can drive.
 *
 * @param {object} options see `MJCFDocument`
 * @param {(done: number, total: number) => void} [options.onProgress]
 */
export async function loadMJCF(options) {
  const document = new MJCFDocument(options);
  return document.build(options.onProgress);
}

/** How many sliders one MJCF joint is worth on the panel: a hinge or a slide is
 *  one, a ball joint is re-parameterised as three hinges, and a free base is
 *  pinned and gets none. Kept in step with `readJoints`. */
const JOINT_DOF = { hinge: 1, slide: 1, ball: 3, free: 0 };

/**
 * What an MJCF document is made of, without building any geometry: the files it
 * is spread across, the assets it names as the candidate paths MuJoCo would
 * look at, and the counts a spec table wants.
 *
 * Two callers, one for each half. A download needs the file list — a Menagerie
 * model is rarely one file, and a zip of the scene alone would be four lines of
 * XML pointing at a repository — and js/custom.js needs the counts before it
 * has a stage to read them off, so that the picker can say what it found.
 *
 * @param {object} options `text`, `path` and `readXml`, as `MJCFDocument` takes
 */
export async function inspectMJCF(options) {
  const document = new MJCFDocument({ ...options, resolve: (path) => path });
  await document.flatten();
  document.readCompiler();
  document.classes = readDefaults([...document.root.querySelectorAll('mujoco > default')]);
  document.readAssets();

  const joints = {};
  for (const body of document.root.querySelectorAll('worldbody body')) {
    for (const node of body.children) {
      if (node.tagName === 'freejoint') joints.free = (joints.free || 0) + 1;
      else if (node.tagName === 'joint') {
        const type = withDefaults(node, 'joint', document.classes, '').type || 'hinge';
        joints[type] = (joints[type] || 0) + 1;
      }
    }
  }
  let mass = 0;
  for (const node of document.root.querySelectorAll('inertial')) {
    mass += num(node.getAttribute('mass'), 0);
  }
  const geomGroups = document.geomGroups();
  const visualGeomGroups = document.visualGeomGroupSet(geomGroups);
  const hiddenGeomGroups = document.hiddenGeomGroupSet(geomGroups);

  return {
    name: document.modelName,
    // MuJoCo counts the world as body 0, and so does this: it is the frame the
    // description hangs off, exactly as a URDF's root link is.
    links: document.root.querySelectorAll('worldbody body').length + 1,
    joints,
    moving_joints: Object.entries(joints).reduce(
      (sum, [type, n]) => sum + n * (JOINT_DOF[type] ?? 1),
      0,
    ),
    mass_kg: mass ? +mass.toFixed(3) : null,
    has_collision: [...geomGroups.keys()].some(
      (group) => !visualGeomGroups.has(group) && !hiddenGeomGroups.has(group),
    ),
    has_inertia: document.root.querySelector('inertial') !== null,
    xml: [normalize(document.path), ...document.included],
    assets: [...document.meshes.values(), ...document.textures.values()].map(
      (asset) => asset.candidates,
    ),
    warnings: document.warnings,
  };
}
