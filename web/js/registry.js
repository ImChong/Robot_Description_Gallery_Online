/** Loading, indexing and filtering of data/robots.json. */

let cache = null;

export async function loadRegistry(url = '../data/robots.json') {
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
