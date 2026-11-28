export interface ExtractedEvidenceLink {
  url: string;
  repo: string;
  project_id?: string;
  kind: 'blob' | 'tree';
  commit: string;
  path: string;
  label: string;
  section: string;
  section_slug?: string;
  language?: 'c';
  file_kind?: 'source' | 'header';
  start_line?: number;
  end_line?: number;
  summary?: string;
  symbols?: string[];
}

export interface ExtractedEvidenceContext {
  summary: string;
  symbols: string[];
}

export interface ExtractedDiagram {
  index: number;
  diagram_type: string;
  direction?: string;
  title: string;
  section_slug?: string;
  source: string;
}

export interface ExtractEvidenceOptions {
  /** Strictly retain only C-language `.c` and `.h` blobs (default: true). */
  cOnly?: boolean;
}

export declare function isCSourcePath(filePath?: string): boolean;
export declare function getCFileKind(filePath?: string): 'source' | 'header' | null;
export declare function parseGithubLineHash(hash?: string): {
  start_line?: number;
  end_line?: number;
};
export declare function splitFrontmatterBody(raw?: string): string;
export declare function slugifyHeading(raw?: string, seenCounts?: Map<string, number>): string;
export declare function extractEvidenceContextMap(
  rawMarkdown: string,
): Map<string, ExtractedEvidenceContext[]>;
export declare function extractEvidenceLinks(
  rawMarkdown: string,
  repoToProjectId?: Map<string, string>,
  options?: ExtractEvidenceOptions,
): ExtractedEvidenceLink[];
export declare function extractDiagrams(
  rawMarkdown: string,
  fallbackTitle?: string,
): ExtractedDiagram[];
