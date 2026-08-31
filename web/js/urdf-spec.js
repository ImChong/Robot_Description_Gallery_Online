/**
 * A URDF read as numbers rather than as geometry.
 *
 * The viewer loads a description for its meshes; this reads the same file for
 * everything the meshes cannot say — the limits declared on each joint, the
 * masses declared on each link, and where the joints sit relative to one
 * another when nothing has been moved. Nothing here fetches a mesh, so a robot
 * costs one request of a few tens of kilobytes instead of the twenty megabytes
 * its STLs weigh: putting six machines side by side is a page load, not a
 * download.
 *
 * Everything is read straight out of the XML with no defaulting and no
 * repairing: a `<limit>` upstream never wrote stays null here, and the compare
 * page says so rather than showing a zero that would read as a real number.
 */

/** Joint types that describe a free-floating base rather than an actuator. */
const MULTI_DOF = { floating: 6, planar: 3 };

/* ── small matrix helpers ─────────────────────────────────────────────────
   Three-by-three, row-major, and only what the walk below needs: a URDF's
   `<origin rpy>` is fixed-axis roll-pitch-yaw, so R = Rz(yaw)·Ry(pitch)·Rx(roll). */

function rotation([roll, pitch, yaw]) {
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr,
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr,
    -sp, cp * sr, cp * cr,
  ];
}

function multiply(a, b) {
  const out = new Array(9);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[row * 3 + col] =
        a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return out;
}

