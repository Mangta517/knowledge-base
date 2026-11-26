import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const __dirname = path.dirname(SCRIPT_PATH);
const PORTAL_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PORTAL_ROOT, '../..');
const WIKI_DIR = path.join(REPO_ROOT, 'wiki');
const WIKI_ASSETS_DIR = path.join(WIKI_DIR, 'assets');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const OUT_DOCS_DIR = path.join(PORTAL_ROOT, 'src/content/docs');
const OUT_ASSETS_DIR = path.join(PORTAL_ROOT, 'public/wiki-assets');

export function normalizeBase(raw = '') {
  const trimmed = String(raw).trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

const SITE_BASE = normalizeBase(process.env.SITE_BASE || '');

export function withBase(route, base = SITE_BASE) {
  const clean = route.startsWith('/') ? route : `/${route}`;
  return `${base}${clean}`;
}

export function withDocRoute(route, base = SITE_BASE) {
  return withBase(String(route).toLowerCase(), base);
}

export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeMarkdownLabel(str = '') {
  return String(str).replace(/([[\]\\])/g, '\\$1');
}

function yamlStr(str = '') {
  return JSON.stringify(String(str));
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isSafeRelativeAssetPosix(relPosix) {
  if (typeof relPosix !== 'string' || !relPosix.trim()) return false;
  if (relPosix.startsWith('/') || relPosix.includes('\\') || relPosix.includes('\0')) return false;
  const parts = relPosix.split('/');
  return parts.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

function encodeAssetUrl(relPosix, base = SITE_BASE) {
  const encoded = relPosix.split('/').map(encodeURIComponent).join('/');
  return withBase(`/wiki-assets/${encoded}`, base);
}

export function splitFrontmatter(raw) {
  const normalized = String(raw).replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('Missing YAML frontmatter');
  }
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx !== -1) {
    return {
      frontmatter: normalized.slice(4, endIdx),
      body: normalized.slice(endIdx + 5).trim(),
    };
  }
  if (normalized.endsWith('\n---')) {
    return {
      frontmatter: normalized.slice(4, -4),
      body: '',
    };
  }
  throw new Error('Unterminated YAML frontmatter');
}

export function stripOrPreserveHumanNotes(body, hasHumanNotesHint) {
  return body.replace(
    /<!--\s*HUMAN-NOTES:START\s*-->([\s\S]*?)<!--\s*HUMAN-NOTES:END\s*-->/g,
    (_, inner = '') => {
      const trimmed = inner.trim();
      if (!trimmed) return '';
      const withoutHeading = trimmed
        .replace(/^#{1,6}\s*个人复盘与后续思考\s*/m, '')
        .trim();
      const isPlaceholder =
        !withoutHeading ||
        withoutHeading === '（由人工补充与维护）' ||
        withoutHeading === '(由人工补充与维护)';
      if (hasHumanNotesHint === false || isPlaceholder) {
        return '';
      }
      return `\n\n<div class="kb-human-notes">\n\n${trimmed}\n\n</div>\n\n`;
    },
  );
}

export function convertCallouts(text) {
  const lines = text.split('\n');
  const out = [];
  const calloutMap = {
    NOTE: 'note',
    INFO: 'note',
    ABSTRACT: 'note',
    TIP: 'tip',
    HINT: 'tip',
    IMPORTANT: 'caution',
    WARNING: 'caution',
    CAUTION: 'danger',
    DANGER: 'danger',
    BUG: 'danger',
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^>\s*\[!([A-Za-z]+)\]\s*(.*)$/);
    if (m) {
      const kind = calloutMap[m[1].toUpperCase()] || 'note';
      const title = m[2].trim();
      const bodyLines = [];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        bodyLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(title ? `:::${kind}[${title}]` : `:::${kind}`);
      out.push(...bodyLines);
      out.push(':::');
      continue;
    }
    out.push(line);
    i++;
  }

  return out.join('\n');
}

function detectMermaidLabel(source) {
  const first = (source.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) || '').trim();
  if (/^sequenceDiagram\b/.test(first)) return '时序图 · 点击缩放';
  if (/^stateDiagram/.test(first)) return '状态图 · 点击缩放';
  if (/^(flowchart|graph)\b/.test(first)) return '信号流图 · 点击缩放';
  return '示意图 · 点击缩放';
}

