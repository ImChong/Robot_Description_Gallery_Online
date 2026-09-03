#!/usr/bin/env node
/**
 * Validate data/robots.json without opening a browser: structural invariants
 * the site relies on, plus (with --links) the hand-written URLs in
 * data/curation.json, which are the one part of the registry no build step can
 * verify.
 *
 *   node scripts/check_registry.mjs [--links] [--thumbs]
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseVisibility } from '../web/js/registry.js';

const args = process.argv.slice(2);
const root = new URL('..', import.meta.url);
const registry = JSON.parse(readFileSync(new URL('data/robots.json', root)));

const problems = [];
const warnings = [];
const fail = (id, message) => problems.push(`${id}: ${message}`);
const warn = (id, message) => warnings.push(`${id}: ${message}`);

/**
 * Card renders are transparent WebP files. A screenshot copied from a viewer
 * can have the right name and dimensions while baking the studio grid into the
 * image, so existence alone is not enough to catch that mistake.
 */
function checkThumbnail(id) {
  const path = new URL(`web/thumbs/${id}.webp`, root);
  if (!existsSync(path)) {
    fail(id, 'no thumbnail — run `npm run thumbs`');
    return;
  }
  const bytes = readFileSync(path);
  let alpha = false;
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const chunk = bytes.subarray(offset, offset + 4).toString();
      const size = bytes.readUInt32LE(offset + 4);
      const data = offset + 8;
      if (chunk === 'ALPH' || (chunk === 'VP8X' && size && (bytes[data] & 0x10))) {
        alpha = true;
        break;
      }
      offset = data + size + (size & 1);
    }
  }
  if (!alpha) {
    fail(id, 'thumbnail has no alpha channel — regenerate it with `npm run thumbs -- --force`');
  }
}

const categories = new Set(registry.categories.map((c) => c.id));
const ids = new Set();
const variantIds = new Set();

