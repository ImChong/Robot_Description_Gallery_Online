#!/usr/bin/env node
/**
 * Exercise the download buttons in a real browser and validate what comes out.
 *
 *   node scripts/serve.mjs &
 *   node scripts/check_downloads.mjs [--robot <id>] [--all]
 *
 * `--robot` and `--all` cover every version of a machine upstream publishes as
 * several URDFs; the default sample takes only the one its card opens on.
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
import { applyMeshRewrite, parseVisibility } from '../web/js/registry.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const base = flag('--base', process.env.BASE_URL || 'http://localhost:8080');
const registry = JSON.parse(readFileSync(new URL('../data/robots.json', import.meta.url)));

// The site only serves what data/visibility.md leaves checked, so that is what
// there is to exercise; an unchecked robot has no detail page or download buttons.
const visibilityPath = new URL('../data/visibility.md', import.meta.url);
const visibility = existsSync(visibilityPath)
  ? parseVisibility(readFileSync(visibilityPath, 'utf8'))
  : new Map();
const shown = registry.robots.filter((r) => visibility.get(r.id) !== false);
const downloadable = shown.filter((r) => r.formats.includes('urdf'));
const hidden = registry.robots.length - shown.length;
if (hidden) console.log(`${hidden} robot(s) hidden by data/visibility.md`);

/**
 * What one set of download buttons is: a robot, or one version of a robot that
 * upstream publishes as several URDFs. The buttons write whichever version the
 * detail page is on, so each has to be reached by its own address and checked
 * against its own file and mesh count.
 */
function loads(robot, everyVersion) {
  const variants = robot.variants || [];
  if (!variants.length) return [{ ...robot, url: `#robot=${robot.id}` }];
  const wanted = everyVersion ? variants : variants.slice(0, 1);
  return wanted.map((v) => ({
    ...robot,
    ...v,
    id: v.id,
    url: `#robot=${robot.id}${v.id === variants[0].id ? '' : `&v=${v.id}`}`,
    assets: { ...robot.assets, ...v.assets },
  }));
}

let targets;
if (flag('--robot')) {
  targets = downloadable.filter((r) => r.id === flag('--robot')).flatMap((r) => loads(r, true));
  if (!targets.length) console.log(`${flag('--robot')}: not shown (or unknown) — nothing to test`);
} else if (args.includes('--all')) {
  targets = downloadable.flatMap((r) => loads(r, true));
} else {
  // Default: the lightest shown robot per mesh format, so every loader path that
  // the bundle has to copy is covered without downloading a gigabyte.
  const byFormat = new Map();
  for (const robot of downloadable) {
    const key = robot.assets.mesh_formats.join('+');
    const current = byFormat.get(key);
    if (!current || robot.assets.mesh_bytes < current.assets.mesh_bytes) {
      byFormat.set(key, robot);
    }
  }
  targets = [...byFormat.values()].flatMap((r) => loads(r, false));
}

if (!targets.length) {
  console.log('nothing to test');
  process.exit(0);
}

/**
 * Fetch a text asset the way build_registry.py does: a 200 or a 404 is an
 * answer, anything else — a 5xx, a 429, a reset connection — is the CDN having
 * a moment, and gets another go. One dropped connection used to fail the whole
 * job with a bare "fetch failed" and no clue which request it was: that is how
 * fanuc_m710ic failed on main while passing on the very commit that merged.
 */
async function fetchText(url, attempts = 3) {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await new Promise((done) => setTimeout(done, 2 ** attempt * 1000));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (response.ok) return response.text();
      failure = new Error(`${url} → HTTP ${response.status}`);
      if (response.status === 404) break;
    } catch (err) {
      failure = new Error(`${url} → ${err.message || err}`);
    }
  }
  throw failure;
}

