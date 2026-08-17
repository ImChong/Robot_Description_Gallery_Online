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

const args = process.argv.slice(2);
const root = new URL('..', import.meta.url);
const registry = JSON.parse(readFileSync(new URL('data/robots.json', root)));

const problems = [];
const warnings = [];
const fail = (id, message) => problems.push(`${id}: ${message}`);
const warn = (id, message) => warnings.push(`${id}: ${message}`);

const categories = new Set(registry.categories.map((c) => c.id));
const ids = new Set();

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
  if (!assets.base.includes(source.commit)) fail(id, 'assets.base is not pinned to source.commit');
  // robot_descriptions pins most repositories to a sha and a few to a release
  // tag; both are reproducible. A branch name is not.
  const ref = source.commit || '';
  if (!/^[0-9a-f]{40}$/.test(ref) && !/^v?\d+(\.\d+)*/.test(ref)) {
    fail(id, `upstream ref is not pinned to a sha or version tag: ${ref}`);
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
  if (args.includes('--thumbs') && !existsSync(new URL(`web/thumbs/${robot.id}.webp`, root))) {
    fail(id, 'no thumbnail — run `npm run thumbs`');
  }
}

for (const category of registry.categories) {
  if (!registry.robots.some((r) => r.category === category.id)) {
    warn(category.id, 'category has no robots');
  }
  if (!category.label || !category.label_zh) fail(category.id, 'category missing a label');
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
