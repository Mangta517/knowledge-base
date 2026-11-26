/**
 * Shared SVG attribute & URL safety helpers for defense-in-depth sanitization
 * of Mermaid-rendered SVGs (used alongside Mermaid securityLevel: 'strict').
 */

export const DISALLOWED_SVG_SELECTOR = [
  'script',
  'iframe',
  'object',
  'embed',
  'base',
  'meta',
  'link',
  'form',
  'input',
  'textarea',
  'button',
  'select',
  'audio',
  'video',
  'applet',
  'frame',
  'frameset',
  'portal',
  'animate',
  'set',
  'animateMotion',
  'animateTransform',
  'handler',
].join(', ');

const URL_ATTRS = new Set([
  'href',
  'xlink:href',
  'src',
  'action',
  'poster',
  'data',
  'background',
]);

const STRIPPED_ATTRS = new Set(['srcdoc', 'formaction']);

const UNSAFE_CSS_RE =
  /expression\s*\(|javascript\s*:|vbscript\s*:|@import\b|url\s*\(\s*['"]?\s*(?:javascript:|vbscript:|data\s*:\s*text\/html|data\s*:\s*image\/svg\+xml)/i;

/**
 * Strict allowlist check for URL-bearing SVG attributes.
 * Strips ASCII control characters and whitespace before scheme validation.
 */
export function isSafeSvgUrl(rawValue = '') {
  const compact = String(rawValue ?? '').replace(/[\u0000-\u0020\u007f]+/g, '');
  if (!compact) return false;
  if (compact.startsWith('#')) return true;
  if (compact.startsWith('/') && !compact.startsWith('//')) return true;

  try {
    const parsed = new URL(compact);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Reject CSS injection payloads inside inline style attributes or <style> text
 * while keeping normal Mermaid layout/color rules and local url(#id) references.
 */
export function isSafeSvgCss(rawCss = '') {
  const normalized = String(rawCss ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, '');
  return !UNSAFE_CSS_RE.test(normalized);
}

/**
 * Return true when an attribute on a parsed SVG element should be removed.
 */
export function shouldRemoveSvgAttribute(attrName = '', attrValue = '') {
  const name = String(attrName ?? '').trim().toLowerCase();
  if (!name) return true;
  if (name.startsWith('on') || STRIPPED_ATTRS.has(name)) {
    return true;
  }
  if (URL_ATTRS.has(name)) {
    return !isSafeSvgUrl(attrValue);
  }
  if (name === 'style') {
    return !isSafeSvgCss(attrValue);
  }
  return false;
}
