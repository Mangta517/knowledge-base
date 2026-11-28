import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { micromark } from 'micromark';
import { checkPage } from '../scripts/check-built-pages.mjs';

import {
  copyAssets,
  splitFrontmatter,
  stripOrPreserveHumanNotes,
  transformBody,
} from '../scripts/prepare-content.mjs';
import {
  DISALLOWED_SVG_SELECTOR,
  isSafeSvgCss,
  isSafeSvgUrl,
  shouldRemoveSvgAttribute,
} from '../src/lib/svg-sanitize.mjs';
import {
  extractDiagrams,
  extractEvidenceContextMap,
  extractEvidenceLinks,
  getCFileKind,
  isCSourcePath,
  parseGithubLineHash,
} from '../src/lib/kb-extract.mjs';
import { highlightCCode, renderInlineCodeHtml } from '../src/lib/c-highlight.mjs';
import {
  existsExactCase,
  normalizeSiteOrigin,
  verifyOutputs,
} from '../../../scripts/build-site.mjs';
import { createPreviewServer } from '../../../scripts/preview-site.mjs';

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function rawHttpRequest(port, method, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: rawPath,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('prepare-content: CommonMark fences, comments, multi-backtick inline code, and wikilinks', () => {
  const linkMap = {
    watch: '/projects/watch/',
    'ADR-0001-stage-image-before-boot': '/adr/adr-0001-stage-image-before-boot/',
  };

  const md = [
    '正文引用 [[ADR-0001-stage-image-before-boot|镜像 [暂存] 决策]] 与 `` `[[watch|不转换]]` ``。',
    '',
    '    [[watch|缩进示例]]',
    '',
    '>     [[watch|引用缩进示例]]',
    '',
    '> ```md',
    '> [[watch|引用围栏示例]]',
    '> ```',
    '',
    '多行 ``第一行',
    '[[watch|行内示例]] `x` ``。',
    '',
    '```inline``` 后继续 [[watch|手表档案]]。',
    '',
    '<!--',
    '[[watch|注释内不转换]]',
    '```mermaid',
    'flowchart TD',
    '  X --- Y',
    '```',
    '-->',
    '',
    '````markdown',
    '```mermaid',
    'flowchart TD',
    '  Inner-->Block',
    '```',
    '> [!NOTE]',
    '> [[watch|四反引号示例内不转换]]',
    '````',
    '',
    '~~~mermaid',
    'stateDiagram-v2',
    '  [*] --> Idle',
    '~~~',
    '',
    '> [!WARNING] 实板注意',
    '> 请核对 [[watch|手表信号]]。',
  ].join('\n');

  const out = transformBody(md, linkMap, false, {}, { base: '/konwlegde' });

  // Active wikilinks converted to lowercase doc route with base and escaped brackets
  assert.match(out, /\[镜像 \\\[暂存\\\] 决策\]\(\/konwlegde\/adr\/adr-0001-stage-image-before-boot\/\)/);
  assert.match(out, /```inline``` 后继续 \[手表档案\]\(\/konwlegde\/projects\/watch\/\)/);

  // Double-backtick code span containing single backtick + wikilink stays untouched
  assert.ok(out.includes('`` `[[watch|不转换]]` ``'));
  assert.ok(out.includes('    [[watch|缩进示例]]'));
  assert.ok(out.includes('>     [[watch|引用缩进示例]]'));
  assert.ok(out.includes('> ```md\n> [[watch|引用围栏示例]]\n> ```'));
  assert.ok(out.includes('``第一行\n[[watch|行内示例]] `x` ``'));

  // HTML comments stay untouched (no figure conversion inside comment)
  assert.ok(out.includes('[[watch|注释内不转换]]'));

  // 4-backtick outer markdown example keeps inner ```mermaid and > [!NOTE] literal
  assert.ok(out.includes('````markdown\n```mermaid\nflowchart TD\n  Inner-->Block\n```\n> [!NOTE]\n> [[watch|四反引号示例内不转换]]\n````'));

  // Top-level ~~~mermaid converted into exactly one interactive figure
  const figureMatches = out.match(/<figure class="kb-mermaid-wrap/g) || [];
  assert.equal(figureMatches.length, 1);

  // Callout outside code blocks converted to Starlight aside with converted wikilink
  assert.ok(out.includes(':::caution[实板注意]\n请核对 [手表信号](/konwlegde/projects/watch/)。\n:::'));
});

test('release: Markdown download links publish under SITE_BASE and fail on missing attachments', (t) => {
  const tmp = makeTempDir(t);
  const assetsDir = path.join(tmp, 'wiki/assets');
  const noteDir = path.join(tmp, 'wiki/topics/embedded');
  const distAssets = path.join(tmp, 'dist/wiki-assets');
  fs.mkdirSync(path.join(assetsDir, 'boards'), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'boards', '参考 (v2).pdf'), 'pdf');
  fs.writeFileSync(path.join(assetsDir, 'firmware.bin'), Buffer.from([0, 255]));
  const markdown = [
    '[下载](<../../assets/boards/参考 (v2).pdf?edition=2&amp;lang=zh#pins> "手册")',
    '[固件][firmware]',
    '[远端](https://example.org/firmware.bin)',
    '',
    '[firmware]: ../../assets/firmware.bin',
    '',
    '    [示例](../../assets/example.bin)',
    '',
    '`示例',
    '[内联](../../assets/example.bin)`',
  ].join('\n');
  const options = { base: '/knowledge-base', noteDir, assetsDir };
  const site = new URL('https://example.org/knowledge-base/');
  const page = new URL('topics/embedded/board/', site);
  const assetRoot = new URL('wiki-assets/', site);
  const head = "<head><meta http-equiv=\"content-security-policy\" content=\"script-src 'self'\"></head>";
  const rendered = micromark(transformBody(markdown, {}, false, {}, options));
  assert.match(rendered, /href="\/knowledge-base\/wiki-assets\/boards\/[^"]+\.pdf\?edition=2&amp;lang=zh#pins"/);
  assert.match(rendered, /href="https:\/\/example\.org\/firmware\.bin"/);
  const referenced = new Set();
  checkPage(head + rendered, page, assetRoot, referenced);
  assert.deepEqual([...referenced], ['boards/参考 (v2).pdf', 'firmware.bin']);
  copyAssets(assetsDir, distAssets, referenced);
  assert.deepEqual(fs.readFileSync(path.join(distAssets, 'firmware.bin')), Buffer.from([0, 255]));

  const missing = transformBody('[手册](../../assets/missing.pdf)', {}, false, {}, options);
  checkPage(head + micromark(missing), page, assetRoot, referenced);
  assert.throws(() => copyAssets(assetsDir, distAssets, referenced), /Missing referenced wiki assets: missing\.pdf/);
});

test('prepare-content: nested Obsidian embeds, relative Markdown images, and traversal rejection', (t) => {
  const tmp = makeTempDir(t);
  const wikiDir = path.join(tmp, 'wiki');
  const assetsDir = path.join(wikiDir, 'assets');
  const noteDir = path.join(wikiDir, 'projects');
  fs.mkdirSync(path.join(assetsDir, 'boards'), { recursive: true });
  fs.mkdirSync(noteDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'boards', 'front panel(v2).svg'), '<svg/>', 'utf-8');
  fs.writeFileSync(path.join(assetsDir, 'boards', 'pinout.svg'), '<svg/>', 'utf-8');
  fs.writeFileSync(path.join(assetsDir, 'draft.svg'), '<svg/>', 'utf-8');
  fs.writeFileSync(path.join(wikiDir, 'secret.svg'), '<svg/>', 'utf-8');

  const body = [
    '![[front panel(v2).svg|前面板 [v2]]]',
    '![[escape.svg|越界]]',
    '![示意](<../assets/boards/front panel(v2).svg> "板框图")',
    '![括号](../assets/boards/front%20panel(v2).svg)',
    '![引脚](../assets/boards/pinout.svg#pins)',
    '<!-- ![草稿](../assets/draft.svg) -->',
    '`![草稿](../assets/draft.svg)`',
    '![越出assets](../secret.svg)',
  ].join('\n');

  const out = transformBody(
    body,
    {},
    false,
    {
      'front panel(v2).svg': 'boards/front panel(v2).svg',
      'escape.svg': '../secret.svg',
    },
    { base: '/konwlegde', noteDir, assetsDir },
  );

  assert.ok(
    out.includes('![前面板 \\[v2\\]](</konwlegde/wiki-assets/boards/front%20panel(v2).svg>)'),
  );
  // Unsafe ../ in assets map is refused
  assert.ok(out.includes('![[escape.svg|越界]]'));
  // Angle-bracket relative image with spaces and title rewritten
  assert.ok(
    out.includes('![示意](</konwlegde/wiki-assets/boards/front%20panel(v2).svg> "板框图")'),
  );
  // Percent-encoded relative image with parentheses rewritten
  assert.ok(
    out.includes('![括号](</konwlegde/wiki-assets/boards/front%20panel(v2).svg>)'),
  );
  // Image outside wiki/assets is not rewritten to /wiki-assets/
  assert.ok(out.includes('![越出assets](../secret.svg)'));
});

