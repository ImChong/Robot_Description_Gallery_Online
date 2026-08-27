/**
 * Which joint of one robot is the same joint of another.
 *
 * Nothing in a URDF says so. Upstream names the left knee `left_knee_joint`,
 * `LeftKneePitch`, `l_leg_kny`, `leg_left_4_joint` or `FL_calf_joint`, and a
 * comparison that lines those up by string equality lines up nothing at all.
 * Two readings are offered instead, and the compare page lets the visitor swap
 * between them:
 *
 *   - **by anatomy** — a joint is placed by what it is: a side (or a corner, on
 *     a machine with four of them), a body part, and the axis it turns about.
 *     The part comes from the words in the name, the axis from the words if
 *     they say and from the joint's own axis vector when they do not, and the
 *     side from the words if they say and from which half of the body the joint
 *     sits in when they do not. Where the words carry no anatomy but do name a
 *     limb — `leg_left_1..6` — the six joints of a leg are read in the order
 *     legs are built: three at the hip, the knee, two at the ankle. Those are
 *     marked as inferred wherever they are shown.
 *
 *   - **by kinematic order** — a joint is placed by where it sits along its
 *     chain: the second joint of the longest chain, whatever anyone calls it.
 *     This is the reading that matters for arms, which upstream numbers
 *     `joint_1`…`joint_6` precisely because the anatomy is beside the point.
 *
 * Either way the cells carry the joint names that were lined up, because a
 * heuristic the reader cannot check is worse than no heuristic at all.
 */

export const REGION_ORDER = ['torso', 'head', 'arm', 'leg', 'hand', 'wheel', 'other'];

/** Proximal to distal — the order the rows of one limb are read in. */
export const SEGMENT_ORDER = {
  torso: ['waist', 'lift'],
  head: ['neck', 'head'],
  arm: ['shoulder', 'upperarm', 'elbow', 'forearm', 'wrist'],
  leg: ['abduct', 'hip', 'thigh', 'knee', 'shin', 'achilles', 'tarsus', 'ankle', 'foot', 'toe', 'wheel'],
  hand: ['thumb', 'index', 'middle', 'ring', 'pinky', 'finger', 'knuckle', 'gripper'],
  wheel: ['wheel', 'caster'],
  other: ['other'],
};

export const AXIS_ORDER = ['pitch', 'roll', 'yaw', 'tx', 'ty', 'tz', 'none'];

export const SIDE_ORDER = ['center', 'left', 'right', 'FL', 'FR', 'RL', 'RR'];

/** A word in a joint name, and the body part it names. */
const WORD = {
  neck: ['head', 'neck'],
  head: ['head', 'head'],
  pan: ['head', 'head'],
  tilt: ['head', 'head'],

  waist: ['torso', 'waist'],
  torso: ['torso', 'waist'],
  spine: ['torso', 'waist'],
  trunk: ['torso', 'waist'],
  chest: ['torso', 'waist'],
  back: ['torso', 'waist'],
  bk: ['torso', 'waist'],
  abs: ['torso', 'waist'],
  bust: ['torso', 'waist'],
  lift: ['torso', 'lift'],

  shoulder: ['arm', 'shoulder'],
  sh: ['arm', 'shoulder'],
  shld: ['arm', 'shoulder'],
  clavicle: ['arm', 'shoulder'],
  upperarm: ['arm', 'upperarm'],
  elbow: ['arm', 'elbow'],
  el: ['arm', 'elbow'],
  elb: ['arm', 'elbow'],
  forearm: ['arm', 'forearm'],
  wrist: ['arm', 'wrist'],
  wr: ['arm', 'wrist'],
  wrst: ['arm', 'wrist'],
  arm: ['arm', null],

  hip: ['leg', 'hip'],
  hp: ['leg', 'hip'],
  haa: ['leg', 'abduct'],
  abad: ['leg', 'abduct'],
  abduct: ['leg', 'abduct'],
  abduction: ['leg', 'abduct'],
  hfe: ['leg', 'hip'],
  thigh: ['leg', 'thigh'],
  knee: ['leg', 'knee'],
  kn: ['leg', 'knee'],
  kfe: ['leg', 'knee'],
  calf: ['leg', 'knee'],
  shank: ['leg', 'knee'],
  shin: ['leg', 'shin'],
  achilles: ['leg', 'achilles'],
  tarsus: ['leg', 'tarsus'],
  ankle: ['leg', 'ankle'],
  ak: ['leg', 'ankle'],
  foot: ['leg', 'foot'],
  heel: ['leg', 'foot'],
  toe: ['leg', 'toe'],
  leg: ['leg', null],

  thumb: ['hand', 'thumb'],
  index: ['hand', 'index'],
  middle: ['hand', 'middle'],
  ring: ['hand', 'ring'],
  pinky: ['hand', 'pinky'],
  pinkie: ['hand', 'pinky'],
  little: ['hand', 'pinky'],
  finger: ['hand', 'finger'],
  fingertip: ['hand', 'finger'],
  mrl: ['hand', 'finger'],
  knuckle: ['hand', 'knuckle'],
  gripper: ['hand', 'gripper'],
  hand: ['hand', null],

  wheel: ['wheel', 'wheel'],
  whl: ['wheel', 'wheel'],
  caster: ['wheel', 'caster'],
};

