import { parse, postprocess, preprocess } from 'micromark';

const CODE_TYPES = new Set(['codeText', 'codeIndented', 'codeFenced']);
const CONTAINER_TYPES = new Set(['blockQuote', 'listOrdered', 'listUnordered']);

const SOURCE_LINK_RE =
  /https:\/\/github\.com\/(?<repo>[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/(?<kind>blob|tree)\/(?<ref>[0-9a-fA-F]{40})(?:\/(?<path>(?:\\[()]|\([^()\s<>]*\)|[^()\s<>[\]`"'?#、，。；：！？])*))?(?<hash>#[^\s<>)\]`"']*)?/gi;

const MERMAID_HEADER_RE =
  /^(?<type>flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|xychart-beta)(?:\s+(?<dir>[A-Za-z0-9_-]+))?/;

const C_SOURCE_PATH_RE = /\.[ch]$/i;
const GITHUB_LINE_HASH_RE = /^#L(\d+)(?:-L?(\d+))?$/i;

export function isCSourcePath(filePath = '') {
  return typeof filePath === 'string' && C_SOURCE_PATH_RE.test(filePath.trim());
}

export function getCFileKind(filePath = '') {
  const clean = String(filePath || '').trim().toLowerCase();
  if (clean.endsWith('.c')) return 'source';
  if (clean.endsWith('.h')) return 'header';
  return null;
}

export function parseGithubLineHash(hash = '') {
  const match = String(hash || '').trim().match(GITHUB_LINE_HASH_RE);
  if (!match) return {};
  const startLine = Number.parseInt(match[1], 10);
  const endLine = match[2] ? Number.parseInt(match[2], 10) : startLine;
  if (!Number.isInteger(startLine) || startLine < 1) return {};
  if (!Number.isInteger(endLine) || endLine < startLine) {
    return { start_line: startLine, end_line: startLine };
  }
  return { start_line: startLine, end_line: endLine };
}

export function splitFrontmatterBody(raw = '') {
  const normalized = String(raw).replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return normalized;
  }
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx !== -1) {
    return normalized.slice(endIdx + 5).replace(/^(?:[ \t]*\n)*/, '').trimEnd();
  }
  if (normalized.endsWith('\n---')) {
    return '';
  }
  return normalized;
}

export function slugifyHeading(raw = '', seenCounts = new Map()) {
  const cleaned = String(raw)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
  const base = cleaned
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) return '';
  const count = seenCounts.get(base) || 0;
  seenCounts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function maskRangePreserveNewlines(text) {
  return text.replace(/[^\n]/g, ' ');
}

function analyzeMarkdown(body) {
  const events = postprocess(parse().document().write(preprocess()(body, undefined, true)));
  const maskedRanges = [];
  const mermaidBlocks = [];
  let containerDepth = 0;
  let fence = null;

  for (const [action, token] of events) {
    const { type } = token;
    const start = token.start.offset;
    const end = token.end.offset;

    if (action === 'enter') {
      if (CONTAINER_TYPES.has(type)) {
        containerDepth++;
      }
      if (CODE_TYPES.has(type)) {
        maskedRanges.push({ start, end });
      }
      if (type === 'codeFenced' && containerDepth === 0) {
        fence = { start, end, info: '', lines: [] };
      } else if (fence && type === 'codeFencedFenceInfo') {
        fence.info = body.slice(start, end);
      } else if (fence && type === 'codeFlowValue') {
        fence.lines.push({ line: token.start.line, start, end });
      }
    } else {
      if (CONTAINER_TYPES.has(type)) {
        containerDepth--;
      }
      if (type === 'codeFenced' && fence) {
        const lang = fence.info.trim().split(/\s+/)[0] || '';
        if (lang === 'mermaid') {
          const lines = [];
          let prev = fence.lines[0]?.line;
          for (const entry of fence.lines) {
            while (prev < entry.line) {
              lines.push('');
              prev++;
            }
            lines.push(body.slice(entry.start, entry.end));
            prev++;
          }
          mermaidBlocks.push({
            start: fence.start,
            source: lines.join('\n').trim(),
          });
        }
        fence = null;
      }
    }
  }

  // Mask code blocks / inline code while preserving offsets & line breaks
  maskedRanges.sort((a, b) => a.start - b.start);
  let visible = '';
  let cursor = 0;
  for (const range of maskedRanges) {
    if (range.start < cursor) {
      if (range.end > cursor) {
        visible += maskRangePreserveNewlines(body.slice(cursor, range.end));
        cursor = range.end;
      }
      continue;
    }
    visible += body.slice(cursor, range.start);
    visible += maskRangePreserveNewlines(body.slice(range.start, range.end));
    cursor = range.end;
  }
  visible += body.slice(cursor);

  // Strip HTML comments while preserving offsets
  visible = visible.replace(/<!--[\s\S]*?-->/g, (comment) => maskRangePreserveNewlines(comment));

  // Collect visible H2/H3 headings with their offsets and Starlight-compatible slugs
  const headings = [];
  const seenSlugs = new Map();
  const headingRe = /^(#{2,3})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/gm;
  for (const match of visible.matchAll(headingRe)) {
    const rawTitle = match[2].trim();
    if (!rawTitle) continue;
    const cleanTitle = rawTitle
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .trim();
    headings.push({
      offset: match.index ?? 0,
      title: cleanTitle,
      slug: slugifyHeading(cleanTitle, seenSlugs),
    });
  }

  return { visible, headings, mermaidBlocks };
}

function findNearestHeading(headings, offset) {
  let matched = null;
  for (const h of headings) {
    if (h.offset <= offset) {
      matched = h;
    } else {
      break;
    }
  }
  return matched;
}

function extractMarkdownLinkLabel(body, urlOffset) {
  // Check whether url is preceded by "](" or "](<" on the same line
  const lineStart = body.lastIndexOf('\n', Math.max(0, urlOffset - 1)) + 1;
  const before = body.slice(lineStart, urlOffset);
  const opener = before.match(/\]\(\s*<?$/);
  if (!opener) return '';
  const closeBracketIdx = before.length - opener[0].length;
  let depth = 0;
  for (let i = closeBracketIdx; i >= 0; i--) {
    const ch = before[i];
    if (ch === ']') depth++;
    else if (ch === '[') {
      depth--;
      if (depth === 0) {
        return before
          .slice(i + 1, closeBracketIdx)
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\\([[\]\\])/g, '$1')
          .trim();
      }
    }
  }
  return '';
}

function decodeGithubPath(rawPath = '') {
  const unescaped = String(rawPath || '')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')');
  try {
    return decodeURIComponent(unescaped);
  } catch {
    return unescaped;
  }
}

function cleanMarkdownContextLine(rawLine = '', linkLabel = '') {
  let line = String(rawLine || '').trim();
  if (!line) return '';

  // Strip Markdown table pipes into a readable engineering summary
  if (line.startsWith('|') && line.endsWith('|')) {
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((cell) =>
        cell
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
          .replace(/\[\[([^\]]+)\]\]/g, '$1')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .trim(),
      )
      .filter(Boolean);
    const filtered =
      cells.length > 1 && linkLabel && cells[0] === linkLabel ? cells.slice(1) : cells;
    return filtered.join(' · ').replace(/\s+/g, ' ').trim();
  }

  // Strip list / blockquote / callout prefixes
  line = line
    .replace(/^(?:>\s*)+/, '')
    .replace(/^(?:[-*+]|\d+\.)\s+/, '')
    .replace(/^\[![\w-]+\][+-]?\s*/, '');

  // Keep link labels and wikilink display names, drop raw URLs
  line = line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return line;
}

function extractContextSymbols(cleanLine = '') {
  const found = [];
  const seen = new Set();
  for (const match of cleanLine.matchAll(/`([^`\n]{2,56})`/g)) {
    const token = match[1].trim();
    // Pick C-like symbols, macros, registers, hex constants, structs, functions
    if (
      /^(?:[A-Za-z_][A-Za-z0-9_]*(?:->[A-Za-z_][A-Za-z0-9_]*|\(\))?|0x[0-9a-fA-F]+)$/.test(token) &&
      !seen.has(token)
    ) {
      seen.add(token);
      found.push(token);
      if (found.length >= 6) break;
    }
  }
  return found;
}

function extractLineContext(body, offset, linkLabel) {
  const lineStart = body.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const lineEndIdx = body.indexOf('\n', offset);
  const rawLine = body.slice(lineStart, lineEndIdx === -1 ? body.length : lineEndIdx);
  const summary = cleanMarkdownContextLine(rawLine, linkLabel);
  const symbols = extractContextSymbols(summary);
  return { summary, symbols };
}

/**
 * Build a lookup map of engineering context sentences & C symbols for each fixed-SHA C link
 * inside a Markdown document (used to enrich evidence_links when backend summaries are absent).
 */
export function extractEvidenceContextMap(rawMarkdown) {
  const body = splitFrontmatterBody(rawMarkdown);
  const { visible } = analyzeMarkdown(body);
  const byUrl = new Map();

  for (const match of visible.matchAll(SOURCE_LINK_RE)) {
    const groups = match.groups || {};
    const kind = (groups.kind || 'blob').toLowerCase() === 'tree' ? 'tree' : 'blob';
    const rawPath = groups.path || '';
    const decodedPath = decodeGithubPath(rawPath);
    if (kind !== 'blob' || !isCSourcePath(decodedPath)) continue;

    const repo = groups.repo || '';
    const commit = groups.ref || '';
    const hash = groups.hash || '';
    const offset = match.index ?? 0;
    const url = `https://github.com/${repo}/${kind}/${commit}${rawPath ? `/${rawPath}` : ''}${hash}`;
    const label = extractMarkdownLinkLabel(body, offset);
    const ctx = extractLineContext(body, offset, label);
    const list = byUrl.get(url) || [];
    list.push(ctx);
    byUrl.set(url, list);
  }

  return byUrl;
}

export function extractEvidenceLinks(rawMarkdown, repoToProjectId = new Map(), options = {}) {
  const cOnly = options.cOnly !== false;
  const body = splitFrontmatterBody(rawMarkdown);
  const { visible, headings } = analyzeMarkdown(body);
  const entries = [];

  for (const match of visible.matchAll(SOURCE_LINK_RE)) {
    const groups = match.groups || {};
    const repo = groups.repo || '';
    const kind = (groups.kind || 'blob').toLowerCase() === 'tree' ? 'tree' : 'blob';
    const commit = groups.ref || '';
    const rawPath = groups.path || '';
    const hash = groups.hash || '';
    const offset = match.index ?? 0;

    const decodedPath = decodeGithubPath(rawPath);
    const isC = kind === 'blob' && isCSourcePath(decodedPath);
    if (cOnly && !isC) {
      continue;
    }

    const baseUrl = `https://github.com/${repo}/${kind}/${commit}${rawPath ? `/${rawPath}` : ''}${hash}`;
    const heading = findNearestHeading(headings, offset);
    const mdLabel = extractMarkdownLinkLabel(body, offset);
    const fallbackLabel = decodedPath
      ? decodedPath.replace(/\/+$/, '').split('/').pop() || decodedPath
      : repo;
    const label = mdLabel || fallbackLabel;
    const projectId = repoToProjectId.get(repo.toLowerCase());
    const fileKind = getCFileKind(decodedPath);
    const lineRange = parseGithubLineHash(hash);
    const { summary, symbols } = extractLineContext(body, offset, label);

    entries.push({
      url: baseUrl,
      repo,
      ...(projectId ? { project_id: projectId } : {}),
      kind,
      commit,
      path: decodedPath,
      label,
      section: heading?.title || '',
      ...(heading?.slug ? { section_slug: heading.slug } : {}),
      ...(isC ? { language: 'c' } : {}),
      ...(fileKind ? { file_kind: fileKind } : {}),
      ...lineRange,
      ...(summary ? { summary } : {}),
      ...(symbols.length > 0 ? { symbols } : {}),
    });
  }

  return entries;
}

export function extractDiagrams(rawMarkdown, fallbackTitle = '') {
  const body = splitFrontmatterBody(rawMarkdown);
  const { headings, mermaidBlocks } = analyzeMarkdown(body);

  return mermaidBlocks.map((block, idx) => {
    const firstContentLine =
      block.source
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('%%')) || '';
    const headerMatch = firstContentLine.match(MERMAID_HEADER_RE);
    const rawType = headerMatch?.groups?.type || 'diagram';
    const diagramType = rawType === 'graph' ? 'flowchart' : rawType;
    const direction = headerMatch?.groups?.dir || undefined;
    const heading = findNearestHeading(headings, block.start);

    return {
      index: idx + 1,
      diagram_type: diagramType,
      ...(direction ? { direction } : {}),
      title: heading?.title || fallbackTitle || `图表 #${idx + 1}`,
      ...(heading?.slug ? { section_slug: heading.slug } : {}),
      source: block.source,
    };
  });
}