export function buildMermaidFigure(rawSource) {
  const source = rawSource.trim();
  const b64 = Buffer.from(source, 'utf-8').toString('base64');
  const caption = detectMermaidLabel(source);
  return [
    `<figure class="kb-mermaid-wrap not-content" data-pagefind-ignore data-mermaid-b64="${b64}">`,
    `  <div class="kb-mermaid-toolbar" hidden>`,
    `    <span class="kb-mermaid-caption">${escapeHtml(caption)}</span>`,
    `    <div class="kb-mermaid-actions">`,
    `      <button type="button" class="kb-mmd-btn" data-mmd-action="copy" aria-label="复制 Mermaid 源码" title="复制 Mermaid 源码">源码</button>`,
    `      <button type="button" class="kb-mmd-btn" data-mmd-action="zoom" aria-label="全屏缩放查看图表" title="全屏放大并支持滚轮缩放与拖拽平移">全屏 ⤢</button>`,
    `    </div>`,
    `  </div>`,
    `  <div class="kb-mermaid-stage" data-mmd-stage-zoom title="点击全屏放大检视">`,
    `    <pre class="kb-mermaid-fallback"><code>${escapeHtml(source)}</code></pre>`,
    `  </div>`,
    `</figure>`,
  ].join('\n');
}

// Deterministic CommonMark block scanner aligned with lint_kb.py:
// Recognizes HTML comments <!-- ... --> and CommonMark fenced code blocks (``` / ~~~)
function tokenizeBlocks(text) {
  const tokens = [];
  let pos = 0;
  let proseStart = 0;
  const len = text.length;

  while (pos < len) {
    // 1. Check HTML comment at current position
    if (text.startsWith('<!--', pos)) {
      const endComment = text.indexOf('-->', pos + 4);
      const commentEnd = endComment === -1 ? len : endComment + 3;
      if (pos > proseStart) {
        tokens.push({ kind: 'prose', raw: text.slice(proseStart, pos) });
      }
      tokens.push({ kind: 'comment', raw: text.slice(pos, commentEnd) });
      pos = commentEnd;
      proseStart = pos;
      continue;
    }

    // 2. Check CommonMark fenced code block at start of line
    if (pos === 0 || text[pos - 1] === '\n') {
      const lineEnd = text.indexOf('\n', pos);
      const firstLine = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd);
      const openMatch = firstLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (openMatch) {
        const fence = openMatch[1];
        const marker = fence[0];
        const info = openMatch[2];
        // CommonMark §4.5: backtick fence info string cannot contain backticks
        if (!(marker === '`' && info.includes('`'))) {
          if (pos > proseStart) {
            tokens.push({ kind: 'prose', raw: text.slice(proseStart, pos) });
          }
          if (lineEnd === -1) {
            tokens.push({ kind: 'fence', raw: firstLine, info, code: '' });
            pos = len;
            proseStart = pos;
            break;
          }

          let cursor = lineEnd + 1;
          const codeStart = cursor;
          let codeEnd = len;
          let blockEnd = len;
          const closeRe = new RegExp(`^ {0,3}${marker}{${fence.length},}[ \\t]*$`);

          while (cursor <= len) {
            const nextNl = text.indexOf('\n', cursor);
            const curLine = nextNl === -1 ? text.slice(cursor) : text.slice(cursor, nextNl);
            if (closeRe.test(curLine)) {
              codeEnd = cursor > codeStart ? cursor - 1 : codeStart;
              blockEnd = nextNl === -1 ? len : nextNl;
              break;
            }
            if (nextNl === -1) break;
            cursor = nextNl + 1;
          }

          tokens.push({
            kind: 'fence',
            raw: text.slice(pos, blockEnd),
            info,
            code: text.slice(codeStart, codeEnd),
          });
          pos = blockEnd;
          proseStart = pos;
          continue;
        }
      }
    }

    pos++;
  }

  if (proseStart < len) {
    tokens.push({ kind: 'prose', raw: text.slice(proseStart) });
  }
  return tokens;
}

// Exact CommonMark backtick inline code spans (matching exact backtick delimiter count)
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)[^\n]+?(?<!`)\1(?!`)/g;

