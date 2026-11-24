import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../dist');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

function normalizeBase(raw = '') {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

const SITE_BASE = normalizeBase(process.env.SITE_BASE || '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.pf_fragment': 'application/octet-stream',
  '.pf_index': 'application/octet-stream',
  '.pf_meta': 'application/octet-stream',
  '.pagefind': 'application/octet-stream',
};

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveFile(pathname) {
  const cleanRel = pathname.replace(/^\/+/, '');
  const candidate = path.resolve(DIST_DIR, cleanRel);
  if (!isWithin(DIST_DIR, candidate)) {
    return null;
  }

  const indexPath = path.join(candidate, 'index.html');
  for (const file of [candidate, indexPath, `${candidate}.html`]) {
    if (!isWithin(DIST_DIR, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      continue;
    }
    const filePath = fs.realpathSync(file);
    if (isWithin(fs.realpathSync(DIST_DIR), filePath)) {
      return { filePath, directoryIndex: file === indexPath };
    }
  }
  return null;
}

function serveNotFound(res) {
  const notFound = resolveFile('/404.html');
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  if (notFound) {
    res.end(fs.readFileSync(notFound.filePath));
    return;
  }
  res.end('404 Not Found');
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url || '/';
  const [rawPathname] = rawUrl.split('?');
  const suffix = rawUrl.slice(rawPathname.length);
  let pathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  // Support sub-path SITE_BASE preview parity with GitHub Pages project sites
  if (SITE_BASE) {
    if (pathname === '/') {
      res.writeHead(302, { Location: `${SITE_BASE}/${suffix}` });
      res.end();
      return;
    }
    if (pathname === SITE_BASE) {
      res.writeHead(301, { Location: `${SITE_BASE}/${suffix}` });
      res.end();
      return;
    }
    if (!pathname.startsWith(`${SITE_BASE}/`)) {
      serveNotFound(res);
      return;
    }
    pathname = pathname.slice(SITE_BASE.length);
  }

  const file = resolveFile(pathname);
  if (!file) {
    serveNotFound(res);
    return;
  }
  if (file.directoryIndex && !rawPathname.endsWith('/') && !path.extname(pathname)) {
    res.writeHead(301, { Location: `${rawPathname}/${suffix}` });
    res.end();
    return;
  }

  const ext = path.extname(file.filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file.filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
  const entry = `${SITE_BASE}/`;
  console.log(
    `Serving the knowledge base at http://${HOST}:${PORT}${entry} (graph: ${SITE_BASE}/graph/, indexes: ${SITE_BASE}/llms.txt)`,
  );
});
