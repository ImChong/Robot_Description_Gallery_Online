/**
 * "Preview my own URDF" — the picker on the gallery, and the file set it turns
 * into something js/viewer.js can load.
 *
 * Local files never leave the browser: the File API and `blob:` URLs are the
 * whole path to three.js. The alternative input is a public GitHub URL; that
 * one is fetched directly from raw.githubusercontent.com, with no proxy,
 * upload endpoint or analytics between the visitor and the repository.
 */
import { LOCAL_URL_PREFIX } from './viewer.js';
import { t } from './i18n.js';
import { formatBytes } from './registry.js';

/**
 * The id the local model answers to — never a registry id, so it cannot clash.
 * The compare view needs it too: a picked model can be put beside the machines
 * it is meant to be like, and then this is what the address bar calls it.
 */
export const CUSTOM_ID = '__local__';

/** A description is a folder, not a workspace: past this, something is wrong. */
const MAX_FILES = 6000;
const MAX_GITHUB_URDF_BYTES = 5 * 1024 * 1024;

const el = (id) => document.getElementById(id);

const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** A failure with a translatable message, so the dialog can say what went wrong. */
class PickError extends Error {
  constructor(key, params) {
    super(key);
    this.key = key;
    this.params = params || {};
  }
  text() {
    return Object.entries(this.params).reduce(
      (out, [name, value]) => out.replace(`{${name}}`, value),
      t(this.key),
    );
  }
}

