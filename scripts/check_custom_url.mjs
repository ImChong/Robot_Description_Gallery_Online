#!/usr/bin/env node
import assert from 'node:assert/strict';
import { inferGithubPackages, parseGithubUrdfUrl } from '../web/js/custom.js';

const blob = parseGithubUrdfUrl(
  'https://github.com/acme/robot_description/blob/main/robots/arm/urdf/arm.urdf?raw=1',
);
assert.equal(blob.rawUrl, 'https://raw.githubusercontent.com/acme/robot_description/main/robots/arm/urdf/arm.urdf');
assert.equal(blob.path, 'robots/arm/urdf/arm.urdf');
assert.equal(blob.ref, 'main');

const raw = parseGithubUrdfUrl(
  'https://raw.githubusercontent.com/acme/robot_description/v1.2.0/robot.urdf',
);
assert.equal(raw.repo, 'robot_description');
assert.equal(raw.ref, 'v1.2.0');
assert.equal(raw.path, 'robot.urdf');

assert.deepEqual(
  inferGithubPackages('src/arm_description/urdf/arm.urdf', [
    'package://arm_description/meshes/base.stl',
    'package://shared_meshes/gripper.dae',
  ]),
  {
    arm_description: 'src/arm_description',
    shared_meshes: 'src/arm_description',
  },
);

for (const invalid of [
  'http://github.com/acme/repo/blob/main/robot.urdf',
  'https://example.com/acme/repo/blob/main/robot.urdf',
  'https://github.com/acme/repo/blob/main/README.md',
]) {
  assert.throws(() => parseGithubUrdfUrl(invalid));
}

console.log('✓ GitHub URDF URL parsing and package-root inference');
