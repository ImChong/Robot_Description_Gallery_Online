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
  targets = shown.filter((r) => r.id === flag('--robot')).flatMap((r) => loads(r, true));
  if (!targets.length) console.log(`${flag('--robot')}: not shown (or unknown) — nothing to test`);
} else if (args.includes('--all')) {
  targets = shown.flatMap((r) => loads(r, true));
} else {
  // One representative (the lightest) per category keeps the default fast.
  const byCategory = new Map();
  for (const robot of shown) {
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
          // for the joint it turns: a slider, or — for one that mimics another
          // and so has no value of its own to set — the joint it follows.
          joints: document.querySelectorAll('#d-tree .tree-slider').length,
          sliders: document.querySelectorAll('#d-tree .tree-slider input[type="range"]').length,
          follows: document.querySelectorAll('#d-tree .tree-slider.is-follow').length,
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

  console.log(
    `  ✓ ${name} ${String(result.sliders).padStart(3)} joints` +
      `${result.follows ? `+${String(result.follows).padStart(2)} mimic` : '         '}  ` +
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
