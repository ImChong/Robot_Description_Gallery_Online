#!/usr/bin/env node
/**
 * Headless check of the compare page.
 *
 *   node scripts/serve.mjs &
 *   node scripts/check_compare.mjs [--base http://localhost:8080]
 *
 * Two things are checked, both in a real browser because the parser this page
 * is built on is the browser's own DOMParser.
 *
 *   - The invariants of the alignment, on one selection per category: every
 *     joint of every description ends up either in exactly one row or in the
 *     leftovers, no row holds two joints of the same robot, and the joint a
 *     cell claims is a joint that description actually has. A heuristic that
 *     quietly drops or duplicates joints would still render a table that looks
 *     right, so this is the check that matters.
 *   - That the page itself draws: the three tables, the columns that were
 *     asked for, no failed downloads and no console errors.
 *
 * The URDFs come from the CDN, so this is a network test — and, like the
 * gallery's own smoke test, it catches an upstream that moved a file.
 */
import { launchBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const base = flag('--base', process.env.BASE_URL || 'http://localhost:8080');

/**
 * One selection per category the gallery has enough of to compare, chosen for
 * how differently upstream names their joints: `FL_hip_joint` against `LF_HAA`,
 * `left_knee_joint` against `Left_Knee_Pitch`.
 */
const CASES = [
  {
    category: 'humanoid',
    ids: ['g1', 'h1', 'booster_t1'],
    mode: 'anatomy',
    // Every joint of all three is named well enough to place; a change to the
    // dictionary that stops placing them should fail rather than pass quietly.
    minCoverage: 1,
  },
  { category: 'quadruped', ids: ['go2', 'anymal_c', 'solo'], mode: 'anatomy', minCoverage: 1 },
  { category: 'biped', ids: ['cassie', 'bolt'], mode: 'anatomy', minCoverage: 1 },
  { category: 'dual_arm', ids: ['baxter', 'yumi'], mode: 'anatomy', minCoverage: 0.9 },
  // An arm is numbered rather than named upstream, so the page is expected to
  // open on the other reading rather than to invent an anatomy for it.
  { category: 'arm', ids: ['panda', 'iiwa14', 'z1'], mode: 'chain', minCoverage: 0 },
  // A hand is fingers, and a finger is a chain whether or not upstream named
  // it: the Allegro's are `joint_0`…`joint_15` and Dex5-1's are `Roll_21R`, and
  // both have to come out as five chains read root to tip.
  {
    category: 'hand',
    ids: ['allegro_hand', 'dex5_1', 'ability_hand'],
    mode: 'anatomy',
    minCoverage: 1,
    fingers: ['thumb', 'index', 'middle', 'ring', 'pinky'],
  },
  { category: 'hand', ids: ['barrett_hand', 'robotiq_2f85'], mode: 'anatomy', minCoverage: 1 },
];

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(`${base}/web/`, { waitUntil: 'networkidle' });

let failures = 0;
let ran = 0;
const fail = (message) => {
  console.error(`  ✗ ${message}`);
  failures += 1;
};

for (const test of CASES) {
  const label = `${test.category}: ${test.ids.join(', ')}`;

  // ---- the alignment, checked against the parsed descriptions themselves ----
  const report = await page.evaluate(async ({ ids, modes }) => {
    const { urdfUrl, byId, loadRegistry } = await import('./js/registry.js');
    const { loadUrdfSpec } = await import('./js/urdf-spec.js');
    const { align, defaultMode } = await import('./js/joint-align.js');
    const data = await loadRegistry();

    const entries = [];
    for (const id of ids) {
      const robot = byId(data, id);
      if (!robot) return { missing: id };
      let spec;
      try {
        spec = await loadUrdfSpec(urdfUrl(robot));
      } catch (err) {
        return { error: `${id}: ${err.message || err}` };
      }
      entries.push({ id, spec, category: robot.category });
    }

    const problems = [];
    const perMode = {};
    for (const mode of modes) {
      const { groups, leftovers, coverage } = align(entries, mode);
      const placed = new Map(entries.map((entry) => [entry.id, new Map()]));
      let rows = 0;
      for (const group of groups) {
        for (const row of group.rows) {
          rows += 1;
          if (!row.cells.size) problems.push(`${mode}: a row with no cells in it`);
          for (const [id, cell] of row.cells) {
            const seen = placed.get(id);
            if (!seen) {
              problems.push(`${mode}: a cell for ${id}, which is not in this comparison`);
              continue;
            }
            if (seen.has(cell.joint.name)) {
              problems.push(`${mode}: ${id} ${cell.joint.name} is in two rows`);
            }
            seen.set(cell.joint.name, row);
          }
        }
      }
      for (const entry of entries) {
        const seen = placed.get(entry.id);
        const spare = leftovers.find((one) => one.id === entry.id)?.joints || [];
        for (const name of seen.keys()) {
          const joint = entry.spec.joints.find((one) => one.name === name);
          if (!joint) problems.push(`${mode}: ${entry.id} has no joint called ${name}`);
          else if (!joint.movable) problems.push(`${mode}: ${entry.id} ${name} does not move`);
        }
        const total = entry.spec.moving.length;
        if (seen.size + spare.length !== total) {
          problems.push(
            `${mode}: ${entry.id} has ${total} moving joints but ` +
              `${seen.size} placed + ${spare.length} left over`,
          );
        }
        const stat = coverage.get(entry.id);
        if (stat && stat.matched !== seen.size && mode === 'anatomy') {
          problems.push(`${mode}: ${entry.id} coverage says ${stat.matched}, rows hold ${seen.size}`);
        }
      }
      // A group whose rows are steps along a chain is only a chain if the steps
      // run 1, 2, 3 … and each machine walks its own joints down it in the
      // order the URDF hangs them, root first: a table that renumbered a
      // finger, or read one backwards, would still look perfectly aligned.
      for (const group of groups) {
        if (!group.steps) continue;
        const steps = group.rows.map((row) => row.step);
        if (steps.some((step, index) => step !== index + 1)) {
          problems.push(`${mode}: ${group.key} steps run ${steps.join(',')}`);
        }
        const walked = new Map();
        for (const row of group.rows) {
          for (const [id, cell] of row.cells) {
            const previous = walked.get(id);
            if (previous && cell.joint.branchIndex <= previous.branchIndex) {
              problems.push(
                `${mode}: ${group.key} reads ${id} ${previous.name} before ${cell.joint.name}`,
              );
            }
            walked.set(id, { name: cell.joint.name, branchIndex: cell.joint.branchIndex });
          }
        }
      }
      perMode[mode] = {
        rows,
        groups: groups.map((group) => ({
          key: group.key,
          part: group.part || null,
          steps: !!group.steps,
          depth: group.rows.length,
        })),
        coverage: entries.map((entry) => {
          const stat = coverage.get(entry.id);
          return { id: entry.id, matched: stat.matched, total: stat.total };
        }),
      };
    }
    return { problems, perMode, mode: defaultMode(entries) };
  }, { ids: test.ids, modes: ['anatomy', 'chain'] });

  // data/visibility.md decides what the site offers, and a robot unchecked
  // there has no card and no column. That is a reason to skip a case, not to
  // fail one — but the tally at the end still insists most of them ran.
  if (report.missing) {
    console.log(`  · ${label.padEnd(46)} skipped — ${report.missing} is not shown`);
    continue;
  }
  if (report.error) {
    fail(`${label} — ${report.error}`);
    continue;
  }
  ran += 1;
  for (const problem of report.problems) fail(`${label} — ${problem}`);
  if (report.mode !== test.mode) {
    fail(`${label} — opens on "${report.mode}", expected "${test.mode}"`);
  }
  const worst = Math.min(
    ...report.perMode.anatomy.coverage.map((one) => (one.total ? one.matched / one.total : 1)),
  );
  if (worst < test.minCoverage) {
    const short = report.perMode.anatomy.coverage
      .map((one) => `${one.id} ${one.matched}/${one.total}`)
      .join(', ');
    fail(`${label} — anatomy places only ${(worst * 100).toFixed(0)}% (${short})`);
  }
  if (!report.perMode[test.mode].rows) fail(`${label} — no rows in "${test.mode}"`);
  // The fingers a hand is expected to come out as, in the order a hand is read.
  if (test.fingers) {
    const found = report.perMode[test.mode].groups.map((group) => group.part);
    if (String(found) !== String(test.fingers)) {
      fail(`${label} — fingers came out as ${found.join(', ') || '(none)'}`);
    }
  }

  // ---- and that the page draws it ----------------------------------------
  await page.goto(`${base}/web/#compare=1&cat=${test.category}&ids=${test.ids.join(',')}`, {
    waitUntil: 'commit',
  });
  let drawn;
  try {
    drawn = await page
      .waitForFunction(
        (count) => {
          const body = document.getElementById('compare-body');
          if (!body || body.hidden) return false;
          const heads = document.querySelectorAll('#compare-overview thead th').length;
          const jointRows = document.querySelectorAll('#compare-joints tbody tr').length;
          if (heads !== count + 1 || !jointRows) return false;
          return {
            heads,
            jointRows,
            overviewRows: document.querySelectorAll('#compare-overview tbody tr').length,
            failed: document.getElementById('compare-failed').textContent.trim(),
            names: [...document.querySelectorAll('#compare-overview thead .col-name')].map(
              (node) => node.textContent,
            ),
          };
        },
        test.ids.length,
        { timeout: 120000, polling: 300 },
      )
      .then((handle) => handle.jsonValue());
  } catch {
    drawn = null;
  }
  if (!drawn) {
    fail(`${label} — the page did not draw ${test.ids.length} columns`);
    continue;
  }
  if (drawn.failed) fail(`${label} — ${drawn.failed}`);
  if (drawn.overviewRows < 20) fail(`${label} — only ${drawn.overviewRows} overview rows`);

  console.log(
    `  ✓ ${label.padEnd(46)} ${String(drawn.overviewRows).padStart(2)} metrics · ` +
      `${String(drawn.jointRows).padStart(3)} joint rows · opens ${report.mode}`,
  );
}

// The picker refuses to mix categories, which is the one rule the page has.
const mixed = await page.evaluate(async () => {
  const { loadRegistry } = await import('./js/registry.js');
  const { Compare } = await import('./js/compare.js');
  const data = await loadRegistry();
  const compare = new Compare(data, () => {});
  compare.category = 'humanoid';
  await compare.show({ category: 'humanoid', ids: ['g1', 'go2', 'h1'] });
  return compare.ids;
});
if (mixed.includes('go2')) fail(`a quadruped was accepted into a humanoid comparison: ${mixed}`);
else console.log(`  ✓ ${'a robot of another category is refused'.padEnd(46)} ${mixed.join(', ')}`);

const relevant = consoleErrors.filter((e) => !/favicon|thumbs\/.*404|Failed to load resource/.test(e));
if (relevant.length) {
  console.error(`\nconsole errors (${relevant.length}):`);
  for (const error of relevant.slice(0, 12)) console.error(`  ${error}`);
  failures += relevant.length;
}

await browser.close();
console.log(failures ? `\n${failures} problem(s)` : '\nall good');
if (ran < 4) {
  console.error(`only ${ran} case(s) ran — data/visibility.md may have hidden the robots this checks`);
  process.exitCode = 1;
}
if (failures) process.exitCode = 1;