function apply(r, [x, y, z]) {
  return [
    r[0] * x + r[1] * y + r[2] * z,
    r[3] * x + r[4] * y + r[5] * z,
    r[6] * x + r[7] * y + r[8] * z,
  ];
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/* ── XML reading ─────────────────────────────────────────────────────────── */

/** An attribute as a number, or null — an absent limit is not a limit of zero. */
function num(node, attr) {
  const raw = node?.getAttribute(attr);
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function triple(node, attr, fallback) {
  const raw = node?.getAttribute(attr);
  if (!raw) return fallback;
  const parts = raw.trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : fallback;
}

/**
 * The XML as links, joints and a kinematic tree.
 *
 * @param {string} xmlText
 * @returns {object} spec
 */
export function parseUrdfSpec(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('not valid XML');
  const root = doc.querySelector('robot');
  if (!root) throw new Error('no <robot> element');

  const links = [];
  for (const node of root.querySelectorAll(':scope > link')) {
    const name = node.getAttribute('name');
    if (!name) continue;
    const inertial = node.querySelector(':scope > inertial');
    const inertia = inertial?.querySelector('inertia') || null;
    links.push({
      name,
      mass: inertial ? num(inertial.querySelector('mass'), 'value') : null,
      // Whether the tensor is anything other than zeros: a generated URDF often
      // declares the element and leaves it empty, which is not the same thing
      // as having measured it.
      inertiaSum: inertia
        ? ['ixx', 'iyy', 'izz'].reduce((sum, key) => sum + Math.abs(num(inertia, key) ?? 0), 0)
        : 0,
      collisions: node.querySelectorAll(':scope > collision').length,
    });
  }

  const joints = [];
  for (const node of root.querySelectorAll(':scope > joint')) {
    const name = node.getAttribute('name');
    if (!name) continue;
    const type = node.getAttribute('type') || '';
    const limit = node.querySelector(':scope > limit');
    const mimic = node.querySelector(':scope > mimic');
    const lower = num(limit, 'lower');
    const upper = num(limit, 'upper');
    const effort = num(limit, 'effort');
    const velocity = num(limit, 'velocity');
    const movable = type !== 'fixed' && !(type in MULTI_DOF);
    joints.push({
      name,
      type,
      movable,
      parent: node.querySelector(':scope > parent')?.getAttribute('link') || null,
      child: node.querySelector(':scope > child')?.getAttribute('link') || null,
      // A revolute joint with no <axis> turns about x, per the spec.
      axis: triple(node.querySelector(':scope > axis'), 'xyz', [1, 0, 0]),
      xyz: triple(node.querySelector(':scope > origin'), 'xyz', [0, 0, 0]),
      rpy: triple(node.querySelector(':scope > origin'), 'rpy', [0, 0, 0]),
      lower,
      upper,
      effort,
      velocity,
      // `continuous` turns forever by definition; anything else without a
      // declared range is upstream having left the range out.
      hasLimit: type !== 'continuous' && (lower !== null || upper !== null),
      travel: lower !== null && upper !== null ? Math.abs(upper - lower) : null,
      // The mechanical ceiling the two limits imply together. It is an upper
      // bound and not a rating — no real actuator delivers peak torque at peak
      // speed — but it is the one number that puts a fast weak joint and a slow
      // strong one on the same scale.
      power: effort && velocity ? effort * velocity : null,
      mimic: mimic
        ? {
            joint: mimic.getAttribute('joint') || '',
            multiplier: num(mimic, 'multiplier') ?? 1,
            offset: num(mimic, 'offset') ?? 0,
          }
        : null,
    });
  }

  const spec = {
    name: root.getAttribute('name') || '',
    links,
    joints,
    linkByName: new Map(links.map((link) => [link.name, link])),
  };
  buildTree(spec);
  spec.totals = totals(spec);
  return spec;
}

/**
 * Where every joint sits, and what hangs off what.
 *
 * The frames are the zero pose — every joint at zero, which is what the URDF
 * declares directly and what the site's own thumbnails are rendered from. That
 * is enough to measure a machine: with the legs straight and the arms down, the
 * distance from a hip joint to an ankle joint is the leg, and the distance
 * between the two hips is the stance.
 *
 * `branch` is what makes an alignment by position possible. A serial arm is one
 * branch and its joints number 1..n along it; a quadruped forks four ways at
 * the trunk and each leg is a branch of its own. The fork is found on the tree
 * of *moving* joints, so the fixed frames upstream scatters through a
 * description — sensor mounts, mesh offsets — never split a limb in two.
 */
function buildTree(spec) {
  const childrenOf = new Map();
  const childLinks = new Set();
  for (const joint of spec.joints) {
    if (!joint.parent || !joint.child) continue;
    if (!childrenOf.has(joint.parent)) childrenOf.set(joint.parent, []);
    childrenOf.get(joint.parent).push(joint);
    childLinks.add(joint.child);
  }
  const root =
    spec.links.find((link) => !childLinks.has(link.name))?.name || spec.links[0]?.name || null;
  spec.root = root;

  /** How many moving joints hang below a link, this side of the tree only. */
  const movingBelow = new Map();
  const countBelow = (link, seen = new Set()) => {
    if (movingBelow.has(link)) return movingBelow.get(link);
    if (seen.has(link)) return 0; // a malformed URDF can name a loop
    seen.add(link);
    let n = 0;
    for (const joint of childrenOf.get(link) || []) {
      n += (joint.movable ? 1 : 0) + countBelow(joint.child, seen);
    }
    movingBelow.set(link, n);
    return n;
  };
  if (root) countBelow(root);

  const walk = (link, position, orientation, depth, branch, branchIndex, seen) => {
    if (seen.has(link)) return;
    seen.add(link);
    const children = childrenOf.get(link) || [];
    // A fork is a link with moving joints down more than one of its children:
    // the point where the trunk becomes limbs. Everything below one of those
    // children belongs to that child's limb.
    const limbs = children.filter((joint) => joint.movable || movingBelow.get(joint.child) > 0);
    const forks = limbs.length > 1;
    for (const joint of children) {
      const rotated = apply(orientation, joint.xyz);
      const at = [position[0] + rotated[0], position[1] + rotated[1], position[2] + rotated[2]];
      const frame = multiply(orientation, rotation(joint.rpy));
      joint.origin = at;
      joint.axisWorld = apply(frame, joint.axis);
      joint.depth = depth + (joint.movable ? 1 : 0);
      // Below a fork every child sub-tree is a limb of its own, claimed by the
      // first joint in it that moves: the fixed frames upstream likes to put
      // between a trunk and a limb — a mount, a mesh offset — must not be what
      // decides where the limb begins.
      const inherited = forks ? null : branch;
      const inheritedIndex = forks ? 0 : branchIndex;
      if (joint.movable) {
        joint.branch = inherited || joint.name;
        joint.branchIndex = inherited ? inheritedIndex + 1 : 1;
      } else {
        joint.branch = inherited;
        joint.branchIndex = inheritedIndex;
      }
      walk(joint.child, at, frame, joint.depth, joint.branch, joint.branchIndex, seen);
    }
  };
  if (root) walk(root, [0, 0, 0], IDENTITY, 0, null, 0, new Set());

  // A joint the walk never reached — a description with two roots, or a broken
  // parent reference — still has to carry the fields everything downstream
  // reads, so it gets a frame at the origin and a branch of its own.
  for (const joint of spec.joints) {
    if (joint.origin) continue;
    joint.origin = [0, 0, 0];
    joint.axisWorld = joint.axis;
    joint.depth = 0;
    joint.branch = joint.movable ? joint.name : null;
    joint.branchIndex = 1;
  }

  // How much of the machine hangs below each joint: the link it moves and
  // everything under that. It is what makes "how much of this robot is its
  // legs" answerable — a question about where a design puts its mass, which
  // the total on its own cannot answer.
  const below = (link, seen) => {
    if (seen.has(link)) return 0;
    seen.add(link);
    let total = spec.linkByName.get(link)?.mass || 0;
    for (const joint of childrenOf.get(link) || []) total += below(joint.child, seen);
    return total;
  };
  for (const joint of spec.joints) {
    joint.subtreeMass = joint.child ? below(joint.child, new Set()) : 0;
    // A joint moves its child link. Keep that link's own mass on the joint as
    // well as the mass of the whole sub-tree so the joint-by-joint comparison
    // can put like-for-like link masses beside one another.
    joint.linkMass = joint.child ? spec.linkByName.get(joint.child)?.mass ?? null : null;
  }

  spec.moving = spec.joints.filter((joint) => joint.movable);
  spec.branches = branchList(spec);
}

/**
 * The limbs, in an order two different robots can be expected to agree on: the
 * longest chain first — an arm's own axes before the two joints of the gripper
 * on the end of it — and, between limbs of equal length, front before back,
 * left before right, top before bottom. Nothing about a URDF forces that
 * ordering to mean anything: it is the fallback for descriptions whose joint
 * names carry no anatomy at all (`0`…`15` for a sixteen-joint hand), so the
 * compare page always shows the joint names it lined up beside the numbers.
 */
function branchList(spec) {
  const byKey = new Map();
  for (const joint of spec.moving) {
    if (!joint.branch) continue;
    if (!byKey.has(joint.branch)) byKey.set(joint.branch, []);
    byKey.get(joint.branch).push(joint);
  }
  const branches = [...byKey].map(([key, joints]) => {
    const sorted = joints.slice().sort((a, b) => a.branchIndex - b.branchIndex);
    return { key, joints: sorted, origin: sorted[0].origin };
  });
  branches.sort(
    (a, b) =>
      b.joints.length - a.joints.length ||
      b.origin[0] - a.origin[0] ||
      b.origin[1] - a.origin[1] ||
      b.origin[2] - a.origin[2],
  );
  branches.forEach((branch, index) => {
    branch.index = index + 1;
    for (const joint of branch.joints) joint.branchOrder = index + 1;
  });
  return branches;
}

/** Everything about the description that is one number for the whole machine. */
function totals(spec) {
  const moving = spec.moving;
  const byType = {};
  for (const joint of spec.joints) byType[joint.type] = (byType[joint.type] || 0) + 1;

  const sum = (list, pick) =>
    list.reduce((total, item) => {
      const value = pick(item);
      return value === null || value === undefined || !Number.isFinite(value) ? total : total + value;
    }, 0);

  const peak = (key) => {
    let best = null;
    for (const joint of moving) {
      const value = joint[key];
      if (value === null || !Number.isFinite(value) || value <= 0) continue;
      if (!best || value > best.value) best = { value, joint: joint.name };
    }
    return best;
  };

  const withMass = spec.links.filter((link) => (link.mass ?? 0) > 0);
  // Only the joints that turn: a slide's travel is a distance, and adding
  // metres to radians would produce a number about nothing.
  const travels = moving
    .filter((joint) => joint.type !== 'prismatic')
    .map((joint) => joint.travel)
    .filter((t) => t !== null && t > 0);

  return {
    links: spec.links.length,
    joints: spec.joints.length,
    jointTypes: byType,
    moving: moving.length,
    revolute: moving.filter((j) => j.type === 'revolute').length,
    continuous: moving.filter((j) => j.type === 'continuous').length,
    prismatic: moving.filter((j) => j.type === 'prismatic').length,
    fixed: byType.fixed || 0,
    mass: withMass.length ? sum(spec.links, (link) => link.mass) : null,
    massLinks: withMass.length,
    inertiaLinks: spec.links.filter((link) => link.inertiaSum > 0).length,
    collisionLinks: spec.links.filter((link) => link.collisions > 0).length,
    effortSum: sum(moving, (joint) => (joint.effort > 0 ? joint.effort : 0)),
    effortPeak: peak('effort'),
    velocityPeak: peak('velocity'),
    powerPeak: peak('power'),
    powerSum: sum(moving, (joint) => (joint.power > 0 ? joint.power : 0)),
    travelSum: travels.reduce((a, b) => a + b, 0),
    travelMean: travels.length ? travels.reduce((a, b) => a + b, 0) / travels.length : null,
    // Data quality, which is worth a row of its own: a joint with no declared
    // range, one whose effort is zero or missing, and one that is driven by
    // another are all places where a number below is not what it seems.
    noLimit: moving.filter((joint) => !joint.hasLimit).length,
    noEffort: moving.filter((joint) => !joint.effort).length,
    noVelocity: moving.filter((joint) => !joint.velocity).length,
    mimic: moving.filter((joint) => joint.mimic).length,
  };
}

/* ── fetching ────────────────────────────────────────────────────────────── */

const specCache = new Map();

/**
 * One URDF, parsed once per tab. The detail view has usually already asked the
 * CDN for the same URL, so a robot that has been looked at costs nothing to
 * add to a comparison.
 *
 * @param {string} url
 * @returns {Promise<object>} spec
 */
export function loadUrdfSpec(url) {
  if (!specCache.has(url)) {
    specCache.set(
      url,
      fetch(url)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
        .then((text) => {
          const spec = parseUrdfSpec(text);
          spec.bytes = text.length;
          return spec;
        })
        .catch((err) => {
          // A failed load must not poison the cache: the CDN drops a request now
          // and then, and the next attempt should be a real one.
          specCache.delete(url);
          throw err;
        }),
    );
  }
  return specCache.get(url);
}