test('release: check inline script hashes and collect actual same-site attachment references', () => {
  const site = new URL('https://example.org/kb/');
  const assets = new URL('wiki-assets/', site);
  const page = new URL('projects/board/', site);
  const script = 'const version = 1;';
  const digest = createHash('sha256').update(script).digest('base64');
  const html = [
    `<head><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-${digest}'"><script>${script}</script></head>`,
    '<a href="../../wiki-assets/boards/guide.pdf#pins">Guide</a>',
    '<img src="/kb/wiki-assets/panel%20v2.png" srcset="/kb/wiki-assets/small.png 1x, /kb/wiki-assets/large.png 2x">',
    '<code>&lt;img src="/kb/wiki-assets/example.png"&gt;</code>',
    '<!-- <img src="/kb/wiki-assets/comment.png"> -->',
    '<img src="https://another.example/kb/wiki-assets/external.png">',
  ].join('');
  const referenced = new Set();
  checkPage(html, page, assets, referenced);
  assert.deepEqual([...referenced].sort(), ['boards/guide.pdf', 'large.png', 'panel v2.png', 'small.png']);
  assert.throws(() => checkPage(html.replace(script, 'const version = 2;'), page, assets, new Set()), /Unapproved inline script/);
  assert.throws(() => checkPage('<head><script src="theme.js"></script></head>', page, assets, new Set()), /precedes/);
});

