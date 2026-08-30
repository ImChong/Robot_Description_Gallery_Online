#!/usr/bin/env node
/**
 * Copy the browser dependencies out of node_modules into web/vendor/.
 *
 * The site is deliberately build-step free: it is plain ES modules served as
 * static files, so the deps it needs at runtime are committed under
 * web/vendor/ and resolved through the import map in web/index.html.
 * Re-run this after bumping three or urdf-loader in package.json.
 */
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'web', 'vendor');

const files = [
  ['three/build/three.module.min.js', 'three/three.module.min.js'],
  ['three/build/three.core.min.js', 'three/three.core.min.js'],
  ['three/examples/jsm/controls/OrbitControls.js', 'three/jsm/controls/OrbitControls.js'],
  ['three/examples/jsm/loaders/STLLoader.js', 'three/jsm/loaders/STLLoader.js'],
  ['three/examples/jsm/loaders/ColladaLoader.js', 'three/jsm/loaders/ColladaLoader.js'],
  ['three/examples/jsm/loaders/TGALoader.js', 'three/jsm/loaders/TGALoader.js'],
  ['three/examples/jsm/loaders/OBJLoader.js', 'three/jsm/loaders/OBJLoader.js'],
  ['three/examples/jsm/loaders/MTLLoader.js', 'three/jsm/loaders/MTLLoader.js'],
  ['three/examples/jsm/loaders/GLTFLoader.js', 'three/jsm/loaders/GLTFLoader.js'],
  // GLTFLoader's only non-three import.
  ['three/examples/jsm/utils/BufferGeometryUtils.js', 'three/jsm/utils/BufferGeometryUtils.js'],
  // USD, for a model picked off a local disk. Loaded on demand: nothing in the
  // registry is a USD, so the gallery never fetches any of this.
  ['three/examples/jsm/loaders/USDLoader.js', 'three/jsm/loaders/USDLoader.js'],
  ['three/examples/jsm/loaders/usd/USDAParser.js', 'three/jsm/loaders/usd/USDAParser.js'],
  ['three/examples/jsm/loaders/usd/USDCParser.js', 'three/jsm/loaders/usd/USDCParser.js'],
  // USDLoader unzips a .usdz with this.
  ['three/examples/jsm/libs/fflate.module.js', 'three/jsm/libs/fflate.module.js'],
  ['three/LICENSE', 'three/LICENSE'],
  ['urdf-loader/src/URDFLoader.js', 'urdf-loader/URDFLoader.js'],
  ['urdf-loader/src/URDFClasses.js', 'urdf-loader/URDFClasses.js'],
  // Xacro expansion, also on demand and also only for a picked file.
  ['xacro-parser/src/index.js', 'xacro-parser/index.js'],
  ['xacro-parser/src/XacroParser.js', 'xacro-parser/XacroParser.js'],
  ['xacro-parser/src/XacroLoader.js', 'xacro-parser/XacroLoader.js'],
  ['xacro-parser/src/ExpressionParser.js', 'xacro-parser/ExpressionParser.js'],
  ['xacro-parser/src/utils.js', 'xacro-parser/utils.js'],
  ['xacro-parser/LICENSE', 'xacro-parser/LICENSE'],
  // xacro-parser's only dependency: the expression evaluator that gives
  // `${arm_length / 2}` a value.
  ['expr-eval-fork/dist/index.mjs', 'expr-eval-fork/index.mjs'],
  ['expr-eval-fork/LICENSE.txt', 'expr-eval-fork/LICENSE.txt'],
];

// urdf-loader's npm tarball ships no licence file, so record it here.
const NOTICE = `Third-party code vendored into this directory
==========================================

three (three.module.min.js, three.core.min.js, jsm/*)
  MIT License — see three/LICENSE
  https://github.com/mrdoob/three.js

urdf-loader (URDFLoader.js, URDFClasses.js)
  Apache License 2.0
  https://github.com/gkjohnson/urdf-loaders

xacro-parser (index.js, XacroParser.js, XacroLoader.js, ExpressionParser.js,
              utils.js)
  MIT License — see xacro-parser/LICENSE
  https://github.com/gkjohnson/xacro-parser

expr-eval-fork (index.mjs)
  MIT License — see expr-eval-fork/LICENSE.txt
  https://github.com/silentmatt/expr-eval

All are unmodified copies of the published npm packages; see VERSIONS.json
for the exact versions and regenerate with \`npm run vendor\`.
`;

if (!existsSync(nm)) {
  console.error('node_modules/ missing — run `npm install` first.');
  process.exit(1);
}

for (const [from, to] of files) {
  const src = join(nm, from);
  const dst = join(out, to);
  if (!existsSync(src)) {
    console.error(`missing dependency file: ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`vendored ${to}`);
}

// Record which upstream versions the vendored copies came from.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(
  join(out, 'VERSIONS.json'),
  JSON.stringify(
    {
      three: pkg.devDependencies.three,
      'urdf-loader': pkg.devDependencies['urdf-loader'],
      'xacro-parser': pkg.devDependencies['xacro-parser'],
      'expr-eval-fork': pkg.devDependencies['expr-eval-fork'],
      vendored_at: new Date().toISOString().slice(0, 10),
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(join(out, 'NOTICE.txt'), NOTICE);
console.log('wrote web/vendor/VERSIONS.json and NOTICE.txt');