// Standard Markdown image syntax: ![alt](<dest> title) or ![alt](dest title) with balanced parens
const MARKDOWN_IMAGE_RE =
  /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|((?:\\[()]|[^()\s]|\([^()\n]*\))+))([ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

function resolveRelativeMarkdownAsset(rawTarget, noteDir, assetsDir) {
  const unescaped = rawTarget.replace(/\\\(/g, '(').replace(/\\\)/g, ')');
  let pathname = unescaped;
  let suffix = '';
  const hashIdx = pathname.indexOf('#');
  if (hashIdx !== -1) {
    suffix = pathname.slice(hashIdx);
    pathname = pathname.slice(0, hashIdx);
  }
  const queryIdx = pathname.indexOf('?');
  if (queryIdx !== -1) {
    suffix = pathname.slice(queryIdx) + suffix;
    pathname = pathname.slice(0, queryIdx);
  }
  if (!pathname || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathname) || pathname.startsWith('//') || pathname.startsWith('/')) {
    return null;
  }

  let decodedPath = pathname;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes('\0')) return null;

  if (noteDir && assetsDir && fs.existsSync(assetsDir)) {
    const resolvedCandidate = path.resolve(noteDir, decodedPath);
    if (!isWithin(assetsDir, resolvedCandidate) || !fs.existsSync(resolvedCandidate)) {
      return null;
    }
    const stat = fs.lstatSync(resolvedCandidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return null;
    }
    const realAssets = fs.realpathSync(assetsDir);
    const realFile = fs.realpathSync(resolvedCandidate);
    if (!isWithin(realAssets, realFile)) {
      return null;
    }
    const relPosix = path.relative(realAssets, realFile).split(path.sep).join('/');
    return isSafeRelativeAssetPosix(relPosix) ? { relPosix, suffix } : null;
  }

  // Pure fallback when noteDir/assetsDir are not provided
  const match = decodedPath.match(/^(?:\.\/)?(?:\.\.\/)+assets\/(.+)$/);
  if (!match) return null;
  const normalized = path.posix.normalize(match[1]);
  return isSafeRelativeAssetPosix(normalized) ? { relPosix: normalized, suffix } : null;
}

function transformInlineProse(text, { linkMap, assets, base, noteDir, assetsDir }) {
  const converted = convertCallouts(text);
  const out = [];
  let lastIdx = 0;

  INLINE_CODE_RE.lastIndex = 0;
  let codeMatch;
  const transformChunk = (part) => {
    let chunk = part.replace(
      /(!)?\[\[([^\]\n|]+)(?:\|([^\n]+?))?\]\](?!\])/g,
      (full, embed, target, label) => {
      if (embed) {
        if (!assets || !Object.hasOwn(assets, target)) {
          return full;
        }
        const assetPath = assets[target];
        if (!isSafeRelativeAssetPosix(assetPath)) {
          return full;
        }
        const alt = escapeMarkdownLabel((label || path.posix.basename(assetPath)).trim());
        return `![${alt}](<${encodeAssetUrl(assetPath, base)}>)`;
      }
      const cleanTarget = target.trim();
      const route = Object.hasOwn(linkMap, cleanTarget) ? linkMap[cleanTarget] : undefined;
      const display = escapeMarkdownLabel((label || cleanTarget).trim());
      if (!route) return (label || cleanTarget).trim();
      return `[${display}](${withDocRoute(route, base)})`;
    });

    chunk = chunk.replace(MARKDOWN_IMAGE_RE, (full, alt, angleDest, bareDest, titlePart = '') => {
      const rawDest = angleDest ?? bareDest ?? '';
      const resolved = resolveRelativeMarkdownAsset(rawDest, noteDir, assetsDir);
      if (!resolved) return full;
      const url = `${encodeAssetUrl(resolved.relPosix, base)}${resolved.suffix}`;
      return `![${alt}](<${url}>${titlePart || ''})`;
    });

    return chunk;
  };

  while ((codeMatch = INLINE_CODE_RE.exec(converted)) !== null) {
    if (codeMatch.index > lastIdx) {
      out.push(transformChunk(converted.slice(lastIdx, codeMatch.index)));
    }
    out.push(codeMatch[0]);
    lastIdx = INLINE_CODE_RE.lastIndex;
  }
  if (lastIdx < converted.length) {
    out.push(transformChunk(converted.slice(lastIdx)));
  }

  return out.join('');
}