test('prepare-content: human notes collapsing and symlink rejection in copyAssets', (t) => {
  assert.equal(
    stripOrPreserveHumanNotes(
      '正文\n<!-- HUMAN-NOTES:START -->\n## 个人复盘与后续思考\n（由人工补充与维护）\n<!-- HUMAN-NOTES:END -->',
      false,
    ).trim(),
    '正文',
  );
  const preservedNotes = stripOrPreserveHumanNotes(
    '正文\n<!-- HUMAN-NOTES:START -->\n## 个人复盘与后续思考\n实测 CAN 帧间隔 1.1s。\n<!-- HUMAN-NOTES:END -->',
    true,
  );
  assert.match(preservedNotes, /<div class="kb-human-notes">/);
  assert.match(preservedNotes, /实测 CAN 帧间隔 1\.1s。/);

  const transformedWithNotes = transformBody(
    '正文\n<!-- HUMAN-NOTES:START -->\n## 个人复盘与后续思考\n复核 [[watch|手表档案]] 的 `1.1s` 时序。\n<!-- HUMAN-NOTES:END -->',
    { watch: '/projects/watch/' },
    true,
    {},
    { base: '/konwlegde' },
  );
  assert.match(
    transformedWithNotes,
    /<div class="kb-human-notes">\s+## 个人复盘与后续思考\s+复核 \[手表档案\]\(\/konwlegde\/projects\/watch\/\) 的 `1\.1s` 时序。\s+<\/div>/,
  );
  assert.deepEqual(splitFrontmatter('---\ntitle: "x"\n---'), {
    frontmatter: 'title: "x"',
    body: '',
  });
  const example = '    ![[example-only.svg]]';
  assert.equal(splitFrontmatter(`---\ntitle: "x"\n---\n\n${example}\n`).body, example);
  assert.equal(transformBody(example), example);

  const tmp = makeTempDir(t);
  const srcAssets = path.join(tmp, 'assets');
  const outsideDir = path.join(tmp, 'outside');
  const dstAssets = path.join(tmp, 'public-assets');
  fs.mkdirSync(path.join(srcAssets, 'sub'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(srcAssets, '.gitkeep'), '', 'utf-8');
  fs.writeFileSync(path.join(srcAssets, 'sub', 'ok.svg'), '<svg/>', 'utf-8');
  fs.writeFileSync(path.join(outsideDir, 'leak.txt'), 'secret', 'utf-8');

  const publishedAssets = new Set(['sub/ok.svg']);
  copyAssets(srcAssets, dstAssets, publishedAssets);
  assert.equal(fs.existsSync(path.join(dstAssets, '.gitkeep')), false);
  assert.equal(fs.existsSync(path.join(dstAssets, 'sub', 'ok.svg')), true);
  copyAssets(srcAssets, dstAssets, new Set());
  assert.equal(fs.existsSync(path.join(dstAssets, 'sub', 'ok.svg')), false);

  // Create a directory junction/symlink inside assets pointing outside -> must throw
  const linkPath = path.join(srcAssets, 'linked-outside');
  fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyAssets(srcAssets, dstAssets, publishedAssets), /Refusing symbolic link/);
});

test('build-site: exact case, site origin validation, and published asset verification', (t) => {
  assert.equal(normalizeSiteOrigin('https://mangta517.github.io/'), 'https://mangta517.github.io');
  assert.throws(() => normalizeSiteOrigin('javascript:alert(1)'), /Invalid SITE_URL protocol/);

  const tmp = makeTempDir(t);
  const dataDir = path.join(tmp, 'data');
  const distDir = path.join(tmp, 'dist');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(distDir, 'adr', 'adr-0001-demo'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'graph'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'diagrams'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'pagefind'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'wiki-assets', 'boards'), { recursive: true });

  const catalog = {
    projects: [],
    topics: [],
    adrs: [
      {
        id: 'ADR-0001-demo',
        route: '/adr/adr-0001-demo/',
        assets: { 'panel.svg': 'boards/panel.svg' },
      },
    ],
    troubleshooting: [],
    synthesis: [],
  };
  fs.writeFileSync(path.join(dataDir, 'catalog.json'), JSON.stringify(catalog), 'utf-8');

  for (const rel of [
    'index.html',
    '404.html',
    'graph/index.html',
    'evidence/index.html',
    'diagrams/index.html',
    'robots.txt',
    'sitemap-index.xml',
    'pagefind/pagefind.js',
    'llms.txt',
    'llms-full.txt',
    'data/catalog.json',
    'data/graph.json',
    'data/stats.json',
    'adr/adr-0001-demo/index.html',
    'wiki-assets/boards/panel.svg',
  ]) {
    fs.writeFileSync(path.join(distDir, rel), 'ok', 'utf-8');
  }
  fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf-8');

  assert.equal(existsExactCase(distDir, 'adr/adr-0001-demo/index.html'), true);
  assert.equal(existsExactCase(distDir, 'adr/ADR-0001-demo/index.html'), false);
  assert.equal(existsExactCase(distDir, '../data/catalog.json'), false);
  assert.equal(verifyOutputs({ dataDir, distDir }), 1);

  fs.rmSync(path.join(distDir, 'wiki-assets', 'boards', 'panel.svg'));
  assert.throws(() => verifyOutputs({ dataDir, distDir }), /wiki-assets\/boards\/panel\.svg/);
});

