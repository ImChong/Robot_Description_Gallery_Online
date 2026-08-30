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
      // A model's versions are on its detail page rather than on cards of
      // their own, so searching for one of them has to reach the card that
      // holds it: "mode_15" and "lock_waist" name G1 files, not robots.
      ...(robot.variants || []).map((v) => v.name),
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

/**
 * One version of a model, shaped like a registry entry.
 *
 * Upstream often publishes a machine as several URDFs — the G1 ships
 * twenty-two, one per `mode_machine` and hand combination — and the gallery
 * gives them one card and one detail page with a picker on it. Rather than
 * teach the viewer, the spec table and the three download writers what a
 * version is, the picked one is materialised into the shape a single-file
 * entry already has: they go on reading `assets`, `urdf` and `formats` and
 * never learn that a choice was made.
 *
 * `id` becomes the version's, because that is what a downloaded file, a saved
 * PNG and a generated ROS 2 package should be called; `modelId` keeps the id
 * the gallery, the address bar and prev/next are keyed on.
 *
 * @param {object} robot registry entry
 * @param {string} [variantId] falls back to the model's default version
 */
export function variantView(robot, variantId) {
  const variants = robot.variants || [];
  if (!variants.length) return robot;
  const variant = variants.find((v) => v.id === variantId) || variants[0];
  return {
    ...robot,
    id: variant.id,
    modelId: robot.id,
    variant,
    // Long enough to say which machine and which of its files, since this is
    // the name that reaches the ROS 2 package and the fullscreen caption.
    name: `${robot.name} · ${variant.name}`,
    modelName: robot.name,
    dof: variant.dof,
    formats: variant.formats,
    notes: variant.notes ?? robot.notes,
    notes_zh: variant.notes_zh ?? robot.notes_zh,
    measured: variant.measured,
    urdf: variant.urdf,
    // Every version of a model is read from the one repository at the one
    // pinned commit, so only the paths below the base differ.
    assets: { ...robot.assets, ...variant.assets },
    source: { ...robot.source, mjcf: variant.mjcf },
  };
}

export function byId(data, id) {
  return data.robots.find((r) => r.id === id) || null;
}

export function filterRobots(data, { query = '' } = {}) {
  const q = query.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  return data.robots.filter((robot) => terms.every((term) => robot._haystack.includes(term)));
}

/**
 * The gallery's reading order: humanoids, then quadrupeds, then arms — one
 * group per category, in registry order, with anything whose category the
 * registry does not list appended after them. The search still applies inside
 * the groups, and a group nothing matches is dropped rather than left empty.
 *
 * @returns {{ id: string, robots: object[] }[]}
 */
export function groupRobots(data, state = {}) {
  const groups = new Map(data.categories.map((c) => [c.id, []]));
  for (const robot of filterRobots(data, state)) {
    if (!groups.has(robot.category)) groups.set(robot.category, []);
    groups.get(robot.category).push(robot);
  }
  return [...groups]
    .filter(([, robots]) => robots.length)
    .map(([id, robots]) => ({ id, robots }));
}

export function stats(data) {
  const makers = new Set();
  const categories = new Set();
  const repos = new Set();
  for (const robot of data.robots) {
    if (robot.maker) makers.add(robot.maker);
    if (robot.category) categories.add(robot.category);
    // Several robots share one upstream description repository, so this counts
    // the repositories the gallery streams from, not the robots in them.
    if (robot.source?.github) repos.add(robot.source.github);
  }
  return {
    robots: data.robots.length,
    makers: makers.size,
    categories: categories.size,
    repos: repos.size,
  };
}

export function urdfUrl(robot) {
  return robot.assets.base + robot.assets.urdf;
}

/**
 * The description this entry is built on, whichever language it is written in.
 *
 * Most of the gallery is about URDF, but a MuJoCo Menagerie model that nobody
 * ever published a URDF of is described by its MJCF and nothing else. The two
 * blocks carry the same fields — links, joints, moving joints, mass, size on
 * disk — so a panel that only wants to say how big the description is asks
 * this rather than asking which format it is in.
 */
export function descriptionOf(robot) {
  return robot.urdf || robot.mjcf || null;
}

/** The file the description itself lives in, on the CDN or on the mirror. */
export function descriptionUrl(robot) {
  return robot.assets.base + descriptionPath(robot);
}

/** Its repository-relative path. */
export function descriptionPath(robot) {
  return robot.assets.urdf || robot.assets.mjcf || '';
}

/** `urdf` or `mjcf` — which of the two this entry is rendered from. */
export function descriptionKind(robot) {
  return robot.assets.urdf ? 'urdf' : 'mjcf';
}

/**
 * Apply an entry's `assets.mesh_rewrite` substitutions to a resolved mesh path.
 *
 * Only mirrored entries have any. An archive that re-hosts someone else's URDF
 * tends to flatten the mesh tree while leaving the references alone, so the
 * paths the URDF writes are not the paths the host serves; these put them back.
 * The build step applies the same rules, so what it recorded as present and
 * what the browser asks for are the same files.
 *
 * @param {string} path
 * @param {{from: string, to: string}[]} [rules]
 */
export function applyMeshRewrite(path, rules) {
  let out = path;
  for (const { from, to } of rules || []) out = out.split(from).join(to);
  return out;
}

export function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}