/** `a/./b/../c` → `a/c`, and Windows separators along the way. */
function normalise(path) {
  const out = [];
  for (const segment of String(path).replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

const basename = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The files the visitor handed over, and the one question they have to answer:
 * given a path a URDF writes, which of them is it?
 *
 * A description can be picked from anywhere in its tree — the package folder,
 * its parent, or a handful of loose files — so a path is matched against what
 * is here rather than resolved against a root. An exact hit wins; otherwise the
 * file whose own path shares the most trailing segments with the one asked for
 * does, which is what makes `package://arm_description/meshes/base.stl` find
 * `meshes/base.stl` when only the meshes folder was picked.
 */
export class LocalFileSet {
  /**
   * @param {{path: string, file: File}[]} entries picked files, with the path
   *   each had in the tree they came from
   * @param {string} urdfPath which of them is the description
   */
  constructor(entries, urdfPath) {
    this.records = [];
    this.byPath = new Map();
    this.byBase = new Map();
    for (const { path, file } of entries) {
      const clean = normalise(path);
      const key = clean.toLowerCase();
      if (!key || this.byPath.has(key)) continue;
      const record = { key, path: clean, file, url: null };
      this.records.push(record);
      this.byPath.set(key, record);
      const base = basename(key);
      if (!this.byBase.has(base)) this.byBase.set(base, []);
      this.byBase.get(base).push(record);
    }
    this.urdf = this.byPath.get(normalise(urdfPath).toLowerCase());
    if (!this.urdf) throw new PickError('custom.noUrdf');
    /** Relative mesh paths hang off the URDF's own folder, with a trailing '/'. */
    this.dir = this.urdf.path.replace(/[^/]*$/, '');
    this._urls = [];
  }

  /** @returns {?object} the record a URDF path names, or null if nobody has it */
  lookup(path) {
    const wanted = normalise(path).toLowerCase();
    if (!wanted) return null;
    const exact = this.byPath.get(wanted);
    if (exact) return exact;
    const pool = this.byBase.get(basename(wanted));
    if (!pool || !pool.length) return null;
    if (pool.length === 1) return pool[0];
    const segments = wanted.split('/');
    let best = pool[0];
    let bestScore = -1;
    for (const record of pool) {
      const own = record.key.split('/');
      let score = 0;
      while (
        score < own.length &&
        score < segments.length &&
        own[own.length - 1 - score] === segments[segments.length - 1 - score]
      ) {
        score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = record;
      }
    }
    return best;
  }

  /**
   * The blob a `urdfgallery-local://` URL stands for, or null when no picked
   * file answers to it — which is how js/viewer.js knows to fail that mesh
   * rather than request something unreachable.
   */
  resolve(url) {
    if (typeof url !== 'string' || !url.startsWith(LOCAL_URL_PREFIX)) return null;
    // Both forms carry the same shape: a `pkg`/`rel` marker, then a path.
    const rest = url.slice(LOCAL_URL_PREFIX.length);
    const slash = rest.indexOf('/');
    const record = slash === -1 ? null : this.lookup(rest.slice(slash + 1));
    return record ? this.urlFor(record) : null;
  }

  /** A blob for one picked file, made on first use and kept until `release`. */
  urlFor(record) {
    if (!record.url) {
      record.url = URL.createObjectURL(record.file);
      this._urls.push(record.url);
    }
    return record.url;
  }

  /**
   * The path one `<mesh filename>` names — the same string urdf-loader will
   * arrive at through js/viewer.js, minus the scheme. Counting the meshes a
   * description will find is then the same question as answering `resolve`.
   */
  pathOf(filename) {
    return /^package:\/\//i.test(filename)
      ? filename.replace(/^package:\/\//i, '')
      : this.dir + filename;
  }

  /** @returns {?object} the picked file one `<mesh filename>` names */
  find(filename) {
    return this.lookup(this.pathOf(filename));
  }

  /** Hand the blobs back. Called when another model replaces this one. */
  release() {
    for (const url of this._urls) URL.revokeObjectURL(url);
    this._urls.length = 0;
    for (const record of this.records) record.url = null;
  }
}

// --------------------------------------------------------------- URDF parsing

const childrenNamed = (node, name) =>
  [...node.children].filter((child) => child.nodeName.toLowerCase() === name);

const numberAttr = (node, name) => {
  const value = Number(node?.getAttribute(name));
  return Number.isFinite(value) ? value : 0;
};

/**
 * What the specs panel needs, read straight off the XML. The viewer reports the
 * same facts once it has parsed the file, but the panel is drawn before the
 * meshes arrive and a file that will not parse should say so before the stage
 * is ever opened.
 */
function readUrdf(text) {
  // An expanded URDF usually still declares the xacro namespace on <robot>, so
  // that is no evidence either way; a xacro element or a substitution left in
  // the file is. Checked before parsing, since a template whose namespace was
  // never declared does not parse as XML at all and would otherwise be reported
  // as malformed rather than as what it is.
  if (/<xacro:/i.test(text) || /\$\{/.test(text)) throw new PickError('custom.xacro');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new PickError('custom.badXml');
  const robot = doc.documentElement;
  if (!robot || robot.nodeName.toLowerCase() !== 'robot') throw new PickError('custom.noRobot');

  const links = childrenNamed(robot, 'link');
  const joints = childrenNamed(robot, 'joint');
  const types = {};
  let moving = 0;
  for (const joint of joints) {
    const type = (joint.getAttribute('type') || 'fixed').toLowerCase();
    types[type] = (types[type] || 0) + 1;
    if (type !== 'fixed') moving += 1;
  }

  let mass = 0;
  let hasCollision = false;
  let hasInertia = false;
  for (const link of links) {
    if (childrenNamed(link, 'collision').length) hasCollision = true;
    for (const inertial of childrenNamed(link, 'inertial')) {
      mass += numberAttr(childrenNamed(inertial, 'mass')[0], 'value');
      if (childrenNamed(inertial, 'inertia').length) hasInertia = true;
    }
  }

  const meshes = [];
  for (const mesh of robot.getElementsByTagName('mesh')) {
    const filename = mesh.getAttribute('filename');
    if (filename && !meshes.includes(filename)) meshes.push(filename);
  }

  return {
    name: robot.getAttribute('name') || '',
    links: links.length,
    joints: types,
    moving_joints: moving,
    mass_kg: +mass.toFixed(3),
    has_collision: hasCollision,
    has_inertia: hasInertia,
    meshes,
  };
}

/**
 * A registry entry for a model that is not in the registry: the same shape
 * data/robots.json carries, so the detail view and the viewer need to know
 * nothing about where it came from beyond the `local` flag.
 */
function buildEntry(fileSet, text) {
  const parsed = readUrdf(text);
  const found = [];
  const missing = [];
  const formats = new Set();
  for (const filename of parsed.meshes) {
    const record = fileSet.find(filename);
    if (record) {
      found.push(record);
      const dot = record.path.lastIndexOf('.');
      if (dot !== -1) formats.add(record.path.slice(dot).toLowerCase());
    } else {
      missing.push(filename);
    }
  }
  const bytes = found.reduce((sum, record) => sum + record.file.size, 0);
  const fileName = basename(fileSet.urdf.path);

  return {
    id: CUSTOM_ID,
    local: true,
    name: parsed.name || fileName.replace(/\.[^.]+$/, ''),
    maker: '',
    category: 'custom',
    tags: [],
    dof: parsed.moving_joints,
    license: '',
    formats: ['urdf'],
    notes: null,
    notes_zh: null,
    pose: null,
    // A visitor's own model is shown in the frame its URDF was written in:
    // nothing here knows which way its palm looks.
    preview_frame: null,
    measured: null,
    urdf: {
      xml_name: parsed.name,
      links: parsed.links,
      joints: parsed.joints,
      moving_joints: parsed.moving_joints,
      mass_kg: parsed.mass_kg,
      has_collision: parsed.has_collision,
      has_inertia: parsed.has_inertia,
      bytes: fileSet.urdf.file.size,
    },
    assets: {
      base: '',
      urdf: fileSet.urlFor(fileSet.urdf),
      packages: {},
      local: fileSet,
      mesh_files: found.length,
      mesh_bytes: bytes,
      mesh_formats: [...formats],
      referenced: parsed.meshes.length,
      missing,
    },
    source: {
      local: true,
      file: fileSet.urdf.path,
      fileName,
      picked: fileSet.records.length,
      picked_bytes: fileSet.records.reduce((sum, record) => sum + record.file.size, 0),
    },
    links: {},
  };
}

// ------------------------------------------------------------- GitHub links

/**
 * Turn the two GitHub URLs people normally copy into a raw-content URL.
 * Branches and tags with a single path segment are supported; raw URLs work as
 * well as the more familiar `github.com/.../blob/...` form.
 */
export function parseGithubUrdfUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new PickError('custom.githubInvalid');
  }
  if (url.protocol !== 'https:') throw new PickError('custom.githubInvalid');

  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  let owner;
  let repo;
  let ref;
  let path;
  if (url.hostname === 'github.com') {
    [owner, repo] = parts;
    const marker = parts[2];
    if (!owner || !repo || !['blob', 'raw'].includes(marker)) {
      throw new PickError('custom.githubInvalid');
    }
    ref = parts[3];
    path = parts.slice(4).join('/');
  } else if (url.hostname === 'raw.githubusercontent.com') {
    [owner, repo, ref] = parts;
    path = parts.slice(3).join('/');
  } else {
    throw new PickError('custom.githubInvalid');
  }
  repo = repo?.replace(/\.git$/i, '');
  if (!owner || !repo || !ref || !path || !/\.urdf(?:\.xml)?$/i.test(path)) {
    throw new PickError('custom.githubInvalid');
  }

  const encoded = [owner, repo, ref, ...path.split('/')]
    .map((part) => encodeURIComponent(part))
    .join('/');
  const repoUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    owner,
    repo,
    ref,
    path,
    rawUrl: `https://raw.githubusercontent.com/${encoded}`,
    repoUrl,
    treeUrl: `${repoUrl}/tree/${encodeURIComponent(ref)}/${path.replace(/[^/]+$/, '')}`,
  };
}

/** Infer package roots from the URDF's own path and its package:// references. */
export function inferGithubPackages(urdfPath, meshes) {
  const segments = normalise(urdfPath).split('/');
  const urdfDir = segments.slice(0, -1);
  const urdfFolder = urdfDir.lastIndexOf('urdf');
  const fallback = (urdfFolder === -1 ? urdfDir : urdfDir.slice(0, urdfFolder)).join('/');
  const packages = {};
  for (const filename of meshes) {
    const match = /^package:\/\/([^/]+)/i.exec(filename);
    if (!match || packages[match[1]] !== undefined) continue;
    const index = urdfDir.lastIndexOf(match[1]);
    packages[match[1]] = (index === -1 ? fallback : urdfDir.slice(0, index + 1).join('/'));
  }
  return packages;
}

/** Build the registry-shaped entry used by the existing detail and viewer code. */
async function entryFromGithub(value) {
  const source = parseGithubUrdfUrl(value);
  const response = await fetch(source.rawUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) {
    throw new PickError('custom.githubFetch', { status: response.status });
  }
  const declaredBytes = Number(response.headers.get('content-length'));
  if (declaredBytes > MAX_GITHUB_URDF_BYTES) throw new PickError('custom.githubTooLarge');
  const text = await response.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_GITHUB_URDF_BYTES) throw new PickError('custom.githubTooLarge');

  const parsed = readUrdf(text);
  const formats = new Set(
    parsed.meshes
      .map((name) => /\.[a-z0-9]+(?=$|[?#])/i.exec(name)?.[0]?.toLowerCase())
      .filter(Boolean),
  );
  const fileName = basename(source.path);
  const base = `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/` +
    `${encodeURIComponent(source.repo)}/${encodeURIComponent(source.ref)}/`;
  return {
    id: CUSTOM_ID,
    // `local` means “the visitor's custom model” to routing and comparison.
    // `source.remote` distinguishes this from File API data in the detail UI.
    local: true,
    name: parsed.name || fileName.replace(/\.[^.]+$/, ''),
    maker: source.owner,
    category: 'custom',
    tags: [],
    dof: parsed.moving_joints,
    license: '',
    formats: ['urdf'],
    notes: null,
    notes_zh: null,
    pose: null,
    preview_frame: null,
    measured: null,
    urdf: {
      xml_name: parsed.name,
      links: parsed.links,
      joints: parsed.joints,
      moving_joints: parsed.moving_joints,
      mass_kg: parsed.mass_kg,
      has_collision: parsed.has_collision,
      has_inertia: parsed.has_inertia,
      bytes,
    },
    assets: {
      base,
      urdf: source.path,
      packages: inferGithubPackages(source.path, parsed.meshes),
      mesh_files: parsed.meshes.length,
      mesh_bytes: 0,
      mesh_formats: [...formats],
      referenced: parsed.meshes.length,
      missing: [],
    },
    source: {
      remote: true,
      file: source.path,
      fileName,
      github: `${source.owner}/${source.repo}`,
      repo_url: source.repoUrl,
      tree_url: source.treeUrl,
      commit: source.ref,
      urdf_url: source.rawUrl,
    },
    links: {},
  };
}

// ------------------------------------------------------------- picking files

/** Walk a dropped directory, which arrives as a tree rather than a file list. */
async function walkEntry(entry, prefix, out) {
  if (out.length > MAX_FILES) return;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ path: prefix + entry.name, file });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  // readEntries hands back a page at a time and signals the end with an empty
  // one, so a folder of 200 meshes needs more than the one call it looks like.
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
  }
}

