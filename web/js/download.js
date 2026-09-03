/**
 * One-click downloads.
 *
 * Three flavours, because a description on its own renders as nothing:
 *   - `downloadUrdf`   — just the description file, exactly as upstream ships
 *                        it: a `.urdf`, or the `.xml` of an MJCF-only model.
 *   - `downloadBundle` — a .zip with the description plus every mesh it
 *                        references — and, for an MJCF, every file it includes —
 *                        laid out at the same paths the upstream repository
 *                        uses, so `package://<pkg>/...` still resolves once the
 *                        package directory is on your ROS package path, and a
 *                        NOTICE.txt records where it came from and under which
 *                        licence.
 *   - `downloadRos2`   — the same payload wrapped as a buildable ROS 2 package:
 *                        package.xml, CMakeLists.txt, an RViz config and a
 *                        display.launch.py that starts robot_state_publisher,
 *                        joint_state_publisher_gui (the slider window) and
 *                        RViz 2. Mesh references are rewritten to point at the
 *                        generated package, so it resolves with nothing else
 *                        installed.
 *
 * The zip is written here rather than pulled from a library: everything is
 * stored uncompressed, which needs a CRC-32 and two small record layouts, and
 * saves shipping a compression library for files that are mostly already
 * awkward to compress further.
 */

import { applyMeshRewrite, descriptionKind, descriptionPath } from './registry.js';
import { inspectMJCF } from './mjcf.js';

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
  return resolveMeshes(robot, urdfText).targets;
}

/**
 * Split a URDF's mesh references into the ones that can be fetched and the ones
 * the host does not have.
 *
 * The second list is only ever non-empty for a mirrored entry, whose archive
 * keeps the meshes it renders and drops the rest. They have to be recognised
 * rather than requested: the archive answers a path it does not have with 200
 * and an HTML page, so a zip built without this check fills up with copies of
 * its fallback page.
 *
 * @param {object} robot registry entry
 * @param {string} urdfText
 * @returns {{targets: object[], skipped: string[]}}
 */
function resolveMeshes(robot, urdfText) {
  const { base, packages, urdf } = robot.assets;
  const urdfDir = urdf.replace(/[^/]*$/, '');
  const doc = new DOMParser().parseFromString(urdfText, 'text/xml');
  const seen = new Map();
  const skip = new Set(robot.assets.skip_meshes || []);
  const alt = robot.assets.mesh_alt || {};
  const skipped = new Set();

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
    if (!path) continue;
    path = applyMeshRewrite(path, robot.assets.mesh_rewrite);
    if (skip.has(path)) {
      skipped.add(filename);
      continue;
    }
    seen.set(filename, { ref: filename, url: alt[path] || base + path, path });
  }
  return { targets: [...seen.values()], skipped: [...skipped] };
}

/**
 * Remove the `<visual>` and `<collision>` elements whose mesh the host does not
 * have.
 *
 * For the ROS 2 package only, and for a reason the raw bundle does not share:
 * the package is meant to build and start RViz, and a URDF naming a file the
 * package does not contain fails to load at all. The bundle ships upstream's
 * file untouched instead, with the shortfall recorded in its NOTICE.
 *
 * Done on the text so the rest of the file is byte-for-byte upstream's. Neither
 * element nests inside itself, so matching one non-greedily is unambiguous.
 */
