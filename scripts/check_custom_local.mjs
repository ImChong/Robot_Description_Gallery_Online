#!/usr/bin/env node
/**
 * Browser check for the local-file half of the picker: one description in each
 * of the four languages it reads, handed to the real file input and staged in
 * the real viewer.
 *
 *   node scripts/serve.mjs &
 *   node scripts/check_custom_local.mjs
 *
 * Every case is written out as a small folder so the interesting part of the
 * plumbing is exercised rather than mocked: the xacro pulls a macro out of an
 * included file and names its mesh through `$(find …)`, the MJCF splits itself
 * across an `<include>` and reaches its mesh through `meshdir`, and both are
 * resolved against the picked files by the same code the gallery uses.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser } from './browser.mjs';

const base = process.env.BASE_URL || 'http://localhost:8080';

/** A two-triangle STL, in the ASCII form both loaders accept. */
const STL = `solid wedge
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 0.2 0 0
    vertex 0.2 0.1 0
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 0.2 0.1 0
    vertex 0 0.1 0
  endloop
endfacet
endsolid wedge
`;

const root = mkdtempSync(join(tmpdir(), 'rug-local-'));

/** @returns {string[]} absolute paths, for `setInputFiles` */
function writeCase(name, files) {
  const dir = join(root, name);
  const paths = [];
  for (const [path, contents] of Object.entries(files)) {
    const at = join(dir, path);
    mkdirSync(join(at, '..'), { recursive: true });
    writeFileSync(at, contents);
    paths.push(at);
  }
  return paths;
}

const CASES = [
  {
    name: 'urdf',
    kind: 'URDF',
    model: 'plain_urdf',
    pick: 'robot.urdf',
    joints: 1,
    files: {
      'robot.urdf': `<?xml version="1.0"?>
<robot name="plain_urdf">
  <link name="base">
    <visual><geometry><box size="0.4 0.2 0.1"/></geometry></visual>
  </link>
  <link name="arm">
    <visual><geometry><mesh filename="meshes/wedge.stl"/></geometry></visual>
  </link>
  <joint name="shoulder" type="revolute">
    <parent link="base"/><child link="arm"/>
    <origin xyz="0 0 0.1"/><axis xyz="0 1 0"/>
    <limit lower="-1" upper="1" effort="10" velocity="1"/>
  </joint>
</robot>`,
      'meshes/wedge.stl': STL,
    },
  },
  {
    name: 'xacro',
    kind: 'Xacro',
    model: 'from_xacro',
    pick: 'robot.urdf.xacro',
    joints: 2,
    files: {
      // Properties, an argument, a macro out of an included file, arithmetic and
      // a `$(find …)` mesh path: the whole reason this cannot be done with a
      // regular expression.
      'robot.urdf.xacro': `<?xml version="1.0"?>
<robot name="from_xacro" xmlns:xacro="http://ros.org/wiki/xacro">
  <xacro:arg name="segments" default="2"/>
  <xacro:property name="length" value="0.3"/>
  <xacro:include filename="$(find demo_description)/urdf/segment.xacro"/>
  <link name="base">
    <visual><geometry><box size="\${length} 0.2 0.1"/></geometry></visual>
  </link>
  <xacro:segment name="one" parent="base" at="\${length / 2}"/>
  <xacro:segment name="two" parent="one" at="\${length}"/>
</robot>`,
      'urdf/segment.xacro': `<?xml version="1.0"?>
<robot xmlns:xacro="http://ros.org/wiki/xacro">
  <xacro:macro name="segment" params="name parent at">
    <link name="\${name}">
      <visual>
        <geometry><mesh filename="$(find demo_description)/meshes/wedge.stl"/></geometry>
      </visual>
    </link>
    <joint name="\${name}_joint" type="revolute">
      <parent link="\${parent}"/><child link="\${name}"/>
      <origin xyz="0 0 \${at}"/><axis xyz="0 1 0"/>
      <limit lower="-1.2" upper="1.2" effort="10" velocity="1"/>
    </joint>
  </xacro:macro>
</robot>`,
      'meshes/wedge.stl': STL,
    },
  },
  {
    name: 'mjcf',
    kind: 'MJCF',
    model: 'from_mjcf',
    pick: 'scene.xml',
    joints: 2,
    files: {
      'scene.xml': `<mujoco model="from_mjcf">
  <include file="robot.xml"/>
  <worldbody>
    <light pos="0 0 2"/>
    <geom name="floor" size="0 0 0.05" type="plane"/>
  </worldbody>
</mujoco>`,
      'robot.xml': `<mujoco model="from_mjcf">
  <compiler angle="radian" meshdir="assets" autolimits="true"/>
  <asset>
    <material name="grey" rgba="0.6 0.6 0.6 1"/>
    <mesh file="wedge.stl"/>
  </asset>
  <default>
    <default class="visual"><geom group="2" contype="0" conaffinity="0" material="grey"/></default>
    <default class="collision"><geom group="3"/></default>
  </default>
  <worldbody>
    <body name="base" pos="0 0 0.1">
      <freejoint/>
      <geom class="visual" type="box" size="0.15 0.1 0.05"/>
      <geom class="collision" type="box" size="0.15 0.1 0.05"/>
      <body name="arm" pos="0 0 0.05">
        <joint name="shoulder" type="hinge" axis="0 1 0" range="-1 1"/>
        <geom class="visual" type="mesh" mesh="wedge"/>
        <body name="wrist" pos="0.2 0 0">
          <joint name="reach" type="slide" axis="1 0 0" range="0 0.1"/>
          <geom class="visual" type="capsule" fromto="0 0 0 0.1 0 0" size="0.02"/>
        </body>
      </body>
    </body>
  </worldbody>
  <keyframe>
    <key name="home" qpos="0 0 0.1 1 0 0 0 0.4 0.05"/>
  </keyframe>
</mujoco>`,
      'assets/wedge.stl': STL,
    },
  },
  {
    name: 'usd',
    kind: 'USD',
    // A USD stage declares no name of its own, so the entry takes the file's.
    model: 'from_usd',
    pick: 'from_usd.usda',
    joints: 0,
    files: {
      'from_usd.usda': `#usda 1.0
(
    upAxis = "Z"
    metersPerUnit = 1
)

def Xform "root"
{
    def Mesh "block"
    {
        int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]
        int[] faceVertexIndices = [0, 1, 2, 3, 4, 7, 6, 5, 0, 4, 5, 1, 1, 5, 6, 2, 2, 6, 7, 3, 3, 7, 4, 0]
        point3f[] points = [(-0.2, -0.1, 0), (0.2, -0.1, 0), (0.2, 0.1, 0), (-0.2, 0.1, 0), (-0.2, -0.1, 0.3), (0.2, -0.1, 0.3), (0.2, 0.1, 0.3), (-0.2, 0.1, 0.3)]
    }
}
`,
    },
  },
];

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (error) => {
  console.error(`  page error: ${error.message}`);
  process.exitCode = 1;
});

