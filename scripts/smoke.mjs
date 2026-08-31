#!/usr/bin/env node
/**
 * Headless smoke test: open the gallery, then open one robot per category and
 * assert the model actually rendered (meshes present, non-empty bounding box).
 *
 *   node scripts/serve.mjs &
 *   node scripts/smoke.mjs [--all] [--robot <id>] [--base http://localhost:8080]
 *
 * `--all` walks every robot in the registry, which is the check to run before
 * publishing a registry update: a robot whose upstream repository moved its
 * meshes fails here rather than in front of a visitor.
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { launchBrowser } from './browser.mjs';
import { parseVisibility } from '../web/js/registry.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const base = flag('--base', process.env.BASE_URL || 'http://localhost:8080');
const registry = JSON.parse(readFileSync(new URL('../data/robots.json', import.meta.url)));

// The site only serves what data/visibility.md leaves checked, so that is what
// there is to smoke-test; an unchecked robot has no card and no detail page.
const visibilityPath = new URL('../data/visibility.md', import.meta.url);
const visibility = existsSync(visibilityPath)
  ? parseVisibility(readFileSync(visibilityPath, 'utf8'))
  : new Map();
const shown = registry.robots.filter((r) => visibility.get(r.id) !== false);
// Every card opens on the same stage, whether the description behind it is a
// URDF or an MJCF, so every card is worth loading here.
const renderable = shown;
const hidden = registry.robots.length - shown.length;
if (hidden) console.log(`${hidden} robot(s) hidden by data/visibility.md`);

/**
 * What one page load is: a robot, or one version of a robot that upstream
 * publishes as several URDFs. The stage stamps the version's id when it
 * finishes, so that — not the entry's — is what the wait below looks for.
 */
function loads(robot, everyVersion) {
  const variants = robot.variants || [];
  if (!variants.length) return [{ robot, id: robot.id, url: `#robot=${robot.id}` }];
  // The default version is reached by the address a card links to, which is
  // the one worth testing when only one of them is being.
  const wanted = everyVersion ? variants : variants.slice(0, 1);
  return wanted.map((v) => ({
    robot,
    id: v.id,
    url: `#robot=${robot.id}${v.id === variants[0].id ? '' : `&v=${v.id}`}`,
  }));
}

let targets;
if (flag('--robot')) {
  targets = renderable.filter((r) => r.id === flag('--robot')).flatMap((r) => loads(r, true));
  if (!targets.length) console.log(`${flag('--robot')}: not shown (or unknown) — nothing to test`);
} else if (args.includes('--all')) {
  targets = renderable.flatMap((r) => loads(r, true));
} else {
  // One representative (the lightest) per category keeps the default fast.
  const byCategory = new Map();
  for (const robot of renderable) {
    const current = byCategory.get(robot.category);
    if (!current || robot.assets.mesh_bytes < current.assets.mesh_bytes) {
      byCategory.set(robot.category, robot);
    }
  }
  targets = [...byCategory.values()].flatMap((r) => loads(r, false));
}

// Version ids are file names, which run longer than the robot ids the columns
// below were sized for.
const pad = Math.max(26, ...targets.map((t) => t.id.length));

mkdirSync(new URL('../.cache/smoke', import.meta.url), { recursive: true });

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(`${base}/web/`, { waitUntil: 'networkidle' });
const cards = await page.locator('.card').count();
console.log(`gallery: ${cards} cards`);
if (cards !== shown.length) {
  console.error(`  ✗ expected ${shown.length} cards`);
  process.exitCode = 1;
}

// Every category is divided into maker sections. The same maker appearing in
// several non-adjacent registry entries must still produce one section here.
const expectedMakerGroups = [
  ...new Set(shown.map((r) => `${r.category}\0${(r.maker?.trim() || '—').toLocaleLowerCase()}`)),
].length;
const makerGroups = await page.locator('.maker-group').count();
const nestedCards = await page.locator('.maker-group .card').count();
if (makerGroups !== expectedMakerGroups || nestedCards !== shown.length) {
  console.error(
    `  ✗ expected ${expectedMakerGroups} maker groups containing ${shown.length} cards, ` +
      `got ${makerGroups} groups containing ${nestedCards}`,
  );
  process.exitCode = 1;
} else {
  console.log(`gallery: ${makerGroups} maker groups`);
}

