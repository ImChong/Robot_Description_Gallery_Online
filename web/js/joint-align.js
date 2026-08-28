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
 * A hand is read finger by finger under both, because a finger is a chain and
 * the only way to read one is from the knuckle it starts at to the joint it
 * ends at. Which chain is which finger comes from the names where upstream
 * wrote them (`left_thumb_mcp`), and from the shape of the palm where it did
 * not (`joint_0`…`joint_15`): four fingers start in a row and the thumb starts
 * off it. Then the first joint of one thumb lines up with the first joint of
 * the next, whatever either is called, and the rows run root to tip.
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

/**
 * The order whole chains are read in, which is the order of the parts they
 * belong to with one addition: a chain nothing could name at all sits before
 * the hand rather than after everything. It is the machine's own structure —
 * the six axes of an arm are unnamed precisely because they are the arm — and
 * reading it after the two joints of the gripper on its end has it backwards.
 */
const CHAIN_ORDER = ['torso', 'head', 'arm', 'leg', null, 'hand', 'wheel', 'other'];

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
function branchSides(spec, { category = null, read }) {
  const sides = new Map();
  // A hand on its own has no side worth splitting rows by. Upstream models
  // whichever hand it built — Aero ships a left, Dex3 a right — and the thumb
  // of the one is still the thumb of the other. Worse, the y offset that tells
  // a left leg from a right one tells one finger of a palm from the next, and
  // four fingers off one body read as a quadruped's four corners: the same
  // finger of two hands would end up in three different groups.
  if (category === 'hand') {
    for (const branch of spec.branches) sides.set(branch.key, 'center');
    return sides;
  }
  const span = extent(spec);
  const lateral = Math.max(span * 0.02, 0.008);
  for (const branch of spec.branches) {
    const votes = new Map();
    for (const joint of branch.joints) {
      const { side } = read.get(joint.name);
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

/* ── fingers ────────────────────────────────────────────────────────────── */

/** The fingers of a hand, in the order a hand is read. */
export const FINGER_ORDER = ['thumb', 'index', 'middle', 'ring', 'pinky'];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** The two points furthest apart in a set — the line the set is strung along. */
function widest(points) {
  let best = null;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const span = length(sub(points[i], points[j]));
      if (!best || span > best.span) best = { from: points[i], to: points[j], span };
    }
  }
  return best;
}

/** How far a set of points strays from the line through the two furthest of them. */
function straightness(points) {
  const line = widest(points);
  if (!line || line.span <= 0) return { residual: 0, line: null };
  const direction = sub(line.to, line.from).map((value) => value / line.span);
  let residual = 0;
  for (const point of points) {
    residual = Math.max(residual, length(cross(sub(point, line.from), direction)));
  }
  return { residual, line: { at: line.from, direction } };
}

/**
 * Which chain of a palm is which finger, read off where the chains start.
 *
 * A hand is four fingers whose knuckles sit in a row and a thumb whose does
 * not — that offset is what makes it a thumb rather than a fifth finger. So the
 * thumb is the chain whose removal leaves the rest straightest, and it has to
 * win clearly: the two jaws of a gripper are symmetric, dropping either
 * straightens the rest the same amount, and a thumb picked out of that tie
 * would be an anatomy this function invented. The rest are then read along the
 * row they lie on, beginning at the end the thumb sits nearest — the index.
 *
 * @param {number[][]} bases where each chain's first joint is
 * @returns {?string[]} a finger for each chain, in the order given, or null
 */
function fingersByShape(bases) {
  if (bases.length < 4 || bases.length > FINGER_ORDER.length + 1) return null;
  const spread = widest(bases)?.span || 0;
  if (spread <= 0) return null;
  const scores = bases
    .map((_, index) => ({
      index,
      residual: straightness(bases.filter((_, other) => other !== index)).residual,
    }))
    .sort((a, b) => a.residual - b.residual);
  const [best, next] = scores;
  // Three times straighter than dropping any other chain, and the runner-up has
  // to be a real crookedness rather than rounding in a symmetric layout.
  if (!next || best.residual * 3 > next.residual || next.residual < spread * 0.05) return null;

  const rest = bases
    .map((point, index) => ({ point, index }))
    .filter((one) => one.index !== best.index);
  const { line } = straightness(rest.map((one) => one.point));
  if (!line) return null;
  rest.sort(
    (a, b) => dot(sub(a.point, line.at), line.direction) - dot(sub(b.point, line.at), line.direction),
  );
  const thumb = bases[best.index];
  if (length(sub(rest[rest.length - 1].point, thumb)) < length(sub(rest[0].point, thumb))) {
    rest.reverse();
  }
  const fingers = new Array(bases.length).fill(null);
  fingers[best.index] = 'thumb';
  rest.forEach((one, order) => {
    fingers[one.index] = FINGER_ORDER[order + 1] || null;
  });
  return fingers.every(Boolean) ? fingers : null;
}

/** Where a finger sorts against the others, positional ones after the named. */
export function fingerOrder(part) {
  if (!part) return 0;
  const named = FINGER_ORDER.indexOf(part);
  if (named !== -1) return named;
  const positional = /^f(\d+)$/.exec(part);
  return positional ? FINGER_ORDER.length + Number(positional[1]) : 99;
}

/**
 * Which region each chain belongs to: whatever most of its joints' names say,
 * and where they say nothing, what the machine can only be.
 */
function branchRegions(spec, { read, sides, category }) {
  const regions = new Map();
  for (const branch of spec.branches) {
    const votes = new Map();
    for (const joint of branch.joints) {
      const region = read.get(joint.name).region;
      if (region) votes.set(region, (votes.get(region) || 0) + 1);
    }
    let region = null;
    let best = 0;
    for (const [candidate, count] of votes) {
      if (count > best) {
        region = candidate;
        best = count;
      }
    }
    // What the chain is, not what one joint of it is: an arm whose last joint
    // is `gripper_joint_1` and whose other five name nothing is an arm, and
    // calling the whole thing a hand on that one vote would file five arm
    // joints under the gripper on the end of them. Two joints that agree are
    // enough — a leg named `LL_HAA`, `LL_HFE`, `LL_KFE` and three initialisms
    // nobody has a word for is still a leg.
    if (best === 1 && branch.joints.length > 1) region = null;
    // A limb whose names carry a side but no body part at all —
    // `yumi_joint_1_r` — is still a limb, and on a machine that has nothing but
    // arms there is only one thing it can be. Nothing is assumed on a body that
    // has both arms and legs: there a wrong guess reads as an anatomy.
    const side = sides.get(branch.key) || 'center';
    if (!region && branch.joints.length >= 3) {
      if ((side === 'left' || side === 'right') && category === 'dual_arm') region = 'arm';
      else if (side.length === 2 && category === 'quadruped') region = 'leg';
    }
    // Every chain of a hand is a finger, whatever upstream called it: the
    // Allegro's sixteen joints are `joint_0`…`joint_15` and name nothing at
    // all, but the gallery already knows the machine is a hand.
    if (!region && category === 'hand') region = 'hand';
    regions.set(branch.key, region);
  }
  return regions;
}

/**
 * Which finger each chain of each hand is.
 *
 * The chains are grouped by the link they hang off, so a machine with two hands
 * has two palms and a finger is a finger of the hand it belongs to. Inside a
 * palm the names decide where they say a finger, the shape of the palm decides
 * where they say nothing, and where neither does — a two-jaw gripper, a
 * three-fingered Barrett — the chains are numbered in the order they are
 * already in rather than given an anatomy they do not have.
 *
 * @returns {Map<string, {part: string, side: string, inferred: boolean}>}
 *   chain key -> which finger it is and which hand that hand is
 */
function handFingers(spec, { read, regions, category }) {
  /**
   * Which side of the machine a palm is on, which is the side every finger of
   * it is on. A finger's own offset says which finger of the palm it is, not
   * which hand it belongs to — read one jaw of a gripper that way and the
   * gripper comes apart into a left half and a right half — so the names
   * decide, and where they say nothing the middle of the palm does.
   */
  const lateral = Math.max(extent(spec) * 0.02, 0.008);
  const palmSide = (chains) => {
    // A hand on its own is not a left or a right one; see branchSides.
    if (category === 'hand') return 'center';
    const votes = new Map();
    for (const branch of chains) {
      for (const joint of branch.joints) {
        const { side } = read.get(joint.name);
        if (side) votes.set(side, (votes.get(side) || 0) + 1);
      }
    }
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 1 || (ranked.length > 1 && ranked[0][1] > ranked[1][1])) return ranked[0][0];
    const middle = chains.reduce((sum, one) => sum + one.origin[1], 0) / chains.length;
    if (Math.abs(middle) <= lateral) return 'center';
    return middle > 0 ? 'left' : 'right';
  };

  const palms = new Map();
  for (const branch of spec.branches) {
    if (regions.get(branch.key) !== 'hand') continue;
    // A chain is a finger when it is one the whole way down. An arm that ends
    // in a gripper is still an arm: OpenManipulator's `gripper_joint_1` hangs
    // straight off `joint1`…`joint5` with no fork to separate them, and one
    // joint carrying the whole chain's vote must not turn the other five into
    // knuckles. On a machine that is nothing but a hand there is no arm for a
    // chain to be, so there the names get to say nothing at all.
    const says = branch.joints.filter((joint) => read.get(joint.name).region === 'hand').length;
    if (category !== 'hand' && says * 2 <= branch.joints.length) continue;
    const palm = branch.joints[0].parent || '';
    if (!palms.has(palm)) palms.set(palm, []);
    palms.get(palm).push(branch);
  }
  const fingers = new Map();
  for (const chains of palms.values()) {
    const named = chains.map((branch) => {
      for (const joint of branch.joints) {
        const { segment } = read.get(joint.name);
        if (FINGER_ORDER.includes(segment)) return segment;
      }
      return null;
    });
    const guessed = named.some(Boolean) ? null : fingersByShape(chains.map((one) => one.origin));
    const side = palmSide(chains);
    let spare = 0;
    chains.forEach((branch, index) => {
      const part = named[index] || guessed?.[index] || null;
      if (part) fingers.set(branch.key, { part, side, inferred: !named[index] });
      else {
        spare += 1;
        fingers.set(branch.key, { part: `f${spare}`, side, inferred: true });
      }
    });
  }
  return fingers;
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
  const read = new Map(spec.moving.map((joint) => [joint.name, readName(joint)]));
  const sides = branchSides(spec, { category, read });
  const regions = branchRegions(spec, { read, sides, category });
  const fingers = handFingers(spec, { read, regions, category });
  const placed = new Map();

  for (const branch of spec.branches) {
    // A limb takes its region from what its joints name — a couple of
    // `arm_left_4_joint`s are enough to say the whole branch is an arm.
    const branchRegion = regions.get(branch.key);
    const finger = fingers.get(branch.key) || null;
    const side = (finger ? finger.side : sides.get(branch.key)) || 'center';

    // A finger is a chain and reads as one: its joints are lined up against
    // another hand's by how far down the finger they sit, not by what upstream
    // called them. One hand's knuckles are `mcp`, `pip`, `dip`, the next's are
    // `q1`, `q2`, the third's are `12`, `13`, `14` — but the first joint of a
    // thumb is the first joint of a thumb everywhere.
    let step = 0;

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
      const segment = (finger ? finger.part : name.segment) || (region === 'hand' ? 'gripper' : null);
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
      if (finger) step += 1;
      placed.set(joint.name, {
        region,
        side,
        segment: resolved,
        axis,
        inferred: !!name.inferred || (finger ? finger.inferred : false),
        ordinal: name.ordinal,
        part: finger ? finger.part : null,
        step: finger ? step : null,
        tip: finger ? joint === branch.joints[branch.joints.length - 1] : false,
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
    // Thumb first, then across the hand, and down each finger from the knuckle
    // it starts at: on a finger the step is the anatomy, and sorting by the
    // axis first would put a roll above the joint it hangs off.
    fingerOrder(a.part) - fingerOrder(b.part) ||
    (a.step ?? 0) - (b.step ?? 0) ||
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
      // it, an extra ankle link — keep their order and take numbered rows. A
      // finger is keyed by how far down the finger the joint is instead, which
      // is the one thing every hand agrees on however it names its knuckles.
      const base = slot.step
        ? `${slot.region}|${slot.side}|${slot.part}|s${slot.step}`
        : `${slot.region}|${slot.side}|${slot.segment}|${slot.axis}`;
      const dup = (seen.get(base) || 0) + 1;
      seen.set(base, dup);
      const key = dup === 1 ? base : `${base}|${dup}`;
      if (!rows.has(key)) {
        rows.set(key, { key, ...slot, dup, joint: undefined, cells: new Map() });
      }
      rows
        .get(key)
        .cells.set(entry.id, { joint, inferred: slot.inferred, axis: slot.axis, tip: slot.tip });
      matched += 1;
    }
    coverage.set(entry.id, { matched, total: entry.spec.moving.length });
    if (spare.length) leftovers.push({ id: entry.id, joints: spare });
  }

  const sorted = [...rows.values()].sort(slotSort);
  const groups = [];
  for (const row of sorted) {
    // A finger is a group of its own, so its rows read as the chain they are
    // rather than as five fingers' worth of knuckles under one heading.
    const key = `${row.region}|${row.side}${row.part ? `|${row.part}` : ''}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else {
      groups.push({
        key,
        region: row.region,
        side: row.side,
        part: row.part || null,
        steps: !!row.step,
        rows: [row],
      });
    }
  }
  return { groups, leftovers, coverage };
}

/**
 * What one chain of one robot is, as far as anything can say: a limb, a side,
 * and — on a hand — which finger. It is what lets the chain of one machine be
 * put beside the same chain of another rather than beside whichever chain the
 * URDF happened to declare in the same position.
 */
function chainSlots(spec, { category = null } = {}) {
  const read = new Map(spec.moving.map((joint) => [joint.name, readName(joint)]));
  const sides = branchSides(spec, { category, read });
  const regions = branchRegions(spec, { read, sides, category });
  const fingers = handFingers(spec, { read, regions, category });
  const slots = new Map();
  for (const branch of spec.branches) {
    const region = regions.get(branch.key);
    const finger = fingers.get(branch.key) || null;
    slots.set(branch.key, {
      region: region || null,
      side: (finger ? finger.side : sides.get(branch.key)) || 'center',
      part: finger ? finger.part : null,
      inferred: finger ? finger.inferred : false,
    });
  }
  return slots;
}

/**
 * The rows of a comparison by kinematic order: one chain of each robot beside
 * the same chain of the others, joint by joint from the joint it starts at to
 * the joint it ends at.
 *
 * Which chain is "the same" is the whole question. Where the descriptions say
 * enough to answer it — a left arm, a thumb — the answer is used, so that a
 * thumb of four joints is read against a thumb of four joints and not against
 * whichever finger upstream listed first. Where they say nothing at all, which
 * is exactly the case this reading exists for, the chains fall back on the
 * order `urdf-spec.js` puts them in: longest first, then front, left and top.
 *
 * @param {Array<{id: string, spec: object}>} entries
 */
export function alignByChain(entries) {
  const coverage = new Map();
  /** Chains that named themselves, by what they named themselves. */
  const claims = new Map();
  /** Every chain of every description, in the order urdf-spec.js put them in. */
  const listed = [];

  for (const entry of entries) {
    coverage.set(entry.id, { matched: entry.spec.moving.length, total: entry.spec.moving.length });
    const slots = chainSlots(entry.spec, { category: entry.category });
    for (const branch of entry.spec.branches) {
      const slot = slots.get(branch.key) || { region: null, side: 'center', part: null };
      let claim = slot.region
        ? `${slot.region}|${slot.side}${slot.part ? `|${slot.part}` : ''}`
        : null;
      // One machine with two chains in the same place — a hand whose thumb the
      // names give twice — keeps both, and only the first of them claims it.
      if (claim && claims.get(claim)?.some((one) => one.id === entry.id)) claim = null;
      const chain = { id: entry.id, branch, slot, claim };
      if (claim) {
        if (!claims.has(claim)) claims.set(claim, []);
        claims.get(claim).push(chain);
      }
      listed.push(chain);
    }
  }

  // A name only one of the descriptions could produce has told us nothing about
  // which chain of the others it belongs beside, so that chain goes back among
  // the unnamed and is read against whatever sits in the same position — the
  // fallback this whole reading is built on. It keeps its name for the heading.
  const shared = new Set([...claims].filter(([, chains]) => chains.length > 1).map(([key]) => key));
  const groups = new Map();
  const position = new Map();
  for (const chain of listed) {
    let key = chain.claim;
    if (!key || !shared.has(key)) {
      const next = (position.get(chain.id) || 0) + 1;
      position.set(chain.id, next);
      key = `#${String(next).padStart(3, '0')}`;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chain);
  }

  // A group's heading is what its chains agree they are, which for one paired
  // by position is usually nothing — and then it is the chain it is, numbered.
  const agreed = (chains, field) => {
    const first = chains[0].slot[field] ?? null;
    return chains.every((chain) => (chain.slot[field] ?? null) === first) ? first : null;
  };
  const out = [...groups]
    .map(([key, chains], order) => ({
      key,
      chains,
      order,
      region: agreed(chains, 'region'),
      side: agreed(chains, 'side') || 'center',
      part: agreed(chains, 'part'),
    }))
    .sort(
      (a, b) =>
        orderOf(CHAIN_ORDER, a.region) - orderOf(CHAIN_ORDER, b.region) ||
        orderOf(SIDE_ORDER, a.side) - orderOf(SIDE_ORDER, b.side) ||
        fingerOrder(a.part) - fingerOrder(b.part) ||
        a.order - b.order,
    );

  return {
    groups: out.map((group, index) => {
      const depth = Math.max(...group.chains.map((chain) => chain.branch.joints.length));
      const rows = [];
      for (let step = 0; step < depth; step += 1) {
        const row = {
          key: `${group.key}-${step}`,
          chain: index + 1,
          step: step + 1,
          steps: true,
          cells: new Map(),
        };
        for (const chain of group.chains) {
          const joint = chain.branch.joints[step];
          if (!joint) continue;
          row.cells.set(chain.id, {
            joint,
            inferred: chain.slot.inferred || false,
            axis: geometricAxis(joint),
            tip: joint === chain.branch.joints[chain.branch.joints.length - 1],
          });
        }
        rows.push(row);
      }
      return {
        key: group.key,
        chain: index + 1,
        region: group.region,
        side: group.side,
        part: group.part,
        steps: true,
        rows,
        size: depth,
      };
    }),
    leftovers: [],
    coverage,
  };
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
    // A finger is a limb of a hand: five of them is what there is to compare
    // about a hand, and one row reading "hand" would be the whole machine.
    const key = `${slot.region}|${slot.side}${slot.part ? `|${slot.part}` : ''}`;
    if (!bySide.has(key)) {
      bySide.set(key, {
        key,
        region: slot.region,
        side: slot.side,
        part: slot.part || null,
        joints: [],
        slots: [],
      });
    }
    bySide.get(key).joints.push(joint);
    bySide.get(key).slots.push(slot);
  }
  return [...bySide.values()].map((limb) => {
    const ordered = limb.slots
      .slice()
      .sort(
        (a, b) =>
          (a.step ?? 0) - (b.step ?? 0) ||
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
