import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const __dirname = path.dirname(SCRIPT_PATH);
const DEFAULT_DIST_DIR = path.resolve(__dirname, '../dist');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

export function normalizeBase(raw = '') {
  const trimmed = String(raw).trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

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

const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
};

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sanitizeQuerySuffix(rawSuffix = '') {
  if (!rawSuffix) return '';
  // Encode any non-ASCII or space/quote characters so Node HTTP header serialization never throws ERR_INVALID_CHAR
  return rawSuffix.replace(/[^\x21-\x7e]/g, (ch) => encodeURIComponent(ch));
}

function buildCanonicalLocation(siteBase, cleanSubpath, trailingSlash, rawSuffix) {
  const segments = cleanSubpath
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg));
  const suffix = sanitizeQuerySuffix(rawSuffix);
  if (segments.length === 0) {
    return `${siteBase}/${suffix}`;
  }
  return `${siteBase}/${segments.join('/')}${trailingSlash ? '/' : ''}${suffix}`;
}

export function resolveFile(distDir, pathname) {
  const cleanRel = pathname.replace(/^\/+/, '');
  const candidate = path.resolve(distDir, cleanRel);
  if (!isWithin(distDir, candidate) || !fs.existsSync(distDir)) {
    return null;
  }

  let realDist;
  try {
    realDist = fs.realpathSync(distDir);
  } catch {
    return null;
  }

  const indexPath = path.join(candidate, 'index.html');
  for (const file of [candidate, indexPath, `${candidate}.html`]) {
    if (!isWithin(distDir, file) || !fs.existsSync(file)) {
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    const filePath = fs.realpathSync(file);
    if (isWithin(realDist, filePath)) {
      const relFromDist = path.relative(realDist, file === indexPath ? path.dirname(filePath) : filePath);
      const canonicalRel = relFromDist.split(path.sep).filter(Boolean).join('/');
      return {
        filePath,
        directoryIndex: file === indexPath,
        canonicalRel,
      };
    }
  }
  return null;
}

export function createPreviewServer({
  distDir = DEFAULT_DIST_DIR,
  siteBase = normalizeBase(process.env.SITE_BASE || ''),
} = {}) {
  const normalizedBase = normalizeBase(siteBase);

  function serveNotFound(req, res) {
    const notFound = resolveFile(distDir, '/404.html');
    res.writeHead(404, {
      ...BASE_SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    if (notFound) {
      res.end(fs.readFileSync(notFound.filePath));
      return;
    }
    res.end('404 Not Found');
  }

  return http.createServer((req, res) => {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, {
        ...BASE_SECURITY_HEADERS,
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end('405 Method Not Allowed');
      return;
    }

    const rawUrl = req.url || '/';
    // Reject control characters and non-origin-form targets (e.g. scheme://...)
    if (/[\x00-\x1f\x7f]/.test(rawUrl) || !rawUrl.startsWith('/')) {
      res.writeHead(400, {
        ...BASE_SECURITY_HEADERS,
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end(method === 'HEAD' ? undefined : '400 Bad Request');
      return;
    }

    const [rawPathname] = rawUrl.split('?');
    const suffix = rawUrl.slice(rawPathname.length);
    let pathname;
    try {
      pathname = decodeURIComponent(rawPathname);
    } catch {
      res.writeHead(400, {
        ...BASE_SECURITY_HEADERS,
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end(method === 'HEAD' ? undefined : '400 Bad Request');
      return;
    }

    // Reject NUL bytes and Windows backslashes so preview matches Linux GitHub Pages strictly
    if (pathname.includes('\0') || pathname.includes('\\')) {
      res.writeHead(400, {
        ...BASE_SECURITY_HEADERS,
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end(method === 'HEAD' ? undefined : '400 Bad Request');
      return;
    }

    // Support sub-path SITE_BASE preview parity with GitHub Pages project sites
    if (normalizedBase) {
      if (pathname === '/') {
        res.writeHead(302, {
          ...BASE_SECURITY_HEADERS,
          Location: buildCanonicalLocation(normalizedBase, '', true, suffix),
        });
        res.end();
        return;
      }
      if (pathname === normalizedBase) {
        res.writeHead(301, {
          ...BASE_SECURITY_HEADERS,
          Location: buildCanonicalLocation(normalizedBase, '', true, suffix),
        });
        res.end();
        return;
      }
      if (!pathname.startsWith(`${normalizedBase}/`)) {
        serveNotFound(req, res);
        return;
      }
      pathname = pathname.slice(normalizedBase.length);
    }

    const hasDuplicateSlashes = rawPathname.includes('//') || pathname.includes('//');
    const file = resolveFile(distDir, pathname);
    if (!file) {
      serveNotFound(req, res);
      return;
    }

    if (
      (file.directoryIndex && !pathname.endsWith('/') && !path.posix.extname(pathname)) ||
      hasDuplicateSlashes
    ) {
      res.writeHead(301, {
        ...BASE_SECURITY_HEADERS,
        Location: buildCanonicalLocation(normalizedBase, file.canonicalRel, file.directoryIndex, suffix),
      });
      res.end();
      return;
    }

    const ext = path.extname(file.filePath).toLowerCase();
    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(file.filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, {
          ...BASE_SECURITY_HEADERS,
          'Content-Type': 'text/plain; charset=utf-8',
        });
      }
      res.end();
    });
    stream.pipe(res);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const siteBase = normalizeBase(process.env.SITE_BASE || '');
  if (!fs.existsSync(DEFAULT_DIST_DIR)) {
    console.warn(`[preview-site] Warning: ${DEFAULT_DIST_DIR} does not exist yet. Run "pnpm build:site" first.`);
  }
  const server = createPreviewServer({ distDir: DEFAULT_DIST_DIR, siteBase });
  server.listen(PORT, HOST, () => {
    const entry = `${siteBase}/`;
    console.log(
      `Serving the knowledge base at http://${HOST}:${PORT}${entry} (graph: ${siteBase}/graph/, indexes: ${siteBase}/llms.txt)`,
    );
  });
}