// Short maker groups share a card row, but one which starts after column zero
// must fit there in full. Larger groups may wrap only when they own the row.
const makerLayout = await page.locator('.maker-groups').evaluateAll((containers) =>
  containers.flatMap((container, section) => {
    const parent = container.getBoundingClientRect();
    return [...container.children].map((group) => {
      const box = group.getBoundingClientRect();
      const cardRows = new Set(
        [...group.querySelectorAll('.card')].map((card) =>
          Math.round(card.getBoundingClientRect().top),
        ),
      ).size;
      return {
        section,
        left: box.left,
        right: box.right,
        top: box.top,
        parentLeft: parent.left,
        parentRight: parent.right,
        cardRows,
      };
    });
  }),
);
const sharesRow = makerLayout.some((group, index) => {
  const previous = makerLayout[index - 1];
  return previous && previous.section === group.section && Math.abs(previous.top - group.top) < 1;
});
const badMakerLayout = makerLayout.filter(
  (group) =>
    group.right > group.parentRight + 1 ||
    (group.cardRows > 1 && Math.abs(group.left - group.parentLeft) > 1),
);
if (!sharesRow || badMakerLayout.length) {
  console.error(
    `  ✗ maker packing: shared row ${sharesRow ? 'found' : 'missing'}, ` +
      `${badMakerLayout.length} overflowing or partially-started wrapping groups`,
  );
  process.exitCode = 1;
} else {
  console.log('gallery: maker groups pack without crossing rows');
}

// Those spans are measured from the laid-out grid, and the gallery is not
// always laid out when it re-renders: the search box is in the header, so it is
// reachable from a comparison or a robot's page, and the gallery behind them is
// `hidden`. A grid the browser is not laying out resolves no tracks to count —
// `getComputedStyle` answers with the `repeat(auto-fill, ...)` the stylesheet
// wrote — and a count taken from that froze every group three cards wide for
// the rest of the visit, with two thirds of the page left empty. Coming back
// has to measure again.
await page.evaluate(() => {
  location.hash = 'compare=1';
});
await page.locator('#view-gallery').waitFor({ state: 'hidden' });
await page.fill('#search', 'a');
await page.fill('#search', '');
await page.locator('#compare-back').click();
await page.locator('#view-gallery').waitFor({ state: 'visible' });
const spans = await page.locator('#grid .maker-groups').evaluateAll((containers) =>
  containers.map((container) => {
    const columns = getComputedStyle(container)
      .gridTemplateColumns.split(' ')
      .filter(Boolean).length;
    const wrong = [...container.children].filter(
      (group) =>
        Number(group.style.getPropertyValue('--maker-span')) !==
        Math.min(Number(group.dataset.size), columns),
    ).length;
    return { columns, wrong };
  }),
);
const respanned = Math.max(0, ...spans.map((s) => s.columns));
const misspanned = spans.reduce((total, s) => total + s.wrong, 0);
// Four is not the answer — five columns fit at 1440px — but it is well clear of
// the three the unmeasured grid used to report.
if (misspanned || respanned < 4) {
  console.error(
    `  ✗ maker spans after a re-render behind another view: ${respanned} columns, ` +
      `${misspanned} group(s) not spanning what fits`,
  );
  process.exitCode = 1;
} else {
  console.log(`gallery: maker spans re-measure on the way back (${respanned} columns)`);
}

