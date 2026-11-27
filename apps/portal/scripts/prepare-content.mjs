import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, postprocess, preprocess } from 'micromark';
import { decodeString } from 'micromark-util-decode-string';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const __dirname = path.dirname(SCRIPT_PATH);
const PORTAL_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PORTAL_ROOT, '../..');
const WIKI_DIR = path.join(REPO_ROOT, 'wiki');
export const WIKI_ASSETS_DIR = path.join(WIKI_DIR, 'assets');
const DATA_DIR = path.join(REPO_ROOT, 'data');
export const OUT_DOCS_DIR = path.join(PORTAL_ROOT, 'src/content/docs');
export const OUT_ASSETS_DIR = path.join(PORTAL_ROOT, 'public/wiki-assets');

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
      body: normalized.slice(endIdx + 5).replace(/^(?:[ \t]*\n)*/, '').trimEnd(),
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
  const code = markdownEvents(body).filter(([action, token]) => action === 'enter' && codeTypes.has(token.type));
  return body.replace(
    /<!--\s*HUMAN-NOTES:START\s*-->([\s\S]*?)<!--\s*HUMAN-NOTES:END\s*-->/g,
    (full, inner, start) => {
      const end = start + full.length;
      if (code.some(([, token]) =>
        (token.start.offset <= start && start < token.end.offset) ||
        (token.start.offset < end && end <= token.end.offset)
      )) {
        return full;
      }
      const trimmed = inner.replace(/^(?:[ \t]*\n)*/, '').trimEnd();
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

  const marker = lines[0].match(/^> {0,4}\[!([A-Za-z]+)\][ \t]*(.*)$/);
  if (!marker) {
    return text;
  }
  const kind = calloutMap[marker[1].toUpperCase()] || 'note';
  const title = marker[2].trim();
  let opening = `:::${kind}`;
  if (title) {
    opening += `[${title}]`;
  }
  const body = lines.slice(1).map((line) => line.replace(/^> ?/, ''));
  return [opening, ...body, ':::'].join('\n');
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

const codeTypes = new Set(['codeText', 'codeIndented', 'codeFenced']);
const containers = new Set(['blockQuote', 'listOrdered', 'listUnordered']);

function markdownEvents(text) {
  return postprocess(parse().document().write(preprocess()(text, undefined, true)));
}

function resolveRelativeMarkdownAsset(rawTarget, noteDir, assetsDir) {
  const target = decodeString(rawTarget.replace(/^<|>$/g, ''));
  const suffixStart = target.search(/[?#]/);
  let pathname = target;
  let suffix = '';
  if (suffixStart !== -1) {
    pathname = target.slice(0, suffixStart);
    suffix = target.slice(suffixStart);
  }
  if (!pathname || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathname) || pathname.startsWith('/')) {
    return null;
  }

  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')) {
    return null;
  }

  const candidate = path.resolve(noteDir, pathname);
  if (!isWithin(assetsDir, candidate)) {
    return null;
  }
  const relPosix = path.relative(assetsDir, candidate).split(path.sep).join('/');
  if (!isSafeRelativeAssetPosix(relPosix)) {
    return null;
  }
  return { relPosix, suffix };
}

function rewriteSource(text, edits) {
  let out = '';
  let end = 0;
  for (const edit of edits) {
    out += text.slice(end, edit.start) + edit.replacement;
    end = edit.end;
  }
  return out + text.slice(end);
}

export function transformBody(body, linkMap = {}, hasHumanNotesHint, assets = {}, options = {}) {
  const base = options.base ?? SITE_BASE;
  const assetsDir = options.assetsDir ?? WIKI_ASSETS_DIR;
  const noteDir = options.noteDir ?? path.join(WIKI_DIR, 'projects');
  const text = stripOrPreserveHumanNotes(body, hasHumanNotesHint);
  const edits = [];
  const protectedRanges = [];
  let containerDepth = 0;
  let fence;
  for (const [action, token] of markdownEvents(text)) {
    const { type } = token;
    const start = token.start.offset;
    const end = token.end.offset;
    if (action === 'enter') {
      if (containers.has(type)) {
        containerDepth++;
      }
      if (codeTypes.has(type) || ['htmlFlow', 'htmlText', 'resource', 'definition', 'reference'].includes(type)) {
        protectedRanges.push({ start, end });
      }

      if (type === 'codeFenced' && containerDepth === 0) {
        fence = { start, end, language: '', lines: [] };
      } else if (fence && type === 'codeFencedFenceInfo') {
        fence.language = text.slice(start, end);
      } else if (fence && type === 'codeFlowValue') {
        fence.lines.push({ line: token.start.line, start, end });
      }

      if (type === 'resourceDestination' || type === 'definitionDestination') {
        const resolved = resolveRelativeMarkdownAsset(text.slice(start, end), noteDir, assetsDir);
        if (resolved) {
          // The rendered HTML selects the files, and copyAssets enforces existence and exact case.
          const suffix = resolved.suffix.replace(/[<>\s\\]/g, encodeURIComponent).replaceAll('&', '&amp;');
          edits.push({ start, end, replacement: `<${encodeAssetUrl(resolved.relPosix, base)}${suffix}>` });
        }
      }
    } else {
      if (containers.has(type)) {
        containerDepth--;
      }
      if (type === 'codeFenced' && fence) {
        if (fence.language === 'mermaid') {
          const lines = [];
          let previous = fence.lines[0]?.line;
          for (const line of fence.lines) {
            while (previous < line.line) {
              lines.push('');
              previous++;
            }
            lines.push(text.slice(line.start, line.end));
            previous++;
          }
          edits.push({ start: fence.start, end: fence.end, replacement: buildMermaidFigure(lines.join('\n')) });
        }
        fence = undefined;
      }
    }
  }

  for (const match of text.matchAll(/(!)?\[\[([^\]\n|]+)(?:\|([^\n]+?))?\]\](?!\])/g)) {
    const [full, embed, target, label] = match;
    const start = match.index;
    const end = start + full.length;
    if (protectedRanges.some((range) => start < range.end && end > range.start)) {
      continue;
    }
    let replacement;
    if (embed) {
      if (!Object.hasOwn(assets, target) || !isSafeRelativeAssetPosix(assets[target])) {
        continue;
      }
      const asset = assets[target];
      const alt = escapeMarkdownLabel((label || path.posix.basename(asset)).trim());
      replacement = `![${alt}](<${encodeAssetUrl(asset, base)}>)`;
    } else {
      const cleanTarget = target.trim();
      replacement = (label || cleanTarget).trim();
      if (Object.hasOwn(linkMap, cleanTarget)) {
        replacement = `[${escapeMarkdownLabel(replacement)}](${withDocRoute(linkMap[cleanTarget], base)})`;
      }
    }
    edits.push({ start, end, replacement });
  }

  edits.sort((a, b) => a.start - b.start);
  const rewritten = rewriteSource(text, edits);
  const callouts = [];
  containerDepth = 0;
  for (const [action, token] of markdownEvents(rewritten)) {
    if (!containers.has(token.type)) {
      continue;
    }
    if (action === 'enter') {
      if (token.type === 'blockQuote' && containerDepth === 0) {
        const start = token.start.offset;
        const end = token.end.offset;
        const replacement = convertCallouts(rewritten.slice(start, end));
        callouts.push({ start, end, replacement });
      }
      containerDepth++;
    } else {
      containerDepth--;
    }
  }
  return rewriteSource(rewritten, callouts).replace(/^(?:[ \t]*\n)*/, '').trimEnd();
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

export function copyAssets(srcDir, dstDir, publishedAssets) {
  fs.rmSync(dstDir, { recursive: true, force: true });
  const pending = new Set(publishedAssets);
  if (!fs.existsSync(srcDir) && pending.size === 0) {
    return;
  }
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
      } else if (stat.isFile() && pending.delete(path.relative(srcDir, from).split(path.sep).join('/'))) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(realFrom, to);
      }
    }
  };
  walk(srcDir, dstDir);
  if (pending.size > 0) {
    throw new Error(`Missing referenced wiki assets: ${[...pending].join(', ')}`);
  }
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
      let bodyPrefix = '';
      if (/^(?: {4}| {0,3}\t)/.test(transformed)) {
        // Astro trims leading whitespace when loading Markdown bodies.
        bodyPrefix = '<!-- -->\n\n';
      }
      fs.writeFileSync(
        outPath,
        `${frontmatter}\n\n${bodyPrefix}${transformed}${backlinks}\n`,
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