export function transformBody(
  body,
  linkMap = {},
  hasHumanNotesHint = undefined,
  assets = {},
  options = {},
) {
  const base = options.base ?? SITE_BASE;
  const noteDir = options.noteDir ?? null;
  const assetsDir = options.assetsDir ?? WIKI_ASSETS_DIR;

  const text = stripOrPreserveHumanNotes(body, hasHumanNotesHint);
  const out = [];

  for (const token of tokenizeBlocks(text)) {
    if (token.kind === 'prose') {
      out.push(
        transformInlineProse(token.raw, {
          linkMap,
          assets,
          base,
          noteDir,
          assetsDir,
        }),
      );
    } else if (token.kind === 'fence') {
      const langToken = token.info.trim().split(/\s+/)[0] || '';
      if (langToken === 'mermaid') {
        out.push(buildMermaidFigure(token.code));
      } else {
        out.push(token.raw);
      }
    } else {
      out.push(token.raw);
    }
  }

  return out.join('').trim();
}

function buildBacklinksSection(incoming, allById) {
  const typeLabels = {
    project: '项目',
    topic: '专题',
    adr: 'ADR',
    troubleshooting: '排障',
    synthesis: '复盘',
  };
  const links = incoming
    .map((id) => allById.get(id))
    .filter(Boolean)
    .map((src) => {
      const mins = src.reading_minutes ?? Math.max(1, Math.round((src.word_count || 350) / 350));
      return (
        `  <li>` +
        `<div class="kb-backlink-row">` +
        `<span class="kb-backlink-type kb-type-${escapeHtml(src.type)}">${typeLabels[src.type]}</span>` +
        `<a href="${escapeHtml(withDocRoute(src.route))}">${escapeHtml(src.title)}</a>` +
        `<span class="kb-backlink-meta">${mins} min</span>` +
        `</div>` +
        (src.description ? `<p class="kb-backlink-desc">${escapeHtml(src.description)}</p>` : '') +
        `</li>`
      );
    });

  if (links.length === 0) {
    return '';
  }
  return [
    '',
    '',
    '<section class="kb-backlinks not-content" data-pagefind-ignore>',
    `  <h2>反向引用（${links.length}）</h2>`,
    '  <ul>',
    ...links,
    '  </ul>',
    '</section>',
  ].join('\n');
}

function resolveSidebarBadge(item) {
  if (item.type === 'project' && item.tier === 'core') {
    return { text: 'Core', variant: 'tip' };
  }
  if (item.type === 'troubleshooting' && item.severity === 'high') {
    return { text: 'High', variant: 'danger' };
  }
  if (item.type === 'adr' && item.decision_status && item.decision_status !== 'accepted') {
    return { text: item.decision_status, variant: 'caution' };
  }
  return null;
}

