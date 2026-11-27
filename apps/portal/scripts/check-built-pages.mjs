import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'parse5';
import { copyAssets, OUT_ASSETS_DIR, OUT_DOCS_DIR, splitFrontmatter, WIKI_ASSETS_DIR } from './prepare-content.mjs';

const assetAttributes = {
  a: ['href'], area: ['href'], img: ['src'], source: ['src'], audio: ['src'],
  video: ['src', 'poster'], track: ['src'], image: ['href'], use: ['href'],
};

function visitPage(html, callback) {
  function visit(node) {
    const attrs = Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
    callback(node, attrs);
    for (const child of node.childNodes || []) {
      visit(child);
    }
  }
  visit(parse(html));
}

// Resolve asset URLs from rendered HTML so Markdown examples never select a file.
function collectAssetReferences(tagName, attrs, pageUrl, assetRoot, referenced) {
  const urls = [];
  if (Object.hasOwn(assetAttributes, tagName)) {
    for (const key of assetAttributes[tagName]) {
      urls.push(attrs[key]);
    }
  }
  if ((tagName === 'img' || tagName === 'source') && attrs.srcset) {
    // Keep commas within URLs and skip width/density descriptors.
    for (const match of attrs.srcset.matchAll(/([^,\s]\S*?)(?:,+\s+|\s+[^,]*(?:,|$)|,+$|$)/g)) {
      urls.push(match[1]);
    }
  }
  for (const value of urls) {
    if (!value || !URL.canParse(value, pageUrl)) {
      continue;
    }
    const url = new URL(value, pageUrl);
    if (url.origin === assetRoot.origin && url.pathname.startsWith(assetRoot.pathname)) {
      referenced.add(decodeURIComponent(url.pathname.slice(assetRoot.pathname.length)));
    }
  }
}

export function checkPage(html, pageUrl, assetRoot, referenced) {
  let scriptSources;
  visitPage(html, (node, attrs) => {
    if (node.tagName === 'meta' && node.parentNode?.tagName === 'head' &&
        attrs['http-equiv']?.toLowerCase() === 'content-security-policy') {
      const directive = attrs.content.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src '));
      scriptSources = new Set(directive?.split(/\s+/).slice(1));
    }
    if (node.tagName === 'script') {
      if (!scriptSources?.size) {
        throw new Error(`Script precedes the site's CSP in ${pageUrl}`);
      }
      if (!attrs.src && !['application/json', 'application/ld+json'].includes(attrs.type)) {
        const script = node.childNodes.map((child) => child.value).join('');
        const digest = createHash('sha256').update(script).digest('base64');
        if (!scriptSources.has(`'sha256-${digest}'`)) {
          throw new Error(`Unapproved inline script in ${pageUrl}. Review the source before updating its CSP hash.`);
        }
      }
    }
    collectAssetReferences(node.tagName, attrs, pageUrl, assetRoot, referenced);
  });
  if (!scriptSources?.size) {
    throw new Error(`Missing script-src policy in ${pageUrl}`);
  }
}

export async function prepareDevAssets({ markdown, image }, siteRoot) {
  const renderer = await markdown.processor.createRenderer({
    image,
    gfm: markdown.gfm,
    smartypants: markdown.smartypants,
    syntaxHighlight: false,
  });
  const referenced = new Set();
  const assetRoot = new URL('wiki-assets/', siteRoot);
  for (const entry of fs.readdirSync(OUT_DOCS_DIR, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const file = path.join(entry.parentPath, entry.name);
    const route = path.relative(OUT_DOCS_DIR, file).split(path.sep).join('/').slice(0, -3).toLowerCase();
    const { body } = splitFrontmatter(fs.readFileSync(file, 'utf8'));
    const { code } = await renderer.render(body, { fileURL: pathToFileURL(file) });
    const pageUrl = new URL(`${route}/`, siteRoot);
    visitPage(code, (node, attrs) => collectAssetReferences(node.tagName, attrs, pageUrl, assetRoot, referenced));
  }
  copyAssets(WIKI_ASSETS_DIR, OUT_ASSETS_DIR, referenced);
}

export function checkBuiltPages({ dir, assets, logger }, siteRoot) {
  const referenced = new Set();
  const assetRoot = new URL('wiki-assets/', siteRoot);
  const dist = fileURLToPath(dir);
  let pages = 0;
  for (const files of assets.values()) {
    for (const file of files) {
      if (!file.pathname.endsWith('.html')) {
        continue;
      }
      const route = path.relative(dist, fileURLToPath(file)).split(path.sep).join('/');
      checkPage(fs.readFileSync(file, 'utf8'), new URL(route, siteRoot), assetRoot, referenced);
      pages++;
    }
  }
  if (!pages) {
    throw new Error('Astro returned no rendered HTML pages to check');
  }
  copyAssets(WIKI_ASSETS_DIR, path.join(dist, 'wiki-assets'), referenced);
  logger.info(`Checked CSP on ${pages} pages and published ${referenced.size} referenced wiki assets.`);
}