test('preview-site: blocks open redirects, traversal, bad encoding, backslashes, and supports SITE_BASE + HEAD', async (t) => {
  const tmp = makeTempDir(t);
  const distDir = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(distDir, 'graph'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<h1>Home</h1>', 'utf-8');
  fs.writeFileSync(path.join(distDir, '404.html'), '<h1>Custom 404</h1>', 'utf-8');
  fs.writeFileSync(path.join(distDir, 'graph', 'index.html'), '<h1>Graph</h1>', 'utf-8');
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'do-not-serve', 'utf-8');

  // 1. Root base server (SITE_BASE = '')
  const rootServer = createPreviewServer({ distDir, siteBase: '' });
  await new Promise((resolve) => rootServer.listen(0, '127.0.0.1', resolve));
  t.after(() => rootServer.close());
  const rootPort = rootServer.address().port;

  // Protocol-relative //graph MUST NOT redirect to Location: //graph/ (open redirect)
  const dblSlash = await rawHttpRequest(rootPort, 'GET', '//graph?node=watch');
  assert.equal(dblSlash.status, 301);
  assert.equal(dblSlash.headers.location, '/graph/?node=watch');
  assert.equal(dblSlash.headers['x-content-type-options'], 'nosniff');

  // Malformed percent-encoding -> 400
  const badPct = await rawHttpRequest(rootPort, 'GET', '/%E0%A4%A');
  assert.equal(badPct.status, 400);

  // Encoded NUL byte & Windows backslash -> 400
  const nulReq = await rawHttpRequest(rootPort, 'GET', '/%00');
  assert.equal(nulReq.status, 400);
  const backslashReq = await rawHttpRequest(rootPort, 'GET', '/graph%5cindex.html');
  assert.equal(backslashReq.status, 400);

  // Path traversal -> 404
  const traversal = await rawHttpRequest(rootPort, 'GET', '/..%2foutside.txt');
  assert.equal(traversal.status, 404);
  assert.equal(traversal.body, '<h1>Custom 404</h1>');

  // Method handling: HEAD returns empty body, POST returns 405
  const headRes = await rawHttpRequest(rootPort, 'HEAD', '/graph/');
  assert.equal(headRes.status, 200);
  assert.equal(headRes.body, '');
  const postRes = await rawHttpRequest(rootPort, 'POST', '/graph/');
  assert.equal(postRes.status, 405);
  assert.equal(postRes.headers.allow, 'GET, HEAD');

  // 2. Subpath server (SITE_BASE = '/konwlegde')
  const subServer = createPreviewServer({ distDir, siteBase: '/konwlegde' });
  await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve));
  t.after(() => subServer.close());
  const subPort = subServer.address().port;

  const rootRedirect = await rawHttpRequest(subPort, 'GET', '/?tech=FreeRTOS');
  assert.equal(rootRedirect.status, 302);
  assert.equal(rootRedirect.headers.location, '/konwlegde/?tech=FreeRTOS');

  const baseRedirect = await rawHttpRequest(subPort, 'GET', '/konwlegde');
  assert.equal(baseRedirect.status, 301);
  assert.equal(baseRedirect.headers.location, '/konwlegde/');

  const subDupSlash = await rawHttpRequest(subPort, 'GET', '/konwlegde//graph');
  assert.equal(subDupSlash.status, 301);
  assert.equal(subDupSlash.headers.location, '/konwlegde/graph/');

  const subOk = await rawHttpRequest(subPort, 'GET', '/konwlegde/graph/');
  assert.equal(subOk.status, 200);
  assert.equal(subOk.body, '<h1>Graph</h1>');

  const outsideBase = await rawHttpRequest(subPort, 'GET', '/other-path/');
  assert.equal(outsideBase.status, 404);
});