for (const robot of registry.robots) {
  const id = robot.id || '(missing id)';
  if (!robot.id) fail(id, 'missing id');
  if (ids.has(robot.id)) fail(id, 'duplicate id');
  ids.add(robot.id);
  if (!/^[a-z0-9_]+$/.test(robot.id)) fail(id, `id is not a slug: ${robot.id}`);
  if (!robot.name) fail(id, 'missing name');
  if (!categories.has(robot.category)) fail(id, `unknown category ${robot.category}`);

  const { assets, source, urdf } = robot;
  if (!assets?.base?.startsWith('https://')) fail(id, 'assets.base is not https');
  // A mirrored entry is read from an archive that publishes no revision, so
  // there is no commit to pin it to and nothing for the drift check in CI to
  // compare. What it must do instead is say where it came from, loudly enough
  // that the detail page can tell a visitor.
  if (source.mirror) {
    if (source.commit || source.github) fail(id, 'a mirrored entry must not claim a commit');
    if (!source.mirror.host) fail(id, 'mirror has no host');
    if (!source.mirror.site?.startsWith('https://')) fail(id, 'mirror.site is not https');
    if (!assets.base.startsWith(source.mirror.site.split('/').slice(0, 3).join('/'))) {
      warn(id, `mirror serves its files from another host than its page: ${assets.base}`);
    }
  } else {
    if (!assets.base.includes(source.commit)) fail(id, 'assets.base is not pinned to source.commit');
    // robot_descriptions pins most repositories to a sha and a few to a release
    // tag; both are reproducible. A branch name is not.
    const ref = source.commit || '';
    if (!/^[0-9a-f]{40}$/.test(ref) && !/^v?\d+(\.\d+)*/.test(ref)) {
      fail(id, `upstream ref is not pinned to a sha or version tag: ${ref}`);
    }
  }
  // Two reasons a description may reference geometry this gallery does not
  // serve, and no others: an archive that re-hosts someone else's URDF keeps
  // only the meshes it renders, and an MJCF that names a collision mesh the
  // host does not have. Oversized files the CDN refuses are remapped to
  // GitHub raw in `assets.mesh_alt` rather than skipped. A repository entry
  // whose URDF names a mesh that simply is not there is a broken entry, and
  // the build refuses it rather than recording it here.
  if (assets.skip_meshes?.length && !source.mirror && urdf) {
    fail(id, 'skips meshes but is neither a mirrored entry nor an MJCF description');
  }
  for (const path of assets.skip_meshes || []) {
    if (path.startsWith('/') || path.startsWith('http')) {
      fail(id, `skipped mesh is not a host-relative path: ${path}`);
    }
  }
  for (const [path, url] of Object.entries(assets.mesh_alt || {})) {
    if (path.startsWith('/') || path.startsWith('http')) {
      fail(id, `mesh_alt key is not a host-relative path: ${path}`);
    }
    if (!url.startsWith('https://raw.githubusercontent.com/')) {
      fail(id, `mesh_alt is not a GitHub raw URL: ${url}`);
    }
    if (source.github && !url.includes(`/${source.github}/`)) {
      fail(id, `mesh_alt does not point at ${source.github}`);
    }
    if (source.commit && !url.includes(`/${source.commit}/`)) {
      fail(id, `mesh_alt is not pinned to source.commit`);
    }
  }
  for (const rule of assets.mesh_rewrite || []) {
    if (!rule.from || rule.to === undefined) fail(id, 'mesh_rewrite rule needs a from and a to');
  }
  if (source.mjcf_external) {
    if (!source.mjcf_external.url?.includes(source.mjcf_external.commit)) {
      fail(id, 'external MJCF URL is not pinned to its source commit');
    }
    if (!source.mjcf_external.live_url?.startsWith('https://live.mujoco.org/')) {
      fail(id, 'external MJCF has no MuJoCo Live URL');
    }
  }
  // An MJCF-only entry is rendered on the same stage a URDF is, from its MuJoCo
  // XML, so it has to carry the same facts — the difference is which file they
  // were read out of, and that its detail page also links to MuJoCo Live.
  if (!urdf) {
    const mjcf = robot.mjcf;
    if (robot.formats?.length !== 1 || robot.formats[0] !== 'mjcf') {
      fail(id, 'description without URDF is not MJCF-only');
    }
    if (!assets.mjcf) fail(id, 'MJCF-only entry has no scene path');
    if (!assets.mjcf_model) fail(id, 'MJCF-only entry does not say which file to render');
    if (assets.mjcf.startsWith('/') || assets.mjcf_model?.startsWith('/')) {
      fail(id, 'MJCF paths must be repo-relative');
    }
    if (robot.external_url) fail(id, 'MJCF-only entry should open its own detail page');
    if (!mjcf?.links) fail(id, 'no bodies parsed from the MJCF');
    if (!assets.mesh_files && !mjcf?.links) fail(id, 'no geometry at all');
    if (!source.mjcf_external?.url?.includes(source.commit)) {
      fail(id, 'MJCF-only scene is not pinned to the source commit');
    }
    if (!source.mjcf_external?.live_url) fail(id, 'MJCF-only entry has no MuJoCo Live link');
    if (robot.dof && mjcf?.moving_joints && robot.dof > mjcf.moving_joints) {
      warn(id, `declared DOF ${robot.dof} exceeds ${mjcf.moving_joints} moving joints`);
    }
    if (args.includes('--thumbs')) checkThumbnail(id);
    if (!robot.license) warn(id, 'no SPDX licence recorded upstream');
    continue;
  }
  if (!assets.urdf) fail(id, 'missing assets.urdf');
  if (assets.urdf.startsWith('/')) fail(id, 'assets.urdf must be repo-relative');
  for (const [pkg, dir] of Object.entries(assets.packages || {})) {
    if (dir.endsWith('/')) fail(id, `package ${pkg} root ends with a slash`);
    if (dir.startsWith('/')) fail(id, `package ${pkg} root must be repo-relative`);
  }
  if (!assets.mesh_files && !urdf.links) fail(id, 'no geometry at all');
  if (!urdf.links) fail(id, 'no links parsed from the URDF');
  if (!robot.formats?.includes('urdf')) fail(id, 'not marked as a URDF description');
  if (!robot.license) warn(id, 'no SPDX licence recorded upstream');

  // Upstream data quality: flag values that cannot be right, rather than
  // silently correcting them.
  if (urdf.mass_kg && urdf.mass_kg > 2000) {
    warn(id, `URDF mass is implausible (${urdf.mass_kg} kg) — upstream data`);
  }
  if (robot.dof && urdf.moving_joints && robot.dof > urdf.moving_joints) {
    warn(id, `declared DOF ${robot.dof} exceeds ${urdf.moving_joints} moving joints`);
  }
  if (assets.mesh_bytes > 60e6) {
    warn(id, `${(assets.mesh_bytes / 1e6).toFixed(0)} MB of meshes — slow to load`);
  }
  if (args.includes('--thumbs')) checkThumbnail(id);

  // A machine upstream publishes as several URDFs is one entry with a version
  // picker on its detail page. The versions are addressed by id in the site's
  // address bar and looked up by id in data/measured.json, so they share one
  // namespace with the robots and have to be as unique.
  for (const variant of robot.variants || []) {
    const vid = variant.id || '(missing id)';
    const at = `${id} · ${vid}`;
    if (!variant.id) fail(at, 'version has no id');
    if (!/^[a-z0-9_]+$/.test(vid)) fail(at, `version id is not a slug: ${vid}`);
    if (ids.has(vid) || variantIds.has(vid)) fail(at, 'duplicate id');
    variantIds.add(vid);
    if (!variant.name) fail(at, 'version has no name');
    if (!variant.assets?.urdf) fail(at, 'version has no URDF path');
    if (!variant.urdf?.links) fail(at, 'no links parsed from the version URDF');
    if (!variant.formats?.includes('urdf')) fail(at, 'version is not marked as a URDF');
    for (const format of variant.formats || []) {
      if (!robot.formats.includes(format)) {
        fail(at, `version offers ${format} but the card does not say so`);
      }
    }
  }
  // The entry's own file is what the card is rendered from and what the detail
  // page opens on, so it has to be one of the versions — the first one.
  if (robot.variants?.length && robot.variants[0].assets.urdf !== assets.urdf) {
    fail(id, `opens on ${assets.urdf}, which is not its first version`);
  }
}