/** The word for an axis, where upstream spells one out. */
const AXIS_WORD = {
  pitch: 'pitch',
  roll: 'roll',
  yaw: 'yaw',
  prosup: 'roll', // pronation/supination — iCub's forearm roll
  pan: 'yaw',
  tilt: 'pitch',
  flex: 'pitch',
  abd: 'roll',
};

/** Two-letter part with a trailing axis letter: Atlas writes `l_leg_hpx`. */
const SHORT_PART = /^(sh|el|wr|hp|kn|ak|bk|ne)([xyz])(\d*)$/;
/** Baxter numbers a seven-axis arm `s0 s1 e0 e1 w0 w1 w2`. */
const SHORT_LIMB = /^([sew])(\d)$/;
const SHORT_LIMB_PART = { s: ['arm', 'shoulder'], e: ['arm', 'elbow'], w: ['arm', 'wrist'] };
const AXIS_LETTER = { x: 'roll', y: 'pitch', z: 'yaw' };

const LEFT = new Set(['left', 'l', 'lft', 'lefthand', 'lh_side']);
const RIGHT = new Set(['right', 'r', 'rt', 'righthand']);
/** Every spelling of a quadruped's four corners that the gallery carries. */
const CORNER = {
  fl: 'FL', lf: 'FL',
  fr: 'FR', rf: 'FR',
  rl: 'RL', lh: 'RL', hl: 'RL', bl: 'RL',
  rr: 'RR', rh: 'RR', hr: 'RR', br: 'RR',
};

/** How many joints a limb of each length has where, when the names do not say. */
const TEMPLATE = {
  leg: {
    1: ['hip'],
    2: ['hip', 'knee'],
    3: ['hip', 'hip', 'knee'],
    4: ['hip', 'hip', 'knee', 'ankle'],
    5: ['hip', 'hip', 'hip', 'knee', 'ankle'],
    6: ['hip', 'hip', 'hip', 'knee', 'ankle', 'ankle'],
    7: ['hip', 'hip', 'hip', 'knee', 'ankle', 'ankle', 'foot'],
  },
  cornerLeg: {
    2: ['hip', 'knee'],
    3: ['abduct', 'hip', 'knee'],
    4: ['abduct', 'hip', 'knee', 'wheel'],
  },
  arm: {
    1: ['shoulder'],
    2: ['shoulder', 'elbow'],
    3: ['shoulder', 'shoulder', 'shoulder'],
    4: ['shoulder', 'shoulder', 'shoulder', 'elbow'],
    5: ['shoulder', 'shoulder', 'shoulder', 'elbow', 'wrist'],
    6: ['shoulder', 'shoulder', 'shoulder', 'elbow', 'wrist', 'wrist'],
    7: ['shoulder', 'shoulder', 'shoulder', 'elbow', 'wrist', 'wrist', 'wrist'],
    8: ['shoulder', 'shoulder', 'shoulder', 'elbow', 'forearm', 'wrist', 'wrist', 'wrist'],
  },
};

