#!/usr/bin/env node
/**
 * Exercise the download buttons in a real browser and validate what comes out.
 *
 *   node scripts/serve.mjs &
 *   node scripts/check_downloads.mjs [--robot <id>] [--all]
 *
 * The zip writer in web/js/download.js is hand-rolled, so "the button produced
 * a file" is not enough: every archive is unpacked with the system `unzip`,
 * checked against the mesh count the registry recorded, and the extracted URDF
 * is compared byte-for-byte with the upstream file. A malformed central
 * directory or a wrong CRC fails here rather than in a visitor's downloads
 * folder.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // Default: the lightest robot per mesh format, so every loader path that the
  // bundle has to copy is covered without downloading a gigabyte.
  const byFormat = new Map();
  for (const robot of registry.robots) {
    const key = robot.assets.mesh_formats.join('+');
    const current = byFormat.get(key);
    if (!current || robot.assets.mesh_bytes < current.assets.mesh_bytes) {
      byFormat.set(key, robot);
    }
  }
  targets = [...byFormat.values()];
}

const browser = await launchBrowser();
const workDir = mkdtempSync(join(tmpdir(), 'rug-dl-'));
let failures = 0;

console.log(`checking downloads for ${targets.length} robot(s) → ${workDir}`);

for (const robot of targets) {
  const page = await browser.newPage({ acceptDownloads: true });
  try {
    await page.goto(`${base}/web/#robot=${robot.id}`, { waitUntil: 'commit' });
    await page.waitForSelector('button[data-download="bundle"]', { timeout: 60000 });

    // --- single URDF ---
    const urdfDownload = await Promise.all([
      page.waitForEvent('download', { timeout: 180000 }),
      page.click('button[data-download="urdf"]'),
    ]).then(([download]) => download);
    const urdfPath = join(workDir, `${robot.id}.urdf`);
    await urdfDownload.saveAs(urdfPath);

    const upstream = await fetch(robot.assets.base + robot.assets.urdf).then((r) => r.text());
    const saved = readFileSync(urdfPath, 'utf8');
    if (saved !== upstream) throw new Error('saved URDF differs from upstream');

    // --- bundle ---
    const zipDownload = await Promise.all([
      page.waitForEvent('download', { timeout: 600000 }),
      page.click('button[data-download="bundle"]'),
    ]).then(([download]) => download);
    const zipPath = join(workDir, `${robot.id}.zip`);
    await zipDownload.saveAs(zipPath);

    // `unzip -t` verifies every entry's CRC, which is the part most likely to be
    // wrong in a hand-written archive.
    execFileSync('unzip', ['-tqq', zipPath], { stdio: 'pipe' });
    const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

    const expected = robot.assets.mesh_files + 2; // meshes + URDF + NOTICE.txt
    if (listing.length !== expected) {
      throw new Error(`zip holds ${listing.length} entries, expected ${expected}`);
    }
    if (!listing.includes(robot.assets.urdf)) {
      throw new Error(`zip is missing ${robot.assets.urdf}`);
    }
    if (!listing.includes('NOTICE.txt')) throw new Error('zip is missing NOTICE.txt');

    const extractDir = join(workDir, robot.id);
    execFileSync('unzip', ['-qq', zipPath, '-d', extractDir], { stdio: 'pipe' });
    const extracted = readFileSync(join(extractDir, robot.assets.urdf), 'utf8');
    if (extracted !== upstream) throw new Error('URDF inside the zip differs from upstream');

    const zipSize = statSync(zipPath).size;
    console.log(
      `  ✓ ${robot.id.padEnd(24)} urdf ${(saved.length / 1024).toFixed(0)} KB · ` +
        `zip ${(zipSize / 1e6).toFixed(1)} MB · ${listing.length} entries`,
    );
  } catch (err) {
    console.error(`  ✗ ${robot.id.padEnd(24)} ${err.message || err}`);
    failures += 1;
  } finally {
    await page.close();
  }
}

await browser.close();
if (!args.includes('--keep')) rmSync(workDir, { recursive: true, force: true });
console.log(`\n${targets.length - failures}/${targets.length} download bundles verified`);
if (failures) process.exitCode = 1;
