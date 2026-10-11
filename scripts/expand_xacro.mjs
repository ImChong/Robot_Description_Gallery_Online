#!/usr/bin/env node
/**
 * Expand a xacro description to URDF, for scripts/build_registry.py.
 *
 *   echo '{"urdf": "pkg/urdf/robot.urdf.xacro", "packages": {"pkg": "pkg"}, "files": {...}}' \
 *     | node scripts/expand_xacro.mjs > robot.urdf
 *
 * `files` maps repository-relative paths to the text of every file the xacro
 * includes (the build has fetched them already, through its own cache). The
 * expansion itself is web/js/xacro.js run in headless Chromium — xacro-parser
 * needs a DOM, and using the page's own module means the numbers the registry
 * records come from the same expansion the viewer will do.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const job = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const PAGE = `<!doctype html><script type="importmap">${JSON.stringify({
  imports: {
    'xacro-parser': './vendor/xacro-parser/index.js',
    'expr-eval-fork': './vendor/expr-eval-fork/index.mjs',
  },
})}</script>`;

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (path === '/expand.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    return;
  }
  const file = join(web, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!file.startsWith(web) || !statSync(file).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));

const browser = await launchBrowser();
let code = 0;
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/expand.html`);
  const text = await page.evaluate(async ({ urdf, packages, files }) => {
    const { expandXacroText, resolveXacroPath } = await import('/js/xacro.js');
    const readText = async (path) => {
      const key = resolveXacroPath(path, packages);
      if (!(key in files)) throw new Error(`xacro include not supplied: ${key}`);
      return files[key];
    };
    return expandXacroText(files[urdf], { workingPath: urdf.replace(/[^/]+$/, ''), readText });
  }, job);
  process.stdout.write(text);
} catch (err) {
  console.error(String(err?.message || err));
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