for (const category of registry.categories) {
  if (!registry.robots.some((r) => r.category === category.id)) {
    warn(category.id, 'category has no robots');
  }
  if (!category.label || !category.label_zh) fail(category.id, 'category missing a label');
}

// data/visibility.md decides which entries the site shows. It is generated
// from this registry, so a row that names nothing is a typo the site would
// silently ignore, and a missing row is an entry nobody can switch off.
const visibilityPath = new URL('data/visibility.md', root);
if (existsSync(visibilityPath)) {
  const visibility = parseVisibility(readFileSync(visibilityPath, 'utf8'));
  for (const [id] of visibility) {
    if (!ids.has(id)) fail(id, 'listed in data/visibility.md but not in the registry');
  }
  for (const robot of registry.robots) {
    if (!visibility.has(robot.id)) {
      warn(robot.id, 'no row in data/visibility.md — run `npm run visibility`');
    }
  }
  const shown = [...visibility.values()].filter(Boolean).length;
  console.log(`  visibility  ${shown}/${visibility.size} entries shown`);
  if (variantIds.size) {
    console.log(`  versions    ${variantIds.size} across ${registry.robots.filter((r) => r.variants?.length).length} entries`);
  }
} else {
  warn('visibility', 'data/visibility.md is missing — run `npm run visibility`');
}

if (args.includes('--links')) {
  const urls = new Map();
  for (const robot of registry.robots) {
    for (const [kind, url] of Object.entries(robot.links || {})) {
      if (url) urls.set(url, `${robot.id} (${kind})`);
    }
  }
  console.log(`checking ${urls.size} curated links …`);
  const results = await Promise.all(
    [...urls].map(async ([url, owner]) => {
      for (const method of ['HEAD', 'GET']) {
        try {
          const response = await fetch(url, {
            method,
            redirect: 'follow',
            signal: AbortSignal.timeout(20000),
          });
          if (response.ok) return null;
          // Plenty of marketing sites reject HEAD; only a failed GET counts.
          if (method === 'GET') return `${owner} ${url} → HTTP ${response.status}`;
        } catch (err) {
          if (method === 'GET') return `${owner} ${url} → ${err.name}`;
        }
      }
      return null;
    }),
  );
  for (const result of results.filter(Boolean)) warn('link', result);
}

for (const warning of warnings) console.log(`  warn  ${warning}`);
for (const problem of problems) console.error(`  FAIL  ${problem}`);
console.log(
  `\n${registry.robots.length} robots · ${problems.length} problems · ${warnings.length} warnings`,
);
if (problems.length) process.exitCode = 1;
