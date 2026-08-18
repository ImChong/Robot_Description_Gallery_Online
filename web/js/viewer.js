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
import URDFLoader from 'urdf-loader';

const UP_Z = -Math.PI / 2; // URDF is Z-up, three.js is Y-up.

/**
 * Joints that take more than one value. urdf-loader expects every component to
 * be passed at once — `setJointValue(name, 0)` on a floating joint leaves five
 * arguments undefined and turns the entire subtree's transform into NaN — and
 * they describe a free-floating base rather than something to actuate, so the
 * viewer sets them to zero once and keeps them out of the joint sliders.
 */
const MULTI_DOF = { floating: 6, planar: 3 };

export const THEME = {
  background: 0x0e1116,
  grid: 0x2a3340,
  gridAccent: 0x3d4a5c,
  visual: 0xb9c2cf,
  collision: 0x4ac3ff,
  com: 0xffc857,
  inertia: 0xff6b9d,
  axis: 0x7ee787,
};

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

/** True only if the object and every ancestor up to the root is visible. */
function effectivelyVisible(object, root) {
  for (let node = object; node && node !== root.parent; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

/**
 * Bounding box of what is actually on screen. Ancestor visibility matters:
 * collision geometry is hidden by switching off its URDFCollider parent, and
 * counting it here would both mis-measure the robot and hide the case where the
 * visual meshes failed to load.
 */
function boundingBox(root) {
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

export class RobotViewer {
  /**
   * @param {HTMLElement} container
   * @param {{shadows?: boolean, grid?: boolean, antialias?: boolean, alpha?: boolean}} options
   */
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      shadows: true,
      grid: true,
      antialias: true,
      alpha: false,
      loadTimeout: 120000,
      ...options,
    };
    this.robot = null;
    this.overlays = { collision: false, visual: true, frames: false, axes: false, com: false, inertia: false };
    this._helpers = { frames: [], axes: [], com: [], inertia: [] };
    this._disposables = [];
    this._raf = null;
    this._needsRender = true;

    this.scene = new THREE.Scene();
    if (!this.options.alpha) this.scene.background = new THREE.Color(THEME.background);

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
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener('change', () => this.invalidate());

    this._buildEnvironment();
    this._observeResize();
    this._loop();
  }

  _buildEnvironment() {
    const hemi = new THREE.HemisphereLight(0xd7e3f4, 0x1b1f27, 1.15);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(2.4, 4.2, 2.8);
    key.castShadow = this.options.shadows;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    const d = 3;
    Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 0.1, far: 20 });
    this.scene.add(key);
    this.keyLight = key;

    const fill = new THREE.DirectionalLight(0x9fb6d4, 0.8);
    fill.position.set(-2.5, 1.6, -2.0);
    this.scene.add(fill);

    // Rim light from behind: several of these robots are matte black (H1, Atlas)
    // and would otherwise read as a flat silhouette on a dark stage.
    const rim = new THREE.DirectionalLight(0xdce8ff, 1.6);
    rim.position.set(-1.8, 2.4, -3.4);
    this.scene.add(rim);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.ShadowMaterial({ opacity: 0.32 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    // ShadowMaterial only darkens where a shadow lands, so with the shadow map
    // off the plane would tint the whole frame instead of disappearing.
    this.ground.visible = this.options.shadows;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(20, 40, THEME.gridAccent, THEME.grid);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.42;
    this.grid.visible = this.options.grid;
    this.scene.add(this.grid);

    this.world = new THREE.Group(); // holds the robot, rotated into Y-up
    this.world.rotation.x = UP_Z;
    this.scene.add(this.world);
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
    if (this._gridStep === step && this._gridSize === size) {
      this.grid.position.set(center.x, floorY, center.z);
      return;
    }
    this._gridStep = step;
    this._gridSize = size;
    this.grid.removeFromParent();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.grid = new THREE.GridHelper(size, divisions, THEME.gridAccent, THEME.grid);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.4;
    this.grid.visible = this.options.grid;
    this.grid.position.set(center.x, floorY, center.z);
    this.scene.add(this.grid);
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
    }
  }

  /**
   * Load a robot described by a registry entry.
   * @param {object} entry registry entry (see data/robots.json)
   * @param {(loaded: number, total: number) => void} [onProgress]
   */
  async load(entry, onProgress) {
    this.clear();
    const base = entry.assets.base;
    const loader = new URDFLoader(new THREE.LoadingManager());
    loader.parseCollision = true;
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

    // urdf-loader handles STL and DAE; OBJ needs to be plugged in.
    const objLoader = new OBJLoader();
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
    const check = () => {
      if (parsed && done >= total) markSettled();
    };
    const tick = () => onProgress && onProgress(done, total);

    loader.loadMeshCb = (path, manager, onComplete) => {
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
      if (path.toLowerCase().endsWith('.obj')) {
        objLoader.load(path, (obj) => finish(obj), undefined, (err) => finish(null, err));
      } else {
        defaultLoad(path, manager, (obj, err) => finish(obj, err));
      }
    };

    const url = base + entry.assets.urdf;
    const text = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`URDF ${r.status} ${url}`);
      return r.text();
    });

    const robot = loader.parse(urdfColorsToLinear(text));
    parsed = true;
    this.robot = robot;
    this.world.add(robot);
    this.entry = entry;
    // Primitive geometry (<box>, <cylinder>, <sphere>) exists immediately;
    // mesh files arrive over the network, so styling runs again after they land.
    this._styleAll();
    this._applyOverlays();
    check(); // a URDF made only of primitives has nothing to wait for

    // A single unreachable mesh should degrade to a partial robot, not a page
    // that never finishes loading.
    await Promise.race([settled, new Promise((r) => setTimeout(r, this.options.loadTimeout))]);
    this.loadedMeshes = { done, total };
    this._styleAll();
    this._applyOverlays();
    this.stats = { ...this.meshStats(), stripped };
    this.frameCamera();
    return robot;
  }

  /** Apply the studio look to every mesh that has not been styled yet. */
  _styleAll() {
    this.robot?.traverse((child) => {
      if (!child.isMesh || child.userData.styled) return;
      child.userData.styled = true;
      child.castShadow = true;
      child.receiveShadow = true;
      this._styleMesh(child, this._isCollision(child));
    });
  }

  /** Collision geometry can sit several groups below its URDFCollider. */
  _isCollision(object) {
    for (let node = object; node && node !== this.robot?.parent; node = node.parent) {
      if (node.type === 'URDFCollider') return true;
    }
    return false;
  }

  /** Count the meshes that arrived, split by visual vs collision geometry. */
  meshStats() {
    const stats = { visual: 0, collision: 0, textured: 0 };
    this.robot?.traverse((child) => {
      if (!child.isMesh) return;
      stats[this._isCollision(child) ? 'collision' : 'visual'] += 1;
      const material = Array.isArray(child.material) ? child.material[0] : child.material;
      if (material?.map) stats.textured += 1;
    });
    return stats;
  }


  _styleMesh(mesh, isCollision) {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (isCollision) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.material = new THREE.MeshBasicMaterial({
        color: THEME.collision,
        wireframe: true,
        transparent: true,
        opacity: 0.55,
      });
      this._disposables.push(mesh.material);
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
        color: THEME.visual,
        metalness: 0.25,
        roughness: 0.55,
      });
      this._disposables.push(mesh.material);
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
  }

  /**
   * Frame the robot: place the camera on an orbit around the visible geometry,
   * then fit and centre it against the actual frustum.
   *
   * @param {number} azimuth orbit angle around the vertical axis, radians
   * @param {number} elevation angle above the horizon, radians
   * @param {number} padding 1 = geometry exactly touches the frame edges
   */
  frameCamera(azimuth = Math.PI * 0.22, elevation = 0.28, padding = 1.16) {
    if (!this.robot) return;
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
    this.measured = {
      size: { x: +size.x.toFixed(4), y: +size.y.toFixed(4), z: +size.z.toFixed(4) },
      height_m: +size.y.toFixed(4),
    };
    this.invalidate();
    return this.measured;
  }

  /**
   * Where the robot lands on screen, in CSS pixels relative to the canvas.
   * The thumbnail renderer crops to this so a tall humanoid and a wide
   * quadruped both fill their card instead of floating in dead space.
   */
  screenBounds(margin = 0.03) {
    if (!this.robot) return null;
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
    if (!this.robot) return;
    const { visual, collision } = this.overlays;
    this.robot.traverse((child) => {
      if (child.type === 'URDFVisual') child.visible = visual;
      if (child.type === 'URDFCollider') child.visible = collision;
    });
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
    if (!this.robot) return;
    const scale = this._helperScale();

    if (this.overlays.frames) {
      for (const link of Object.values(this.robot.links)) {
        const axes = new THREE.AxesHelper(scale);
        axes.material.depthTest = false;
        axes.renderOrder = 10;
        link.add(axes);
        this._helpers.frames.push(axes);
      }
    }

    if (this.overlays.axes) {
      for (const joint of Object.values(this.robot.joints)) {
        if (joint.jointType === 'fixed') continue;
        const dir = joint.axis.clone().normalize();
        const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), scale * 2.2, THEME.axis, scale * 0.5, scale * 0.28);
        arrow.line.material.depthTest = false;
        arrow.cone.material.depthTest = false;
        arrow.renderOrder = 11;
        joint.add(arrow);
        this._helpers.axes.push(arrow);
      }
    }

    if (this.overlays.com || this.overlays.inertia) {
      for (const link of Object.values(this.robot.links)) {
        const inertial = this._inertialOf(link.name);
        if (!inertial) continue;
        if (this.overlays.com) {
          const radius = Math.max(scale * 0.22 * Math.cbrt(Math.max(inertial.mass, 1e-3)), scale * 0.12);
          const dot = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 16, 12),
            new THREE.MeshBasicMaterial({ color: THEME.com, depthTest: false }),
          );
          dot.position.fromArray(inertial.origin);
          dot.renderOrder = 12;
          link.add(dot);
          this._helpers.com.push(dot);
        }
        if (this.overlays.inertia && inertial.box) {
          const box = new THREE.Mesh(
            new THREE.BoxGeometry(...inertial.box),
            new THREE.MeshBasicMaterial({ color: THEME.inertia, wireframe: true, transparent: true, opacity: 0.7, depthTest: false }),
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
   *   mimic: ?object}>}
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
        };
      });
  }

  setJoint(name, value) {
    const joint = this.robot?.joints[name];
    if (!joint || joint.jointType in MULTI_DOF || !Number.isFinite(value)) return;
    this.robot.setJointValue(name, value);
    this.invalidate();
  }

  /**
   * Put every joint at its neutral position: zero when the limits allow it,
   * otherwise the middle of the range, so a joint whose range excludes zero does
   * not sit against a hard stop.
   */
  resetJoints() {
    if (!this.robot) return;
    for (const joint of Object.values(this.robot.joints)) {
      const arity = MULTI_DOF[joint.jointType];
      if (arity) {
        this.robot.setJointValue(joint.name, ...new Array(arity).fill(0));
        continue;
      }
      if (joint.jointType === 'fixed') continue;
      const lower = Number.isFinite(joint.limit?.lower) ? joint.limit.lower : null;
      const upper = Number.isFinite(joint.limit?.upper) ? joint.limit.upper : null;
      let rest = 0;
      if (joint.jointType !== 'continuous' && lower !== null && upper !== null) {
        rest = lower <= 0 && upper >= 0 ? 0 : (lower + upper) / 2;
      }
      this.robot.setJointValue(joint.name, rest);
    }
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
      this.setJoint(name, value);
    }
    this.invalidate();
  }

  /** Pose used for still frames: the entry's curated pose, or the zero pose. */
  poseForPortrait(pose) {
    this.resetJoints();
    this.applyPose(pose);
  }

  snapshot(mime = 'image/png') {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL(mime);
  }

  clear() {
    this._clearHelpers();
    if (this.robot) {
      this.robot.removeFromParent();
      this.robot.traverse((child) => {
        child.geometry?.dispose?.();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of materials) {
          m?.map?.dispose?.();
          m?.dispose?.();
        }
      });
      this.robot = null;
    }
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
    this._inertials = undefined;
    this._jointMeta = undefined;
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