/**
 * XML text with its comments removed.
 *
 * The generated package is built from a DOM parse — web/js/download.js walks
 * `<mesh>` elements — so a mesh reference that exists only inside a comment is
 * neither fetched nor rewritten, which is right: nothing loads it. This check
 * reads the URDF as text instead of XML, so that it can compare byte-for-byte
 * against upstream, and has to drop the comments itself or it reads those
 * deliberately untouched references as broken ones. ANYmal D is the case in
 * point: it ships a commented-out `hatch` link whose mesh still names
 * `package://anymal_d_simple_description/...`.
 */
function withoutComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * The URDF's own mesh references that resolve to a path the host does not have.
 *
 * Resolved the same way the registry builder and the browser resolve them —
 * package root, then the entry's rewrite rules — so this agrees with the
 * `assets.skip_meshes` paths recorded at build time. Empty for every entry read
 * from a repository, which may not skip anything.
 */
function skippedRefsOf(robot, urdfText) {
  const skip = new Set(robot.assets.skip_meshes || []);
  if (!skip.size) return [];
  const urdfDir = robot.assets.urdf.replace(/[^/]*$/, '');
  const out = new Set();
  for (const [, ref] of withoutComments(urdfText).matchAll(/<mesh[^>]*filename="([^"]*)"/g)) {
    let path;
    if (ref.startsWith('package://')) {
      const [pkg, ...rest] = ref.slice('package://'.length).split('/');
      const root = robot.assets.packages[pkg];
      if (root === undefined) continue;
      path = normalise(`${root}/${rest.join('/')}`);
    } else if (/^(https?|file):/.test(ref)) {
      continue;
    } else {
      path = normalise(urdfDir + ref);
    }
    if (skip.has(applyMeshRewrite(path, robot.assets.mesh_rewrite))) out.add(ref);
  }
  return [...out];
}

function normalise(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Drop the `<visual>` and `<collision>` elements naming one of `refs`.
 *
 * The same edit web/js/download.js makes to a mirrored model's URDF, so that
 * the comparison below can be told what the package is allowed to be missing.
 */
function dropGeometry(xml, refs) {
  if (!refs.length) return xml;
  const wanted = new Set(refs);
  return xml.replace(/[ \t]*<(visual|collision)\b[^>]*>[\s\S]*?<\/\1>\n?/g, (element) => {
    for (const [, quoted] of element.matchAll(/filename\s*=\s*"([^"]*)"/g)) {
      if (wanted.has(quoted)) return '';
    }
    return element;
  });
}

/**
 * Everything that has to hold for the generated package to build and launch:
 * the files ament and the launch file expect, a launch file Python can parse,
 * and mesh references that resolve inside the package. The URDF must also be
 * upstream's, changed in nothing but those references — and, for a mirrored
 * model, minus the geometry whose mesh the host does not have, which the
 * package drops so that it loads at all.
 *
 * @param {string} root  the unpacked package directory
 * @param {string} pkg   its package name
 * @param {string} upstream  the upstream URDF text
 * @param {string[]} skippedRefs  mesh references the host does not have
 */
function checkRos2Package(root, pkg, upstream, skippedRefs = []) {
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
  for (const [, ref] of withoutComments(urdf).matchAll(/<mesh[^>]*filename="([^"]*)"/g)) {
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
  if (bare(urdf) !== bare(dropGeometry(upstream, skippedRefs))) {
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
    await page.goto(`${base}/web/${robot.url}`, { waitUntil: 'commit' });
    await page.waitForSelector('button[data-download="bundle"]', { timeout: 60000 });

    // --- single URDF ---
    const urdfDownload = await Promise.all([
      page.waitForEvent('download', { timeout: 180000 }),
      page.click('button[data-download="urdf"]'),
    ]).then(([download]) => download);
    const urdfPath = join(workDir, `${robot.id}.urdf`);
    await urdfDownload.saveAs(urdfPath);

    const upstream = await fetchText(robot.assets.base + robot.assets.urdf);
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
    checkRos2Package(join(ros2Dir, pkg), pkg, upstream, skippedRefsOf(robot, upstream));

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