/**
 * A joint name as words: `LeftHipPitch`, `left_hip_pitch_joint` and
 * `l_hip_pitch` all have to come apart the same way, and `AAHead_yaw` — where
 * upstream's own prefix runs into the word — must not swallow the word.
 */
export function jointTokens(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase())
    .filter((token) => token !== 'joint' && token !== 'jnt');
}

/** Which way a joint turns, in the robot's own frame: x rolls, y pitches, z yaws. */
function geometricAxis(joint) {
  const [x, y, z] = joint.axisWorld || joint.axis || [1, 0, 0];
  const translating = joint.type === 'prismatic';
  const magnitudes = [Math.abs(x), Math.abs(y), Math.abs(z)];
  const dominant = magnitudes.indexOf(Math.max(...magnitudes));
  if (translating) return ['tx', 'ty', 'tz'][dominant];
  return ['roll', 'pitch', 'yaw'][dominant];
}

/** What one joint's name says, before anything is inferred from its neighbours. */
function readName(joint) {
  const tokens = jointTokens(joint.name);
  let region = null;
  let segment = null;
  let axis = null;
  let side = null;
  let corner = null;
  let ordinal = null;

  for (const token of tokens) {
    if (WORD[token]) {
      const [wordRegion, wordSegment] = WORD[token];
      // The first word wins the region, but a later word may still name the
      // part inside it: `arm_left_1` is an arm, `l_arm_shx` is its shoulder.
      if (!region) region = wordRegion;
      if (!segment && wordSegment && wordRegion === region) segment = wordSegment;
      continue;
    }
    if (AXIS_WORD[token] && !axis) {
      axis = AXIS_WORD[token];
      continue;
    }
    // The axis as the letter of the axis: `l_shld_y_joint`. Only where the
    // joint turns — on one that slides, the same letter means a direction.
    if (AXIS_LETTER[token] && !axis && joint.type !== 'prismatic') {
      axis = AXIS_LETTER[token];
      continue;
    }
    const short = SHORT_PART.exec(token);
    if (short) {
      const [, part, letter, index] = short;
      const [wordRegion, wordSegment] = WORD[part];
      if (!region) region = wordRegion;
      if (!segment && wordRegion === region) segment = wordSegment;
      if (!axis) axis = AXIS_LETTER[letter];
      if (index && ordinal === null) ordinal = Number(index);
      continue;
    }
    const limb = SHORT_LIMB.exec(token);
    if (limb) {
      const [, letter, index] = limb;
      const [wordRegion, wordSegment] = SHORT_LIMB_PART[letter];
      if (!region) region = wordRegion;
      if (!segment && wordRegion === region) segment = wordSegment;
      if (ordinal === null) ordinal = Number(index);
      continue;
    }
    if (CORNER[token] && !corner) {
      corner = CORNER[token];
      continue;
    }
    // The side run into the part: `LARM_JOINT0`, `rhip`, `lwrist`.
    const glued = token.length > 2 && (token[0] === 'l' || token[0] === 'r') ? token.slice(1) : null;
    if (glued && WORD[glued]) {
      const [wordRegion, wordSegment] = WORD[glued];
      if (!region) region = wordRegion;
      if (!segment && wordSegment && wordRegion === region) segment = wordSegment;
      if (!side) side = token[0] === 'l' ? 'left' : 'right';
      continue;
    }
    if (LEFT.has(token) && !side) {
      side = 'left';
      continue;
    }
    if (RIGHT.has(token) && !side) {
      side = 'right';
      continue;
    }
    if (/^\d+$/.test(token)) {
      if (ordinal === null) ordinal = Number(token);
      continue;
    }
    // A word with its number run into it: hands are where upstream does this
    // — `ThumbPitch2`, `index_q1` — and where the number is the joint.
    const numbered = /^([a-z]+)(\d+)$/.exec(token);
    if (numbered) {
      const [, word, index] = numbered;
      if (WORD[word]) {
        const [wordRegion, wordSegment] = WORD[word];
        if (!region) region = wordRegion;
        if (!segment && wordSegment && wordRegion === region) segment = wordSegment;
      } else if (AXIS_WORD[word] && !axis) {
        axis = AXIS_WORD[word];
      }
      if (ordinal === null) ordinal = Number(index);
    }
  }
  return { region, segment, axis, side: corner || side, ordinal, tokens };
}