// The optional live link used to have no grid area on phones and was auto-
// placed into a third row. Check the narrowest supported layout while a model
// that offers the link is open: all four navigation actions share one row and
// none overlap.
const liveRobot = shown.find((r) => r.source?.mjcf_external?.live_url);
if (liveRobot) {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`${base}/web/#robot=${liveRobot.id}`, { waitUntil: 'commit' });
  await page.locator('#mujoco-live').waitFor({ state: 'visible' });
  const navBoxes = await page
    .locator('#back-btn, #mujoco-live, #prev-robot, #next-robot')
    .evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { id: node.id, left: box.left, right: box.right, top: box.top };
    }));
  const sameRow = Math.max(...navBoxes.map((b) => b.top)) - Math.min(...navBoxes.map((b) => b.top)) < 2;
  const ordered = [...navBoxes].sort((a, b) => a.left - b.left);
  const overlap = ordered.some((box, i) => i > 0 && ordered[i - 1].right > box.left + 0.5);
  if (!sameRow || overlap) {
    console.error(`  ✗ mobile detail navigation is not one non-overlapping row: ${JSON.stringify(navBoxes)}`);
    process.exitCode = 1;
  } else {
    console.log('detail: mobile MuJoCo Live navigation fits at 320px');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

let failures = 0;
for (const target of targets) {
  const name = target.id.padEnd(pad);
  const started = Date.now();
  await page.goto(`${base}/web/${target.url}`, { waitUntil: 'commit' });
  let result;
  try {
    result = await page.waitForFunction(
      (id) => {
        // The stage stamps the id it finished loading, so a stale panel from the
        // previously viewed robot cannot satisfy the wait.
        const stage = document.querySelector('.stage');
        if (stage?.dataset.failed === id) {
          return { error: document.getElementById('stage-error').textContent.trim() };
        }
        if (stage?.dataset.loaded !== id) return false;
        return {
          // Every joint that moves carries a block in the tree, under the row
          // for the joint it turns: a slider, or — for one with no value of
          // its own to set, because it mimics another or a closed loop solves
          // for it — a readout of where it stands.
          joints: document.querySelectorAll('#d-tree .tree-slider').length,
          sliders: document.querySelectorAll('#d-tree .tree-slider input[type="range"]').length,
          follows: document.querySelectorAll('#d-tree .tree-slider.is-follow').length,
          // Of those, the ones a closed loop holds rather than a joint they
          // mimic. Minitaur's knees are the only ones in the gallery.
          loops: document.querySelectorAll('#d-tree .tree-slider.is-loop').length,
          // Every one of them carries the limits its URDF declares; a joint
          // without that row means the raw XML never made it into the panel.
          limits: document.querySelectorAll('#d-tree .tree-slider .joint-limits').length,
          specs: document.querySelectorAll('#d-specs dt').length,
          // The joint tree walks the loaded scene graph, so an empty one means
          // the panel broke rather than that the robot is simple: every
          // description has at least a root link.
          treeNodes: document.querySelectorAll('#d-tree .tree-node').length,
          treeMovable: document.querySelectorAll('#d-tree .tree-node[data-movable="true"]').length,
          meshes: Number(stage.dataset.meshes || 0),
          height: Number(stage.dataset.height || NaN),
          name: document.getElementById('d-name').textContent,
        };
      },
      target.id,
      { timeout: 180000, polling: 400 },
    ).then((handle) => handle.jsonValue());
  } catch (err) {
    result = { error: `timeout after ${Math.round((Date.now() - started) / 1000)}s` };
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    console.error(`  ✗ ${name} ${result.error}`);
    failures += 1;
    continue;
  }
  // A URDF whose meshes 404 still "loads" — an empty scene is the real failure.
  if (!result.meshes) {
    console.error(`  ✗ ${name} loaded but no visual geometry rendered`);
    failures += 1;
    continue;
  }
  if (result.limits !== result.joints) {
    console.error(
      `  ✗ ${name} ${result.joints} joints but ${result.limits} limit rows`,
    );
    failures += 1;
    continue;
  }
  // The blocks are in the tree, one per row that moves: a count that does not
  // match means rows and joints were built from different robots.
  if (result.treeMovable !== result.joints) {
    console.error(
      `  ✗ ${name} ${result.joints} joint blocks but ` +
        `${result.treeMovable} movable joints in the tree`,
    );
    failures += 1;
    continue;
  }
  // And each of those is one or the other: a joint that follows another is
  // shown, but never with a slider that would set a value it cannot keep.
  if (result.sliders + result.follows !== result.joints) {
    console.error(
      `  ✗ ${name} ${result.joints} joint blocks split into ` +
        `${result.sliders} sliders and ${result.follows} followers`,
    );
    failures += 1;
    continue;
  }
  if (!result.treeNodes) {
    console.error(`  ✗ ${name} joint tree is empty`);
    failures += 1;
    continue;
  }
  // Meshes present but nothing measurable means broken transforms.
  if (!Number.isFinite(result.height) || result.height <= 0) {
    console.error(
      `  ✗ ${name} ${result.meshes} meshes but no measurable size ` +
        `(height=${result.height})`,
    );
    failures += 1;
    continue;
  }

  // The blocks that carry a readout instead of a slider, and what holds them
  // there: the joint they mimic, a closed loop, or — for a description with
  // both — neither word, just the count.
  const held = result.follows
    ? `+${String(result.follows).padStart(2)} ` +
      (result.loops === 0 ? 'mimic' : result.loops === result.follows ? 'loop ' : 'held ')
    : '         ';
  console.log(
    `  ✓ ${name} ${String(result.sliders).padStart(3)} joints${held}  ` +
      `${String(result.meshes).padStart(3)} meshes  ${seconds.padStart(5)}s  ` +
      `${result.height.toFixed(2)} m`,
  );
  if (args.includes('--shots')) {
    await page.screenshot({ path: new URL(`../.cache/smoke/${target.id}.png`, import.meta.url).pathname });
  }
}

const relevant = consoleErrors.filter((e) => !/favicon|thumbs\/.*404|Failed to load resource/.test(e));
if (relevant.length) {
  console.error(`\nconsole errors (${relevant.length}):`);
  for (const error of relevant.slice(0, 12)) console.error(`  ${error}`);
}

await browser.close();
console.log(`\n${targets.length - failures}/${targets.length} robots rendered`);
if (failures) process.exitCode = 1;
