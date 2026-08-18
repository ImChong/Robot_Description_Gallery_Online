/**
 * Shared Chromium launcher for the headless scripts.
 *
 * WebGL has to work in headless mode (the whole point is rendering robots), so
 * ANGLE is pinned to SwiftShader — software rasterisation is slow but produces
 * identical output on any machine or CI runner. Set CHROMIUM_PATH to use a
 * browser that Playwright did not download itself.
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
];

export const GL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage',
  '--no-sandbox',
];

/**
 * Robot meshes are fetched from the CDN by the page itself, so on a machine
 * whose egress goes through a proxy (CI sandboxes, corporate networks) the
 * browser needs the same proxy the shell has, plus that proxy's CA.
 */
function proxyConfig() {
  const server = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!server) return {};
  // The dev server is the one host that must never go through the proxy: an
  // agent proxy that only relays CONNECT answers a plain GET to localhost with
  // 405, and the page under test never loads. Loopback leads the list whatever
  // NO_PROXY says, and `::` — which some environments put there and Chromium
  // rejects — is dropped rather than left to invalidate the rest.
  const bypass = [
    'localhost',
    '127.0.0.1',
    '::1',
    ...(process.env.NO_PROXY || process.env.no_proxy || '').split(','),
  ]
    .map((entry) => entry.trim())
    .filter((entry, index, all) => entry && entry !== '::' && all.indexOf(entry) === index);
  return {
    proxy: { server: server.startsWith('http') ? server : `http://${server}`, bypass: bypass.join(',') },
    bypass,
  };
}

export async function launchBrowser(options = {}) {
  const executablePath = CANDIDATES.find((path) => path && existsSync(path));
  const { bypass, ...proxy } = proxyConfig();
  const extraArgs = [];
  // Chromium's own flag as well as Playwright's option: the option alone has
  // been seen not to reach the browser, and then every request — the local page
  // included — goes to the proxy.
  if (bypass) extraArgs.push(`--proxy-bypass-list=${bypass.join(';')}`);
  // Some TLS-terminating proxies reset Chromium's TLS 1.3 handshake (the large
  // post-quantum ClientHello is the usual culprit) while curl and node get
  // through fine. Capping the handshake keeps the mesh downloads working behind
  // such a proxy; set RUG_NO_TLS_CAP=1 to opt out. Certificates are still
  // verified — this only pins the protocol version.
  if (proxy.proxy && !process.env.RUG_NO_TLS_CAP) {
    extraArgs.push('--ssl-version-max=tls1.2');
  }
  return chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    ...proxy,
    args: [...GL_ARGS, ...extraArgs, ...(options.args || [])],
    ...options,
  });
}