function buildStarlightFrontmatter(item, order) {
  const badge = resolveSidebarBadge(item);
  const lines = [
    '---',
    `title: ${yamlStr(item.title)}`,
    `description: ${yamlStr(item.description)}`,
    'sidebar:',
    `  order: ${order}`,
  ];
  if (badge) {
    lines.push('  badge:');
    lines.push(`    text: ${yamlStr(badge.text)}`);
    lines.push(`    variant: ${yamlStr(badge.variant)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export function copyAssets(srcDir, dstDir) {
  fs.rmSync(dstDir, { recursive: true, force: true });
  if (!fs.existsSync(srcDir)) return;
  const rootStat = fs.lstatSync(srcDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refusing symbolic or non-directory assets root: ${srcDir}`);
  }
  const realSrcRoot = fs.realpathSync(srcDir);

  const walk = (curSrc, curDst) => {
    for (const entry of fs.readdirSync(curSrc, { withFileTypes: true })) {
      if (entry.name === '.gitkeep') continue;
      const from = path.join(curSrc, entry.name);
      const to = path.join(curDst, entry.name);
      const stat = fs.lstatSync(from);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link in wiki assets: ${from}`);
      }
      const realFrom = fs.realpathSync(from);
      if (!isWithin(realSrcRoot, realFrom)) {
        throw new Error(`Refusing asset outside wiki/assets boundary: ${from}`);
      }
      if (stat.isDirectory()) {
        walk(from, to);
      } else if (stat.isFile()) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(realFrom, to);
      }
    }
  };
  walk(srcDir, dstDir);
}

export function main() {
  const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf-8'));
  const graph = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'graph.json'), 'utf-8'));

  const allItems = [
    ...catalog.projects,
    ...catalog.topics,
    ...catalog.adrs,
    ...catalog.troubleshooting,
    ...catalog.synthesis,
  ];
  const allById = new Map(allItems.map((item) => [item.id, item]));

  // Build incoming edges map for backlinks panel
  const incomingMap = new Map();
  for (const edge of graph.edges || []) {
    if (!incomingMap.has(edge.target)) incomingMap.set(edge.target, new Set());
    incomingMap.get(edge.target).add(edge.source);
  }

  fs.rmSync(OUT_DOCS_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DOCS_DIR, { recursive: true });

  // Copy wiki/assets -> public/wiki-assets
  copyAssets(WIKI_ASSETS_DIR, OUT_ASSETS_DIR);

  // Order projects with core featured first
  const orderedGroups = [
    [...catalog.projects].sort((a, b) => {
      const rank = { core: 0, active: 1, archive: 2 };
      return (rank[a.tier] ?? 9) - (rank[b.tier] ?? 9) || a.id.localeCompare(b.id);
    }),
    [...catalog.topics].sort((a, b) => a.id.localeCompare(b.id)),
    [...catalog.adrs].sort((a, b) => a.id.localeCompare(b.id)),
    [...catalog.troubleshooting].sort((a, b) => a.id.localeCompare(b.id)),
    [...catalog.synthesis].sort((a, b) => a.id.localeCompare(b.id)),
  ];

  let written = 0;
  for (const group of orderedGroups) {
    group.forEach((item, idx) => {
      const srcPath = path.join(REPO_ROOT, item.source_path);
      const raw = fs.readFileSync(srcPath, 'utf-8');
      const { body } = splitFrontmatter(raw);
      const transformed = transformBody(body, catalog.link_map || {}, item.has_human_notes, item.assets, {
        noteDir: path.dirname(srcPath),
        assetsDir: WIKI_ASSETS_DIR,
      });
      const frontmatter = buildStarlightFrontmatter(item, idx + 1);
      const incoming = Array.from(incomingMap.get(item.id) || []).sort();
      const backlinks = buildBacklinksSection(incoming, allById);

      const relFromWiki = path.relative(WIKI_DIR, srcPath);
      const outPath = path.join(OUT_DOCS_DIR, relFromWiki);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(
        outPath,
        `${frontmatter}\n\n${transformed}${backlinks}\n`,
        'utf-8',
      );
      written++;
    });
  }

  const indexDescription = `基于 ${catalog.owner || 'Mangta517'} 全部公开 GitHub 项目的嵌入式固件、架构决策与排障知识库。`;
  // Generate splash portfolio homepage index.mdx
  const indexMdx = `---
title: ${yamlStr('Mangta 工程知识库')}
description: ${yamlStr(indexDescription)}
template: splash
editUrl: false
pagefind: false
---

import PortfolioHome from '../../components/PortfolioHome.astro';

<PortfolioHome />
`;
  fs.writeFileSync(path.join(OUT_DOCS_DIR, 'index.mdx'), indexMdx, 'utf-8');

  const graphMdx = `---
title: ${yamlStr('知识关系图谱')}
description: ${yamlStr('浏览项目档案、技术专题、架构决策、排障案例和跨项目复盘之间的关联。')}
template: splash
editUrl: false
pagefind: false
---

import KnowledgeGraphPage from '../../components/KnowledgeGraphPage.astro';

<KnowledgeGraphPage />
`;
  fs.writeFileSync(path.join(OUT_DOCS_DIR, 'graph.mdx'), graphMdx, 'utf-8');

  console.log(`[prepare-content] Prepared ${written} docs + index.mdx + graph.mdx (SITE_BASE="${SITE_BASE || '/'}")`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
