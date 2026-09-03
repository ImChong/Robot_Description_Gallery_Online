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
 *   - And the shared 3D stage: that it fetches nothing until it is asked to,
 *     that it then stands every picked machine on one floor at the size the
 *     registry records for it, that clicking one opens that one's joints and
 *     that a slider in that window moves that machine and no other — and that
 *     a machine can be moved across that floor and turned on it, on the grid's
 *     own lines when snapping is on, without its height changing and without
 *     the row it came from being lost.
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
let checkedLinkMass = false;
let checkedLinkInertia = false;
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
    for (const entry of entries) {
      for (const joint of entry.spec.joints) {
        const expected = joint.child ? entry.spec.linkByName.get(joint.child)?.mass ?? null : null;
        if (joint.linkMass !== expected) {
          problems.push(
            `${entry.id}: ${joint.name} link mass is ${joint.linkMass}, expected ${expected}`,
          );
        }
        const expectedInertia = joint.child
          ? entry.spec.linkByName.get(joint.child)?.inertiaTrace ?? null
          : null;
        if (joint.linkInertia !== expectedInertia) {
          problems.push(
            `${entry.id}: ${joint.name} link inertia is ${joint.linkInertia}, expected ${expectedInertia}`,
          );
        }
      }
    }
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

  // The mass attached to a joint is the mass of the child link it moves. Check
  // the new metric through the real toolbar once, including that the values
  // reach the rendered table rather than stopping at the parser.
  if (!checkedLinkMass) {
    const mass = await page.evaluate(() => {
      const button = document.querySelector('#compare-tools [data-set="metric:mass"]');
      if (!button) return { button: false, cells: 0, mismatch: 'missing control' };
      button.click();
      const cells = [...document.querySelectorAll('#compare-joints tbody td:not(.is-absent)')];
      const massCells = cells.filter((cell) => /(?:\d|—)\s*kg$/.test(cell.querySelector('.cell-value')?.textContent.trim() || ''));
      const mismatch = massCells.find((cell) => {
        const title = cell.getAttribute('title');
        const shown = cell.querySelector('.cell-value')?.textContent.trim() || '';
        return title && !/^(?:—|[\d,.]+ kg)$/.test(shown);
      });
      return { button: true, cells: massCells.length, mismatch: mismatch?.textContent.trim() || '' };
    });
    if (!mass.button) fail(`${label} — no child-link mass control`);
    if (!mass.cells) fail(`${label} — child-link mass drew no values`);
    if (mass.mismatch) fail(`${label} — malformed child-link mass cell: ${mass.mismatch}`);
    checkedLinkMass = mass.button && mass.cells > 0 && !mass.mismatch;
  }

  // Inertia is shown as the trace of the child link's tensor. Besides being a
  // compact scalar for the table, the trace stays comparable when two URDFs
  // choose differently rotated inertial frames for equivalent links.
  if (!checkedLinkInertia) {
    const inertia = await page.evaluate(() => {
      const button = document.querySelector('#compare-tools [data-set="metric:inertia"]');
      if (!button) return { button: false, cells: 0, mismatch: 'missing control' };
      button.click();
      const cells = [...document.querySelectorAll('#compare-joints tbody td:not(.is-absent)')];
      const inertiaCells = cells.filter((cell) =>
        /(?:\d|—)\s*kg·m²$/.test(cell.querySelector('.cell-value')?.textContent.trim() || ''),
      );
      const mismatch = inertiaCells.find((cell) => {
        const shown = cell.querySelector('.cell-value')?.textContent.trim() || '';
        return !/^(?:—|[\d,.]+(?:e[+-]?\d+)? kg·m²)$/.test(shown);
      });
      return { button: true, cells: inertiaCells.length, mismatch: mismatch?.textContent.trim() || '' };
    });
    if (!inertia.button) fail(`${label} — no child-link inertia control`);
    if (!inertia.cells) fail(`${label} — child-link inertia drew no values`);
    if (inertia.mismatch) fail(`${label} — malformed child-link inertia cell: ${inertia.mismatch}`);
    checkedLinkInertia = inertia.button && inertia.cells > 0 && !inertia.mismatch;
  }

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

/* ── the shared 3D stage ─────────────────────────────────────────────────── */

