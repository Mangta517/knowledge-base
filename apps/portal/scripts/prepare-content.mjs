import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PORTAL_ROOT, '../..');
const WIKI_DIR = path.join(REPO_ROOT, 'wiki');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const OUT_DOCS_DIR = path.join(PORTAL_ROOT, 'src/content/docs');
const OUT_ASSETS_DIR = path.join(PORTAL_ROOT, 'public/wiki-assets');

function normalizeBase(raw = '') {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

const SITE_BASE = normalizeBase(process.env.SITE_BASE || '');

function withBase(route) {
  const clean = route.startsWith('/') ? route : `/${route}`;
  return `${SITE_BASE}${clean}`;
}

function withDocRoute(route) {
  return withBase(route.toLowerCase());
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function yamlStr(str = '') {
  return JSON.stringify(String(str));
}

function splitFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('Missing YAML frontmatter');
  }
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx === -1) {
    throw new Error('Unterminated YAML frontmatter');
  }
  return {
    frontmatter: normalized.slice(4, endIdx),
    body: normalized.slice(endIdx + 5).trim(),
  };
}

function stripOrPreserveHumanNotes(body, hasHumanNotesHint) {
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
      return `\n\n${trimmed}\n\n`;
    },
  );
}

function convertCallouts(text) {
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

  let inFence = false;
  let fenceMarker = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*([`~]{3,})/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      out.push(line);
      i++;
      continue;
    }

    if (!inFence) {
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
    }

    out.push(line);
    i++;
  }

  return out.join('\n');
}

function detectMermaidLabel(source) {
  const first = (source.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) || '').trim();
  if (/^sequenceDiagram\b/.test(first)) return '交互时序图 · 点击画布可全屏缩放';
  if (/^stateDiagram/.test(first)) return '状态迁移图 · 点击画布可全屏缩放';
  if (/^(flowchart|graph)\b/.test(first)) return '架构信号流图 · 点击画布可全屏缩放';
  return '工程示意图 · 点击画布可全屏缩放';
}

function buildMermaidFigure(rawSource) {
  const source = rawSource.trim();
  const b64 = Buffer.from(source, 'utf-8').toString('base64');
  const caption = detectMermaidLabel(source);
  return [
    `<figure class="kb-mermaid-wrap not-content" data-pagefind-ignore data-mermaid-b64="${b64}">`,
    `  <div class="kb-mermaid-toolbar" hidden>`,
    `    <span class="kb-mermaid-caption">${escapeHtml(caption)}</span>`,
    `    <div class="kb-mermaid-actions">`,
    `      <button type="button" class="kb-mmd-btn" data-mmd-action="copy" aria-label="复制 Mermaid 源码" title="复制 Mermaid 源码">复制源码</button>`,
    `      <button type="button" class="kb-mmd-btn" data-mmd-action="zoom" aria-label="全屏缩放查看图表" title="全屏放大并支持滚轮缩放与拖拽平移">放大检视 ⤢</button>`,
    `    </div>`,
    `  </div>`,
    `  <div class="kb-mermaid-stage" data-mmd-stage-zoom title="点击全屏放大检视">`,
    `    <pre class="kb-mermaid-fallback"><code>${escapeHtml(source)}</code></pre>`,
    `  </div>`,
    `</figure>`,
  ].join('\n');
}

function transformBody(body, linkMap, hasHumanNotesHint) {
  let text = stripOrPreserveHumanNotes(body, hasHumanNotesHint);
  text = convertCallouts(text);

  // Protect fenced code blocks and inline code while converting wikilinks & relative assets
  const segments = [];
  const fenceRegex = /(^|\n)([`~]{3,}[^\n]*\n[\s\S]*?\n[`~]{3,}[ \t]*(?=\n|$))/g;
  let lastIndex = 0;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    const prefixEnd = match.index + match[1].length;
    if (prefixEnd > lastIndex) {
      segments.push({ code: false, value: text.slice(lastIndex, prefixEnd) });
    }
    segments.push({ code: true, value: match[2] });
    lastIndex = fenceRegex.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ code: false, value: text.slice(lastIndex) });
  }

  const transformed = segments
    .map((seg) => {
      if (seg.code) {
        const mmdMatch = seg.value.match(/^```mermaid[ \t]*\n([\s\S]*?)\n```[ \t]*$/);
        if (mmdMatch) {
          return buildMermaidFigure(mmdMatch[1]);
        }
        return seg.value;
      }
      // Split around inline code spans
      return seg.value
        .split(/(`+[^`\n]+`+)/g)
        .map((part, idx) => {
          if (idx % 2 === 1) return part;
          // Convert Obsidian wikilinks [[id|label]] or [[id]]
          let chunk = part.replace(/(!)?\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (full, embed, target, label) => {
            if (embed) {
              const assetName = target.replace(/^assets\//, '');
              return `![${label || assetName}](${withBase(`/wiki-assets/${assetName}`)})`;
            }
            const cleanTarget = target.trim();
            const route = linkMap[cleanTarget];
            const display = (label || cleanTarget).trim();
            if (!route) return display;
            return `[${display}](${withDocRoute(route)})`;
          });
          // Rewrite relative markdown images pointing to wiki/assets
          chunk = chunk.replace(
            /!\[([^\]\n]*)\]\((?:\.\.\/)+assets\/([^)\s]+)\)/g,
            (_, alt, assetPath) => `![${alt}](${withBase(`/wiki-assets/${assetPath}`)})`,
          );
          return chunk;
        })
        .join('');
    })
    .join('');

  return transformed.trim();
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

function copyAssets(srcDir, dstDir) {
  fs.rmSync(dstDir, { recursive: true, force: true });
  if (!fs.existsSync(srcDir)) return;
  const walk = (curSrc, curDst) => {
    for (const entry of fs.readdirSync(curSrc, { withFileTypes: true })) {
      if (entry.name === '.gitkeep') continue;
      const from = path.join(curSrc, entry.name);
      const to = path.join(curDst, entry.name);
      if (entry.isDirectory()) {
        walk(from, to);
      } else {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    }
  };
  walk(srcDir, dstDir);
}

function main() {
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
  copyAssets(path.join(WIKI_DIR, 'assets'), OUT_ASSETS_DIR);

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
      const transformed = transformBody(body, catalog.link_map || {}, item.has_human_notes);
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

  // Generate splash portfolio homepage index.mdx
  const indexMdx = `---
title: Mangta 工程知识库
description: 基于 ${catalog.owner} 全部公开 GitHub 项目的嵌入式固件、架构决策与排障知识库。
template: splash
editUrl: false
pagefind: false
---

import PortfolioHome from '../../components/PortfolioHome.astro';

<PortfolioHome />
`;
  fs.writeFileSync(path.join(OUT_DOCS_DIR, 'index.mdx'), indexMdx, 'utf-8');

  const graphMdx = `---
title: 知识关系图谱
description: 浏览项目档案、技术专题、架构决策、排障案例和跨项目复盘之间的关联。
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

main();
