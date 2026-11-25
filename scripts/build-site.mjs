import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = path.join(REPO_ROOT, 'data');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

export function normalizeBase(raw = '') {
  const trimmed = String(raw).trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

export function normalizeSiteOrigin(raw = 'https://mangta517.github.io') {
  const candidate = String(raw || 'https://mangta517.github.io').trim().replace(/\/+$/, '');
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Invalid SITE_URL protocol "${parsed.protocol}" (expected http: or https:)`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function existsExactCase(rootDir, relPosixPath) {
  if (typeof relPosixPath !== 'string' || !relPosixPath) return false;
  if (relPosixPath.includes('\\') || relPosixPath.includes('\0')) return false;
  const segments = relPosixPath.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) {
    return false;
  }
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

export function copyPublicArtifacts({
  repoRoot = REPO_ROOT,
  dataDir = DATA_DIR,
  distDir = DIST_DIR,
  siteUrl = normalizeSiteOrigin(process.env.SITE_URL),
  siteBase = normalizeBase(process.env.SITE_BASE || ''),
} = {}) {
  for (const name of ['llms.txt', 'llms-full.txt']) {
    fs.copyFileSync(path.join(repoRoot, name), path.join(distDir, name));
  }

  const distDataDir = path.join(distDir, 'data');
  fs.mkdirSync(distDataDir, { recursive: true });
  for (const name of ['catalog.json', 'graph.json', 'stats.json']) {
    fs.copyFileSync(path.join(dataDir, name), path.join(distDataDir, name));
  }

  const fullOriginBase = `${siteUrl}${siteBase}`;
  const robotsTxt = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${fullOriginBase}/sitemap-index.xml`,
    `# LLM Navigation: ${fullOriginBase}/llms.txt`,
    `# LLM Full Corpus: ${fullOriginBase}/llms-full.txt`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(distDir, 'robots.txt'), robotsTxt, 'utf-8');

  // .nojekyll can be empty (0 bytes)
  fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf-8');
}

export function verifyOutputs({ dataDir = DATA_DIR, distDir = DIST_DIR } = {}) {
  const catalog = JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog.json'), 'utf-8'));
  const allDocItems = [
    ...(catalog.projects || []),
    ...(catalog.topics || []),
    ...(catalog.adrs || []),
    ...(catalog.troubleshooting || []),
    ...(catalog.synthesis || []),
  ];

  const publishedAssetPaths = new Set();
  for (const item of allDocItems) {
    if (item.assets && typeof item.assets === 'object') {
      for (const relAsset of Object.values(item.assets)) {
        publishedAssetPaths.add(`wiki-assets/${String(relAsset)}`);
      }
    }
  }

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
    ...publishedAssetPaths,
  ];

  const missingOrCaseMismatch = requiredNonEmpty.filter(
    (rel) => !existsExactCase(distDir, rel),
  );
  if (!fs.existsSync(path.join(distDir, '.nojekyll'))) {
    missingOrCaseMismatch.push('.nojekyll');
  }

  if (missingOrCaseMismatch.length > 0) {
    throw new Error(
      `Missing or case-mismatched build artifacts in dist/: ${missingOrCaseMismatch.join(', ')}`,
    );
  }
  return allDocItems.length;
}

export function buildSite() {
  const siteUrl = normalizeSiteOrigin(process.env.SITE_URL || 'https://mangta517.github.io');
  const siteBase = normalizeBase(process.env.SITE_BASE || '');

  console.log(
    `[build-site] Building Astro Starlight -> dist/ (SITE_URL="${siteUrl}", SITE_BASE="${siteBase || '/'}")`,
  );
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

  copyPublicArtifacts({ siteUrl, siteBase });
  const verifiedDocs = verifyOutputs();
  console.log(
    `[build-site] Verified ${verifiedDocs} doc routes (case-exact), graph, 404, Pagefind, Sitemap, robots.txt, JSON & llms indexes.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  buildSite();
}
