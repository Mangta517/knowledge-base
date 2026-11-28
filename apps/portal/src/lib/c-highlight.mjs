const C_KEYWORDS = new Set([
  'auto',
  'break',
  'case',
  'const',
  'continue',
  'default',
  'do',
  'else',
  'enum',
  'extern',
  'for',
  'goto',
  'if',
  'inline',
  'register',
  'restrict',
  'return',
  'sizeof',
  'static',
  'struct',
  'switch',
  'typedef',
  'union',
  'volatile',
  'while',
  '_Alignas',
  '_Alignof',
  '_Atomic',
  '_Bool',
  '_Generic',
  '_Noreturn',
  '_Static_assert',
  'true',
  'false',
  'NULL',
]);

const C_TYPES = new Set([
  'void',
  'char',
  'short',
  'int',
  'long',
  'float',
  'double',
  'signed',
  'unsigned',
  'bool',
  'size_t',
  'ssize_t',
  'ptrdiff_t',
  'intptr_t',
  'uintptr_t',
  'int8_t',
  'uint8_t',
  'int16_t',
  'uint16_t',
  'int32_t',
  'uint32_t',
  'int64_t',
  'uint64_t',
  'TickType_t',
  'BaseType_t',
  'UBaseType_t',
  'StackType_t',
  'TaskHandle_t',
  'QueueHandle_t',
  'SemaphoreHandle_t',
  'TimerHandle_t',
  'EventGroupHandle_t',
  'HAL_StatusTypeDef',
  'HAL_LockTypeDef',
  'FlagStatus',
  'ITStatus',
  'FunctionalState',
  'ErrorStatus',
  'err_t',
  'u8_t',
  'u16_t',
  'u32_t',
  's8_t',
  's16_t',
  's32_t',
  'ip4_addr_t',
  'ip_addr_t',
  'lv_obj_t',
  'lv_disp_drv_t',
  'lv_area_t',
  'lv_color_t',
]);

export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render short engineering prose safely, upgrading `inline_code` spans to monospace tags. */
export function renderInlineCodeHtml(raw = '') {
  const text = String(raw || '');
  if (!text) return '';
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const start = match.index ?? 0;
    out += escapeHtml(text.slice(cursor, start));
    out += `<code class="kb-ev-inline-code">${escapeHtml(match[1])}</code>`;
    cursor = start + match[0].length;
  }
  out += escapeHtml(text.slice(cursor));
  return out;
}

function isTypeIdent(word) {
  if (C_TYPES.has(word)) return true;
  if (word.length > 2 && /_(?:t|TypeDef|HandleTypeDef|InitTypeDef|ConfigTypeDef)$/.test(word)) {
    return true;
  }
  return false;
}

