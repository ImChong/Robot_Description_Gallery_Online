/**
 * The compare view: several machines of one kind, side by side.
 *
 * The gallery answers "what does this robot look like"; this page answers the
 * question that comes next — "how does it compare". Two to six descriptions of
 * the same category are read as numbers rather than as geometry (js/urdf-spec.js
 * does the reading, js/joint-align.js decides which joint of one is which joint
 * of another) and laid out as three tables:
 *
 *   - the whole machine: degrees of freedom, mass, height, what its actuators
 *     add up to, how complete the description is;
 *   - its limbs: how many joints each carries, how much torque, how long it is;
 *   - and every joint, lined up with the joint that does the same job on the
 *     others — travel, speed limit, torque limit, and the power those two imply.
 *     A chain — a finger, an arm, a leg — is read down its length, from the
 *     joint it starts at to the joint it ends at, so a thumb of four knuckles
 *     can be read against a thumb of three.
 *
 * Only descriptions of one category can be selected together, because a row
 * reading "left knee" across a humanoid and a gripper is a row about nothing.
 * The one exception is the visitor's own file: a model picked off a disk has no
 * category of its own worth honouring — being told what it is, is usually why
 * it was opened — so it joins whichever comparison it is put in and is read as
 * that kind of machine. It never leaves the tab, here as everywhere else: the
 * URDF is parsed from the blob the picker already made, and an address that
 * names it opens for whoever wrote it and for nobody else.
 *
 * Nothing is precomputed into data/robots.json: a URDF is a few tens of
 * kilobytes and the meshes — the twenty megabytes — are never asked for, so six
 * machines cost less than opening one of them on its detail page.
 */
import { categoryLabel, t } from './i18n.js';
import { CUSTOM_ID, customEntry } from './custom.js';
import { formatBytes, urdfUrl, variantView } from './registry.js';
import { loadUrdfSpec } from './urdf-spec.js';
import { align, defaultMode, fingerOrder, limbs, REGION_ORDER, SIDE_ORDER } from './joint-align.js';

const el = (id) => document.getElementById(id);
const comparable = (robot) => robot?.formats?.includes('urdf');

/**
 * As many columns as a table can carry and still be read across. Past six the
 * numbers are there but the comparison is not: a row is only a comparison for
 * as long as its cells can be seen at once.
 */
export const MAX_PICKS = 6;

const DEG = 180 / Math.PI;

/** Upstream names — of robots, of joints, of licences — never reach the DOM raw. */
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

