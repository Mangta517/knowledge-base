export interface HighlightedCLine {
  lineNo: number;
  isHighlighted: boolean;
  html: string;
}

export interface HighlightedCResult {
  lines: HighlightedCLine[];
  totalLines: number;
  startLine: number;
  endLine: number;
}

export interface HighlightCOptions {
  startLine?: number;
  highlightLines?: number[];
}

export declare function escapeHtml(str?: string): string;
export declare function renderInlineCodeHtml(raw?: string): string;
export declare function highlightCCode(
  rawCode?: string,
  options?: HighlightCOptions,
): HighlightedCResult;
export declare function renderHighlightedCLinesHtml(
  highlighted: HighlightedCResult,
): string;