async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) {
    return [...(dataTransfer.files || [])].map((file) => ({
      path: file.webkitRelativePath || file.name,
      file,
    }));
  }
  const out = [];
  for (const entry of entries) await walkEntry(entry, '', out);
  return out;
}

const fromInput = (input) =>
  [...input.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));

/** Anything that could be a description, in the order a picker should offer it. */
function urdfCandidates(entries) {
  return entries
    .filter(({ path }) => /\.(urdf|xacro)$/i.test(path) || /\.urdf\.xml$/i.test(path))
    .map(({ path }) => path)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

// ---------------------------------------------------------------------- view

/** The one model being previewed, and the files behind it. */
let current = null;

/** @returns {?object} the local model, in registry-entry shape, or null */
export function customEntry() {
  return current;
}

/**
 * Wire the hero button and its dialog.
 * @param {{ onPreview: (entry: object) => void }} handlers
 */
export function setupCustomPicker({ onPreview }) {
  const dialog = el('custom-dialog');
  const report = el('custom-report');
  const choice = el('custom-choice');
  const select = el('custom-urdf');
  const go = el('custom-go');
  const drop = el('custom-drop');
  const githubForm = el('custom-github-form');
  const githubInput = el('custom-github-url');
  const githubLoad = el('custom-github-load');

  /** The files picked so far, and the entry the current choice among them makes. */
  let picked = [];
  let pending = null;

  const show = (html) => {
    report.hidden = !html;
    report.innerHTML = html;
  };

  const fail = (message) => {
    pending = null;
    go.disabled = true;
    show(`<p class="custom-bad">${esc(message)}</p>`);
  };

  /** Read the chosen description and say what the picked files add up to. */
  async function analyse() {
    // Whatever the last look at these files made, unless it is on the stage.
    if (pending && pending !== current) pending.assets.local?.release();
    pending = null;
    const path = select.value;
    if (!path) return fail(t('custom.noUrdf'));
    let fileSet;
    try {
      fileSet = new LocalFileSet(picked, path);
    } catch (err) {
      return fail(err instanceof PickError ? err.text() : String(err.message || err));
    }
    let entry;
    try {
      entry = buildEntry(fileSet, await fileSet.urdf.file.text());
    } catch (err) {
      fileSet.release();
      return fail(err instanceof PickError ? err.text() : `${t('custom.badXml')} ${err.message || ''}`);
    }
    pending = entry;
    go.disabled = false;

    const totalBytes = picked.reduce((sum, { file }) => sum + file.size, 0);
    const lines = [
      `<p class="custom-good"><strong>${esc(entry.name)}</strong> · ${esc(basename(path))}</p>`,
      `<p>${fill(t('custom.picked'), { files: picked.length, size: formatBytes(totalBytes) })}</p>`,
      // Nothing to say about meshes for a description built out of primitives.
      entry.assets.referenced
        ? `<p>${fill(t('custom.meshes'), {
            found: entry.assets.mesh_files,
            total: entry.assets.referenced,
          })}</p>`
        : '',
    ].filter(Boolean);
    if (entry.assets.missing.length) {
      const n = entry.assets.missing.length;
      lines.push(
        `<p class="custom-warn">${fill(t(n === 1 ? 'custom.missing1' : 'custom.missing'), { n })}` +
          `<br><span class="custom-missing">${entry.assets.missing
            .slice(0, 4)
            .map((name) => esc(name))
            .join('<br>')}${entry.assets.missing.length > 4 ? '<br>…' : ''}</span></p>`,
      );
    }
    show(lines.join(''));
  }

  /** Fetch and inspect a public GitHub URDF before enabling Preview. */
  async function analyseGithub() {
    if (pending && pending !== current) pending.assets.local?.release();
    pending = null;
    go.disabled = true;
    githubLoad.disabled = true;
    show(`<p>${esc(t('custom.githubLoading'))}</p>`);
    try {
      const entry = await entryFromGithub(githubInput.value);
      pending = entry;
      go.disabled = false;
      const lines = [
        `<p class="custom-good"><strong>${esc(entry.name)}</strong> · ${esc(entry.source.fileName)}</p>`,
        `<p>${fill(t('custom.githubSource'), {
          repo: entry.source.github,
          ref: entry.source.commit,
        })}</p>`,
        entry.assets.referenced
          ? `<p>${fill(t('custom.githubMeshes'), { total: entry.assets.referenced })}</p>`
          : '',
      ].filter(Boolean);
      show(lines.join(''));
    } catch (err) {
      fail(err instanceof PickError ? err.text() : `${t('custom.githubReadFailed')} ${err.message || ''}`);
    } finally {
      githubLoad.disabled = false;
    }
  }

  /** Take a fresh set of files: find the descriptions in it, then read one. */
  async function accept(entries) {
    if (!entries.length) return;
    if (entries.length > MAX_FILES) {
      return fail(fill(t('custom.tooMany'), { n: MAX_FILES }));
    }
    picked = entries;
    const candidates = urdfCandidates(entries);
    if (!candidates.length) {
      // Nothing here to choose between, so the chooser must not go on offering
      // the last pick's files.
      select.innerHTML = '';
      choice.hidden = true;
      return fail(t('custom.noUrdf'));
    }
    select.innerHTML = candidates
      .map((path) => `<option value="${esc(path)}">${esc(path)}</option>`)
      .join('');
    // One description needs no question asked; several is the case where a
    // whole repository was dropped, and then the choice is the whole point.
    choice.hidden = candidates.length < 2;
    await analyse();
  }

  const guard = (promise) =>
    promise.catch((err) => fail(`${t('custom.readFailed')} ${err.message || err}`));

  el('custom-open').addEventListener('click', () => openDialog(dialog));
  el('custom-pick-files').addEventListener('click', () => el('custom-files').click());
  el('custom-pick-dir').addEventListener('click', () => el('custom-dir').click());
  for (const id of ['custom-files', 'custom-dir']) {
    el(id).addEventListener('change', (event) => {
      guard(accept(fromInput(event.target)));
      event.target.value = ''; // so picking the same folder twice still fires
    });
  }
  select.addEventListener('change', () => guard(analyse()));
  githubForm.addEventListener('submit', (event) => {
    event.preventDefault();
    guard(analyseGithub());
  });

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    drop.addEventListener(type, () => drop.classList.remove('is-over'));
  }
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('is-over');
    guard(filesFromDrop(event.dataTransfer).then(accept));
  });
  // Clicking the zone is a shortcut for the button inside it; the keyboard uses
  // that button, so the zone itself is not in the tab order twice over.
  drop.addEventListener('click', (event) => {
    if (!event.target.closest('button')) el('custom-files').click();
  });

  go.addEventListener('click', () => {
    if (!pending) return;
    // The blobs of whatever was on the stage before this one.
    if (current && current !== pending) current.assets.local?.release();
    current = pending;
    pending = null;
    closeDialog(dialog);
    renderHeroCurrent();
    onPreview(current);
  });

  el('custom-cancel').addEventListener('click', () => closeDialog(dialog));
  dialog.addEventListener('cancel', () => closeDialog(dialog));
  renderHeroCurrent();
}

/** A way back to the model already previewed, next to the button that made it. */
function renderHeroCurrent() {
  const host = el('custom-current');
  if (!host) return;
  host.hidden = !current;
  if (current) {
    host.innerHTML = `<a href="#custom=1">${esc(t('custom.again'))} <strong>${esc(current.name)}</strong></a>`;
  }
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

/** `{n}` placeholders, the same convention the rest of the UI strings use. */
function fill(text, params) {
  return Object.entries(params).reduce(
    (out, [name, value]) => out.replace(`{${name}}`, esc(value)),
    esc(text),
  );
}