/** Where one machine stands, off its name tag. */
const placementOf = (page, index) =>
  page.evaluate((i) => {
    const tag = document.querySelectorAll('#cmp-stage-tags .cmp-tag')[i];
    return {
      x: Number(tag.dataset.x),
      y: Number(tag.dataset.y),
      yaw: Number(tag.dataset.yaw),
      height: Number(tag.dataset.height),
    };
  }, index);

/**
 * A point on the render that is actually on one machine's geometry.
 *
 * Its name tag hangs over the top of it, so the search starts there and works
 * down; a click is what asks, since the joint window naming that machine is
 * the page's own answer to "was that a hit". Null if the whole column below
 * the tag is backdrop, which would mean the machine is not being drawn.
 */
async function grabPoint(page, name) {
  const host = await page.locator('#cmp-canvas-host').boundingBox();
  const tag = await page.evaluate((wanted) => {
    const node = [...document.querySelectorAll('#cmp-stage-tags .cmp-tag')].find(
      (one) => one.textContent === wanted,
    );
    return node ? { left: parseFloat(node.style.left), top: parseFloat(node.style.top) } : null;
  }, name);
  if (!tag) return null;
  for (let down = 10; down < 460; down += 10) {
    const y = host.y + tag.top + down;
    if (y > host.y + host.height - 4) break;
    await page.mouse.click(host.x + tag.left, y);
    await page.waitForTimeout(70);
    const about = await page.evaluate(() => {
      const panel = document.getElementById('cmp-joint-panel');
      return panel.hidden ? null : panel.querySelector('.cmp-joint-title strong')?.textContent;
    });
    if (about === name) return { x: host.x + tag.left, y };
  }
  return null;
}