function round(value, digits = 2) {
  if (!isNum(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(value, digits = 2) {
  if (!isNum(value)) return '—';
  const rounded = round(value, digits);
  return Math.abs(rounded) >= 1000 ? rounded.toLocaleString('en-US') : String(rounded);
}

/** An angle in whichever unit the toolbar is on; a slide is always in metres. */
function angle(value, unit, digits = 1) {
  if (!isNum(value)) return '—';
  return unit === 'rad' ? `${fmt(value, 3)} rad` : `${fmt(value * DEG, digits)}°`;
}

const jointIsLinear = (joint) => joint.type === 'prismatic';

function travelText(joint, unit) {
  if (joint.type === 'continuous') return t('limit.continuous');
  if (!joint.hasLimit) return t('limit.none');
  if (jointIsLinear(joint)) return `${fmt(joint.lower, 3)} … ${fmt(joint.upper, 3)} m`;
  return `${angle(joint.lower, unit)} … ${angle(joint.upper, unit)}`;
}

function velocityText(joint, unit) {
  if (!isNum(joint.velocity) || joint.velocity <= 0) return '—';
  if (jointIsLinear(joint)) return `${fmt(joint.velocity, 3)} m/s`;
  return unit === 'rad'
    ? `${fmt(joint.velocity, 2)} rad/s`
    : `${fmt(joint.velocity * DEG, 0)} °/s`;
}

/** How far a joint travels, in its own kind of unit: an angle, or a distance. */
function travelAmount(joint, unit) {
  if (!isNum(joint.travel)) return '—';
  return jointIsLinear(joint) ? `${fmt(joint.travel, 3)} m` : angle(joint.travel, unit);
}

function effortText(joint) {
  if (!isNum(joint.effort) || joint.effort <= 0) return '—';
  return `${fmt(joint.effort, 1)} ${jointIsLinear(joint) ? 'N' : 'N·m'}`;
}

/** What one joint reads as under the metric the table is showing. */
function cellText(joint, metric, unit) {
  if (metric === 'range') return travelText(joint, unit);
  if (metric === 'velocity') return velocityText(joint, unit);
  if (metric === 'effort') return effortText(joint);
  return isNum(joint.power) ? `${fmt(joint.power, 0)} W` : '—';
}

/* ── what one description is worth as numbers ───────────────────────────── */

/**
 * Everything the overview table reads, worked out once per column.
 *
 * The registry supplies what only the meshes can say — the measured height and
 * bounding box, which no URDF declares — and the parsed description supplies
 * the rest.
 */
function metricsFor(robot, spec) {
  const totals = spec.totals;
  const parts = limbs(spec, { category: robot.category });
  const byRegion = (region) => parts.filter((limb) => limb.region === region);
  const mean = (values) => {
    const good = values.filter(isNum);
    return good.length ? good.reduce((a, b) => a + b, 0) / good.length : null;
  };

  const legs = byRegion('leg');
  const arms = byRegion('arm');
  /** The straight line between the first joints of two limbs: a stance, a span. */
  const between = (a, b) => {
    if (!a?.first || !b?.first) return null;
    return Math.hypot(a.first[0] - b.first[0], a.first[1] - b.first[1], a.first[2] - b.first[2]);
  };
  const side = (list, want) => list.find((limb) => limb.side === want) || null;
  const lateral =
    between(side(legs, 'left'), side(legs, 'right')) ?? between(side(legs, 'FL'), side(legs, 'FR'));
  const longitudinal = between(side(legs, 'FL'), side(legs, 'RL'));
  const shoulders = between(side(arms, 'left'), side(arms, 'right'));

  const measured = robot.measured || null;
  const mass = totals.mass;
  /** What a set of limbs weighs together, and what share of the machine that is. */
  const carried = (list) => {
    const total = list.reduce((sum, limb) => sum + (limb.mass || 0), 0);
    return total > 0 ? { kg: total, share: mass ? total / mass : null } : null;
  };

  return {
    dof: robot.dof || totals.moving,
    moving: totals.moving,
    links: totals.links,
    fixed: totals.fixed,
    revolute: totals.revolute,
    continuous: totals.continuous,
    prismatic: totals.prismatic,
    mimic: totals.mimic,

    mass,
    height: measured?.height_m ?? null,
    size: measured?.size ? [measured.size.x, measured.size.y, measured.size.z] : null,
    massPerHeight: mass && measured?.height_m ? mass / measured.height_m : null,

    effortSum: totals.effortSum || null,
    effortPeak: totals.effortPeak,
    velocityPeak: totals.velocityPeak,
    powerPeak: totals.powerPeak,
    powerSum: totals.powerSum || null,
    torqueDensity: mass && totals.effortSum ? totals.effortSum / mass : null,

    travelSum: totals.travelSum || null,
    travelMean: totals.travelMean,
    noLimit: totals.noLimit,
    noEffort: totals.noEffort,
    noVelocity: totals.noVelocity,

    legMass: carried(legs),
    armMass: carried(arms),

    legDof: legs.length ? mean(legs.map((limb) => limb.dof)) : null,
    legEffort: legs.length ? mean(legs.map((limb) => limb.effort)) : null,
    legLength: legs.length ? mean(legs.map((limb) => limb.length)) : null,
    armDof: arms.length ? mean(arms.map((limb) => limb.dof)) : null,
    armEffort: arms.length ? mean(arms.map((limb) => limb.effort)) : null,
    armLength: arms.length ? mean(arms.map((limb) => limb.length)) : null,
    lateral,
    longitudinal,
    shoulders,

    massLinks: totals.massLinks,
    inertiaLinks: totals.inertiaLinks,
    collisionLinks: totals.collisionLinks,
    urdfBytes: spec.bytes || robot.urdf?.bytes || null,
    meshFiles: robot.assets?.mesh_files ?? null,
    meshBytes: robot.assets?.mesh_bytes ?? null,
    meshFormats: (robot.assets?.mesh_formats || []).join(' / '),
    formats: (robot.formats || []).map((f) => f.toUpperCase()).join(' / '),
    license: robot.license || null,
    repo: robot.source?.github || null,
    commit: robot.source?.commit || null,
    treeUrl: robot.source?.tree_url || null,
    // Set instead of the three above for a model read from an archive that
    // re-hosts it, which has no repository and no revision to pin.
    mirror: robot.source?.mirror || null,
    asymmetry: asymmetry(robot, spec),
    limbs: parts,
  };
}

/**
 * How many joints the description gives one side of a machine and not the
 * other, or gives both sides different limits.
 *
 * A left and a right leg are built the same way and upstream nearly always
 * declares them the same way; where they differ it is usually a typo in the
 * URDF rather than a fact about the robot, and it is worth knowing before a
 * number off this page ends up in a controller.
 */
function asymmetry(robot, spec) {
  const { groups } = align([{ id: 'one', spec, category: robot.category }], 'anatomy');
  const rows = new Map();
  for (const group of groups) {
    for (const row of group.rows) {
      const mirror =
        { left: 'right', right: 'left', FL: 'FR', FR: 'FL', RL: 'RR', RR: 'RL' }[row.side] || null;
      if (!mirror) continue;
      const cell = row.cells.get('one');
      if (!cell) continue;
      const key = `${row.region}|${row.segment}|${row.axis}|${row.step ?? ''}|${row.dup}`;
      if (!rows.has(key)) rows.set(key, new Map());
      rows.get(key).set(row.side, cell.joint);
    }
  }
  let pairs = 0;
  let differing = 0;
  const near = (a, b) => {
    if (!isNum(a) && !isNum(b)) return true;
    if (!isNum(a) || !isNum(b)) return false;
    // Mirrored joints often declare mirrored ranges, so it is the width of the
    // travel and the size of the limits that have to match, not their signs.
    return Math.abs(Math.abs(a) - Math.abs(b)) <= Math.abs(a) * 0.02 + 1e-6;
  };
  for (const sides of rows.values()) {
    const seen = [...sides.entries()];
    for (const [sideName, joint] of seen) {
      const mirror =
        { left: 'right', right: 'left', FL: 'FR', FR: 'FL', RL: 'RR', RR: 'RL' }[sideName];
      const other = sides.get(mirror);
      if (!other || sideName > mirror) continue; // count each pair once
      pairs += 1;
      if (!near(joint.travel, other.travel) || !near(joint.effort, other.effort)) differing += 1;
    }
  }
  return { pairs, differing };
}

/* ── the rows of the overview ───────────────────────────────────────────── */

/**
 * One table of the whole machine, in six blocks. `value` is what a bar and a
 * CSV column are drawn from; `text` is what the cell says. A row every column
 * leaves empty is dropped rather than shown as six dashes.
 */
/** A limb's share of the machine: what it weighs, and how much of the whole. */
function shareText(carried) {
  if (!carried) return '—';
  const share = isNum(carried.share) ? `<br><span class="sub">${fmt(carried.share * 100, 0)}%</span>` : '';
  return `${fmt(carried.kg, 2)} kg${share}`;
}

function overviewRows(unit) {
  const nOf = (value) => (isNum(value) ? String(value) : '—');
  const angleSum = (value) => (isNum(value) ? angle(value, unit, 0) : '—');
  return [
    {
      group: 'scale',
      rows: [
        { key: 'dof', value: (m) => m.dof, text: (m) => nOf(m.dof), bar: true },
        {
          key: 'jointTypes',
          value: (m) => m.moving,
          text: (m) =>
            [
              m.revolute ? `${m.revolute} × ${t('jt.revolute')}` : '',
              m.continuous ? `${m.continuous} × ${t('jt.continuous')}` : '',
              m.prismatic ? `${m.prismatic} × ${t('jt.prismatic')}` : '',
            ]
              .filter(Boolean)
              .join('<br>') || '—',
        },
        { key: 'links', value: (m) => m.links, text: (m) => nOf(m.links), bar: true },
        { key: 'fixed', value: (m) => m.fixed, text: (m) => nOf(m.fixed) },
        { key: 'mimic', value: (m) => m.mimic, text: (m) => nOf(m.mimic), skipZero: true },
      ],
    },
    {
      group: 'size',
      rows: [
        { key: 'mass', value: (m) => m.mass, text: (m) => (isNum(m.mass) ? `${fmt(m.mass, 2)} kg` : '—'), bar: true },
        {
          key: 'height',
          value: (m) => m.height,
          text: (m) => (isNum(m.height) ? `${fmt(m.height, 3)} m` : '—'),
          bar: true,
        },
        {
          key: 'bbox',
          value: (m) => (m.size ? m.size[0] * m.size[1] * m.size[2] : null),
          text: (m) =>
            m.size ? `${fmt(m.size[0], 2)} × ${fmt(m.size[2], 2)} × ${fmt(m.size[1], 2)} m` : '—',
        },
        {
          key: 'massPerHeight',
          value: (m) => m.massPerHeight,
          text: (m) => (isNum(m.massPerHeight) ? `${fmt(m.massPerHeight, 1)} kg/m` : '—'),
          bar: true,
        },
        {
          key: 'legMass',
          value: (m) => m.legMass?.share ?? null,
          text: (m) => shareText(m.legMass),
          bar: true,
        },
        {
          key: 'armMass',
          value: (m) => m.armMass?.share ?? null,
          text: (m) => shareText(m.armMass),
          bar: true,
        },
      ],
    },
    {
      group: 'actuation',
      rows: [
        {
          key: 'effortSum',
          value: (m) => m.effortSum,
          text: (m) => (isNum(m.effortSum) ? `${fmt(m.effortSum, 0)} N·m` : '—'),
          bar: true,
        },
        {
          key: 'effortPeak',
          value: (m) => m.effortPeak?.value ?? null,
          text: (m) =>
            m.effortPeak
              ? `${fmt(m.effortPeak.value, 1)} N·m<br><span class="sub">${esc(m.effortPeak.joint)}</span>`
              : '—',
          bar: true,
        },
        {
          key: 'velocityPeak',
          value: (m) => m.velocityPeak?.value ?? null,
          text: (m) =>
            m.velocityPeak
              ? `${unit === 'rad' ? `${fmt(m.velocityPeak.value, 2)} rad/s` : `${fmt(m.velocityPeak.value * DEG, 0)} °/s`}` +
                `<br><span class="sub">${esc(m.velocityPeak.joint)}</span>`
              : '—',
          bar: true,
        },
        {
          key: 'powerPeak',
          value: (m) => m.powerPeak?.value ?? null,
          text: (m) =>
            m.powerPeak
              ? `${fmt(m.powerPeak.value, 0)} W<br><span class="sub">${esc(m.powerPeak.joint)}</span>`
              : '—',
          bar: true,
        },
        {
          key: 'powerSum',
          value: (m) => m.powerSum,
          text: (m) => (isNum(m.powerSum) ? `${fmt(m.powerSum, 0)} W` : '—'),
          bar: true,
        },
        {
          key: 'torqueDensity',
          value: (m) => m.torqueDensity,
          text: (m) => (isNum(m.torqueDensity) ? `${fmt(m.torqueDensity, 1)} N·m/kg` : '—'),
          bar: true,
        },
      ],
    },
    {
      group: 'range',
      rows: [
        { key: 'travelSum', value: (m) => m.travelSum, text: (m) => angleSum(m.travelSum), bar: true },
        { key: 'travelMean', value: (m) => m.travelMean, text: (m) => angleSum(m.travelMean), bar: true },
        { key: 'noLimit', value: (m) => m.noLimit, text: (m) => nOf(m.noLimit), skipZero: true },
      ],
    },
    {
      group: 'geometry',
      rows: [
        { key: 'legDof', value: (m) => m.legDof, text: (m) => (isNum(m.legDof) ? fmt(m.legDof, 1) : '—') },
        {
          key: 'legLength',
          value: (m) => m.legLength,
          text: (m) => (isNum(m.legLength) ? `${fmt(m.legLength, 3)} m` : '—'),
          bar: true,
        },
        {
          key: 'legEffort',
          value: (m) => m.legEffort,
          text: (m) => (isNum(m.legEffort) ? `${fmt(m.legEffort, 0)} N·m` : '—'),
          bar: true,
        },
        { key: 'armDof', value: (m) => m.armDof, text: (m) => (isNum(m.armDof) ? fmt(m.armDof, 1) : '—') },
        {
          key: 'armLength',
          value: (m) => m.armLength,
          text: (m) => (isNum(m.armLength) ? `${fmt(m.armLength, 3)} m` : '—'),
          bar: true,
        },
        {
          key: 'armEffort',
          value: (m) => m.armEffort,
          text: (m) => (isNum(m.armEffort) ? `${fmt(m.armEffort, 0)} N·m` : '—'),
          bar: true,
        },
        {
          key: 'lateral',
          value: (m) => m.lateral,
          text: (m) => (isNum(m.lateral) ? `${fmt(m.lateral, 3)} m` : '—'),
          bar: true,
        },
        {
          key: 'longitudinal',
          value: (m) => m.longitudinal,
          text: (m) => (isNum(m.longitudinal) ? `${fmt(m.longitudinal, 3)} m` : '—'),
          bar: true,
        },
        {
          key: 'shoulders',
          value: (m) => m.shoulders,
          text: (m) => (isNum(m.shoulders) ? `${fmt(m.shoulders, 3)} m` : '—'),
          bar: true,
        },
      ],
    },
    {
      group: 'quality',
      rows: [
        {
          key: 'massLinks',
          value: (m) => m.massLinks,
          text: (m) => `${m.massLinks} / ${m.links}`,
        },
        {
          key: 'inertiaLinks',
          value: (m) => m.inertiaLinks,
          text: (m) => `${m.inertiaLinks} / ${m.links}`,
        },
        {
          key: 'collisionLinks',
          value: (m) => m.collisionLinks,
          text: (m) => `${m.collisionLinks} / ${m.links}`,
        },
        { key: 'noEffort', value: (m) => m.noEffort, text: (m) => nOf(m.noEffort) },
        { key: 'noVelocity', value: (m) => m.noVelocity, text: (m) => nOf(m.noVelocity) },
        {
          key: 'asymmetry',
          value: (m) => m.asymmetry.differing,
          text: (m) =>
            m.asymmetry.pairs
              ? `${m.asymmetry.differing} / ${m.asymmetry.pairs}`
              : '—',
        },
      ],
    },
    {
      group: 'source',
      rows: [
        { key: 'formats', value: () => null, text: (m) => esc(m.formats) || '—' },
        {
          key: 'meshes',
          value: (m) => m.meshBytes,
          text: (m) =>
            isNum(m.meshFiles)
              ? `${m.meshFiles} × ${esc(m.meshFormats) || '—'}<br><span class="sub">${formatBytes(m.meshBytes)}</span>`
              : '—',
        },
        {
          key: 'urdfBytes',
          value: (m) => m.urdfBytes,
          text: (m) => (isNum(m.urdfBytes) ? formatBytes(m.urdfBytes) : '—'),
        },
        { key: 'license', value: () => null, text: (m) => esc(m.license || '—') },
        {
          key: 'upstream',
          value: () => null,
          text: (m) => {
            if (m.repo) {
              return (
                `<a href="${esc(m.treeUrl || `https://github.com/${m.repo}`)}" target="_blank" rel="noopener noreferrer">${esc(m.repo)}</a>` +
                `<br><span class="sub">${esc((m.commit || '').slice(0, 10))}</span>`
              );
            }
            if (m.mirror) {
              return (
                `<a href="${esc(m.mirror.site)}" target="_blank" rel="noopener noreferrer">${esc(m.mirror.host)}</a>` +
                `<br><span class="sub">${esc(t('cmp.mirror'))}</span>`
              );
            }
            return '—';
          },
        },
      ],
    },
  ];
}

/* ── the view ───────────────────────────────────────────────────────────── */

export class Compare {
  /**
   * @param {object} data registry
   * @param {(state: object) => void} onStateChange writes the address bar
   */
  constructor(data, onStateChange) {
    this.data = data;
    this.onStateChange = onStateChange || (() => {});
    this.category = data.categories[0]?.id || 'humanoid';
    /** @type {{robot: string, variant: ?string}[]} */
    this.picks = [];
    this.filter = '';
    this.mode = null; // null = whichever reading suits the selection
    this.metric = 'range';
    this.unit = 'deg';
    this.sharedOnly = false;
    this.showNames = true;
    /** @type {Map<string, {spec?: object, error?: string}>} */
    this.loaded = new Map();
    /** The picked file the local column was last parsed from; see dropStaleLocal. */
    this.localEntry = null;
    /** How many fetches are in flight, so the last one to land clears the line. */
    this.loading = 0;
    this.bound = false;
  }

  /* -- addressing ------------------------------------------------------- */

  /** The selection as it travels in the address bar: `g1.g1_23dof,h1,h1_2`. */
  get ids() {
    return this.picks.map((pick) => (pick.variant ? `${pick.robot}.${pick.variant}` : pick.robot));
  }

  state() {
    return { category: this.category, ids: this.ids };
  }

  /**
   * One id, whether it names a robot of the gallery or the file the visitor
   * picked off their own disk. The picked one is not in `data.robots` and never
   * will be — it belongs to this tab — so it is looked up where it lives.
   */
  find(id) {
    if (id === CUSTOM_ID) return customEntry();
    return this.data.robots.find((robot) => robot.id === id && comparable(robot)) || null;
  }

  /**
   * Robots of the selected category, honouring the picker's own search box —
   * and, first in the list, whatever the visitor has open from their own disk.
   * That one is offered under every category rather than under its own: a file
   * off a disk is compared against the machines it is meant to be like, and
   * which of them that is, is the visitor's to say.
   */
  candidates() {
    const query = this.filter.trim().toLowerCase();
    const list = this.data.robots.filter(
      (robot) =>
        comparable(robot) && robot.category === this.category && (!query || robot._haystack.includes(query)),
    );
    const local = customEntry();
    if (local && (!query || local.name.toLowerCase().includes(query))) list.unshift(local);
    return list;
  }

  /**
   * The chosen robots, with the version each was chosen at.
   *
   * The picked file is read as whatever kind of machine this comparison is of.
   * Everything downstream — which joint is which, what counts as a limb, which
   * of the two readings the page opens on — asks the entry what category it is,
   * and `custom` would answer "none of them" and place none of its joints.
   */
  entries() {
    return this.picks
      .map((pick) => {
        const robot = this.find(pick.robot);
        if (!robot) return null;
        const view = variantView(robot, pick.variant);
        return {
          key: view.id,
          pick,
          model: robot,
          robot: robot.local ? { ...view, category: this.category } : view,
        };
      })
      .filter(Boolean);
  }

  has(id) {
    return this.picks.some((pick) => pick.robot === id);
  }

  toggle(id) {
    if (!this.find(id)) return;
    if (this.has(id)) this.picks = this.picks.filter((pick) => pick.robot !== id);
    else if (this.picks.length < MAX_PICKS) this.picks.push({ robot: id, variant: null });
    this.commit();
  }

  /**
   * Add one robot to the selection from somewhere else on the site — the button
   * on its detail page. Its category becomes the comparison's, because a
   * comparison is of one kind of machine; picking a quadruped while three
   * humanoids are selected starts a new comparison rather than a mixed one.
   * The picked file is the exception, having no category to impose: it joins
   * the comparison already open.
   */
  add(robot, variantId = null) {
    if (!robot.local && robot.category !== this.category) {
      this.category = robot.category;
      this.picks = [];
    }
    const id = robot.local ? CUSTOM_ID : robot.id;
    const already = this.picks.find((pick) => pick.robot === id);
    if (already) already.variant = variantId;
    else if (this.picks.length < MAX_PICKS) this.picks.push({ robot: id, variant: variantId });
  }

  commit() {
    this.onStateChange(this.state());
    this.render();
  }

  /* -- lifecycle -------------------------------------------------------- */

  /**
   * Open the page on a selection, usually the one in the address bar.
   * @param {{category?: string, ids?: string[]}} state
   */
  async show(state = {}) {
    this.setup();
    const categories = new Set(this.data.categories.map((c) => c.id));
    if (state.category && categories.has(state.category)) this.category = state.category;
    else if (state.ids?.length) {
      // An address that names robots but no category — one typed by hand rather
      // than one this page wrote — takes its category from the first of them,
      // instead of quietly dropping every id for belonging to another. The
      // picked file has no category to lend, so the first that has one speaks.
      const first = state.ids
        .map((raw) =>
          this.data.robots.find(
            (robot) => robot.id === raw.split('.')[0] && comparable(robot),
          ),
        )
        .find(Boolean);
      if (first) this.category = first.category;
    }
    if (state.ids) {
      this.picks = state.ids
        .map((raw) => {
          const [robotId, variantId] = raw.split('.');
          // An address naming the picked file is one this tab wrote, and it is
          // only good in this tab: opened after a reload, or on another
          // machine, there are no files behind it, and the column goes rather
          // than the whole comparison.
          if (robotId === CUSTOM_ID) return customEntry() ? { robot: CUSTOM_ID, variant: null } : null;
          const robot = this.data.robots.find((r) => r.id === robotId && comparable(r));
          if (!robot || robot.category !== this.category) return null;
          const variant = (robot.variants || []).some((v) => v.id === variantId)
            ? variantId
            : null;
          return { robot: robotId, variant };
        })
        .filter(Boolean)
        .slice(0, MAX_PICKS);
    }
    await this.render();
  }

  setup() {
    if (this.bound) return;
    this.bound = true;

    const category = el('compare-category');
    category.innerHTML = this.data.categories
      .map((c) => {
        const count = this.data.robots.filter(
          (robot) => comparable(robot) && robot.category === c.id,
        ).length;
        return count
          ? `<option value="${c.id}">${esc(categoryLabel(c.id, this.data.categories))} (${count})</option>`
          : '';
      })
      .join('');
    category.addEventListener('change', () => {
      this.category = category.value;
      // Changing the kind of machine starts a new comparison — except for the
      // visitor's own file, which is not of a kind. Being told what a model is
      // most like is a reason to try it against one category and then another,
      // and re-picking it every time would be the page arguing with that.
      this.picks = this.picks.filter((pick) => pick.robot === CUSTOM_ID);
      this.commit();
    });

    const filter = el('compare-filter');
    filter.addEventListener('input', () => {
      this.filter = filter.value;
      this.renderPicker();
    });

    el('compare-list').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-id]');
      if (button) this.toggle(button.dataset.id);
    });

    el('compare-chips').addEventListener('click', (event) => {
      const drop = event.target.closest('button[data-drop]');
      if (drop) this.toggle(drop.dataset.drop);
    });
    el('compare-chips').addEventListener('change', (event) => {
      const select = event.target.closest('select[data-variant-of]');
      if (!select) return;
      const pick = this.picks.find((entry) => entry.robot === select.dataset.variantOf);
      if (!pick) return;
      pick.variant = select.value || null;
      this.commit();
    });

    el('compare-clear').addEventListener('click', () => {
      this.picks = [];
      this.commit();
    });

    // The joint table's own controls: which number to show, in which unit, read
    // which way, and whether to hide the joints only one machine has.
    el('compare-tools').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-set]');
      if (!button) return;
      const [field, value] = button.dataset.set.split(':');
      if (field === 'mode') this.mode = value;
      if (field === 'metric') this.metric = value;
      if (field === 'unit') this.unit = value;
      if (field === 'shared') this.sharedOnly = !this.sharedOnly;
      if (field === 'names') this.showNames = !this.showNames;
      this.renderTables();
    });

    el('compare-copy').addEventListener('click', () => this.copyMarkdown());
    el('compare-csv').addEventListener('click', () => this.downloadCsv());
  }

  async render() {
    this.dropStaleLocal();
    this.renderPicker();
    const entries = this.entries();
    el('compare-empty').hidden = entries.length >= 2;
    el('compare-body').hidden = entries.length < 2;
    if (entries.length < 2) {
      el('compare-status').hidden = true;
      return;
    }
    await this.loadAll(entries);
    this.renderTables();
  }

  /**
   * The file behind the local column can be swapped for another without ever
   * leaving the tab — the picker is two clicks from here — and it keeps the one
   * id. So what was parsed from the last one has to go when it does, or the
   * column would go on showing a model the visitor has replaced.
   */
  dropStaleLocal() {
    const local = customEntry();
    if (local === this.localEntry) return;
    this.localEntry = local;
    this.loaded.delete(CUSTOM_ID);
  }

  /** Fetch every description that is not already parsed, all at once. */
  async loadAll(entries) {
    const missing = entries.filter((entry) => !this.loaded.has(entry.key));
    const status = el('compare-status');
    if (!missing.length) return;
    this.loading += 1;
    status.hidden = false;
    status.textContent = t('compare.loading').replace('{n}', missing.length);
    await Promise.all(
      missing.map(async (entry) => {
        try {
          const spec = await loadUrdfSpec(urdfUrl(entry.robot));
          this.loaded.set(entry.key, { spec });
        } catch (err) {
          this.loaded.set(entry.key, { error: String(err.message || err) });
        }
      }),
    );
    // Picking quickly leaves several of these in flight at once; the line comes
    // down when the last of them lands, not when the first does.
    this.loading -= 1;
    if (!this.loading) status.hidden = true;
  }

  /* -- the picker ------------------------------------------------------- */

  renderPicker() {
    const category = el('compare-category');
    if (category.value !== this.category) category.value = this.category;

    const picked = new Set(this.picks.map((pick) => pick.robot));
    const full = this.picks.length >= MAX_PICKS;
    const list = this.candidates();
    el('compare-list').innerHTML =
      list
        .map((robot) => {
          const on = picked.has(robot.id);
          const dof = robot.dof || robot.urdf.moving_joints;
          // The picked file has no thumbnail to ask for — nothing has rendered
          // it — and its second line says where it came from rather than who
          // makes it, there being no maker to name.
          const local = robot.local === true;
          const face = local
            ? `<span class="pick-local" aria-hidden="true">${esc(t('compare.yoursMark'))}</span>`
            : `<img src="./thumbs/${robot.id}.webp" alt="" loading="lazy" decoding="async"
                 onerror="this.style.visibility='hidden'">`;
          return `<button type="button" data-id="${robot.id}" aria-pressed="${on}"
            ${!on && full ? 'disabled' : ''}
            title="${esc(robot.name)} · ${esc(local ? t('compare.yours') : robot.maker || '')}">
            ${face}
            <span class="pick-name">${esc(robot.name)}</span>
            <span class="pick-sub">${esc(local ? t('compare.yours') : robot.maker || '—')}</span>
            <span class="pick-dof">${dof} ${t('unit.dof')}</span>
          </button>`;
        })
        .join('') || `<p class="empty">${t('gallery.empty')}</p>`;

    el('compare-chips').innerHTML = this.entries()
      .map((entry) => {
        const variants = entry.model.variants || [];
        const options = variants
          .map(
            (variant) =>
              `<option value="${esc(variant.id)}" ${variant.id === entry.robot.id ? 'selected' : ''}>${esc(variant.name)}</option>`,
          )
          .join('');
        return `<span class="pick-chip">
          <span class="chip-name">${esc(entry.model.name)}</span>
          ${
            variants.length > 1
              ? `<select data-variant-of="${entry.model.id}" aria-label="${esc(entry.model.name)} ${esc(t('version.label'))}">${options}</select>`
              : ''
          }
          <button type="button" data-drop="${entry.model.id}" aria-label="${esc(t('compare.remove'))}">✕</button>
        </span>`;
      })
      .join('');

    // A comparison is a link someone can send, and this one column of it is not
    // sendable: say so where the selection is made rather than let a recipient
    // find a column missing.
    const note = el('compare-local-note');
    note.hidden = !this.has(CUSTOM_ID);
    note.textContent = t('compare.localOnly');

    el('compare-count').textContent = t('compare.count')
      .replace('{n}', String(this.picks.length))
      .replace('{max}', String(MAX_PICKS));
    el('compare-clear').hidden = !this.picks.length;
  }

  /* -- the tables ------------------------------------------------------- */

  /** The columns, in the order they were picked, minus any that failed to load. */
  columns() {
    return this.entries()
      .map((entry) => {
        const state = this.loaded.get(entry.key) || {};
        return { ...entry, spec: state.spec || null, error: state.error || null };
      })
      .filter((entry) => entry.spec || entry.error);
  }

  renderTables() {
    const columns = this.columns();
    const good = columns.filter((column) => column.spec);
    for (const column of good) {
      column.metrics = metricsFor(column.robot, column.spec);
    }
    const failed = columns.filter((column) => column.error);
    el('compare-failed').innerHTML = failed.length
      ? failed
          .map(
            (column) =>
              `<p class="warn-line">${esc(column.robot.name)} — ${t('compare.failed')} <code>${esc(column.error)}</code></p>`,
          )
          .join('')
      : '';

    this.renderOverview(good);
    this.renderLimbs(good);
    this.renderJoints(good);
  }

  /** The column heads every table shares: thumbnail, name, a way back to it. */
  headCells(columns) {
    return columns
      .map((column) => {
        const model = column.model;
        const variant = column.robot.variant;
        const local = model.local === true;
        // The picked file has its own address, no thumbnail, and a file name
        // where a maker would go.
        const href = local
          ? '#custom=1'
          : `#robot=${model.id}${variant ? `&v=${encodeURIComponent(variant.id)}` : ''}`;
        const face = local
          ? `<span class="col-local" aria-hidden="true">${esc(t('compare.yoursMark'))}</span>`
          : `<img src="./thumbs/${model.id}.webp" alt="" loading="lazy" decoding="async"
                 onerror="this.style.visibility='hidden'">`;
        return `<th scope="col">
          <a class="col-head" href="${href}">
            ${face}
            <span class="col-name">${esc(model.name)}</span>
            <span class="col-sub">${esc(local ? t('compare.yours') : model.maker || '')}</span>
            ${
              local
                ? `<span class="col-variant">${esc(model.source.fileName)}</span>`
                : variant
                  ? `<span class="col-variant">${esc(variant.name)}</span>`
                  : ''
            }
          </a>
        </th>`;
      })
      .join('');
  }

  renderOverview(columns) {
    if (!columns.length) {
      el('compare-overview').innerHTML = '';
      return;
    }
    const blocks = overviewRows(this.unit);
    const body = blocks
      .map((block) => {
        const rows = block.rows
          .map((row) => {
            const values = columns.map((column) => row.value(column.metrics));
            const texts = columns.map((column) => row.text(column.metrics));
            const empty = texts.every((text) => text === '—');
            const allZero = row.skipZero && values.every((value) => !value);
            if (empty || allZero) return '';
            const max = Math.max(...values.filter(isNum).map(Math.abs), 0);
            const cells = columns
              .map((column, index) => {
                const value = values[index];
                const width = row.bar && max > 0 && isNum(value) ? (Math.abs(value) / max) * 100 : 0;
                const best = row.bar && isNum(value) && max > 0 && Math.abs(value) === max;
                return `<td class="${best ? 'is-max' : ''}">
                  <span class="cell-value">${texts[index]}</span>
                  ${row.bar ? `<span class="cell-bar"><i style="width:${width.toFixed(1)}%"></i></span>` : ''}
                </td>`;
              })
              .join('');
            return `<tr><th scope="row" title="${esc(t(`cmp.help.${row.key}`))}">${esc(t(`cmp.row.${row.key}`))}</th>${cells}</tr>`;
          })
          .join('');
        if (!rows) return '';
        return `<tr class="group-row"><th scope="rowgroup" colspan="${columns.length + 1}"><span>${esc(t(`cmp.group.${block.group}`))}</span></th></tr>${rows}`;
      })
      .join('');

    el('compare-overview').innerHTML = `
      <div class="panel-block-head">
        <h3>${esc(t('compare.overview'))}</h3>
        <span class="tree-summary">${esc(t('compare.overviewSub'))}</span>
      </div>
      <div class="table-scroll">
        <table class="cmp-table">
          <thead><tr><th scope="col" class="corner">${esc(t('compare.metric'))}</th>${this.headCells(columns)}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  /**
   * The limbs, one row per limb the anatomy could name on any of the machines —
   * and on a hand, one row per finger, because five fingers is what there is to
   * compare about a hand and a single row reading "hand" would be the machine.
   */
  renderLimbs(columns) {
    const host = el('compare-limbs');
    const keys = new Map();
    for (const column of columns) {
      for (const limb of column.metrics.limbs) {
        if (!keys.has(limb.key)) {
          keys.set(limb.key, { region: limb.region, side: limb.side, part: limb.part, key: limb.key });
        }
      }
    }
    const order = [...keys.values()].sort(
      (a, b) =>
        REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region) ||
        SIDE_ORDER.indexOf(a.side) - SIDE_ORDER.indexOf(b.side) ||
        fingerOrder(a.part) - fingerOrder(b.part),
    );
    // A machine with no limbs anyone can name — a six-axis arm, whose joints
    // are `joint_1`…`joint_6` — would get a table of one row that only one
    // column has anything in. That is not a comparison, so there is no table.
    const shared = order.filter(
      (slot) =>
        columns.filter((column) => column.metrics.limbs.some((limb) => limb.key === slot.key))
          .length >= 2,
    );
    if (order.length < 2 || !shared.length || columns.length < 2) {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const rows = order
      .map((slot) => {
        const cells = columns
          .map((column) => {
            const limb = column.metrics.limbs.find((entry) => entry.key === slot.key);
            if (!limb) return '<td class="is-absent">—</td>';
            return `<td>
              <span class="cell-value">${limb.dof} ${esc(t('unit.dof'))}</span>
              <span class="cell-sub">${limb.effort ? `${fmt(limb.effort, 0)} N·m` : '—'}${
                limb.length > 0 ? ` · ${fmt(limb.length, 3)} m` : ''
              }${limb.mass ? ` · ${fmt(limb.mass, 2)} kg` : ''}</span>
            </td>`;
          })
          .join('');
        return `<tr><th scope="row">${esc(groupLabel(slot))}</th>${cells}</tr>`;
      })
      .join('');
    host.innerHTML = `
      <div class="panel-block-head">
        <h3>${esc(t('compare.limbs'))}</h3>
        <span class="tree-summary">${esc(t('compare.limbsSub'))}</span>
      </div>
      <div class="table-scroll">
        <table class="cmp-table">
          <thead><tr><th scope="col" class="corner">${esc(t('compare.limb'))}</th>${this.headCells(columns)}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  /** Which reading of the joints is in force: the chosen one, or the fitting one. */
  activeMode(columns) {
    return this.mode || defaultMode(columns.map((c) => ({ id: c.key, spec: c.spec, category: c.robot.category })));
  }

  renderJoints(columns) {
    const host = el('compare-joints');
    if (columns.length < 2) {
      host.innerHTML = '';
      el('compare-tools').innerHTML = '';
      el('compare-coverage').textContent = '';
      return;
    }
    const mode = this.activeMode(columns);
    const entries = columns.map((column) => ({
      id: column.key,
      spec: column.spec,
      category: column.robot.category,
    }));
    const { groups, leftovers, coverage } = align(entries, mode);

    const rows = groups
      .map((group) => {
        const visible = group.rows.filter(
          (row) => !this.sharedOnly || row.cells.size === columns.length,
        );
        if (!visible.length) return '';
        return (
          // The label is wrapped because it has to stay put when the table is
          // scrolled sideways, and a cell that spans every column has no room
          // to be pinned in — see the rule in app.css.
          `<tr class="group-row"><th scope="rowgroup" colspan="${columns.length + 2}"><span>${esc(groupLabel(group))}</span></th></tr>` +
          visible.map((row) => this.jointRow(row, columns, group)).join('')
        );
      })
      .join('');

    const spare = leftovers
      .map((entry) => {
        const column = columns.find((c) => c.key === entry.id);
        return `<p class="leftover"><span class="leftover-name">${esc(column?.model.name || entry.id)}</span>
          <span class="leftover-list">${entry.joints.map((joint) => `<code>${esc(joint.name)}</code>`).join(' ')}</span></p>`;
      })
      .join('');

    const covered = columns
      .map((column) => {
        const stat = coverage.get(column.key);
        // Set with textContent below, which escapes on its own.
        return stat ? `${column.model.name} ${stat.matched}/${stat.total}` : '';
      })
      .filter(Boolean)
      .join(' · ');

    // The toolbar is not written here: it lives in a wrapper of its own that
    // outlives this rewrite, so the one listener bound in setup() keeps working.
    el('compare-coverage').textContent = covered;
    el('compare-tools').innerHTML = this.toolsHtml(mode);
    host.innerHTML = `
      <div class="table-scroll">
        <table class="cmp-table cmp-joints">
          <thead><tr>
            <th scope="col" class="corner">${esc(t('compare.joint'))}</th>
            ${this.headCells(columns)}
            <th scope="col" class="spread-col" title="${esc(t('cmp.help.spread'))}">${esc(t('compare.spread'))}</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="${columns.length + 2}" class="empty">${esc(t('compare.noRows'))}</td></tr>`}</tbody>
        </table>
      </div>
      ${
        spare
          ? `<details class="leftovers"><summary>${esc(t('compare.leftovers'))}</summary>${spare}</details>`
          : ''
      }
      <p class="cmp-note">${esc(mode === 'chain' ? t('compare.chainNote') : t('compare.anatomyNote'))}</p>`;
  }

  toolsHtml(mode) {
    const group = (field, options, active) =>
      `<div class="unit-toggle">${options
        .map(
          ([value, label, title]) =>
            `<button type="button" data-set="${field}:${value}" aria-pressed="${value === active}" title="${esc(title || label)}">${esc(label)}</button>`,
        )
        .join('')}</div>`;
    return (
      `<span class="tools-label">${esc(t('compare.show'))}</span>` +
      group(
        'metric',
        [
          ['range', t('limit.range'), t('limit.rangeFull')],
          ['velocity', t('limit.velocity'), t('limit.velocityFull')],
          ['effort', t('limit.effort'), t('limit.effortFull')],
          ['power', t('compare.power'), t('cmp.help.powerPeak')],
        ],
        this.metric,
      ) +
      `<span class="tools-label">${esc(t('compare.align'))}</span>` +
      group(
        'mode',
        [
          ['anatomy', t('compare.byAnatomy'), t('compare.anatomyNote')],
          ['chain', t('compare.byChain'), t('compare.chainNote')],
        ],
        mode,
      ) +
      group(
        'unit',
        [
          ['deg', 'deg', t('joints.unitDeg')],
          ['rad', 'rad', t('joints.unitRad')],
        ],
        this.unit,
      ) +
      `<button type="button" class="link-btn" data-set="shared:toggle" aria-pressed="${this.sharedOnly}">${esc(
        this.sharedOnly ? t('compare.showAllRows') : t('compare.sharedOnly'),
      )}</button>` +
      `<button type="button" class="link-btn" data-set="names:toggle" aria-pressed="${this.showNames}">${esc(
        this.showNames ? t('compare.hideNames') : t('compare.showNames'),
      )}</button>`
    );
  }

  /** One place on the body — or one step down a chain — across the columns. */
  jointRow(row, columns, group) {
    const metric = this.metric;
    // The last row of the group is the end of the chain and says so in its own
    // label; a machine whose chain ends earlier is marked in the cell instead,
    // which is how a four-knuckle thumb reads against a three-knuckle one.
    const lastRow = !group || row === group.rows[group.rows.length - 1];
    const values = columns.map((column) => {
      const cell = row.cells.get(column.key);
      return cell ? metricValue(cell.joint, metric) : null;
    });
    const numbers = values.filter((value) => isNum(value) && value > 0);
    const max = numbers.length ? Math.max(...numbers) : 0;
    const min = numbers.length ? Math.min(...numbers) : 0;

    // A travel is drawn where it actually lies, on one scale for the whole row:
    // two joints with the same 120° of travel are not the same joint if one of
    // them starts at zero and the other is centred on it.
    let low = 0;
    let high = 0;
    if (metric === 'range') {
      for (const column of columns) {
        const cell = row.cells.get(column.key);
        if (!cell || !cell.joint.hasLimit) continue;
        low = Math.min(low, cell.joint.lower);
        high = Math.max(high, cell.joint.upper);
      }
    }
    const span = high - low;

    const cells = columns
      .map((column, index) => {
        const cell = row.cells.get(column.key);
        if (!cell) return `<td class="is-absent">—</td>`;
        const joint = cell.joint;
        const value = values[index];
        const best = isNum(value) && value > 0 && value === max && numbers.length > 1;
        const name = this.showNames
          ? `<span class="cell-sub">${esc(joint.name)}${cell.inferred ? ` <i class="guess" title="${esc(t('compare.inferred'))}">~</i>` : ''}</span>`
          : '';
        // On a chain the row is a position and not an axis, so the axis each
        // machine turns about there is worth saying: one hand's second knuckle
        // pitches where another's rolls.
        const tags = row.step
          ? [
              cell.axis && cell.axis !== 'none'
                ? `<i class="axis-tag">${esc(t(`cmp.axis.${cell.axis}`))}</i>`
                : '',
              cell.tip && !lastRow
                ? `<i class="tip-tag" title="${esc(t('cmp.chain.tipTitle'))}">${esc(t('cmp.chain.tipShort'))}</i>`
                : '',
            ].join('')
          : '';
        const tagLine = tags ? `<span class="cell-tags">${tags}</span>` : '';
        if (metric === 'range') {
          const bar =
            joint.hasLimit && span > 0
              ? `<span class="range-bar">
                   <i style="left:${(((joint.lower - low) / span) * 100).toFixed(1)}%;width:${(((joint.upper - joint.lower) / span) * 100).toFixed(1)}%"></i>
                   <b style="left:${((-low / span) * 100).toFixed(1)}%"></b>
                 </span>`
              : '';
          return `<td class="${best ? 'is-max' : ''}" title="${esc(joint.name)}">
            <span class="cell-value">${esc(travelText(joint, this.unit))}</span>
            ${bar}
            <span class="cell-sub">${joint.hasLimit ? `${esc(t('compare.travel'))} ${esc(travelAmount(joint, this.unit))}` : ''}</span>
            ${tagLine}
            ${name}
          </td>`;
        }
        const text = cellText(joint, metric, this.unit);
        const width = max > 0 && isNum(value) ? (value / max) * 100 : 0;
        return `<td class="${best ? 'is-max' : ''}" title="${esc(joint.name)}">
          <span class="cell-value">${esc(text)}</span>
          <span class="cell-bar"><i style="width:${width.toFixed(1)}%"></i></span>
          ${tagLine}
          ${name}
        </td>`;
      })
      .join('');

    const spread = numbers.length > 1 && min > 0 ? `×${fmt(max / min, 1)}` : '';
    return `<tr><th scope="row">${esc(rowLabel(row, group))}</th>${cells}<td class="spread-col">${esc(spread)}</td></tr>`;
  }

  /* -- taking it away --------------------------------------------------- */

  /** The two tables as a grid of strings, which is what both exports need. */
  tableData() {
    const columns = this.columns().filter((column) => column.spec);
    for (const column of columns) {
      if (!column.metrics) column.metrics = metricsFor(column.robot, column.spec);
    }
    const strip = (html) =>
      String(html)
        .replace(/<br\s*\/?>/g, ' · ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const grid = [[t('compare.metric'), ...columns.map((column) => column.robot.name)]];
    for (const block of overviewRows(this.unit)) {
      grid.push([t(`cmp.group.${block.group}`), ...columns.map(() => '')]);
      for (const row of block.rows) {
        const texts = columns.map((column) => strip(row.text(column.metrics)));
        if (texts.every((text) => text === '—')) continue;
        grid.push([t(`cmp.row.${row.key}`), ...texts]);
      }
    }

    const mode = this.activeMode(columns);
    const { groups } = align(
      columns.map((column) => ({ id: column.key, spec: column.spec, category: column.robot.category })),
      mode,
    );
    grid.push([]);
    grid.push([
      `${t('compare.joints')} — ${t(`compare.${this.metric === 'range' ? 'metricRange' : this.metric}`)}`,
      ...columns.map(() => ''),
    ]);
    for (const group of groups) {
      const visible = group.rows.filter(
        (row) => !this.sharedOnly || row.cells.size === columns.length,
      );
      if (!visible.length) continue;
      grid.push([groupLabel(group), ...columns.map(() => '')]);
      for (const row of visible) {
        grid.push([
          rowLabel(row, group),
          ...columns.map((column) => {
            const cell = row.cells.get(column.key);
            if (!cell) return '—';
            return `${cellText(cell.joint, this.metric, this.unit)} (${cell.joint.name})`;
          }),
        ]);
      }
    }
    return grid;
  }

  async copyMarkdown() {
    const grid = this.tableData().filter((row) => row.length);
    const width = Math.max(...grid.map((row) => row.length));
    const pad = (row) => [...row, ...Array(width - row.length).fill('')];
    const lines = grid.map((row) => `| ${pad(row).map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`);
    lines.splice(1, 0, `|${' --- |'.repeat(width)}`);
    const text = lines.join('\n');
    const button = el('compare-copy');
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = t('panel.copied');
    } catch {
      button.textContent = t('compare.copyFailed');
    }
    setTimeout(() => {
      button.textContent = t('compare.copyMd');
    }, 1600);
  }

  downloadCsv() {
    const grid = this.tableData();
    const csv = grid
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    // A byte order mark, so the spreadsheet this lands in reads the degree
    // signs and the Chinese labels as UTF-8 rather than as the local codepage.
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    // `__local__` is an id, not a name anyone would want on a file.
    const names = this.picks.map((pick) => (pick.robot === CUSTOM_ID ? 'local' : pick.robot));
    link.download = `compare-${this.category}-${names.join('-')}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

/* ── labels ─────────────────────────────────────────────────────────────── */

/** A finger by name where the hand has one, by number where it does not. */
function partLabel(part) {
  const numbered = /^f(\d+)$/.exec(part);
  return numbered ? t('cmp.finger.n').replace('{n}', numbered[1]) : t(`cmp.seg.${part}`);
}

function groupLabel(group) {
  // A chain nothing could name — the six axes of an industrial arm — is the
  // chain it is: numbered, and the joint names in the cells say the rest.
  if (!group.region) return t('cmp.chain.title').replace('{n}', String(group.chain || 1));
  const region = t(`cmp.region.${group.region}`);
  const sided = !group.side || group.side === 'center'
    ? region
    : t('cmp.groupWith')
        .replace('{side}', t(`cmp.side.${group.side}`))
        .replace('{region}', region);
  if (!group.part) return sided;
  const part = partLabel(group.part);
  // A hand on its own is read as fingers and nothing else; a hand on a body
  // has to say which hand first.
  return !group.side || group.side === 'center'
    ? part
    : t('cmp.groupPart').replace('{group}', sided).replace('{part}', part);
}

/**
 * One row's place. Along a chain that is how far down the chain it is, with the
 * two ends named rather than numbered — the point of reading a finger or an arm
 * this way is that it starts somewhere and ends somewhere.
 */
function rowLabel(row, group) {
  if (row.step) {
    if (row.step === 1) return t('cmp.chain.root');
    if (group && row === group.rows[group.rows.length - 1]) return t('cmp.chain.tip');
    return t('cmp.chain.step').replace('{n}', String(row.step));
  }
  const segment = t(`cmp.seg.${row.segment}`);
  const axis = row.axis && row.axis !== 'none' ? t(`cmp.axis.${row.axis}`) : '';
  const ordinal = row.region === 'hand' && row.ordinal ? ` ${row.ordinal}` : '';
  const dup = row.dup > 1 ? ` (${row.dup})` : '';
  return `${segment}${ordinal}${axis ? ` ${axis}` : ''}${dup}`;
}

/** The number a joint contributes to the metric on show. */
function metricValue(joint, metric) {
  if (metric === 'range') return joint.travel;
  if (metric === 'velocity') return joint.velocity;
  if (metric === 'effort') return joint.effort;
  return joint.power;
}