test('svg-sanitize: enforces strict URL allowlist, control-char stripping, event/CSS blocking', () => {
  // Allowed Mermaid SVG references and external links
  assert.equal(isSafeSvgUrl('#arrowhead'), true);
  assert.equal(isSafeSvgUrl('/knowledge-base/projects/watch/'), true);
  assert.equal(isSafeSvgUrl('https://github.com/Mangta517/watch'), true);
  assert.equal(isSafeSvgUrl('http://example.com/doc'), true);

  // Blocked schemes, control-char obfuscation, protocol-relative URLs, data URIs
  assert.equal(isSafeSvgUrl('javascript:alert(1)'), false);
  assert.equal(isSafeSvgUrl('java\tscript:alert(1)'), false);
  assert.equal(isSafeSvgUrl('\u0001javascript:alert(1)'), false);
  assert.equal(isSafeSvgUrl('vbscript:msgbox(1)'), false);
  assert.equal(isSafeSvgUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeSvgUrl('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(isSafeSvgUrl('//evil.example/payload'), false);
  assert.equal(isSafeSvgUrl(''), false);

  // Attribute decisions
  assert.equal(shouldRemoveSvgAttribute('onclick', 'alert(1)'), true);
  assert.equal(shouldRemoveSvgAttribute('OnLoad', 'alert(1)'), true);
  assert.equal(shouldRemoveSvgAttribute('formaction', 'https://evil.example'), true);
  assert.equal(shouldRemoveSvgAttribute('srcdoc', '<script>alert(1)</script>'), true);
  assert.equal(shouldRemoveSvgAttribute('xlink:href', 'java\nscript:alert(1)'), true);
  assert.equal(shouldRemoveSvgAttribute('xlink:href', '#marker-end'), false);
  assert.equal(shouldRemoveSvgAttribute('style', 'max-width: 720px; fill: url(#grad);'), false);
  assert.equal(shouldRemoveSvgAttribute('style', 'background: url(javascript:alert(1))'), true);
  assert.equal(shouldRemoveSvgAttribute('style', 'width: exp/*x*/ression(alert(1))'), true);

  // CSS and disallowed tag checks
  assert.equal(isSafeSvgCss('#kb-mmd-1 .node rect { fill: #fff; }'), true);
  assert.equal(isSafeSvgCss('@import url("https://evil.example/x.css");'), false);
  assert.match(DISALLOWED_SVG_SELECTOR, /\bscript\b/);
  assert.match(DISALLOWED_SVG_SELECTOR, /\banimate\b/);
  assert.match(DISALLOWED_SVG_SELECTOR, /\bset\b/);
});

test('card hit-area: stretched primary links and z-index layering stay intact across cards', () => {
  const portalSrc = path.resolve(import.meta.dirname, '../src');
  const customCss = fs.readFileSync(path.join(portalSrc, 'styles/custom.css'), 'utf-8');
  const homeAstro = fs.readFileSync(path.join(portalSrc, 'components/PortfolioHome.astro'), 'utf-8');
  const stepperAstro = fs.readFileSync(
    path.join(portalSrc, 'components/ReadingTrackStepper.astro'),
    'utf-8',
  );

  // Spotlight surface uses isolation + negative z-index so direct children (> *) do not trap ::after
  assert.match(
    customCss,
    /:is\(\.kb-project,\s*\.kb-bento-card,[^)]+\)\s*\{[^}]*isolation:\s*isolate;/s,
  );
  assert.doesNotMatch(
    customCss,
    /:is\(\.kb-project,\s*\.kb-bento-card,[^)]+\)\s*>\s*\*\s*\{[^}]*position:\s*relative;/s,
  );

  // Project & Bento cards stretch primary links via ::after (z-index: 2) and elevate secondary controls (z-index: 3)
  assert.match(homeAstro, /class="kb-project-primary-link"/);
  assert.match(homeAstro, /class="kb-bento-primary-link"/);
  assert.match(
    homeAstro,
    /\.kb-project-primary-link::after,\s*\.kb-bento-primary-link::after\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*z-index:\s*2;/s,
  );
  for (const secondarySelector of [
    '\\.kb-card-tech',
    '\\.kb-tech-overflow',
    '\\.kb-rel-pill',
    '\\.kb-project-ext a',
    '\\.kb-proj-mini-tag',
  ]) {
    assert.match(
      homeAstro,
      new RegExp(`${secondarySelector}\\s*\\{[^}]*position:\\s*relative;[^}]*z-index:\\s*3;`, 's'),
    );
  }

  // Stepper focus box and doc backlinks also stretch primary links across their boxes
  assert.match(
    stepperAstro,
    /\.kb-step-doc-link::after\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s,
  );
  assert.match(
    customCss,
    /\.kb-backlink-row a::after\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s,
  );
});

test('card hover stability: cards use color-only feedback without layout-shifting expansion or transform', () => {
  const portalSrc = path.resolve(import.meta.dirname, '../src');
  const files = {
    customCss: fs.readFileSync(path.join(portalSrc, 'styles/custom.css'), 'utf-8'),
    homeAstro: fs.readFileSync(path.join(portalSrc, 'components/PortfolioHome.astro'), 'utf-8'),
    stepperAstro: fs.readFileSync(
      path.join(portalSrc, 'components/ReadingTrackStepper.astro'),
      'utf-8',
    ),
    schematicAstro: fs.readFileSync(
      path.join(portalSrc, 'components/ProjectMicroSchematic.astro'),
      'utf-8',
    ),
  };

  // No hover-triggered height drawer or line-clamp expansion that shifts grid layout
  assert.doesNotMatch(files.homeAstro, /kb-project-desc-drawer/);
  for (const [name, content] of Object.entries(files)) {
    assert.doesNotMatch(
      content,
      /:hover[^}]*\{[^}]*-webkit-line-clamp\s*:/s,
      `${name} should not change -webkit-line-clamp on hover`,
    );
  }

  // Primary cards must not shift or scale via transform on hover
  const noHoverTransformChecks = [
    [files.homeAstro, /\.kb-project:hover\s*\{[^}]*\}/s, '.kb-project:hover'],
    [files.homeAstro, /\.kb-bento-card:hover\s*\{[^}]*\}/s, '.kb-bento-card:hover'],
    [files.homeAstro, /\.kb-metric-card:hover\s*\{[^}]*\}/s, '.kb-metric-card:hover'],
    [files.stepperAstro, /\.kb-track-card:hover\s*\{[^}]*\}/s, '.kb-track-card:hover'],
    [files.customCss, /\.kb-ds-card:hover\s*\{[^}]*\}/s, '.kb-ds-card:hover'],
    [
      files.customCss,
      /\.sl-markdown-content\s+\.kb-backlinks\s+li:hover\s*\{[^}]*\}/s,
      '.kb-backlinks li:hover',
    ],
  ];

  for (const [source, pattern, label] of noHoverTransformChecks) {
    const match = source.match(pattern);
    assert.ok(match, `Expected hover rule for ${label}`);
    assert.doesNotMatch(match[0], /\btransform\s*:/, `${label} should not use transform`);
    assert.match(match[0], /\bborder-color\s*:/, `${label} should provide color feedback`);
  }

  // Schematic micro-chips & dots inside project cards stay in place on hover
  assert.doesNotMatch(
    files.schematicAstro,
    /:global\(\.kb-project:is\(:hover,\s*:focus-within\)\)[^{]*\{[^}]*\btransform\s*:/s,
  );
});