function dropGeometry(urdfText, refs) {
  if (!refs.length) return urdfText;
  const wanted = new Set(refs);
  return urdfText.replace(
    /[ \t]*<(visual|collision)\b[^>]*>[\s\S]*?<\/\1>\n?/g,
    (element) => {
      for (const [, quoted] of element.matchAll(/filename\s*=\s*"([^"]*)"/g)) {
        if (wanted.has(xmlDecode(quoted)) || wanted.has(quoted)) return '';
      }
      return element;
    },
  );
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
  const url = robot.assets.base + descriptionPath(robot);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${descriptionKind(robot).toUpperCase()} ${response.status}`);
  return response.text();
}

/** Save the description file — a `.urdf` or a `.xml` — on its own. */
export async function downloadUrdf(robot) {
  const text = await fetchUrdfText(robot);
  const name = descriptionPath(robot).split('/').pop();
  saveBlob(new Blob([text], { type: 'application/xml' }), name);
  return { files: 1, bytes: textEncoder.encode(text).length };
}

/**
 * Save the description and all of its meshes as a zip.
 * @param {object} robot registry entry
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function downloadBundle(robot, onProgress) {
  const text = await fetchUrdfText(robot);
  const files =
    descriptionKind(robot) === 'mjcf'
      ? await mjcfBundle(robot, text, onProgress)
      : await urdfBundle(robot, text, onProgress);
  const blob = makeZip(files);
  saveBlob(blob, `${robot.id}.zip`);
  return { files: files.length, bytes: blob.size };
}

async function urdfBundle(robot, urdfText, onProgress) {
  const targets = meshTargets(robot, urdfText);
  return [
    { name: robot.assets.urdf, bytes: textEncoder.encode(urdfText) },
    { name: 'NOTICE.txt', bytes: textEncoder.encode(notice(robot, targets.length)) },
    ...(await fetchMeshes(targets, (target) => target.path, onProgress)),
  ];
}

/**
 * The same for an MJCF, which is rarely one file.
 *
 * A Menagerie scene includes the description, which may include more files
 * still, and the whole chain has to travel with the meshes for the zip to
 * compile in MuJoCo. Every file keeps the path it has in the repository, so the
 * `<include file>` and mesh references inside it resolve unchanged.
 */
async function mjcfBundle(robot, sceneText, onProgress) {
  const { base } = robot.assets;
  const read = async (path) => {
    const response = await fetch(base + path);
    return response.ok ? await response.text() : null;
  };
  const inventory = await inspectMJCF({
    text: sceneText,
    path: descriptionPath(robot),
    readXml: read,
  });

  // The scene is already in hand; the files it reaches are fetched here, and an
  // asset is asked for at each of the paths MuJoCo would look at in turn.
  const xml = await Promise.all(
    inventory.xml.slice(1).map(async (path) => ({ path, text: await read(path) })),
  );
  // Files the host does not have are left out. Oversized meshes the CDN
  // refuses are fetched from the GitHub raw URL in `assets.mesh_alt`.
  const skip = new Set(robot.assets.skip_meshes || []);
  const alt = robot.assets.mesh_alt || {};
  const assets = await fetchMeshes(
    inventory.assets
      .filter((candidates) => !candidates.every((path) => skip.has(path)))
      .map((candidates) => ({
        candidates,
        path: candidates[0],
        urls: candidates.map((path) => alt[path] || base + path),
      })),
    (target) => target.path,
    onProgress,
  );
  return [
    { name: descriptionPath(robot), bytes: textEncoder.encode(sceneText) },
    ...xml
      .filter((file) => file.text !== null)
      .map((file) => ({ name: file.path, bytes: textEncoder.encode(file.text) })),
    { name: 'NOTICE.txt', bytes: textEncoder.encode(notice(robot, assets.length)) },
    ...assets,
  ];
}

/**
 * Download every mesh, a handful at a time — enough parallelism to keep a big
 * robot quick, not so much that it hammers the CDN or blows up memory on a
 * phone.
 * A target may name more than one URL, in which case they are tried in order
 * and the one that answers is the file: an MJCF asset path resolves either
 * against the model or against the file that declared it, and only the CDN
 * knows which (see web/js/mjcf.js). The path the file keeps inside the zip
 * follows the URL that won, so `<include>` and mesh references still resolve.
 *
 * @param {Array<{url?: string, urls?: string[], path: string, candidates?: string[]}>} targets
 * @param {(target: object) => string} nameFor path the file takes inside the zip
 * @param {(done: number, total: number) => void} [onProgress]
 */
async function fetchMeshes(targets, nameFor, onProgress) {
  const files = [];
  let done = 0;
  const total = targets.length;
  onProgress?.(0, total);

  const queue = [...targets];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const target = queue.shift();
      const urls = target.urls || [target.url];
      let hit = null;
      let last = '';
      for (const [index, url] of urls.entries()) {
        const response = await fetch(url);
        if (response.ok) {
          hit = response;
          if (target.candidates) target.path = target.candidates[index];
          break;
        }
        last = `${url} → HTTP ${response.status}`;
      }
      if (!hit) throw new Error(last || `${target.path} → not found`);
      files.push({ name: nameFor(target), bytes: new Uint8Array(await hit.arrayBuffer()) });
      done += 1;
      onProgress?.(done, total);
    }
  });
  await Promise.all(workers);
  return files;
}

/* ── ROS 2 package ───────────────────────────────────────── */

/**
 * A valid ROS 2 package name for a gallery id: lowercase, `[a-z][a-z0-9_]*`,
 * and suffixed the way description packages conventionally are.
 */
export function ros2PackageName(robot) {
  const base = robot.id
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safe = /^[a-z]/.test(base) ? base : `robot_${base}`;
  return safe.endsWith('_description') ? safe : `${safe}_description`;
}

/**
 * Work out what the generated package looks like: where each file lands inside
 * it, and the URDF with its mesh references pointed at the package.
 *
 * Files keep their position relative to the shallowest directory that holds
 * both the URDF and all of its meshes, so the layout mirrors upstream. That
 * matters twice over: plain relative mesh references still resolve (anything
 * that opens the .urdf directly keeps working), and the rewritten
 * `package://<pkg>/...` references point at those same files.
 *
 * @param {object} robot registry entry
 * @param {string} urdfText
 */
