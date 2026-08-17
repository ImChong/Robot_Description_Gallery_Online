/**
 * One-click downloads.
 *
 * Two flavours, because a URDF on its own renders as nothing:
 *   - `downloadUrdf`   — just the .urdf file, exactly as upstream ships it.
 *   - `downloadBundle` — a .zip with the URDF plus every mesh it references,
 *                        laid out at the same paths the upstream repository
 *                        uses, so `package://<pkg>/...` still resolves once the
 *                        package directory is on your ROS package path, and a
 *                        NOTICE.txt records where it came from and under which
 *                        licence.
 *
 * The zip is written here rather than pulled from a library: everything is
 * stored uncompressed, which needs a CRC-32 and two small record layouts, and
 * saves shipping a compression library for files that are mostly already
 * awkward to compress further.
 */

const textEncoder = new TextEncoder();

/* ── zip writing ─────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, the only timestamp format a basic zip entry carries. */
function dosDateTime(date = new Date()) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Build a zip archive with the "stored" method.
 * @param {Array<{name: string, bytes: Uint8Array}>} files
 * @returns {Blob}
 */
export function makeZip(files) {
  const { time, day } = dosDateTime();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const crc = crc32(file.bytes);
    const size = file.bytes.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // flags: UTF-8 names
    local.setUint16(8, 0, true); // method: stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true); // compressed size
    local.setUint32(22, size, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra field length

    chunks.push(new Uint8Array(local.buffer), nameBytes, file.bytes);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); // central directory signature
    entry.setUint16(4, 20, true); // version made by
    entry.setUint16(6, 20, true); // version needed
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true); // offset of local header
    central.push(new Uint8Array(entry.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
    type: 'application/zip',
  });
}

/* ── saving ──────────────────────────────────────────────── */

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start reading the blob before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ── mesh discovery ──────────────────────────────────────── */

/**
 * Resolve every mesh reference in a URDF to a CDN URL plus the repository-
 * relative path it should keep inside the archive.
 * @param {object} robot registry entry
 * @param {string} urdfText
 */
export function meshTargets(robot, urdfText) {
  const { base, packages, urdf } = robot.assets;
  const urdfDir = urdf.replace(/[^/]*$/, '');
  const doc = new DOMParser().parseFromString(urdfText, 'text/xml');
  const seen = new Map();

  for (const mesh of doc.querySelectorAll('mesh')) {
    const filename = mesh.getAttribute('filename');
    if (!filename || seen.has(filename)) continue;
    let path = null;
    if (filename.startsWith('package://')) {
      const [pkg, ...rest] = filename.slice('package://'.length).split('/');
      const root = packages[pkg];
      if (root === undefined) continue;
      path = normalise(`${root}/${rest.join('/')}`);
    } else if (!/^(https?|file):/.test(filename)) {
      path = normalise(urdfDir + filename);
    }
    if (path) seen.set(filename, { url: base + path, path });
  }
  return [...seen.values()];
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

/* ── public API ──────────────────────────────────────────── */

export async function fetchUrdfText(robot) {
  const url = robot.assets.base + robot.assets.urdf;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`URDF ${response.status}`);
  return response.text();
}

/** Save the URDF file on its own. */
export async function downloadUrdf(robot) {
  const text = await fetchUrdfText(robot);
  const name = robot.assets.urdf.split('/').pop();
  saveBlob(new Blob([text], { type: 'application/xml' }), name);
  return { files: 1, bytes: textEncoder.encode(text).length };
}

/**
 * Save the URDF and all of its meshes as a zip.
 * @param {object} robot registry entry
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function downloadBundle(robot, onProgress) {
  const urdfText = await fetchUrdfText(robot);
  const targets = meshTargets(robot, urdfText);
  const files = [
    { name: robot.assets.urdf, bytes: textEncoder.encode(urdfText) },
    { name: 'NOTICE.txt', bytes: textEncoder.encode(notice(robot, targets.length)) },
  ];

  let done = 0;
  const total = targets.length;
  onProgress?.(0, total);

  // A handful of parallel requests keeps big robots quick without hammering the
  // CDN or blowing up memory on a phone.
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const target = queue.shift();
      const response = await fetch(target.url);
      if (!response.ok) throw new Error(`${target.path} → HTTP ${response.status}`);
      files.push({ name: target.path, bytes: new Uint8Array(await response.arrayBuffer()) });
      done += 1;
      onProgress?.(done, total);
    }
  });
  await Promise.all(workers);

  const blob = makeZip(files);
  saveBlob(blob, `${robot.id}.zip`);
  return { files: files.length, bytes: blob.size };
}

function notice(robot, meshCount) {
  const { source, assets } = robot;
  return `${robot.name}${robot.maker ? ` — ${robot.maker}` : ''}
${'='.repeat(60)}

Downloaded from the Robot URDF Gallery. This archive is a subset of an upstream
repository, unmodified, at a pinned commit:

  repository : ${source.repo_url}
  commit     : ${source.commit}
  URDF       : ${assets.urdf}
  meshes     : ${meshCount}
  licence    : ${robot.license || 'see the upstream repository'}
${source.license_url ? `  licence file: ${source.license_url}\n` : ''}
Files keep their repository-relative paths, so package:// references resolve
once the package directory below is on your ROS package path:

${Object.entries(assets.packages)
  .map(([pkg, root]) => `  ${pkg} -> ${root || '.'}`)
  .join('\n') || '  (this URDF uses paths relative to the URDF file)'}

Metadata for this model comes from robot_descriptions.py:
  https://github.com/robot-descriptions/robot_descriptions.py

The licence above governs this model — check it before use, some are
non-commercial.
`;
}