test('hero metric cards: all 4 tiles are interactive links backed by C-only evidence & exact diagram counts', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const portalSrc = path.resolve(import.meta.dirname, '../src');
  const homeAstro = fs.readFileSync(path.join(portalSrc, 'components/PortfolioHome.astro'), 'utf-8');
  const evidenceAstro = fs.readFileSync(
    path.join(portalSrc, 'components/EvidenceIndexPage.astro'),
    'utf-8',
  );
  const cSourceCardAstro = fs.readFileSync(
    path.join(portalSrc, 'components/CSourceCard.astro'),
    'utf-8',
  );
  const docSourceAnchorsAstro = fs.readFileSync(
    path.join(portalSrc, 'components/DocSourceAnchors.astro'),
    'utf-8',
  );
  const diagramsAstro = fs.readFileSync(
    path.join(portalSrc, 'components/DiagramsGalleryPage.astro'),
    'utf-8',
  );

  // All 4 Hero metric cards must be semantic anchor links to concrete destinations
  const metricAnchors = homeAstro.match(/<a\s+[^>]*class="kb-metric-card\b/g) || [];
  assert.equal(metricAnchors.length, 4, 'Expected all 4 hero metric cards to be <a> links');
  assert.match(homeAstro, /href="#kb-projects"[^>]*data-metric-jump="projects"/s);
  assert.match(homeAstro, /href=\{withBase\('\/evidence\/'\)\}/);
  assert.match(homeAstro, /href=\{withBase\('\/diagrams\/'\)\}/);
  assert.match(homeAstro, /href="#kb-library"[^>]*data-metric-jump="library"/s);

  // Evidence, C source card, and diagram subpage cards stay transform-free on hover & free of inline scripts
  assert.doesNotMatch(evidenceAstro, /\.kb-ev-card:hover\s*\{[^}]*\btransform\s*:/s);
  assert.doesNotMatch(cSourceCardAstro, /\.kb-cs-card:hover\s*\{[^}]*\btransform\s*:/s);
  assert.doesNotMatch(diagramsAstro, /\.kb-dg-card:hover\s*\{[^}]*\btransform\s*:/s);
  assert.doesNotMatch(evidenceAstro, /<script\s+is:inline/);
  assert.doesNotMatch(cSourceCardAstro, /<script\s+is:inline/);
  assert.doesNotMatch(docSourceAnchorsAstro, /<script\s+is:inline/);
  assert.match(cSourceCardAstro, /data-c-copy/);
  assert.match(cSourceCardAstro, /data-c-fold-toggle/);
  assert.match(cSourceCardAstro, /\.kb-cs-pre\s*\{[^}]*white-space:\s*normal;/s);
  assert.match(cSourceCardAstro, /\.kb-c-line-code\s*\{[^}]*white-space:\s*pre;/s);

  // Extractors match published C-only evidence subset and exact diagram counts across all published docs
  const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/catalog.json'), 'utf-8'));
  const stats = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/stats.json'), 'utf-8'));
  const repoToProjectId = new Map(catalog.projects.map((p) => [p.repo.toLowerCase(), p.id]));
  const allDocs = [
    ...catalog.projects,
    ...catalog.topics,
    ...catalog.adrs,
    ...catalog.troubleshooting,
    ...catalog.synthesis,
  ];

  let totalCOnly = 0;
  let totalAllRaw = 0;
  let totalDiagrams = 0;
  for (const doc of allDocs) {
    const raw = fs.readFileSync(path.join(repoRoot, doc.source_path), 'utf-8');
    const cEv = extractEvidenceLinks(raw, repoToProjectId);
    const allEv = extractEvidenceLinks(raw, repoToProjectId, { cOnly: false });
    const dg = extractDiagrams(raw, doc.title);

    // Default extractor must strictly retain ONLY .c and .h blobs
    assert.ok(
      cEv.every((entry) => entry.kind === 'blob' && isCSourcePath(entry.path) && entry.language === 'c'),
      `Non-C entry leaked in ${doc.id}`,
    );
    const catalogCOnly = (doc.evidence_links || []).filter(
      (entry) => entry.kind === 'blob' && isCSourcePath(entry.path),
    );
    assert.equal(cEv.length, catalogCOnly.length, `C-only evidence mismatch for ${doc.id}`);
    assert.ok(
      doc.evidence_count === cEv.length || doc.evidence_count === allEv.length,
      `evidence_count mismatch for ${doc.id}: got ${doc.evidence_count}, expected C-only ${cEv.length} or raw ${allEv.length}`,
    );
    assert.equal(dg.length, doc.mermaid_count, `mermaid_count mismatch for ${doc.id}`);
    totalCOnly += cEv.length;
    totalAllRaw += allEv.length;
    totalDiagrams += dg.length;
  }
  assert.ok(totalCOnly > 0, 'Expected at least one C source anchor across published docs');
  assert.ok(
    stats.counts.total_evidence_links === totalCOnly ||
      stats.counts.total_evidence_links === totalAllRaw,
    `total_evidence_links mismatch: got ${stats.counts.total_evidence_links}, expected C-only ${totalCOnly} or raw ${totalAllRaw}`,
  );
  assert.equal(totalDiagrams, stats.counts.total_mermaids);

  // Extractor enforces C-only (.c / .h blobs), parses #L ranges + context + symbols, and ignores non-C/comments/code
  const sha = 'a'.repeat(40);
  const sampleMd = [
    '---',
    'title: demo',
    '---',
    '## 真实章节',
    `跳转到 \`SCB->VTOR\` 前调用 \`Int_bootloader_jump\` 检查栈顶 [主入口](https://github.com/owner/demo/blob/${sha}/src/main.c#L12-L38)。`,
    `状态枚举见 [状态头](https://github.com/owner/demo/blob/${sha}/inc/boot_cfg.h#L5)。`,
    `非 C 文件应被排除：[工程配置](https://github.com/owner/demo/blob/${sha}/MDK-ARM/demo.uvprojx)、[说明](https://github.com/owner/demo/blob/${sha}/README.md)、[脚本](https://github.com/owner/demo/blob/${sha}/tools/gen.py)、[启动汇编](https://github.com/owner/demo/blob/${sha}/startup.s)、[配置](https://github.com/owner/demo/blob/${sha}/main.syscfg)、[目录](https://github.com/owner/demo/tree/${sha}/src)。`,
    '[浮动分支](https://github.com/owner/demo/blob/main/src/ignored.c)',
    `\`https://github.com/owner/demo/blob/${sha}/src/inline.c\``,
    `<!-- https://github.com/owner/demo/blob/${sha}/src/comment.c -->`,
    '```markdown',
    `https://github.com/owner/demo/blob/${sha}/src/fenced.c`,
    '```',
    '```mermaid',
    'sequenceDiagram',
    '  A->>B: ping',
    '```',
    '> ```mermaid',
    '> flowchart TD',
    '>   X --> Y',
    '> ```',
  ].join('\n');
  const parsedEv = extractEvidenceLinks(sampleMd, new Map([['owner/demo', 'demo']]));
  assert.equal(parsedEv.length, 2);
  assert.equal(parsedEv[0].project_id, 'demo');
  assert.equal(parsedEv[0].label, '主入口');
  assert.equal(parsedEv[0].section, '真实章节');
  assert.equal(parsedEv[0].path, 'src/main.c');
  assert.equal(parsedEv[0].file_kind, 'source');
  assert.equal(parsedEv[0].start_line, 12);
  assert.equal(parsedEv[0].end_line, 38);
  assert.ok(parsedEv[0].summary?.includes('SCB->VTOR'));
  assert.deepEqual(parsedEv[0].symbols, ['SCB->VTOR', 'Int_bootloader_jump']);
  assert.equal(parsedEv[1].path, 'inc/boot_cfg.h');
  assert.equal(parsedEv[1].file_kind, 'header');
  assert.equal(parsedEv[1].start_line, 5);
  assert.equal(parsedEv[1].end_line, 5);

  const ctxMap = extractEvidenceContextMap(sampleMd);
  assert.equal(ctxMap.size, 2);
  assert.equal(isCSourcePath('a/b.c'), true);
  assert.equal(isCSourcePath('a/b.H'), true);
  assert.equal(isCSourcePath('a/b.py'), false);
  assert.equal(isCSourcePath('a/b.uvprojx'), false);
  assert.equal(isCSourcePath('a/b.md'), false);
  assert.equal(isCSourcePath('a/b.s'), false);
  assert.equal(getCFileKind('foo.c'), 'source');
  assert.equal(getCFileKind('foo.h'), 'header');
  assert.equal(getCFileKind('foo.py'), null);
  assert.deepEqual(parseGithubLineHash('#L42-L68'), { start_line: 42, end_line: 68 });
  assert.deepEqual(parseGithubLineHash('#L9'), { start_line: 9, end_line: 9 });
  assert.deepEqual(parseGithubLineHash('#section'), {});

  const parsedDg = extractDiagrams(sampleMd, 'demo');
  assert.equal(parsedDg.length, 1);
  assert.equal(parsedDg[0].diagram_type, 'sequenceDiagram');
  assert.equal(parsedDg[0].title, '真实章节');
});