for (const testCase of CASES) {
  const paths = writeCase(testCase.name, testCase.files);
  await page.goto(`${base}/web/`, { waitUntil: 'networkidle' });
  await page.locator('#custom-open').click();
  await page.locator('#custom-files').setInputFiles(paths);
  // Several descriptions in a folder means the picker offers a choice; a
  // single one is chosen already. The chooser is only on screen in the first
  // case, so the value is written rather than clicked.
  const chosen = await page.evaluate((wanted) => {
    const select = document.getElementById('custom-urdf');
    const option = [...select.options].find((one) => one.value.endsWith(wanted));
    if (!option) return [...select.options].map((one) => one.value);
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }, testCase.pick);
  if (chosen !== true) {
    throw new Error(`${testCase.name}: ${testCase.pick} was not offered (${chosen})`);
  }
  await page.locator('#custom-go:not([disabled])').waitFor({ timeout: 20000 });

  const report = await page.locator('#custom-report').textContent();
  if (!report.includes(testCase.kind)) {
    throw new Error(`${testCase.name}: picker did not recognise it as ${testCase.kind} — ${report}`);
  }

  await page.locator('#custom-go').click();
  await page.waitForFunction(
    () => document.querySelector('.stage')?.dataset.loaded === '__local__',
    null,
    { timeout: 60000 },
  );
  const staged = await page.evaluate(() => ({
    name: document.getElementById('d-name').textContent.trim(),
    height: Number(document.querySelector('.stage').dataset.height),
    meshes: Number(document.querySelector('.stage').dataset.meshes),
    sliders: document.querySelectorAll("#d-tree input[type='range']").length,
    error: document.getElementById('stage-error').hidden
      ? null
      : document.getElementById('stage-error').textContent,
  }));

  if (staged.error) throw new Error(`${testCase.name}: ${staged.error}`);
  if (staged.name !== testCase.model) {
    throw new Error(`${testCase.name}: staged as ${staged.name}, wanted ${testCase.model}`);
  }
  if (!staged.meshes) throw new Error(`${testCase.name}: nothing rendered`);
  if (!(staged.height > 0)) throw new Error(`${testCase.name}: measured no height`);
  if (staged.sliders !== testCase.joints) {
    throw new Error(
      `${testCase.name}: ${staged.sliders} joint sliders, wanted ${testCase.joints}`,
    );
  }
  console.log(
    `✓ ${testCase.kind.padEnd(6)} ${staged.name.padEnd(12)} ` +
      `${String(staged.meshes).padStart(2)} meshes · ${staged.sliders} slider(s) · ` +
      `${staged.height.toFixed(3)} m`,
  );
}

await browser.close();