function isMacroIdent(word) {
  return word.length >= 2 && /^[A-Z][A-Z0-9_]*$/.test(word) && /[A-Z]/.test(word);
}

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch) {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function highlightLineTokens(line, state) {
  let out = '';
  let i = 0;
  const n = line.length;

  // Continue multi-line block comment from previous line
  if (state.inBlockComment) {
    const endIdx = line.indexOf('*/');
    if (endIdx === -1) {
      return `<span class="kb-c-cmt">${escapeHtml(line)}</span>`;
    }
    out += `<span class="kb-c-cmt">${escapeHtml(line.slice(0, endIdx + 2))}</span>`;
    i = endIdx + 2;
    state.inBlockComment = false;
  }

  // Handle C preprocessor directives at start of line
  if (i === 0) {
    const preproc = line.match(/^([ \t]*)(#[ \t]*[a-zA-Z_]\w*)/);
    if (preproc) {
      out += escapeHtml(preproc[1]);
      out += `<span class="kb-c-pp">${escapeHtml(preproc[2])}</span>`;
      i = preproc[0].length;
      if (/^#[ \t]*include\b/.test(preproc[2])) {
        const inc = line.slice(i).match(/^([ \t]*)(<[^>\n]+>|"[^"\n]+")/);
        if (inc) {
          out += escapeHtml(inc[1]);
          out += `<span class="kb-c-str">${escapeHtml(inc[2])}</span>`;
          i += inc[0].length;
        }
      }
    }
  }

  while (i < n) {
    const ch = line[i];
    const next = i + 1 < n ? line[i + 1] : '';

    // Single-line comment
    if (ch === '/' && next === '/') {
      out += `<span class="kb-c-cmt">${escapeHtml(line.slice(i))}</span>`;
      break;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      const endIdx = line.indexOf('*/', i + 2);
      if (endIdx === -1) {
        out += `<span class="kb-c-cmt">${escapeHtml(line.slice(i))}</span>`;
        state.inBlockComment = true;
        break;
      }
      out += `<span class="kb-c-cmt">${escapeHtml(line.slice(i, endIdx + 2))}</span>`;
      i = endIdx + 2;
      continue;
    }

    // String or char literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      out += `<span class="kb-c-str">${escapeHtml(line.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // Numeric literal (hex, binary, float, int with C suffixes)
    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '.' && next >= '0' && next <= '9')
    ) {
      const numMatch = line
        .slice(i)
        .match(
          /^(?:0[xX][0-9a-fA-F]+[uUlL]*|0[bB][01]+[uUlL]*|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fFlLuU]*)/,
        );
      if (numMatch) {
        out += `<span class="kb-c-num">${escapeHtml(numMatch[0])}</span>`;
        i += numMatch[0].length;
        continue;
      }
    }

    // Identifiers: keywords, types, function calls, macros/registers
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(line[j])) j++;
      const word = line.slice(i, j);

      if (C_KEYWORDS.has(word)) {
        out += `<span class="kb-c-kw">${escapeHtml(word)}</span>`;
      } else if (isTypeIdent(word)) {
        out += `<span class="kb-c-type">${escapeHtml(word)}</span>`;
      } else {
        let k = j;
        while (k < n && (line[k] === ' ' || line[k] === '\t')) k++;
        if (k < n && line[k] === '(') {
          out += `<span class="kb-c-fn">${escapeHtml(word)}</span>`;
        } else if (isMacroIdent(word)) {
          out += `<span class="kb-c-macro">${escapeHtml(word)}</span>`;
        } else {
          out += escapeHtml(word);
        }
      }
      i = j;
      continue;
    }

    // Multi-char operators
    const opMatch = line
      .slice(i)
      .match(/^(?:->|<<=|>>=|<<|>>|==|!=|<=|>=|&&|\|\||\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\+\+|--)/);
    if (opMatch) {
      out += `<span class="kb-c-op">${escapeHtml(opMatch[0])}</span>`;
      i += opMatch[0].length;
      continue;
    }

    out += escapeHtml(ch);
    i++;
  }

  return out;
}

/**
 * Highlight verbatim C source code at build time into XSS-safe per-line HTML
 * with exact source file line numbers and optional spotlighted lines.
 */
export function highlightCCode(rawCode = '', options = {}) {
  const normalized = String(rawCode || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/, '');

  const parsedStart = Number.isInteger(options.startLine) && options.startLine > 0 ? options.startLine : 1;
  const highlightSet = new Set(
    Array.isArray(options.highlightLines)
      ? options.highlightLines.filter((n) => Number.isInteger(n) && n > 0)
      : [],
  );

  if (!normalized) {
    return {
      lines: [],
      totalLines: 0,
      startLine: parsedStart,
      endLine: parsedStart,
    };
  }

  const rawLines = normalized.split('\n');
  const state = { inBlockComment: false };
  const lines = rawLines.map((lineText, idx) => {
    const lineNo = parsedStart + idx;
    const html = highlightLineTokens(lineText, state);
    return {
      lineNo,
      isHighlighted: highlightSet.has(lineNo),
      html: html || '&#8203;',
    };
  });

  return {
    lines,
    totalLines: lines.length,
    startLine: parsedStart,
    endLine: parsedStart + lines.length - 1,
  };
}

/**
 * Serialize highlighted C lines into compact semantic HTML without per-span Astro scope attributes.
 * Every token is already HTML-escaped by `highlightCCode`.
 */
export function renderHighlightedCLinesHtml(highlighted) {
  if (!highlighted || !Array.isArray(highlighted.lines) || highlighted.lines.length === 0) {
    return '';
  }
  return highlighted.lines
    .map(
      (line) =>
        `<span class="kb-c-line${line.isHighlighted ? ' is-hl' : ''}"><span class="kb-c-ln" aria-hidden="true">${line.lineNo}</span><span class="kb-c-line-code">${line.html}</span></span>`,
    )
    .join('');
}