test('c-highlight: tokenizes embedded C99 safely with real line numbers, multi-line comments, and HTML escaping', () => {
  const sampleC = [
    '#include <stdint.h>',
    '/* multi-line',
    '   comment with <script>alert(1)</script> */',
    'static HAL_StatusTypeDef jump_app(uint32_t addr)',
    '{',
    '    if ((addr & 0x7U) != 0U && addr < APP_END_ADDR) { // check align',
    '        SCB->VTOR = addr;',
    '        return HAL_OK;',
    '    }',
    '    return HAL_ERROR;',
    '}',
  ].join('\n');

  const res = highlightCCode(sampleC, { startLine: 35, highlightLines: [40, 41] });
  assert.equal(res.startLine, 35);
  assert.equal(res.endLine, 45);
  assert.equal(res.totalLines, 11);

  // Preprocessor + angle-bracket header escaped safely
  assert.match(res.lines[0].html, /<span class="kb-c-pp">#include<\/span>/);
  assert.match(res.lines[0].html, /<span class="kb-c-str">&lt;stdint\.h&gt;<\/span>/);

  // Multi-line comment spans lines 36 & 37 and escapes raw HTML tags
  assert.match(res.lines[1].html, /<span class="kb-c-cmt">\/\* multi-line<\/span>/);
  assert.match(res.lines[2].html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(res.lines[2].html, /<script>/);

  // Keywords, embedded types, function names, hex literals, macros, operators, highlighted lines
  assert.match(res.lines[3].html, /<span class="kb-c-kw">static<\/span>/);
  assert.match(res.lines[3].html, /<span class="kb-c-type">HAL_StatusTypeDef<\/span>/);
  assert.match(res.lines[3].html, /<span class="kb-c-fn">jump_app<\/span>/);
  assert.match(res.lines[3].html, /<span class="kb-c-type">uint32_t<\/span>/);
  assert.equal(res.lines[5].lineNo, 40);
  assert.equal(res.lines[5].isHighlighted, true);
  assert.match(res.lines[5].html, /<span class="kb-c-num">0x7U<\/span>/);
  assert.match(res.lines[5].html, /<span class="kb-c-macro">APP_END_ADDR<\/span>/);
  assert.match(res.lines[5].html, /<span class="kb-c-cmt">\/\/ check align<\/span>/);
  assert.equal(res.lines[6].lineNo, 41);
  assert.equal(res.lines[6].isHighlighted, true);
  assert.match(res.lines[6].html, /<span class="kb-c-macro">SCB<\/span><span class="kb-c-op">-&gt;<\/span><span class="kb-c-macro">VTOR<\/span>/);

  // Inline prose markdown code renderer escapes HTML safely
  const prose = renderInlineCodeHtml('当 `a < b` 时写入 `SCB->VTOR` & <img src=x>');
  assert.equal(
    prose,
    '当 <code class="kb-ev-inline-code">a &lt; b</code> 时写入 <code class="kb-ev-inline-code">SCB-&gt;VTOR</code> &amp; &lt;img src=x&gt;',
  );
});

test('sunlit backdrop: light-first layered canvas, 3 presets, CSP hash parity, and print/motion guards', () => {
  const portalRoot = path.resolve(import.meta.dirname, '..');
  const customCss = fs.readFileSync(path.join(portalRoot, 'src/styles/custom.css'), 'utf-8');
  const astroCfg = fs.readFileSync(path.join(portalRoot, 'astro.config.mjs'), 'utf-8');
  const themeProvider = fs.readFileSync(
    path.join(portalRoot, 'src/components/CustomThemeProvider.astro'),
    'utf-8',
  );
  const skipLink = fs.readFileSync(
    path.join(portalRoot, 'src/components/CustomSkipLink.astro'),
    'utf-8',
  );
  const backdropComp = fs.readFileSync(
    path.join(portalRoot, 'src/components/AmbientBackdrop.astro'),
    'utf-8',
  );
  const socialIcons = fs.readFileSync(
    path.join(portalRoot, 'src/components/CustomSocialIcons.astro'),
    'utf-8',
  );

  // SkipLink mounts AmbientBackdrop directly inside <body> outside .main-pane isolation
  assert.match(astroCfg, /SkipLink:\s*'\.\/src\/components\/CustomSkipLink\.astro'/);
  assert.match(skipLink, /<AmbientBackdrop\s*\/>/);
  assert.match(backdropComp, /class="kb-backdrop print:hidden"/);
  assert.match(backdropComp, /data-kb-motif=\{motif\}/);
  assert.match(backdropComp, /data-kb-tone=\{tone\}/);
  assert.match(backdropComp, /aria-hidden="true"/);

  // Light mode uses a rich multi-stop daylight gradient and frosted glass surfaces (not flat pure white)
  const lightBlock = customCss.match(/:root\[data-theme='light'\]\s*\{[\s\S]*?\n\}/);
  assert.ok(lightBlock, 'Expected :root[data-theme="light"] palette block');
  assert.match(lightBlock[0], /--kb-page-bg:\s*linear-gradient\(/);
  assert.match(lightBlock[0], /--kb-surface-glass:\s*rgba\(255,\s*255,\s*255,/);
  assert.doesNotMatch(lightBlock[0], /--sl-color-bg:\s*#fff(?:fff)?\s*;/i);

  // All 3 light backdrop presets and contextual tones are styled
  assert.match(customCss, /:root\[data-theme='light'\]\[data-kb-backdrop='vellum'\]/);
  assert.match(customCss, /:root\[data-theme='light'\]\[data-kb-backdrop='aurora'\]/);
  for (const tone of ['mint', 'amber', 'rose', 'violet', 'teal']) {
    assert.match(customCss, new RegExp(`\\.kb-backdrop\\[data-kb-tone='${tone}'\\]`));
  }

  // Header switcher cycles presets cleanly without inline scripts
  assert.match(socialIcons, /data-kb-backdrop-cycle/);
  assert.doesNotMatch(socialIcons, /<script\s+is:inline/);

  // Print media resets background to crisp white and hides decorative backdrop & switcher
  assert.match(customCss, /@media print\s*\{[\s\S]*?\.kb-backdrop,[\s\S]*?display:\s*none !important;/);

  // CustomThemeProvider inline script hash stays strictly synchronized with astro.config.mjs CSP
  const scriptMatch = themeProvider.replace(/\r\n/g, '\n').match(/<script is:inline>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Expected inline script in CustomThemeProvider.astro');
  const expectedHash = `'sha256-${createHash('sha256').update(scriptMatch[1]).digest('base64')}'`;
  assert.ok(
    astroCfg.includes(expectedHash),
    `Expected astro.config.mjs inlineScripts to contain ${expectedHash}`,
  );
});