/**
 * Which half — or which corner — of the machine a limb is on, decided once for
 * the whole limb rather than joint by joint. A leg whose joints are named
 * `leg_left_1..6` says "left" six times; one named `0..3` says it nowhere, and
 * then the answer is where the limb actually hangs: y is left on every URDF,
 * and x is forward.
 */
function branchSides(spec) {
  const span = extent(spec);
  const lateral = Math.max(span * 0.02, 0.008);
  const sides = new Map();
  for (const branch of spec.branches) {
    const votes = new Map();
    for (const joint of branch.joints) {
      const { side } = readName(joint);
      if (side) votes.set(side, (votes.get(side) || 0) + 1);
    }
    let side = null;
    let best = 0;
    for (const [candidate, count] of votes) {
      if (count > best) {
        side = candidate;
        best = count;
      }
    }
    if (!side) {
      const [x, y] = branch.joints[0].origin;
      if (Math.abs(y) > lateral) side = y > 0 ? 'left' : 'right';
      else side = 'center';
      // Four limbs off one body is a quadruped however it was named: the
      // corners are what the visitor is comparing, not "left" twice.
      if (side !== 'center' && spec.branches.filter((b) => b.joints.length >= 2).length >= 4) {
        const front = Math.abs(x) > lateral ? (x > 0 ? 'F' : 'R') : null;
        if (front) side = `${front}${side === 'left' ? 'L' : 'R'}`;
      }
    }
    sides.set(branch.key, side);
  }
  return sides;
}

/** How big the machine is, as the joints alone can tell — the tolerance scale. */
function extent(spec) {
  if (!spec.moving.length) return 1;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const joint of spec.moving) {
    for (let i = 0; i < 3; i += 1) {
      lo[i] = Math.min(lo[i], joint.origin[i]);
      hi[i] = Math.max(hi[i], joint.origin[i]);
    }
  }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return Number.isFinite(size) && size > 0 ? size : 1;
}

/**
 * Every moving joint of one description, placed.
 *
 * @param {object} spec from parseUrdfSpec
 * @param {{category?: string}} [options] the gallery's category for the robot,
 *   which is the only thing that can tell a limb nobody named from a limb
 *   nobody has
 * @returns {Map<string, object>} joint name -> { region, side, segment, axis,
 *   inferred }
 */
export function anatomy(spec, { category = null } = {}) {
  const sides = branchSides(spec);
  const read = new Map(spec.moving.map((joint) => [joint.name, readName(joint)]));
  const placed = new Map();

  for (const branch of spec.branches) {
    const side = sides.get(branch.key) || 'center';
    // A limb takes its region from whatever its joints do name — one
    // `arm_left_4_joint` is enough to say the whole branch is an arm.
    const regions = new Map();
    for (const joint of branch.joints) {
      const region = read.get(joint.name).region;
      if (region) regions.set(region, (regions.get(region) || 0) + 1);
    }
    let branchRegion = null;
    let best = 0;
    for (const [region, count] of regions) {
      if (count > best) {
        branchRegion = region;
        best = count;
      }
    }

    // A limb whose names carry a side but no body part at all —
    // `yumi_joint_1_r` — is still a limb, and on a machine that has nothing but
    // arms there is only one thing it can be. Nothing is assumed on a body that
    // has both arms and legs: there a wrong guess reads as an anatomy.
    if (!branchRegion && branch.joints.length >= 3) {
      if ((side === 'left' || side === 'right') && category === 'dual_arm') {
        branchRegion = 'arm';
      } else if (side.length === 2 && category === 'quadruped') {
        branchRegion = 'leg';
      }
    }

    // Joints of the branch's own region that nobody named a part for: read
    // them off the shape a limb of that length has.
    const anonymous = branch.joints.filter((joint) => {
      const name = read.get(joint.name);
      return !name.segment && (!name.region || name.region === branchRegion);
    });
    const corner = side.length === 2 && side !== 'left'; // FL / FR / RL / RR
    const templateFor =
      branchRegion === 'leg'
        ? TEMPLATE[corner ? 'cornerLeg' : 'leg']
        : branchRegion === 'arm'
          ? TEMPLATE.arm
          : null;
    const template = templateFor?.[anonymous.length] || null;

    anonymous.forEach((joint, index) => {
      if (!template) return;
      const name = read.get(joint.name);
      name.segment = template[index];
      name.region = branchRegion;
      name.inferred = true;
    });

    for (const joint of branch.joints) {
      const name = read.get(joint.name);
      const region = name.region || branchRegion;
      // One joint that names the hand and nothing inside it is the hand
      // opening and closing: Romeo's `LHand`, Pepper's `RHand`.
      const segment = name.segment || (region === 'hand' ? 'gripper' : null);
      // Nothing to line this one up by. A six-axis arm is the whole reason the
      // other reading exists: `joint_1`…`joint_6` name no part of any body, and
      // inventing one for them would only produce rows that look aligned.
      if (!region || !segment) continue;
      const axis = name.axis || geometricAxis(joint);
      // The two joints a quadruped's names call "hip" and "thigh" are the
      // abduction and the hip: on four legs it is the axis that separates them.
      const resolved =
        corner && region === 'leg' && (segment === 'hip' || segment === 'thigh')
          ? axis === 'roll'
            ? 'abduct'
            : 'hip'
          : segment;
      placed.set(joint.name, {
        region,
        side,
        segment: resolved,
        axis,
        inferred: !!name.inferred,
        ordinal: name.ordinal,
        joint,
      });
    }
  }
  return placed;
}