export function ros2Layout(robot, urdfText) {
  const pkg = ros2PackageName(robot);
  const { targets, skipped } = resolveMeshes(robot, urdfText);
  const prefix = commonDir([robot.assets.urdf, ...targets.map((t) => t.path)]);
  const inPackage = (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path);
  const refs = new Map(targets.map((t) => [t.ref, `package://${pkg}/${inPackage(t.path)}`]));
  return {
    pkg,
    targets,
    inPackage,
    // Geometry the host does not have, dropped from this URDF so the package
    // loads. Named here so the README can say what came out.
    skipped,
    urdfPath: inPackage(robot.assets.urdf),
    urdf: rewriteMeshRefs(dropGeometry(urdfText, skipped), refs),
    // References the registry could not map to a file in the upstream repository
    // — usually a package:// pointing at some package this description does not
    // ship. They are left alone and called out in the README rather than
    // silently producing a package with dangling references.
    unresolved: unresolvedMeshRefs(dropGeometry(urdfText, skipped), refs),
    rootLink: rootLink(urdfText),
  };
}

/** Longest directory prefix (with trailing slash) shared by every path. */
function commonDir(paths) {
  if (!paths.length) return '';
  const segments = paths.map((path) => path.split('/').slice(0, -1));
  let shared = segments[0];
  for (const parts of segments.slice(1)) {
    let i = 0;
    while (i < shared.length && i < parts.length && shared[i] === parts[i]) i += 1;
    shared = shared.slice(0, i);
  }
  return shared.length ? `${shared.join('/')}/` : '';
}

const XML_ENTITY = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function xmlDecode(text) {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITY[entity]);
}

