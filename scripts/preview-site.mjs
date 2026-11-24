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

function resolveFile(relUrlPathname) {
  const decoded = decodeURIComponent(relUrlPathname.split('?')[0]);
  const cleanRel = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(DIST_DIR, cleanRel);

  if (!candidate.startsWith(DIST_DIR)) return null;

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    const idx = path.join(candidate, 'index.html');
    if (fs.existsSync(idx)) return idx;
  }
  const htmlFallback = `${candidate}.html`;
  if (fs.existsSync(htmlFallback) && fs.statSync(htmlFallback).isFile()) {
    return htmlFallback;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url || '/';
  const [rawPathname, queryString] = rawUrl.split('?');
  const suffix = queryString ? `?${queryString}` : '';

  // Support sub-path SITE_BASE preview parity with GitHub Pages project sites
  let relPathname = rawPathname;
  if (SITE_BASE) {
    if (rawPathname === '/') {
      res.writeHead(302, { Location: `${SITE_BASE}/${suffix}` });
      res.end();
      return;
    }
    if (rawPathname === SITE_BASE) {
      res.writeHead(301, { Location: `${SITE_BASE}/${suffix}` });
      res.end();
      return;
    }
    if (!rawPathname.startsWith(`${SITE_BASE}/`)) {
      const notFound = path.join(DIST_DIR, '404.html');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : '404 Not Found');
      return;
    }
    relPathname = rawPathname.slice(SITE_BASE.length) || '/';
  }

  // Redirect directory URLs without trailing slash (matches GitHub Pages behavior for /graph -> /graph/)
  if (relPathname !== '/' && !relPathname.endsWith('/') && !path.extname(relPathname)) {
    const dirCandidate = path.resolve(DIST_DIR, relPathname.replace(/^\/+/, ''));
    if (
      dirCandidate.startsWith(DIST_DIR) &&
      fs.existsSync(dirCandidate) &&
      fs.statSync(dirCandidate).isDirectory() &&
      fs.existsSync(path.join(dirCandidate, 'index.html'))
    ) {
      res.writeHead(301, { Location: `${SITE_BASE}${relPathname}/${suffix}` });
      res.end();
      return;
    }
  }

  const filePath = resolveFile(relPathname);
  if (!filePath) {
    const notFound = path.join(DIST_DIR, '404.html');
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : '404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
  const entry = `${SITE_BASE}/`;
  console.log(
    `Serving the knowledge base at http://${HOST}:${PORT}${entry} (graph: ${SITE_BASE}/graph/, indexes: ${SITE_BASE}/llms.txt)`,
  );
});
