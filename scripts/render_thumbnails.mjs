#!/usr/bin/env node
/**
 * Render the gallery card images.
 *
 *   node scripts/serve.mjs &
 *   npm run thumbs                  # only robots without a thumbnail
 *   npm run thumbs -- --force       # re-render everything
 *   npm run thumbs -- --robot g1
 *
 * Cards are static images on purpose: seventy live WebGL contexts on one page
 * would melt a laptop. Renders run in headless Chromium against web/thumb.html,
 * so they use exactly the same viewer code the detail page uses.
 *
 * Side effect: each successful render records the model's measured bounding box
 * in data/measured.json, which is the only honest source for "how tall is this
 * robot" — the number comes from the meshes themselves.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { launchBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const base = flag('--base', process.env.BASE_URL || 'http://localhost:8080');
const width = Number(flag('--width', 800));
const height = Number(flag('--height', 600));
const force = args.includes('--force');

const root = new URL('..', import.meta.url);
const registry = JSON.parse(readFileSync(new URL('data/robots.json', root)));
const thumbDir = new URL('web/thumbs/', root);
mkdirSync(thumbDir, { recursive: true });

const measuredPath = new URL('data/measured.json', root);
const measured = existsSync(measuredPath) ? JSON.parse(readFileSync(measuredPath)) : {};

let targets = registry.robots;
if (flag('--robot')) targets = targets.filter((r) => r.id === flag('--robot'));
if (!force) {
  targets = targets.filter((r) => !existsSync(new URL(`${r.id}.webp`, thumbDir)));
}

if (!targets.length) {
  console.log('nothing to render (use --force to re-render)');
  process.exit(0);
}

const browser = await launchBrowser();
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 2,
});

console.log(`rendering ${targets.length} thumbnail(s) at ${width}×${height}@2x`);
let failures = 0;

for (const robot of targets) {
  const started = Date.now();
  await page.goto(`${base}/web/thumb.html?robot=${robot.id}`, { waitUntil: 'commit' });
  let state;
  try {
    state = await page
      .waitForFunction(() => (window.__thumb?.ready ? window.__thumb : false), null, {
        timeout: 300000,
        polling: 500,
      })
      .then((handle) => handle.jsonValue());
  } catch {
    state = { error: 'timeout' };
  }

  if (state.error || !state.meshes) {
    console.error(`  ✗ ${robot.id.padEnd(26)} ${state.error || 'no geometry'}`);
    failures += 1;
    continue;
  }

  // Crop to where the robot actually is, so every card is filled rather than
  // showing a tall robot floating in a wide empty frame.
  await page.screenshot({
    path: new URL(`${robot.id}.webp`, thumbDir).pathname,
    type: 'webp',
    quality: 88,
    omitBackground: true, // keep the alpha channel the viewer rendered
    ...(state.clip && state.clip.width > 32 && state.clip.height > 32
      ? { clip: state.clip }
      : {}),
  });
  if (state.measured) measured[robot.id] = state.measured;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `  ✓ ${robot.id.padEnd(26)} ${String(state.meshes).padStart(3)} meshes  ` +
      `${String(state.measured?.height_m?.toFixed(2) ?? '?').padStart(5)} m  ` +
      `${state.stripped ? `· stripped ${state.stripped} light/camera  ` : ''}${seconds}s`,
  );
}

await browser.close();

writeFileSync(
  measuredPath,
  JSON.stringify(Object.fromEntries(Object.entries(measured).sort()), null, 1) + '\n',
);
console.log(`\n${targets.length - failures}/${targets.length} rendered · measurements in data/measured.json`);
if (failures) process.exitCode = 1;
