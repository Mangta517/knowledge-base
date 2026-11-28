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
}

export interface ExtractedDiagram {
  index: number;
  diagram_type: string;
  direction?: string;
  title: string;
  section_slug?: string;
  source: string;
}

export declare function splitFrontmatterBody(raw?: string): string;
export declare function slugifyHeading(raw?: string, seenCounts?: Map<string, number>): string;
export declare function extractEvidenceLinks(
  rawMarkdown: string,
  repoToProjectId?: Map<string, string>,
): ExtractedEvidenceLink[];
export declare function extractDiagrams(
  rawMarkdown: string,
  fallbackTitle?: string,
): ExtractedDiagram[];