/**
 * Two machines on one floor, at the size the registry records for each.
 *
 * The premise of this page is that a comparison costs six URDFs and no meshes,
 * so the first thing checked is that nothing is fetched until the stage is
 * asked for. What it then has to get right is scale: the whole reason to draw
 * six machines rather than tabulate them is that a hand beside a humanoid is
 * the size it really is, and a stage that quietly normalised each one to fill
 * its share of the frame would look perfectly plausible and say nothing. The
 * heights the stage measures off the geometry are therefore checked against the
 * ones scripts/render_thumbnails.mjs recorded per robot.
 *
 * Then the part a picture cannot do on its own: clicking one machine opens that
 * machine's joints, and a slider in that window moves that machine only.
 *
 * Two small arms rather than two humanoids — this is a network test that has
 * already fetched a dozen descriptions by the time it gets here, and what is
 * being checked is the stage, not the size of the download.
 */
{
  const label = 'stage: two machines on one floor';
  const ids = ['so_arm100', 'z1'];
  const wasFailing = failures;
  const recorded = await page.evaluate(async (ids) => {
    const { loadRegistry, byId } = await import('./js/registry.js');
    const data = await loadRegistry();
    const found = ids.map((id) => byId(data, id));
    return found.every(Boolean)
      ? found.map((robot) => ({ id: robot.id, height: robot.measured?.height_m ?? null }))
      : null;
  }, ids);

  if (!recorded || recorded.some((one) => !one.height)) {
    console.log(`  · ${label.padEnd(46)} skipped — ${ids.join(', ')} not shown or unmeasured`);
  } else {
    await page.goto(`${base}/web/#compare=1&cat=arm&ids=${ids.join(',')}`, { waitUntil: 'commit' });
    await page.waitForFunction(
      () => {
        const body = document.getElementById('compare-body');
        return !!body && !body.hidden && !!document.querySelector('#compare-joints tbody tr');
      },
      null,
      { timeout: 120000, polling: 300 },
    );

    // Nothing on the floor until it is asked for: the tables are drawn and the
    // stage is still an invitation.
    const before = await page.evaluate(() => ({
      hidden: document.getElementById('cmp-stage').hidden,
      standing: document.getElementById('cmp-stage').dataset.standing || '0',
      canvases: document.querySelectorAll('#cmp-canvas-host canvas').length,
    }));
    if (!before.hidden || before.standing !== '0' || before.canvases) {
      fail(`${label} — the stage loaded before it was asked to: ${JSON.stringify(before)}`);
    }

    await page.click('#cmp-stage-open');
    let stood;
    try {
      stood = await page
        .waitForFunction(
          (count) => {
            if (!document.getElementById('cmp-stage-loading').hidden) return false;
            const tags = [...document.querySelectorAll('#cmp-stage-tags .cmp-tag')];
            if (tags.length !== count) return false;
            return {
              failed: document.getElementById('cmp-stage-failed').textContent.trim(),
              span: Number(document.getElementById('cmp-stage').dataset.span),
              tags: tags.map((tag) => ({
                name: tag.textContent,
                height: Number(tag.dataset.height),
                x: Number(tag.dataset.x),
              })),
            };
          },
          ids.length,
          { timeout: 300000, polling: 500 },
        )
        .then((handle) => handle.jsonValue());
    } catch {
      stood = null;
    }

    if (!stood) {
      fail(`${label} — ${ids.length} machines never reached the floor`);
    } else {
      if (stood.failed) fail(`${label} — ${stood.failed}`);
      // At true scale, measured where they are drawn: the same reading the
      // registry holds, which is the whole claim the picture makes.
      for (const [index, one] of recorded.entries()) {
        const drawn = stood.tags[index];
        const off = Math.abs(drawn.height - one.height) / one.height;
        if (off > 0.01) {
          fail(`${label} — ${one.id} stands ${drawn.height} m, the registry records ${one.height} m`);
        }
      }
      // Side by side, in the order the table reads its columns, and far enough
      // apart that neither is standing inside the other.
      const [left, right] = stood.tags;
      if (!(left.x < right.x)) {
        fail(`${label} — the row runs ${left.name} at ${left.x} and ${right.name} at ${right.x}`);
      }
      if (!(stood.span > 0)) fail(`${label} — the row measured no width`);

      // Clicking one machine's name opens that machine's joints, and the
      // sliders in that window are its own. The pose of the machine that was
      // not clicked is read before and after, since "the sliders drive one
      // robot" is the claim, and a window wired to the wrong description
      // would look exactly as convincing.
      const [first, second] = stood.tags.map((tag) => tag.name);
      const readWindow = () =>
        page.evaluate(() => {
          const panel = document.getElementById('cmp-joint-panel');
          return {
            about: panel.querySelector('.cmp-joint-title strong')?.textContent || null,
            sliders: panel.querySelectorAll('input[type="range"]').length,
            values: [...panel.querySelectorAll('.tree-value')].map((node) => node.textContent),
          };
        });
      const clickTag = async (index) => {
        await page.click(`#cmp-stage-tags .cmp-tag:nth-of-type(${index + 1})`);
        await page.waitForSelector('#cmp-joint-panel:not([hidden])', { timeout: 30000 });
      };

      await clickTag(1);
      const restOfSecond = await readWindow();
      if (restOfSecond.about !== second) {
        fail(`${label} — clicking ${second} opened a window about ${restOfSecond.about}`);
      }

      await clickTag(0);
      const posed = await page.evaluate(() => {
        const panel = document.getElementById('cmp-joint-panel');
        const input = panel.querySelector('input[type="range"][data-joint]');
        if (!input) return null;
        const value = panel.querySelector('.tree-value');
        const was = value.textContent;
        input.value = String(Number(input.min) + (Number(input.max) - Number(input.min)) * 0.75);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { was, now: value.textContent };
      });
      const window0 = await readWindow();
      if (window0.about !== first) {
        fail(`${label} — clicking ${first} opened a window about ${window0.about}`);
      }
      if (!posed) fail(`${label} — ${first} came up with no sliders`);
      else if (posed.was === posed.now) {
        fail(`${label} — a slider in ${first}'s window moved nothing (${posed.now})`);
      }

      await clickTag(1);
      const afterSecond = await readWindow();
      if (String(afterSecond.values) !== String(restOfSecond.values)) {
        fail(`${label} — posing ${first} moved ${second}`);
      }

      /* ---- and where each of them stands ---------------------------------
       *
       * A placement is x and y across the floor and a turn about the vertical,
       * and it is deliberately not a height and not a scale: those two are the
       * comparison the stage exists to make. So what is checked is that the
       * two that can move do, that a turn turns the machine where it stands
       * rather than swinging it round whatever point its description calls the
       * origin, that the height survives all of it, and that the row is still
       * there to go back to.
       */
      const step = Number(await page.getAttribute('#cmp-stage', 'data-step'));
      const placed = await page.evaluate(() => {
        // Queried afresh every time: putting the machines back in a row
        // rebuilds the row of tags, and a node held across that is a detached
        // one still carrying the placement it had before.
        const tag = () => document.querySelector('#cmp-stage-tags .cmp-tag');
        const relayout = document.querySelector('#cmp-stage-toolbar [data-action="relayout"]');
        const read = () => ({
          x: Number(tag().dataset.x),
          y: Number(tag().dataset.y),
          yaw: Number(tag().dataset.yaw),
          height: Number(tag().dataset.height),
          pinned: tag().dataset.pinned,
        });
        tag().click();
        const field = (key) => document.querySelector(`#cmp-place input[data-place="${key}"]`);
        if (!field('x') || !field('y') || !field('yaw')) return { fields: false };
        const type = (key, value) => {
          const input = field(key);
          input.value = String(value);
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        // The row as it stands right now — the pose has been dragged about
        // since the stage loaded, and a row is laid out from the geometry as
        // it is drawn, so the reading has to be taken fresh to be compared to.
        relayout.click();
        const row = read();
        // Off it, by numbers that are not on the grid: a typed placement is
        // exact, and only a drag is snapped.
        type('x', -1.37);
        type('y', 0.82);
        type('yaw', 90);
        const moved = read();
        relayout.click();
        return { fields: true, row, moved, back: read() };
      });

      if (!placed.fields) {
        fail(`${label} — the joint window carries no placement fields`);
      } else {
        // Typed exactly, and turned about the machine's own middle: the mark it
        // stands on is the one it turns about, so x and y do not move with it.
        if (Math.abs(placed.moved.x - -1.37) > 1e-6 || Math.abs(placed.moved.y - 0.82) > 1e-6) {
          fail(`${label} — placing ${first} at -1.37, 0.82 left it at ${placed.moved.x}, ${placed.moved.y}`);
        }
        if (Math.abs(placed.moved.yaw - Math.PI / 2) > 1e-3) {
          fail(`${label} — typing 90° gave ${placed.moved.yaw} rad`);
        }
        if (Math.abs(placed.moved.height - placed.row.height) > 1e-4) {
          fail(`${label} — moving ${first} changed its height to ${placed.moved.height} m`);
        }
        if (placed.moved.pinned !== 'true') fail(`${label} — a moved machine is not marked placed`);
        // And back in the row it came from, exactly.
        if (
          Math.abs(placed.back.x - placed.row.x) > 1e-6 ||
          Math.abs(placed.back.y - placed.row.y) > 1e-6 ||
          placed.back.yaw !== 0 ||
          placed.back.pinned !== 'false'
        ) {
          fail(`${label} — "back in a row" left ${first} at ${JSON.stringify(placed.back)}`);
        }
        if (!(step > 0)) fail(`${label} — the stage published no snap step`);
      }

      // The same placement, dragged. Snapping is on by default, so what a drag
      // lands on is the floor grid's own lines — which is the whole of what
      // "snap" claims, and the part no typed number exercises.
      if (step > 0) {
        await page.click('#cmp-stage-toolbar [data-action="arrange"]');
        const grab = await grabPoint(page, first);
        if (!grab) {
          fail(`${label} — could not take hold of ${first} on the render`);
        } else {
          const before = await placementOf(page, 0);
          await page.mouse.move(grab.x, grab.y);
          await page.mouse.down();
          await page.mouse.move(grab.x + 120, grab.y + 30, { steps: 10 });
          await page.mouse.up();
          await page.waitForTimeout(200);
          const after = await placementOf(page, 0);
          const onGrid = (value) => Math.abs(value / step - Math.round(value / step)) < 1e-6;
          if (after.x === before.x && after.y === before.y) {
            fail(`${label} — dragging ${first} moved nothing`);
          } else if (!onGrid(after.x) || !onGrid(after.y)) {
            fail(`${label} — a snapped drag landed at ${after.x}, ${after.y}, off a ${step} m grid`);
          }
          if (Math.abs(after.height - before.height) > 1e-4) {
            fail(`${label} — dragging ${first} changed its height to ${after.height} m`);
          }
        }
        await page.click('#cmp-stage-toolbar [data-action="arrange"]');
        await page.click('#cmp-stage-toolbar [data-action="relayout"]');
      }

      if (failures === wasFailing) {
        console.log(
          `  ✓ ${label.padEnd(46)} ${stood.tags
            .map((tag) => `${tag.name} ${tag.height.toFixed(2)} m`)
            .join(' · ')}`,
        );
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