function xmlEscape(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Repoint every mesh reference at the generated package.
 *
 * Done on the text rather than through a re-serialised DOM: the URDF that comes
 * out of here should differ from upstream in exactly these attributes and
 * nothing else — no reordered attributes, no dropped comments, no changed
 * whitespace — so the diff against the upstream file stays readable.
 */
function rewriteMeshRefs(urdfText, refs) {
  return urdfText.replace(
    /filename\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    (match, doubleQuoted, singleQuoted) => {
      const raw = doubleQuoted !== undefined ? doubleQuoted : singleQuoted;
      const next = refs.get(xmlDecode(raw)) ?? refs.get(raw);
      return next === undefined ? match : `filename="${xmlEscape(next)}"`;
    },
  );
}

function unresolvedMeshRefs(urdfText, refs) {
  const doc = new DOMParser().parseFromString(urdfText, 'text/xml');
  const out = new Set();
  for (const mesh of doc.querySelectorAll('mesh')) {
    const filename = mesh.getAttribute('filename');
    if (filename && !refs.has(filename)) out.add(filename);
  }
  return [...out];
}

/**
 * The link no joint declares as a child — RViz needs it as the fixed frame,
 * since nothing publishes a transform above it.
 */
export function rootLink(urdfText) {
  const doc = new DOMParser().parseFromString(urdfText, 'text/xml');
  const children = new Set(
    [...doc.querySelectorAll('robot > joint > child')].map((c) => c.getAttribute('link')),
  );
  const links = [...doc.querySelectorAll('robot > link')].map((l) => l.getAttribute('name'));
  return links.find((name) => name && !children.has(name)) || links[0] || 'base_link';
}

/**
 * Save a buildable ROS 2 package: the URDF and its meshes, plus the manifest,
 * build file, launch file and RViz config that turn them into something
 * `colcon build` accepts and `ros2 launch` shows in RViz with a slider per
 * joint.
 *
 * @param {object} robot registry entry
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function downloadRos2(robot, onProgress) {
  const urdfText = await fetchUrdfText(robot);
  const layout = ros2Layout(robot, urdfText);
  const { pkg } = layout;

  const generated = [
    { name: layout.urdfPath, text: layout.urdf },
    { name: 'package.xml', text: packageXml(robot, layout) },
    { name: 'launch/display.launch.py', text: launchPy(robot, layout) },
    { name: 'rviz/display.rviz', text: rvizConfig(robot, layout) },
    { name: 'README.md', text: packageReadme(robot, layout) },
    { name: 'NOTICE.txt', text: notice(robot, layout.targets.length, layout) },
  ];
  const meshNames = layout.targets.map((target) => layout.inPackage(target.path));
  generated.push({
    name: 'CMakeLists.txt',
    text: cmakeLists(pkg, [...generated.map((file) => file.name), ...meshNames]),
  });

  const files = [
    ...generated.map((file) => ({
      name: `${pkg}/${file.name}`,
      bytes: textEncoder.encode(file.text),
    })),
    ...(await fetchMeshes(
      layout.targets,
      (target) => `${pkg}/${layout.inPackage(target.path)}`,
      onProgress,
    )),
  ];

  const blob = makeZip(files);
  saveBlob(blob, `${pkg}_ros2.zip`);
  return { files: files.length, bytes: blob.size };
}

function packageXml(robot, layout) {
  const { source } = robot;
  return `<?xml version="1.0"?>
<?xml-model href="http://download.ros.org/schema/package_format3.xsd" schematypens="http://www.w3.org/2001/XMLSchema"?>
<package format="3">
  <name>${layout.pkg}</name>
  <version>0.0.0</version>
  <description>
    ${xmlEscape(robot.name)}${robot.maker ? ` (${xmlEscape(robot.maker)})` : ''} URDF and meshes, packaged for ROS 2 by the
    Robot URDF Gallery Online from ${
      source.mirror
        ? `the copy re-hosted at ${xmlEscape(source.mirror.site)}`
        : `${xmlEscape(source.repo_url)} at commit ${source.commit}`
    }.
  </description>
  <maintainer email="you@example.com">you</maintainer>
  <license>${xmlEscape(robot.license || 'TODO: see NOTICE.txt')}</license>

  <buildtool_depend>ament_cmake</buildtool_depend>

  <exec_depend>joint_state_publisher</exec_depend>
  <exec_depend>joint_state_publisher_gui</exec_depend>
  <exec_depend>launch</exec_depend>
  <exec_depend>launch_ros</exec_depend>
  <exec_depend>robot_state_publisher</exec_depend>
  <exec_depend>rviz2</exec_depend>
  <exec_depend>xacro</exec_depend>

  <export>
    <build_type>ament_cmake</build_type>
  </export>
</package>
`;
}

/**
 * Install whatever the package actually holds. The upstream layout is
 * preserved, so which top-level directories exist differs per robot — meshes
 * may sit in `meshes/`, `mesh/`, or beside the URDF.
 */
function cmakeLists(pkg, names) {
  const dirs = new Set();
  const files = new Set();
  for (const name of names) {
    // ament installs these two itself.
    if (name === 'CMakeLists.txt' || name === 'package.xml') continue;
    const [head, ...rest] = name.split('/');
    if (rest.length) dirs.add(head);
    else files.add(head);
  }
  const quote = (entries) => [...entries].sort().map((entry) => `"${entry}"`).join(' ');
  const install = [];
  if (dirs.size) {
    install.push(`install(DIRECTORY ${quote(dirs)}\n  DESTINATION share/\${PROJECT_NAME})`);
  }
  if (files.size) {
    install.push(`install(FILES ${quote(files)}\n  DESTINATION share/\${PROJECT_NAME})`);
  }
  return `cmake_minimum_required(VERSION 3.8)
project(${pkg})

find_package(ament_cmake REQUIRED)

${install.join('\n\n')}

ament_package()
`;
}

/** A Python string literal for a path segment. */
function pyStr(text) {
  return `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function launchPy(robot, layout) {
  const urdfParts = layout.urdfPath.split('/').map(pyStr).join(', ');
  return `"""Show ${robot.name} in RViz 2, with a slider per joint.

    ros2 launch ${layout.pkg} display.launch.py
    ros2 launch ${layout.pkg} display.launch.py gui:=false   # no slider window
    ros2 launch ${layout.pkg} display.launch.py rviz:=false  # publish only

Generated by the Robot URDF Gallery Online.
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.conditions import IfCondition, UnlessCondition
from launch.substitutions import Command, LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    pkg_share = FindPackageShare(${pyStr(layout.pkg)})
    urdf_path = PathJoinSubstitution([pkg_share, ${urdfParts}])
    rviz_config = PathJoinSubstitution([pkg_share, 'rviz', 'display.rviz'])

    gui = LaunchConfiguration('gui')
    use_rviz = LaunchConfiguration('rviz')

    # xacro passes a plain URDF straight through, and keeps this launch file
    # working if the description is ever swapped for a .xacro one.
    robot_description = ParameterValue(Command(['xacro ', urdf_path]), value_type=str)

    return LaunchDescription([
        DeclareLaunchArgument(
            'gui',
            default_value='true',
            description='Publish joint states from the joint_state_publisher_gui sliders '
                        'instead of the headless joint_state_publisher.',
        ),
        DeclareLaunchArgument(
            'rviz', default_value='true', description='Start RViz 2 with the bundled config.'
        ),
        Node(
            package='robot_state_publisher',
            executable='robot_state_publisher',
            output='screen',
            parameters=[{'robot_description': robot_description}],
        ),
        Node(
            package='joint_state_publisher_gui',
            executable='joint_state_publisher_gui',
            condition=IfCondition(gui),
        ),
        Node(
            package='joint_state_publisher',
            executable='joint_state_publisher',
            condition=UnlessCondition(gui),
        ),
        Node(
            package='rviz2',
            executable='rviz2',
            arguments=['-d', rviz_config],
            condition=IfCondition(use_rviz),
            output='screen',
        ),
    ])
`;
}

/**
 * An RViz 2 config with the robot already set up: the RobotModel display bound
 * to /robot_description, the fixed frame on the root link, and the camera
 * pulled back to the height the gallery measured, so the robot is in frame on
 * the first paint instead of somewhere off screen.
 */
function rvizConfig(robot, layout) {
  const height = robot.measured?.height_m > 0 ? robot.measured.height_m : 1;
  const distance = Math.max(1, height * 2.6).toFixed(2);
  const focal = (height / 2).toFixed(2);
  return `# RViz 2 config for ${robot.name}, generated by the Robot URDF Gallery Online.
Panels:
  - Class: rviz_common/Displays
    Help Height: 0
    Name: Displays
    Property Tree Widget:
      Expanded:
        - /Global Options1
        - /RobotModel1
      Splitter Ratio: 0.5
    Tree Height: 640
Visualization Manager:
  Class: ""
  Displays:
    - Alpha: 0.5
      Cell Size: 1
      Class: rviz_default_plugins/Grid
      Color: 160; 160; 164
      Enabled: true
      Line Style:
        Line Width: 0.03
        Value: Lines
      Name: Grid
      Normal Cell Count: 0
      Offset:
        X: 0
        Y: 0
        Z: 0
      Plane: XY
      Plane Cell Count: 10
      Reference Frame: <Fixed Frame>
      Value: true
    - Alpha: 1
      Class: rviz_default_plugins/RobotModel
      Collision Enabled: false
      Description File: ""
      Description Source: Topic
      Description Topic:
        Depth: 5
        Durability Policy: Transient Local
        History Policy: Keep Last
        Reliability Policy: Reliable
        Value: /robot_description
      Enabled: true
      Links:
        All Links Enabled: true
        Expand Joint Details: false
        Expand Link Details: false
        Expand Tree: false
        Link Tree Style: Links in Alphabetic Order
      Mass Properties:
        Inertia: false
        Mass: false
      Name: RobotModel
      TF Prefix: ""
      Update Interval: 0
      Value: true
      Visual Enabled: true
    - Class: rviz_default_plugins/TF
      Enabled: false
      Frame Timeout: 15
      Frames:
        All Enabled: false
      Marker Scale: 0.3
      Name: TF
      Show Arrows: true
      Show Axes: true
      Show Names: false
      Update Interval: 0
      Value: false
  Enabled: true
  Global Options:
    Background Color: 48; 48; 48
    Fixed Frame: ${layout.rootLink}
    Frame Rate: 30
  Name: root
  Tools:
    - Class: rviz_default_plugins/MoveCamera
    - Class: rviz_default_plugins/Select
    - Class: rviz_default_plugins/FocusCamera
    - Class: rviz_default_plugins/Measure
      Line color: 128; 128; 0
  Transformation:
    Current:
      Class: rviz_default_plugins/TF
  Value: true
  Views:
    Current:
      Class: rviz_default_plugins/Orbit
      Distance: ${distance}
      Enable Stereo Rendering:
        Stereo Eye Separation: 0.06
        Stereo Focal Distance: 1
        Swap Stereo Eyes: false
        Value: false
      Focal Point:
        X: 0
        Y: 0
        Z: ${focal}
      Focal Shape Fixed Size: true
      Focal Shape Size: 0.05
      Invert Z Axis: false
      Name: Current View
      Near Clip Distance: 0.01
      Pitch: 0.32
      Target Frame: <Fixed Frame>
      Value: Orbit (rviz_default_plugins)
      Yaw: 0.87
    Saved: ~
Window Geometry:
  Displays:
    collapsed: false
  Height: 900
  Hide Left Dock: false
  Hide Right Dock: true
  Views:
    collapsed: true
  Width: 1400
  X: 60
  Y: 60
`;
}


function packageReadme(robot, layout) {
  const { source } = robot;
  const distro = 'ros-$ROS_DISTRO';
  return `# ${robot.name} — ROS 2 description package

\`${layout.pkg}\` holds the ${robot.name}${robot.maker ? ` (${robot.maker})` : ''} URDF and its meshes, taken from
${
  source.mirror
    ? `the copy [${source.mirror.host}](${source.mirror.site}) re-hosts, which publishes no revision to pin`
    : `[${source.github}](${source.tree_url}) at commit \`${source.commit.slice(0, 10)}\``
}, plus a launch file
that starts \`robot_state_publisher\`, the \`joint_state_publisher_gui\` slider
window and RViz 2. Generated by the
[Robot URDF Gallery Online](https://imchong.github.io/Robot_URDF_Gallery_Online/).

## Build and run

\`\`\`bash
mkdir -p ~/ros2_ws/src
cp -r ${layout.pkg} ~/ros2_ws/src/
cd ~/ros2_ws
colcon build --packages-select ${layout.pkg}
source install/setup.bash
ros2 launch ${layout.pkg} display.launch.py
\`\`\`

Drag the sliders in the joint_state_publisher window; RViz follows. Targets
ROS 2 Humble or newer.

If a dependency is missing:

\`\`\`bash
sudo apt install ${distro}-robot-state-publisher ${distro}-joint-state-publisher-gui \\
                 ${distro}-rviz2 ${distro}-xacro
\`\`\`

## Launch arguments

| argument | default | effect |
| --- | --- | --- |
| \`gui\` | \`true\` | slider window; \`gui:=false\` falls back to the headless \`joint_state_publisher\` |
| \`rviz\` | \`true\` | \`rviz:=false\` publishes \`/robot_description\`, \`/joint_states\` and TF without opening RViz |

RViz opens with \`rviz/display.rviz\`: RobotModel bound to \`/robot_description\`,
fixed frame \`${layout.rootLink}\`, camera pulled back to fit the model.

## What is in here

\`\`\`
${layout.pkg}/
├── package.xml
├── CMakeLists.txt
├── launch/display.launch.py
├── rviz/display.rviz
├── ${layout.urdfPath}
└── ${layout.targets.length} mesh file${layout.targets.length === 1 ? '' : 's'}, at their upstream paths
\`\`\`

The URDF is upstream's, with one edit: mesh \`filename\` attributes now read
\`package://${layout.pkg}/...\`, so they resolve from this package alone. The files
keep their upstream layout, so plain relative paths resolve too.
${
  layout.unresolved.length
    ? `
⚠ ${layout.unresolved.length} mesh reference${layout.unresolved.length === 1 ? '' : 's'} could not be mapped to a file in the upstream
repository, so ${layout.unresolved.length === 1 ? 'it was' : 'they were'} left untouched and the file ${layout.unresolved.length === 1 ? 'it names is' : 'they name are'} not in this
package:

${layout.unresolved.map((ref) => `  - ${ref}`).join('\n')}
`
    : ''
}
## 中文

\`${layout.pkg}\` 是由 [Robot URDF Gallery Online](https://imchong.github.io/Robot_URDF_Gallery_Online/)
自动生成的 ROS 2 功能包，包含 ${robot.name} 的 URDF 与全部网格文件，以及一个启动
\`robot_state_publisher\`、\`joint_state_publisher_gui\`（关节滑块窗口）和 RViz 2 的
launch 文件。把整个目录复制到工作空间的 \`src/\` 下，\`colcon build\` 后运行：

\`\`\`bash
ros2 launch ${layout.pkg} display.launch.py
\`\`\`

拖动滑块即可在 RViz 里看到关节运动；\`gui:=false\` 用无界面的
\`joint_state_publisher\`，\`rviz:=false\` 则只发布话题不开界面。

## Licence

The model keeps its upstream licence (${robot.license || 'see NOTICE.txt'}) —
see \`NOTICE.txt\` for where the files came from and the licence that covers them.
`;
}

/**
 * Provenance, shipped inside every archive: where the files came from, at which
 * commit, under what licence, and how their paths are meant to resolve.
 * @param {object} robot registry entry
 * @param {number} meshCount
 * @param {?object} ros2 layout, when this is the ROS 2 package rather than the
 *   raw bundle — the two differ in whether the URDF was touched.
 */
function notice(robot, meshCount, ros2 = null) {
  const { source, assets } = robot;
  const packages =
    Object.entries(assets.packages || {})
      .map(([pkg, root]) => `  ${pkg} -> ${root || '.'}`)
      .join('\n') || '  (this URDF uses paths relative to the URDF file)';

  // Most models are a subset of a repository at a pinned commit. The few whose
  // maker published no loadable description are read from an archive that
  // re-hosts them, which has no commit to quote and may have dropped meshes the
  // URDF still references — both worth saying in the file that records where
  // these bytes came from.
  const mirror = source.mirror || null;
  const opening = ros2
    ? `Downloaded from the Robot URDF Gallery Online and wrapped as the ROS 2 package
\`${ros2.pkg}\`. The model itself is ${
        mirror
          ? `a subset of a copy re-hosted by
${mirror.host}, which publishes no revision to pin:`
          : `a subset of an upstream repository at a
pinned commit:`
      }`
    : mirror
      ? `Downloaded from the Robot URDF Gallery Online. This archive is a subset of
a copy re-hosted by ${mirror.host}, which publishes no revision to pin:`
      : `Downloaded from the Robot URDF Gallery Online. This archive is a subset of an upstream
repository, unmodified, at a pinned commit:`;

  const layout = ros2
    ? `The URDF is upstream's file with its mesh \`filename\` attributes rewritten to
read \`package://${ros2.pkg}/...\`, so they resolve from this package alone.${
        ros2.skipped?.length
          ? `
The ${ros2.skipped.length} <visual>/<collision> element${
              ros2.skipped.length === 1 ? '' : 's'
            } naming a mesh the host does not
have ${
              ros2.skipped.length === 1 ? 'was' : 'were'
            } dropped: a URDF that points at a file the package does not
contain does not load at all.`
          : ''
      }
Everything else — including where each mesh sits relative to the URDF — is as
upstream ships it, so plain relative references still resolve too.`
    : descriptionKind(robot) === 'mjcf'
      ? `Files keep their repository-relative paths, so the <include file> chain and
every mesh and texture reference inside it resolves as it does upstream:
compile the .xml below with MuJoCo from the top of this archive.`
      : `Files keep their repository-relative paths, so package:// references resolve
once the package directory below is on your ROS package path:

${packages}`;

  const skipped = assets.skip_meshes?.length || 0;
  return `${robot.name}${robot.maker ? ` — ${robot.maker}` : ''}
${'='.repeat(60)}

${opening}

${
  mirror
    ? `  re-hosted by: ${mirror.host}
  page       : ${mirror.site}
  files      : ${assets.base}`
    : `  repository : ${source.repo_url}
  commit     : ${source.commit}`
}
  ${descriptionKind(robot) === 'mjcf' ? 'MJCF       ' : 'URDF       '}: ${descriptionPath(robot)}
  meshes     : ${meshCount}
  licence    : ${robot.license || 'see the upstream repository'}
${source.license_url ? `  licence file: ${source.license_url}\n` : ''}${
    skipped && !ros2
      ? `
This URDF references ${skipped} mesh${skipped === 1 ? '' : 'es'} the host does not have. The file is upstream's,
unmodified, so ${skipped === 1 ? 'that reference is' : 'those references are'} still in it — the ${
          skipped === 1 ? 'file is' : 'files are'
        } simply not in this
archive, and whatever loads the URDF will report ${skipped === 1 ? 'it' : 'them'} as missing.
`
      : ''
  }
${layout}
${
  source.description
    ? `
Metadata for this model comes from robot_descriptions.py:
  https://github.com/robot-descriptions/robot_descriptions.py
`
    : ''
}
The licence above governs this model — check it before use, some are
non-commercial.
`;
}
