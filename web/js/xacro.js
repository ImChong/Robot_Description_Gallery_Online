/**
 * Xacro entries: a registry description that upstream only publishes as xacro.
 *
 * The gallery's own entries are plain URDF. A few makers (ROBOTIS' OP3 is the
 * case that needed this) publish nothing but `*.urdf.xacro`, so for those the
 * registry points `assets.urdf` at the xacro and every consumer that wants the
 * description as text asks `fetchDescriptionText` instead of fetching the file
 * itself: it gets the URDF the xacro expands to, which is what the registry
 * build parsed when it wrote the entry's numbers.
 *
 * Expansion runs in the browser (xacro-parser needs a DOM). The build reaches
 * the same code through scripts/expand_xacro.mjs, so the facts in
 * data/robots.json and the model on the stage come from one expansion.
 */

export const isXacroPath = (path) => /\.xacro$/i.test(String(path || ''));

/**
 * The name the expansion is saved under: `robot.urdf.xacro` → `robot.urdf`,
 * `robot.xacro` → `robot.urdf`. Plain URDF paths come back unchanged.
 */
export function urdfFileName(path) {
  if (!isXacroPath(path)) return path;
  const stem = path.replace(/\.xacro$/i, '');
  return /\.urdf$/i.test(stem) ? stem : `${stem}.urdf`;
}

/** `a/./b/../c` → `a/c`. */
function normalise(path) {
  const out = [];
  for (const segment of String(path).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/**
 * Where a path the xacro writes lives, as a repository-relative path.
 * `package://pkg/rel` goes through the entry's package roots; anything else is
 * already relative to the repository, because the parser was given the xacro's
 * own directory as its working path.
 */
export function resolveXacroPath(path, packages) {
  if (path.startsWith('package://')) {
    const [pkg, ...rest] = path.slice('package://'.length).split('/');
    const root = packages?.[pkg];
    if (root === undefined) throw new Error(`xacro: package ${pkg} has no root in this entry`);
    return normalise(`${root}/${rest.join('/')}`);
  }
  return normalise(path);
}

/**
 * Expand a xacro template to URDF text.
 *
 * ROS Jade semantics (`inOrder`, `requirePrefix`, `localProperties`), the same
 * as the custom-model picker uses. `<xacro:arg>`s take their declared defaults.
 * Gazebo and ros_control blocks describe a simulation rather than a robot and
 * urdf-loader reads neither, so they are dropped, as are visuals and collisions
 * left with an empty `<geometry>` by a conditional that did not fire.
 *
 * @param {string} text the template
 * @param {object} options
 * @param {string} options.workingPath repository-relative directory of the template
 * @param {(path: string) => Promise<string>} options.readText answers includes,
 *   given a path `resolveXacroPath` would accept
 */
export async function expandXacroText(text, { workingPath, readText }) {
  const { XacroParser } = await import('xacro-parser');
  const parser = new XacroParser();
  parser.inOrder = true;
  parser.requirePrefix = true;
  parser.localProperties = true;
  parser.workingPath = workingPath;
  parser.arguments = xacroArguments(text);
  parser.rospackCommands = { find: (pkg) => `package://${pkg}` };
  parser.getFileContents = readText;
  const doc = await parser.parse(text);
  for (const node of doc.querySelectorAll('gazebo, transmission')) node.remove();
  for (const geometry of doc.querySelectorAll('geometry')) {
    if (geometry.children.length) continue;
    const holder = geometry.parentNode;
    if (holder?.nodeName === 'visual' || holder?.nodeName === 'collision') holder.remove();
  }
  return new XMLSerializer().serializeToString(doc).replace(/\sxmlns=""/g, '');
}

function xacroArguments(text) {
  const args = {};
  for (const [, name, value] of text.matchAll(
    /<(?:xacro:)?arg\s+name=["']([^"']+)["'](?:\s+default=["']([^"']*)["'])?/g,
  )) {
    args[name] = value ?? '';
  }
  return args;
}

const expansions = new Map();

/**
 * The description of a registry entry as URDF text: the file itself when it is
 * a URDF, its expansion when it is a xacro. Expansions are cached per URL —
 * the stage, the detail panel, the comparison and the download all ask.
 *
 * @param {object} robot registry entry (or `variantView` of one)
 * @returns {Promise<string>}
 */
export async function fetchDescriptionText(robot) {
  const { base, urdf, packages } = robot.assets;
  const url = base + urdf;
  if (!isXacroPath(urdf)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`URDF ${response.status} ${url}`);
    return response.text();
  }
  if (!expansions.has(url)) {
    const job = (async () => {
      const readText = async (path) => {
        const target = base + resolveXacroPath(path, packages);
        const response = await fetch(target);
        if (!response.ok) throw new Error(`xacro include ${response.status} ${target}`);
        return response.text();
      };
      const response = await fetch(url);
      if (!response.ok) throw new Error(`URDF ${response.status} ${url}`);
      return expandXacroText(await response.text(), {
        workingPath: urdf.replace(/[^/]+$/, ''),
        readText,
      });
    })();
    expansions.set(url, job);
    job.catch(() => expansions.delete(url));
  }
  return expansions.get(url);
}
