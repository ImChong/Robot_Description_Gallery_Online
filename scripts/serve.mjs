#!/usr/bin/env node
/**
 * Static file server for local development: `npm run dev`.
 *
 * The site is plain ES modules, so this only needs to serve files with sane
 * MIME types. It serves the repository root so that /web can reach /data.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.stl': 'model/stl',
  '.dae': 'model/vnd.collada+xml',
  '.obj': 'text/plain',
  '.urdf': 'application/xml',
  '.map': 'application/json',
};

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/web/index.html';
  const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const stat = statSync(file);
    const target = stat.isDirectory() ? join(file, 'index.html') : file;
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`not found: ${path}`);
  }
}).listen(port, () => {
  console.log(`Robot URDF Gallery Online → http://localhost:${port}/web/`);
});
