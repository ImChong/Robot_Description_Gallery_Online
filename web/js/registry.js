/** Loading, indexing and filtering of data/robots.json. */

let cache = null;

/**
 * The visibility list: one task-list line per robot in data/visibility.md.
 * Only the checkbox and the leading `id` matter; everything after them is
 * there for whoever is reading the file.
 *
 *     - [x] `g1` **G1** — UNITREE Robotics — [unitreerobotics/unitree_ros …](…)
 */
const VISIBILITY_LINE = /^\s*[-*]\s*\[([ xX])\]\s*`([a-z0-9_]+)`/;

/** @returns {Map<string, boolean>} robot id -> shown in the gallery */
export function parseVisibility(text) {
  const wanted = new Map();
  for (const line of text.split('\n')) {
    const match = VISIBILITY_LINE.exec(line);
    if (match) wanted.set(match[2], match[1] !== ' ');
  }
  return wanted;
}

/**
 * Hand-editing data/visibility.md is the whole point, so every failure mode
 * here shows the robot rather than hiding it: a missing or unreadable file
 * leaves the gallery complete, and an id nobody has listed yet (a robot added
 * to the registry before the file was regenerated) shows up by default.
 */
async function applyVisibility(data, url) {
  let wanted;
  try {
    const response = await fetch(url);
    if (!response.ok) return;
    wanted = parseVisibility(await response.text());
  } catch {
    return; // file not deployed, offline, ad blocker — show everything
  }
  if (!wanted.size) return;
  data.hidden = data.robots.filter((r) => wanted.get(r.id) === false);
  data.robots = data.robots.filter((r) => wanted.get(r.id) !== false);
}

export async function loadRegistry(url = '../data/robots.json', { visibility = true } = {}) {
  if (cache) return cache;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`registry ${response.status}`);
  const data = await response.json();
  for (const robot of data.robots) {
    robot._haystack = [
      robot.id, robot.name, robot.maker, robot.category,
      robot.source.description, robot.source.github, ...(robot.tags || []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }
  data.hidden = [];
  // Sibling of the registry, so this works from /web/ and from thumb.html alike.
  if (visibility) await applyVisibility(data, url.replace(/[^/]*$/, 'visibility.md'));
  cache = data;
  return data;
}

export function byId(data, id) {
  return data.robots.find((r) => r.id === id) || null;
}

/** Categories that actually have entries, in registry order, with counts. */
export function categoriesWithCounts(data) {
  const counts = new Map();
  for (const robot of data.robots) {
    counts.set(robot.category, (counts.get(robot.category) || 0) + 1);
  }
  return data.categories
    .filter((c) => counts.has(c.id))
    .map((c) => ({ ...c, count: counts.get(c.id) }));
}

export function filterRobots(data, { category = 'all', query = '' } = {}) {
  const q = query.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  return data.robots.filter((robot) => {
    if (category !== 'all' && robot.category !== category) return false;
    return terms.every((term) => robot._haystack.includes(term));
  });
}

export function stats(data) {
  const makers = new Set();
  const repos = new Set();
  let joints = 0;
  for (const robot of data.robots) {
    if (robot.maker) makers.add(robot.maker);
    if (robot.source.github) repos.add(robot.source.github);
    joints += robot.urdf.moving_joints || 0;
  }
  return { robots: data.robots.length, makers: makers.size, repos: repos.size, joints };
}

export function urdfUrl(robot) {
  return robot.assets.base + robot.assets.urdf;
}

export function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}
