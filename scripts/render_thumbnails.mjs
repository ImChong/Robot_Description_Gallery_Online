#!/usr/bin/env node
/**
 * Render the gallery card images.
 *
 *   node scripts/serve.mjs &
 *   npm run thumbs                  # only what has no image and no measurement
 *   npm run thumbs -- --force       # re-render everything
 *   npm run thumbs -- --robot g1
 *
 * Cards are static images on purpose: seventy live WebGL contexts on one page
 * would melt a laptop. Renders run in headless Chromium against web/thumb.html,
 * so they use exactly the same viewer code the detail page uses — which is why
 * an MJCF-only entry is rendered here too rather than falling back to
 * Menagerie's own preview image: it is on the same stage as everything else.
 *
 * Side effect: each successful render records the model's measured bounding box
 * in data/measured.json, which is the only honest source for "how tall is this
 * robot" — the number comes from the meshes themselves.
 *
 * A machine upstream publishes as several URDFs is one card, so only the
 * version that card is rendered from produces an image; the rest are loaded
 * for their measurement alone, which is what the detail page shows before the
 * meshes of the version just picked have arrived.
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

let robots = registry.robots;
if (flag('--robot')) robots = robots.filter((r) => r.id === flag('--robot'));

/**
 * One page load each: the entry itself, which is the card, and then every
 * version of it beyond the one the card already covers.
 */
const targets = robots.flatMap((robot) => [
  { robot, id: robot.id, image: true, alias: robot.variants?.[0]?.id },
  ...(robot.variants || [])
    .slice(1)
    .map((v) => ({ robot, id: v.id, variant: v.id, image: false })),
]);

// Done means the card image is on disk, or — for a version that produces no
// image — that its measurement is already recorded.
const pending = force
  ? targets
  : targets.filter((job) =>
      job.image ? !existsSync(new URL(`${job.id}.webp`, thumbDir)) : !measured[job.id],
    );

if (!pending.length) {
  console.log('nothing to render (use --force to re-render)');
  process.exit(0);
}

const browser = await launchBrowser();
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 2,
});

const images = pending.filter((job) => job.image).length;
console.log(
  `rendering ${images} thumbnail(s) at ${width}×${height}@2x` +
    (pending.length > images ? ` · measuring ${pending.length - images} more version(s)` : ''),
);
let failures = 0;

for (const job of pending) {
  const started = Date.now();
  const query = `robot=${job.robot.id}${job.variant ? `&v=${job.variant}` : ''}`;
  await page.goto(`${base}/web/thumb.html?${query}`, { waitUntil: 'commit' });
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
    console.error(`  ✗ ${job.id.padEnd(26)} ${state.error || 'no geometry'}`);
    failures += 1;
    continue;
  }

  // Crop to where the robot actually is, so every card is filled rather than
  // showing a tall robot floating in a wide empty frame.
  if (job.image) {
    await page.screenshot({
      path: new URL(`${job.id}.webp`, thumbDir).pathname,
      type: 'webp',
      quality: 88,
      omitBackground: true, // keep the alpha channel the viewer rendered
      ...(state.clip && state.clip.width > 32 && state.clip.height > 32
        ? { clip: state.clip }
        : {}),
    });
  }
  if (state.measured) {
    measured[job.id] = state.measured;
    // The card and the version it was rendered from are the same geometry
    // measured once, and both are looked up by name at build time.
    if (job.alias) measured[job.alias] = state.measured;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `  ${job.image ? '✓' : '·'} ${job.id.padEnd(38)} ${String(state.meshes).padStart(3)} meshes  ` +
      `${String(state.measured?.height_m?.toFixed(2) ?? '?').padStart(5)} m  ` +
      `${state.stripped ? `· stripped ${state.stripped} light/camera  ` : ''}${seconds}s`,
  );
}

await browser.close();

writeFileSync(
  measuredPath,
  JSON.stringify(Object.fromEntries(Object.entries(measured).sort()), null, 1) + '\n',
);
console.log(`\n${pending.length - failures}/${pending.length} rendered · measurements in data/measured.json`);
if (failures) process.exitCode = 1;
