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
import { readFileSync, mkdirSync } from 'node:fs';
import { launchBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const base = flag('--base', process.env.BASE_URL || 'http://localhost:8080');
const registry = JSON.parse(readFileSync(new URL('../data/robots.json', import.meta.url)));

let targets;
if (flag('--robot')) {
  targets = registry.robots.filter((r) => r.id === flag('--robot'));
} else if (args.includes('--all')) {
  targets = registry.robots;
} else {
  // One representative (the lightest) per category keeps the default fast.
  const byCategory = new Map();
  for (const robot of registry.robots) {
    const current = byCategory.get(robot.category);
    if (!current || robot.assets.mesh_bytes < current.assets.mesh_bytes) {
      byCategory.set(robot.category, robot);
    }
  }
  targets = [...byCategory.values()];
}

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
if (cards !== registry.robots.length) {
  console.error(`  ✗ expected ${registry.robots.length} cards`);
  process.exitCode = 1;
}

let failures = 0;
for (const robot of targets) {
  const started = Date.now();
  await page.goto(`${base}/web/#robot=${robot.id}`, { waitUntil: 'commit' });
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
          joints: document.querySelectorAll('#d-joints .joint').length,
          specs: document.querySelectorAll('#d-specs dt').length,
          meshes: Number(stage.dataset.meshes || 0),
          height: Number(stage.dataset.height || NaN),
          name: document.getElementById('d-name').textContent,
        };
      },
      robot.id,
      { timeout: 180000, polling: 400 },
    ).then((handle) => handle.jsonValue());
  } catch (err) {
    result = { error: `timeout after ${Math.round((Date.now() - started) / 1000)}s` };
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    console.error(`  ✗ ${robot.id.padEnd(26)} ${result.error}`);
    failures += 1;
    continue;
  }
  // A URDF whose meshes 404 still "loads" — an empty scene is the real failure.
  if (!result.meshes) {
    console.error(`  ✗ ${robot.id.padEnd(26)} loaded but no visual geometry rendered`);
    failures += 1;
    continue;
  }
  // Meshes present but nothing measurable means broken transforms.
  if (!Number.isFinite(result.height) || result.height <= 0) {
    console.error(
      `  ✗ ${robot.id.padEnd(26)} ${result.meshes} meshes but no measurable size ` +
        `(height=${result.height})`,
    );
    failures += 1;
    continue;
  }

  console.log(
    `  ✓ ${robot.id.padEnd(26)} ${String(result.joints).padStart(3)} joints  ` +
      `${String(result.meshes).padStart(3)} meshes  ${seconds.padStart(5)}s  ` +
      `${result.height.toFixed(2)} m`,
  );
  if (args.includes('--shots')) {
    await page.screenshot({ path: new URL(`../.cache/smoke/${robot.id}.png`, import.meta.url).pathname });
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
