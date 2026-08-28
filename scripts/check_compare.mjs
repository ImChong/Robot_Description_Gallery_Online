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
 *   - And that a URDF handed to the page off a disk can be one of the columns:
 *     it is read as the kind of machine the comparison is of, it is dropped
 *     rather than fetched when an address names it in a tab that has no file
 *     behind it, and swapping the file swaps the column.
 *
 * The URDFs come from the CDN, so this is a network test — and, like the
 * gallery's own smoke test, it catches an upstream that moved a file.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

/* ── the visitor's own file as one of the columns ────────────────────────── */

/** Hand files to the picker and put what they describe on the stage, as a visitor would. */
async function pick(paths) {
  await page.goto(`${base}/web/`, { waitUntil: 'networkidle' });
  await page.click('#custom-open');
  await page.waitForSelector('#custom-dialog[open]', { timeout: 30000 });
  await page.setInputFiles('#custom-files', paths);
  await page.waitForFunction(() => !document.getElementById('custom-go').disabled, null, {
    timeout: 60000,
  });
  await page.click('#custom-go');
  await page.waitForFunction(() => document.getElementById('d-name').textContent !== '—', null, {
    timeout: 60000,
  });
}

/** What the stage measured the picked model to be, once it has finished loading. */
async function pickedMeasurement() {
  await page.waitForFunction(
    () => document.querySelector('#canvas-host')?.parentElement?.dataset.loaded,
    null,
    { timeout: 180000, polling: 400 },
  );
  return page.evaluate(async () => (await import('./js/custom.js')).customEntry()?.measured ?? null);
}

/**
 * A model picked off a disk has no category of its own worth honouring, so it
 * is read as whatever the comparison is of — which is the whole reason it can
 * be lined up at all: `custom` matches no anatomy and would place no joints.
 * H1's own description stands in for a visitor's file here, so what the local
 * column reads has an answer in the table beside it.
 */
{
  const label = 'local: a picked file beside the gallery';
  const url = await page.evaluate(async () => {
    const { urdfUrl, byId, loadRegistry } = await import('./js/registry.js');
    const robot = byId(await loadRegistry(), 'h1');
    return robot ? urdfUrl(robot) : null;
  });
  if (!url) {
    console.log(`  · ${label.padEnd(46)} skipped — h1 is not shown`);
  } else {
    const file = join(mkdtempSync(join(tmpdir(), 'rug-local-')), 'my_robot.urdf');
    writeFileSync(file, await (await fetch(url)).text());
    const drawn = () =>
      page.waitForFunction(
        () => {
          const body = document.getElementById('compare-body');
          return !!body && !body.hidden && !!document.querySelector('#compare-joints tbody tr');
        },
        null,
        { timeout: 120000, polling: 300 },
      );
    const heads = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#compare-overview thead .col-name')].map((n) => n.textContent),
      );
    await pick(file);
    // The way in is the button on its own detail page, which the gallery's
    // robots use too — prev/next are what a picked model has no use for.
    await page.click('#add-compare');
    await page.waitForFunction(() => location.hash.includes('compare=1'), null, { timeout: 30000 });
    // Changing the kind of machine keeps it: it is not of a kind.
    await page.selectOption('#compare-category', 'quadruped');
    await page.selectOption('#compare-category', 'humanoid');
    await page.click('#compare-list button[data-id="g1"]');
    await drawn();

    // A description with none of its meshes beside it measures nothing. The
    // height and the bounding box are read off geometry, and half a robot would
    // measure half a robot — a blank is the honest answer, and a wrong height
    // in a table of comparisons is worse than a missing one.
    const bare = await page.evaluate(async () =>
      (await import('./js/custom.js')).customEntry()?.measured ?? null,
    );
    if (bare) fail(`${label} — a description with no meshes measured ${JSON.stringify(bare)}`);

    const local = await page.evaluate(() => {
      const coverage = document.getElementById('compare-coverage').textContent;
      return {
        hash: location.hash,
        coverage,
        note: !document.getElementById('compare-local-note').hidden,
        failed: document.getElementById('compare-failed').textContent.trim(),
      };
    });
    const shown = await heads();
    if (!local.hash.includes('__local__')) fail(`${label} — the address dropped it: ${local.hash}`);
    if (shown.length !== 2) fail(`${label} — ${shown.length} columns, expected 2`);
    if (local.failed) fail(`${label} — ${local.failed}`);
    if (!local.note) fail(`${label} — nothing said the column cannot be shared`);
    // Read as a humanoid, H1's description places every joint it has; read as
    // `custom`, it would place none, which is what this number is here to catch.
    const placed = /19\/19/.test(local.coverage);
    if (!placed) fail(`${label} — the local column placed ${local.coverage}`);

    // Picking another file replaces the column rather than leaving the last
    // one parsed under the same id.
    const second = await page.evaluate(async () => {
      const { urdfUrl, byId, loadRegistry } = await import('./js/registry.js');
      const robot = byId(await loadRegistry(), 'go2');
      return robot ? urdfUrl(robot) : null;
    });
    if (second) {
      const swap = join(mkdtempSync(join(tmpdir(), 'rug-local-')), 'second.urdf');
      writeFileSync(swap, await (await fetch(second)).text());
      await pick(swap);
      await page.evaluate(() => {
        location.hash = 'compare=1&cat=humanoid&ids=__local__,g1';
      });
      await drawn();
      const after = await heads();
      if (after[0] === shown[0]) fail(`${label} — swapping the file left ${after[0]} in the column`);
    }

    // And an address that names it, opened where no file has been picked, is
    // one column short rather than an error.
    await page.goto(`${base}/web/#compare=1&cat=humanoid&ids=__local__,g1,h1`, {
      waitUntil: 'commit',
    });
    await page.reload({ waitUntil: 'commit' });
    await drawn();
    const cold = await heads();
    if (cold.length !== 2) fail(`${label} — a cold link drew ${cold.length} columns, expected 2`);
    if (!failures) console.log(`  ✓ ${label.padEnd(46)} ${local.coverage}`);
  }
}

