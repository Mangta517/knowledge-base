import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = path.join(REPO_ROOT, 'data');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

function normalizeBase(raw = '') {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

const SITE_URL = (process.env.SITE_URL || 'https://mangta517.github.io').replace(/\/+$/, '');
const SITE_BASE = normalizeBase(process.env.SITE_BASE || '');

function existsExactCase(rootDir, relPosixPath) {
  const segments = relPosixPath.split('/').filter(Boolean);
  let current = rootDir;
  for (const seg of segments) {
    if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) {
      return false;
    }
    const entries = fs.readdirSync(current);
    if (!entries.includes(seg)) {
      return false;
    }
    current = path.join(current, seg);
  }
  return fs.existsSync(current) && fs.statSync(current).isFile() && fs.statSync(current).size > 0;
}

function copyPublicArtifacts() {
  for (const name of ['llms.txt', 'llms-full.txt']) {
    fs.copyFileSync(path.join(REPO_ROOT, name), path.join(DIST_DIR, name));
  }

  const distDataDir = path.join(DIST_DIR, 'data');
  fs.mkdirSync(distDataDir, { recursive: true });
  for (const name of ['catalog.json', 'graph.json', 'stats.json']) {
    fs.copyFileSync(path.join(DATA_DIR, name), path.join(distDataDir, name));
  }

  const fullOriginBase = `${SITE_URL}${SITE_BASE}`;
  const robotsTxt = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${fullOriginBase}/sitemap-index.xml`,
    `# LLM Navigation: ${fullOriginBase}/llms.txt`,
    `# LLM Full Corpus: ${fullOriginBase}/llms-full.txt`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(DIST_DIR, 'robots.txt'), robotsTxt, 'utf-8');

  // .nojekyll can be empty (0 bytes)
  fs.writeFileSync(path.join(DIST_DIR, '.nojekyll'), '', 'utf-8');
}

function verifyOutputs() {
  const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf-8'));
  const allDocItems = [
    ...(catalog.projects || []),
    ...(catalog.topics || []),
    ...(catalog.adrs || []),
    ...(catalog.troubleshooting || []),
    ...(catalog.synthesis || []),
  ];

  const requiredNonEmpty = [
    'index.html',
    '404.html',
    'graph/index.html',
    'robots.txt',
    'sitemap-index.xml',
    'pagefind/pagefind.js',
    'llms.txt',
    'llms-full.txt',
    'data/catalog.json',
    'data/graph.json',
    'data/stats.json',
    ...allDocItems.map((item) => {
      const slug = String(item.route || '')
        .toLowerCase()
        .replace(/^\/+|\/+$/g, '');
      return `${slug}/index.html`;
    }),
  ];

  const missingOrCaseMismatch = requiredNonEmpty.filter(
    (rel) => !existsExactCase(DIST_DIR, rel),
  );
  if (!fs.existsSync(path.join(DIST_DIR, '.nojekyll'))) {
    missingOrCaseMismatch.push('.nojekyll');
  }

  if (missingOrCaseMismatch.length > 0) {
    throw new Error(
      `Missing or case-mismatched build artifacts in dist/: ${missingOrCaseMismatch.join(', ')}`,
    );
  }
  return allDocItems.length;
}

console.log(`[build-site] Building Astro Starlight -> dist/ (SITE_URL="${SITE_URL}", SITE_BASE="${SITE_BASE || '/'}")`);
fs.rmSync(DIST_DIR, { recursive: true, force: true });
const buildEnv = {
  ...process.env,
  ...(!process.stdout.isTTY && !process.env.CI ? { CI: 'true' } : {}),
};

const result =
  process.platform === 'win32'
    ? spawnSync('pnpm --filter @kb/portal build', {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        shell: true,
        env: buildEnv,
      })
    : spawnSync('pnpm', ['--filter', '@kb/portal', 'build'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: buildEnv,
      });
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  throw new Error(`Astro Starlight build failed (${result.status ?? result.signal})`);
}

copyPublicArtifacts();
const verifiedDocs = verifyOutputs();
console.log(
  `[build-site] Verified ${verifiedDocs} doc routes (case-exact), graph, 404, Pagefind, Sitemap, robots.txt, JSON & llms indexes.`,
);