const orderOf = (list, value) => {
  const index = list.indexOf(value);
  return index === -1 ? list.length : index;
};

function slotSort(a, b) {
  return (
    orderOf(REGION_ORDER, a.region) - orderOf(REGION_ORDER, b.region) ||
    orderOf(SIDE_ORDER, a.side) - orderOf(SIDE_ORDER, b.side) ||
    orderOf(SEGMENT_ORDER[a.region] || [], a.segment) -
      orderOf(SEGMENT_ORDER[b.region] || [], b.segment) ||
    orderOf(AXIS_ORDER, a.axis) - orderOf(AXIS_ORDER, b.axis) ||
    (a.ordinal ?? 0) - (b.ordinal ?? 0) ||
    a.dup - b.dup
  );
}

/**
 * The rows of an anatomical comparison: one per place on the body that any of
 * the selected machines has a joint at, with the joints that landed there.
 *
 * @param {Array<{id: string, spec: object}>} entries
 * @returns {{ groups: object[], leftovers: object[], coverage: Map }}
 */
export function alignByAnatomy(entries) {
  const rows = new Map();
  const leftovers = [];
  const coverage = new Map();

  for (const entry of entries) {
    const placed = anatomy(entry.spec, { category: entry.category });
    const seen = new Map();
    const spare = [];
    let matched = 0;
    for (const joint of entry.spec.moving) {
      const slot = placed.get(joint.name);
      if (!slot) {
        spare.push(joint);
        continue;
      }
      // Two joints in the same place on one robot — a wrist with two rolls in
      // it, an extra ankle link — keep their order and take numbered rows.
      // A finger is the exception: upstream numbers its knuckles and that
      // number is which knuckle, so it belongs in the slot rather than after it.
      const base =
        slot.region === 'hand' && slot.ordinal
          ? `${slot.region}|${slot.side}|${slot.segment}|${slot.axis}|n${slot.ordinal}`
          : `${slot.region}|${slot.side}|${slot.segment}|${slot.axis}`;
      const dup = (seen.get(base) || 0) + 1;
      seen.set(base, dup);
      const key = dup === 1 ? base : `${base}|${dup}`;
      if (!rows.has(key)) {
        rows.set(key, { key, ...slot, dup, joint: undefined, cells: new Map() });
      }
      rows.get(key).cells.set(entry.id, { joint, inferred: slot.inferred });
      matched += 1;
    }
    coverage.set(entry.id, { matched, total: entry.spec.moving.length });
    if (spare.length) leftovers.push({ id: entry.id, joints: spare });
  }

  const sorted = [...rows.values()].sort(slotSort);
  const groups = [];
  for (const row of sorted) {
    const key = `${row.region}|${row.side}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, region: row.region, side: row.side, rows: [row] });
  }
  return { groups, leftovers, coverage };
}

/**
 * The rows of a comparison by kinematic order: the longest chain of each robot
 * beside the longest chain of the others, joint by joint down them.
 *
 * @param {Array<{id: string, spec: object}>} entries
 */
export function alignByChain(entries) {
  const groups = [];
  const coverage = new Map();
  const width = Math.max(0, ...entries.map((entry) => entry.spec.branches.length));

  for (const entry of entries) {
    coverage.set(entry.id, { matched: entry.spec.moving.length, total: entry.spec.moving.length });
  }

  for (let index = 0; index < width; index += 1) {
    const chains = entries
      .map((entry) => ({ id: entry.id, branch: entry.spec.branches[index] }))
      .filter((chain) => chain.branch);
    const depth = Math.max(...chains.map((chain) => chain.branch.joints.length));
    const rows = [];
    for (let step = 0; step < depth; step += 1) {
      const row = { key: `chain-${index}-${step}`, chain: index + 1, step: step + 1, cells: new Map() };
      for (const chain of chains) {
        const joint = chain.branch.joints[step];
        if (joint) row.cells.set(chain.id, { joint, inferred: false });
      }
      rows.push(row);
    }
    groups.push({ key: `chain-${index}`, chain: index + 1, rows, size: depth });
  }
  return { groups, leftovers: [], coverage };
}

/**
 * Which reading to open on. Anatomy is the useful one for anything with limbs
 * and the useless one for a six-axis arm, whose joints are called `joint_1`…
 * `joint_6` because the anatomy genuinely is beside the point — so the choice
 * is made on how much of the selection anatomy can actually place.
 */
export function defaultMode(entries) {
  if (!entries.length) return 'anatomy';
  const { coverage } = alignByAnatomy(entries);
  let matched = 0;
  let total = 0;
  for (const entry of coverage.values()) {
    matched += entry.matched;
    total += entry.total;
  }
  return total && matched / total >= 0.6 ? 'anatomy' : 'chain';
}

export function align(entries, mode) {
  return mode === 'chain' ? alignByChain(entries) : alignByAnatomy(entries);
}

/**
 * The limbs of one machine as measurements: how many joints each carries, how
 * much torque they add up to, how much of the machine's mass hangs off it, and
 * how long it is at the zero pose — the straight line from its first joint to
 * its last, which for a leg standing straight is the leg, and for an arm
 * hanging down is the arm.
 *
 * @param {object} spec
 * @param {{category?: string}} [options]
 * @returns {Array<{region, side, joints, dof, effort, length, first, last}>}
 */
export function limbs(spec, options) {
  const placed = anatomy(spec, options);
  const bySide = new Map();
  for (const joint of spec.moving) {
    const slot = placed.get(joint.name);
    if (!slot) continue;
    const key = `${slot.region}|${slot.side}`;
    if (!bySide.has(key)) {
      bySide.set(key, { region: slot.region, side: slot.side, joints: [], slots: [] });
    }
    bySide.get(key).joints.push(joint);
    bySide.get(key).slots.push(slot);
  }
  return [...bySide.values()].map((limb) => {
    const ordered = limb.slots
      .slice()
      .sort(
        (a, b) =>
          orderOf(SEGMENT_ORDER[a.region] || [], a.segment) -
          orderOf(SEGMENT_ORDER[b.region] || [], b.segment),
      );
    const first = ordered[0]?.joint.origin || null;
    const last = ordered[ordered.length - 1]?.joint.origin || null;
    // The mass of a limb is what hangs below the joint that attaches it, so it
    // is read off the joint that comes first along the chain rather than the
    // one that comes first anatomically — they are usually the same joint.
    const root = limb.joints.reduce(
      (best, joint) => (!best || joint.branchIndex < best.branchIndex ? joint : best),
      null,
    );
    return {
      ...limb,
      dof: limb.joints.length,
      effort: limb.joints.reduce((sum, joint) => sum + (joint.effort > 0 ? joint.effort : 0), 0),
      mass: root?.subtreeMass || null,
      first,
      last,
      length:
        first && last
          ? Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2])
          : null,
    };
  });
}
