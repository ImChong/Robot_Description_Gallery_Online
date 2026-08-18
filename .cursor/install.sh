#!/usr/bin/env bash
# Idempotent bootstrap for the Robot URDF Gallery Cloud Agent environment.
#
# The site itself has no build step (web/ is plain ES modules with the browser
# deps already vendored under web/vendor/). What this installs is the tooling
# the pipeline and tests need:
#   - Node dev dependencies (three, urdf-loader, playwright) from the lockfile
#   - Python robot_descriptions, the metadata source for scripts/build_registry.py
#   - a headless Chromium with its system libraries, used by the WebGL smoke
#     test, thumbnail renderer and download check
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== npm ci =="
npm ci

echo "== pip install registry deps =="
pip install -r scripts/requirements.txt

echo "== playwright chromium (+ system deps) =="
npx playwright install --with-deps chromium

echo "install complete"