/**
 * A model's height and bounding box exist only once something has rendered it:
 * no URDF declares them, and for the gallery they are recorded at build time by
 * scripts/render_thumbnails.mjs. A file off a disk has never been rendered by
 * anyone, so the stage measures it where the meshes are — and this is the check
 * that the two readings agree, by handing the page a description the registry
 * already carries a measurement for. M-710iC is the one to use: fourteen meshes
 * and 150 kB of them.
 */
{
  const label = 'local: measured from the meshes it came with';
  const model = await page.evaluate(async () => {
    const { byId, loadRegistry } = await import('./js/registry.js');
    const robot = byId(await loadRegistry(), 'fanuc_m710ic');
    return robot
      ? { base: robot.assets.base, urdf: robot.assets.urdf, measured: robot.measured }
      : null;
  });
  if (!model?.measured) {
    console.log(`  · ${label.padEnd(46)} skipped — fanuc_m710ic is not shown`);
  } else {
    // Flat, which is the case worth exercising anyway: files chosen one by one
    // carry no folder, and the description's `package://` paths have to find
    // them by name alone.
    const dir = mkdtempSync(join(tmpdir(), 'rug-meshes-'));
    const text = await (await fetch(model.base + model.urdf)).text();
    const paths = [join(dir, basename(model.urdf))];
    writeFileSync(paths[0], text);
    const refs = [...new Set([...text.matchAll(/filename="([^"]+)"/g)].map((m) => m[1]))];
    let missed = 0;
    for (const ref of refs) {
      const rel = ref.replace(/^package:\/\/[^/]+\//, '');
      const response = await fetch(model.base + rel);
      if (!response.ok) {
        missed += 1;
        continue;
      }
      const at = join(dir, basename(rel));
      writeFileSync(at, Buffer.from(await response.arrayBuffer()));
      paths.push(at);
    }
    if (missed) {
      console.log(`  · ${label.padEnd(46)} skipped — ${missed}/${refs.length} meshes unreachable`);
    } else {
      await pick(paths);
      const got = await pickedMeasurement();
      if (!got) {
        fail(`${label} — nothing was measured from ${paths.length - 1} meshes`);
      } else {
        // The same pose and the same reading, so the same number: a tolerance
        // this wide only forgives a rounding difference, and every way of
        // getting this wrong — measuring a posed robot, or one mid-spin — is
        // out by whole percent.
        const off = Math.abs(got.height_m - model.measured.height_m) / model.measured.height_m;
        if (off > 0.01) {
          fail(
            `${label} — measured ${got.height_m} m, the registry records ` +
              `${model.measured.height_m} m`,
          );
        } else {
          console.log(
            `  ✓ ${label.padEnd(46)} ${got.height_m} m vs ${model.measured.height_m} m recorded`,
          );
        }
      }
    }
  }
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

const relevant = consoleErrors.filter(
  (e) =>
    !/favicon|thumbs\/.*404|Failed to load resource/.test(e) &&
    // The file handed to the page above is a lone .urdf with none of its meshes
    // beside it, so the stage says so once per <mesh> in it. That is the viewer
    // reporting what it was given, not this page failing.
    !/Error loading mesh|not among the picked files/.test(e),
);
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
