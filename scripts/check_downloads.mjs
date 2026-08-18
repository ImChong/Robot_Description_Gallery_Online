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
 *
 * The ROS 2 package gets the same treatment plus the checks that make it a
 * package rather than a folder: the generated files are all there, the launch
 * file is valid Python, and every rewritten `package://` mesh reference points
 * at a file that is actually in the archive.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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

/**
 * Everything that has to hold for the generated package to build and launch:
 * the files ament and the launch file expect, a launch file Python can parse,
 * and mesh references that resolve inside the package. The URDF must also be
 * upstream's, changed in nothing but those references.
 *
 * @param {string} root  the unpacked package directory
 * @param {string} pkg   its package name
 * @param {string} upstream  the upstream URDF text
 */
function checkRos2Package(root, pkg, upstream) {
  for (const required of [
    'package.xml',
    'CMakeLists.txt',
    'launch/display.launch.py',
    'rviz/display.rviz',
    'README.md',
    'NOTICE.txt',
  ]) {
    if (!existsSync(join(root, required))) throw new Error(`ROS 2 package is missing ${required}`);
  }

  const manifest = readFileSync(join(root, 'package.xml'), 'utf8');
  if (!manifest.includes(`<name>${pkg}</name>`)) {
    throw new Error(`package.xml does not declare <name>${pkg}</name>`);
  }
  for (const dep of ['robot_state_publisher', 'joint_state_publisher_gui', 'rviz2']) {
    if (!manifest.includes(`<exec_depend>${dep}</exec_depend>`)) {
      throw new Error(`package.xml does not depend on ${dep}`);
    }
  }

  // A launch file that does not parse is a package that cannot start.
  try {
    execFileSync('python3', ['-m', 'py_compile', join(root, 'launch/display.launch.py')], {
      stdio: 'pipe',
    });
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`display.launch.py does not compile: ${err.message}`);
  }

  const entries = readdirSync(root, { recursive: true, encoding: 'utf8' });
  const urdfName = entries.find((name) => name.endsWith('.urdf'));
  if (!urdfName) throw new Error('ROS 2 package holds no .urdf');
  const urdf = readFileSync(join(root, urdfName), 'utf8');

  const files = new Set(entries.map((name) => name.split('\\').join('/')));
  let rewritten = 0;
  for (const [, ref] of urdf.matchAll(/<mesh[^>]*filename="([^"]*)"/g)) {
    if (!ref.startsWith('package://')) continue;
    const [refPkg, ...rest] = ref.slice('package://'.length).split('/');
    if (refPkg !== pkg) throw new Error(`mesh reference points outside the package: ${ref}`);
    if (!files.has(rest.join('/'))) throw new Error(`mesh reference resolves to nothing: ${ref}`);
    rewritten += 1;
  }
  if (!rewritten && entries.some((name) => /\.(stl|dae|obj)$/i.test(name))) {
    throw new Error('package ships meshes but the URDF references none of them');
  }

  // Only the mesh references may differ from upstream.
  const bare = (text) => text.replace(/filename="[^"]*"/g, 'filename=""');
  if (bare(urdf) !== bare(upstream)) {
    throw new Error('URDF in the ROS 2 package differs from upstream beyond its mesh references');
  }
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

    // --- ROS 2 package ---
    const ros2Download = await Promise.all([
      page.waitForEvent('download', { timeout: 600000 }),
      page.click('button[data-download="ros2"]'),
    ]).then(([download]) => download);
    const ros2Path = join(workDir, `${robot.id}-ros2.zip`);
    await ros2Download.saveAs(ros2Path);

    execFileSync('unzip', ['-tqq', ros2Path], { stdio: 'pipe' });
    const ros2Listing = execFileSync('unzip', ['-Z1', ros2Path], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    // meshes + URDF + package.xml + CMakeLists.txt + launch + rviz + README + NOTICE
    const ros2Expected = robot.assets.mesh_files + 7;
    if (ros2Listing.length !== ros2Expected) {
      throw new Error(`ROS 2 zip holds ${ros2Listing.length} entries, expected ${ros2Expected}`);
    }
    const pkg = ros2Download.suggestedFilename().replace(/_ros2\.zip$/, '');
    const ros2Dir = join(workDir, `${robot.id}-ros2`);
    execFileSync('unzip', ['-qq', ros2Path, '-d', ros2Dir], { stdio: 'pipe' });
    checkRos2Package(join(ros2Dir, pkg), pkg, upstream);

    const zipSize = statSync(zipPath).size;
    console.log(
      `  ✓ ${robot.id.padEnd(24)} urdf ${(saved.length / 1024).toFixed(0)} KB · ` +
        `zip ${(zipSize / 1e6).toFixed(1)} MB · ${listing.length} entries · ` +
        `ros2 ${pkg}`,
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
console.log(`\n${targets.length - failures}/${targets.length} robots verified (urdf · zip · ros2)`);
if (failures) process.exitCode = 1;
