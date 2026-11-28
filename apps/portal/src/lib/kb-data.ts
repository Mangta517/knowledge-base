import fs from 'node:fs';
import path from 'node:path';
import { extractDiagrams, extractEvidenceLinks } from './kb-extract.mjs';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'data', 'catalog.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), '../..');
}

const REPO_ROOT = findRepoRoot();

export interface EvidenceLinkEntry {
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

export interface DiagramEntry {
  index: number;
  diagram_type: string;
  direction?: string;
  title: string;
  section_slug?: string;
  source: string;
}

export type BackdropPresetId = 'blueprint' | 'vellum' | 'aurora';

export type BackdropMotif =
  | 'atlas'
  | 'control'
  | 'bus'
  | 'network'
  | 'rtos'
  | 'ledger'
  | 'probe'
  | 'index';

export type BackdropTone = 'sky' | 'mint' | 'amber' | 'rose' | 'violet' | 'teal';

export interface BackdropPresetEntry {
  id: BackdropPresetId;
  label: string;
  summary: string;
  default?: boolean;
}

export interface PageBackdropMeta {
  motif: BackdropMotif;
  tone: BackdropTone;
}

export interface ItemMetrics {
  reading_minutes?: number;
  mermaid_count?: number;
  table_count?: number;
  evidence_count?: number;
  has_human_notes?: boolean;
  assets?: Record<string, string>;
  /** Populated by backend index pipeline (optional until Codex backend upgrade ships). */
  evidence_links?: EvidenceLinkEntry[];
  /** Populated by backend index pipeline (optional until Codex backend upgrade ships). */
  diagrams?: DiagramEntry[];
  /** Optional contextual page atmosphere emitted by backend index pipeline. */
  backdrop?: PageBackdropMeta;
}

export interface ProjectHighlight {
  label: string;
  value: string;
}

export interface ReadingTrackStep {
  id: string;
  role: string;
  focus: string;
}

export interface ReadingTrackData {
  id: string;
  title: string;
  summary: string;
  steps: ReadingTrackStep[];
}

export interface ProjectItem extends ItemMetrics {
  id: string;
  title: string;
  description: string;
  type: 'project';
  tags: string[];
  created: string;
  updated: string;
  repo: string;
  repo_url: string;
  visibility: string;
  publish_policy: string;
  tier: 'core' | 'active' | 'archive';
  status: string;
  domains: string[];
  tech_stack: string[];
  primary_language: string;
  stars: number;
  synced_commit: string;
  featured: boolean;
  related_topics: string[];
  related_adrs: string[];
  related_troubleshooting?: string[];
  mcu?: string;
  signal_flow?: string[];
  highlights?: ProjectHighlight[];
  route: string;
  source_path: string;
  word_count: number;
}

export interface TopicItem extends ItemMetrics {
  id: string;
  title: string;
  description: string;
  type: 'topic';
  domain: string;
  tags: string[];
  created: string;
  updated: string;
  related_projects: string[];
  route: string;
  source_path: string;
  word_count: number;
}

export interface AdrItem extends ItemMetrics {
  id: string;
  title: string;
  description: string;
  type: 'adr';
  adr_id: string;
  decision_status: string;
  tags: string[];
  created: string;
  updated: string;
  related_projects: string[];
  route: string;
  source_path: string;
  word_count: number;
}

export interface TroubleshootingItem extends ItemMetrics {
  id: string;
  title: string;
  description: string;
  type: 'troubleshooting';
  ts_id: string;
  severity: 'low' | 'medium' | 'high';
  tags: string[];
  created: string;
  updated: string;
  related_projects: string[];
  phases?: string[];
  root_cause?: string;
  located_by?: string;
  route: string;
  source_path: string;
  word_count: number;
}

export interface SynthesisItem extends ItemMetrics {
  id: string;
  title: string;
  description: string;
  type: 'synthesis';
  tags: string[];
  created: string;
  updated: string;
  related_projects: string[];
  related_topics: string[];
  route: string;
  source_path: string;
  word_count: number;
}

export type KbDocItem =
  | ProjectItem
  | TopicItem
  | AdrItem
  | TroubleshootingItem
  | SynthesisItem;

export interface CatalogData {
  generated_at: string;
  owner: string;
  projects: ProjectItem[];
  topics: TopicItem[];
  adrs: AdrItem[];
  troubleshooting: TroubleshootingItem[];
  synthesis: SynthesisItem[];
  link_map: Record<string, string>;
  reading_tracks?: ReadingTrackData[];
  /** Optional site-level light backdrop presets emitted by backend index pipeline. */
  backdrop_presets?: BackdropPresetEntry[];
}

export interface GraphNode {
  id: string;
  title: string;
  type: 'project' | 'topic' | 'adr' | 'troubleshooting' | 'synthesis';
  route: string;
  group: string;
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: 'wikilink' | 'frontmatter';
}

export interface GraphData {
  generated_at: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface EvidenceRepoSummary {
  project_id: string | null;
  count: number;
  unique_files: number;
}

export interface StatsData {
  generated_at: string;
  counts: {
    projects: number;
    topics: number;
    adrs: number;
    troubleshooting: number;
    synthesis: number;
    total_notes: number;
    total_words: number;
    total_mermaids?: number;
    total_tables?: number;
    total_evidence_links?: number;
    unique_evidence_files?: number;
  };
  by_tier: Record<string, number>;
  by_domain: Record<string, number>;
  by_tech_stack: Record<string, number>;
  by_language: Record<string, number>;
  by_evidence_repo?: Record<string, EvidenceRepoSummary>;
  by_diagram_type?: Record<string, number>;
  recent_updates: Array<{
    id: string;
    title: string;
    type: string;
    updated: string;
    route: string;
    description: string;
  }>;
}

export interface ResolvedEvidenceItem extends EvidenceLinkEntry {
  doc_id: string;
  doc_title: string;
  doc_type: KbDocItem['type'];
  doc_route: string;
  doc_href: string;
  project_id?: string;
}

export interface ResolvedDiagramItem extends DiagramEntry {
  doc_id: string;
  doc_title: string;
  doc_type: KbDocItem['type'];
  doc_route: string;
  doc_href: string;
  doc_tags: string[];
  related_projects: string[];
}

export interface NeighborRelation {
  item: KbDocItem;
  kinds: Array<'frontmatter' | 'wikilink'>;
  direction: 'both' | 'out' | 'in';
}

export const TYPE_LABELS: Record<KbDocItem['type'], string> = {
  project: '项目档案',
  topic: '技术专题',
  adr: '架构决策',
  troubleshooting: '排障案例',
  synthesis: '综合复盘',
};

export const TYPE_SHORT_LABELS: Record<KbDocItem['type'], string> = {
  project: '项目',
  topic: '专题',
  adr: 'ADR',
  troubleshooting: '排障',
  synthesis: '复盘',
};

export const DOMAIN_LABELS: Record<string, string> = {
  embedded: '嵌入式',
  networking: '网络协议',
  software: '通用软件',
  mobile: '移动端',
};

export const DECISION_STATUS_LABELS: Record<string, string> = {
  proposed: '提议中',
  accepted: '已采纳',
  deprecated: '已废弃',
  superseded: '已替代',
};

export const SEVERITY_LABELS: Record<string, string> = {
  high: '高严重度',
  medium: '中严重度',
  low: '低严重度',
};

export const DIAGRAM_TYPE_LABELS: Record<string, string> = {
  flowchart: '信号与架构流图',
  sequenceDiagram: '交互时序图',
  'stateDiagram-v2': '状态迁移图',
  stateDiagram: '状态迁移图',
  classDiagram: '类结构图',
  erDiagram: '实体关系图',
  'xychart-beta': '数据趋势图',
};

export function normalizeBase(raw?: string): string {
  if (!raw || raw === '/') return '';
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

export function getSiteBase(): string {
  return normalizeBase(process.env.SITE_BASE || import.meta.env.BASE_URL || '');
}

export function withBase(route: string): string {
  const base = getSiteBase();
  const normalized = route.startsWith('/') ? route : `/${route}`;
  return `${base}${normalized}`;
}

/** Astro Starlight lowercases generated doc route slugs; normalize doc links for case-sensitive hosts (GitHub Pages). */
export function withDocRoute(route: string): string {
  return withBase(route.toLowerCase());
}

/** Normalize an Astro content entry ID or catalog route into a lowercase key like "projects/watch". */
export function normalizeDocKey(routeOrId: string): string {
  return routeOrId
    .trim()
    .replace(/\.(md|mdx)$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

export function isCommitSha(sha?: string): sha is string {
  return typeof sha === 'string' && COMMIT_SHA_RE.test(sha.trim());
}

/** Validate external HTTP(S) URLs to prevent unsafe protocol injection (e.g. javascript:). */
export function safeExternalUrl(raw?: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function getReadingMinutes(item: KbDocItem): number {
  return item.reading_minutes ?? Math.max(1, Math.round(item.word_count / 350));
}

export function getRelatedTroubleshooting(
  project: ProjectItem,
  catalog: CatalogData,
): TroubleshootingItem[] {
  const tsById = new Map(catalog.troubleshooting.map((t) => [t.id, t]));
  if (Array.isArray(project.related_troubleshooting)) {
    return project.related_troubleshooting
      .map((id) => tsById.get(id))
      .filter((item): item is TroubleshootingItem => Boolean(item));
  }
  return catalog.troubleshooting.filter((ts) =>
    (ts.related_projects || []).includes(project.id),
  );
}

const FALLBACK_SIGNAL_FLOWS: Record<string, string[]> = {
  bootloader: ['CAN 接收', 'W25Q16 暂存', 'EEPROM 提交', 'Flash 搬运跳转'],
  flight: ['MPU6050 采样', '姿态解算', '串级 PID', '混控与 PWM'],
  watch: ['传感器采样', 'IMU 快照', 'LVGL 渲染', 'SPI DMA 刷屏'],
  iwip: ['LAN8720A PHY', 'ETH DMA', 'pbuf 投递', 'TCP/IP 核心'],
  mspm0g3507: ['K230 坐标', 'UART0 组帧', '平衡 PID', 'Emm_V5 回执'],
  'freertos-beginer': ['向量表', 'Reset_Handler', 'SystemInit', 'RTOS 入口'],
};

export function getProjectSignalFlow(project: ProjectItem): string[] {
  if (Array.isArray(project.signal_flow) && project.signal_flow.length >= 2) {
    return project.signal_flow;
  }
  return (
    FALLBACK_SIGNAL_FLOWS[project.id] ||
    project.tech_stack.slice(0, 4)
  );
}

const FALLBACK_TRACKS: ReadingTrackData[] = [
  {
    id: 'rtos-and-bus-ownership',
    title: 'RTOS 并发与外设所有权线',
    summary: '从启动模板出发，比较两端任务调度、任务间快照和 TCP/IP 核心邮箱。',
    steps: [
      { id: 'freertos-beginer', role: '启动模板', focus: '从复位入口和 Keil 分组划出公开源码能证实的范围。' },
      { id: 'flight', role: '周期任务', focus: '对照双端任务周期和飞行任务对 I2C1 的独占访问。' },
      { id: 'watch', role: '快照交接', focus: '沿传感器任务、互斥快照和 LVGL 任务追踪数据交接。' },
      { id: 'iwip', role: '线程边界', focus: '追踪 RX 输入线程如何把 pbuf 交给 lwIP 核心线程。' },
      { id: 'task-and-bus-ownership', role: '机制归纳', focus: '用任务、总线和共享状态三个维度检查执行边界。' },
    ],
  },
  {
    id: 'reliable-streams-and-updates',
    title: '可靠串流与固件升级线',
    summary: '追踪 DMA/CAN 分片重组、外部 Flash 暂存、EEPROM 提交和掉电恢复。',
    steps: [
      { id: 'embedded-stream-framing', role: '组帧模型', focus: '比较长度、结束符和校验各自提供的消息边界。' },
      { id: 'bootloader', role: '更新实现', focus: '从 CAN 接收追到外部暂存、复位搬运和向量检查。' },
      { id: 'ADR-0001-stage-image-before-boot', role: '架构决策', focus: '对照 EEPROM 状态与片内 Flash 擦写阶段理解恢复路径。' },
      { id: 'TS-0001-bootloader-update-phase', role: '实板定位', focus: '用接收日志、外部元数据和目标向量判断故障停在哪一阶段。' },
    ],
  },
  {
    id: 'sensor-feedback-and-diagnostics',
    title: '传感器反馈与实板排障线',
    summary: '对照采样时基、坐标单位和有效标志，定位视觉控制异常与手表冷启动延迟。',
    steps: [
      { id: 'sensor-feedback-pipeline', role: '反馈模型', focus: '梳理源数据、有效性、时间基准和执行器输出的关系。' },
      { id: 'mspm0g3507', role: '控制实现', focus: '从 K230 像素追踪到毫度目标与 Emm_V5 位置命令。' },
      { id: 'TS-0004-k230-vision-timeout', role: '视觉排查', focus: '分开观察合法无球、帧超时和电机回执。' },
      { id: 'TS-0002-watch-startup-latency', role: '启动排查', focus: '分别测量首帧提交、DMA 完成和采样就绪。' },
    ],
  },
];

export function getReadingTracks(catalog: CatalogData): ReadingTrackData[] {
  if (Array.isArray(catalog.reading_tracks) && catalog.reading_tracks.length > 0) {
    return catalog.reading_tracks;
  }
  return FALLBACK_TRACKS;
}

const VALID_BACKDROP_PRESETS = new Set<BackdropPresetId>(['blueprint', 'vellum', 'aurora']);
const VALID_BACKDROP_MOTIFS = new Set<BackdropMotif>([
  'atlas',
  'control',
  'bus',
  'network',
  'rtos',
  'ledger',
  'probe',
  'index',
]);
const VALID_BACKDROP_TONES = new Set<BackdropTone>([
  'sky',
  'mint',
  'amber',
  'rose',
  'violet',
  'teal',
]);

export const FALLBACK_BACKDROP_PRESETS: BackdropPresetEntry[] = [
  {
    id: 'blueprint',
    label: '蓝图晨光',
    summary: '日光矿雾渐变底色 + 双尺度精密工程坐标格与外侧 PCB 走线底纹',
    default: true,
  },
  {
    id: 'vellum',
    label: '暖纸手记',
    summary: '晨光象牙暖纸 + 柔点格与细纸纹，适配工程师手记长文阅读',
  },
  {
    id: 'aurora',
    label: '晴空微光',
    summary: '轻盈天青、浅薰衣草与薄荷日光柔彩光晕 + 细密坐标点阵',
  },
];

export function getBackdropPresets(catalog?: CatalogData): BackdropPresetEntry[] {
  if (Array.isArray(catalog?.backdrop_presets) && catalog.backdrop_presets.length > 0) {
    const valid = catalog.backdrop_presets.filter(
      (entry): entry is BackdropPresetEntry =>
        Boolean(
          entry &&
            VALID_BACKDROP_PRESETS.has(entry.id) &&
            typeof entry.label === 'string' &&
            entry.label.trim().length > 0,
        ),
    );
    if (valid.length > 0) {
      return valid;
    }
  }
  return FALLBACK_BACKDROP_PRESETS;
}

export function getDefaultBackdropPreset(catalog?: CatalogData): BackdropPresetId {
  const presets = getBackdropPresets(catalog);
  return presets.find((p) => p.default)?.id || presets[0]?.id || 'blueprint';
}

export const BACKDROP_MOTIF_LABELS: Record<BackdropMotif, string> = {
  atlas: 'ATLAS · DAYLIGHT GRID',
  control: 'CTRL · TELEMETRY ARC',
  bus: 'BUS · PCB TRACE',
  network: 'NET · PACKET LATTICE',
  rtos: 'RTOS · TASK LANES',
  ledger: 'ADR · VELLUM LEDGER',
  probe: 'TS · PROBE BENCH',
  index: 'IDX · SIGNAL MATRIX',
};

/**
 * Resolve contextual backdrop motif & daylight tint for any page.
 * Prefers backend-emitted `doc.backdrop` from `data/catalog.json`, falling back
 * deterministically to document type, hardware domain, and route role.
 */
export function getPageBackdrop(
  doc?: KbDocItem,
  cleanRouteKey = '',
): PageBackdropMeta {
  const backend = doc?.backdrop;
  if (
    backend &&
    VALID_BACKDROP_MOTIFS.has(backend.motif) &&
    VALID_BACKDROP_TONES.has(backend.tone)
  ) {
    return backend;
  }

  if (!doc) {
    if (cleanRouteKey === 'graph' || cleanRouteKey === 'evidence' || cleanRouteKey === 'diagrams') {
      return { motif: 'index', tone: 'teal' };
    }
    return { motif: 'atlas', tone: 'sky' };
  }

  if (doc.type === 'project') {
    const id = doc.id.toLowerCase();
    const domains = (doc.domains || []).map((d) => d.toLowerCase());
    const stack = (doc.tech_stack || []).join(' ').toLowerCase();
    if (domains.includes('networking') || id === 'iwip' || /\blwip\b|ethernet|rmii/.test(stack)) {
      return { motif: 'network', tone: 'teal' };
    }
    if (id === 'bootloader' || /\bcan\b|w25q|eeprom|bootloader/.test(stack)) {
      return { motif: 'bus', tone: 'amber' };
    }
    if (id === 'flight' || id === 'mspm0g3507' || /mpu6050|k230|pid/.test(stack)) {
      return { motif: 'control', tone: 'sky' };
    }
    return { motif: 'rtos', tone: 'mint' };
  }

  if (doc.type === 'topic') {
    return doc.domain === 'networking'
      ? { motif: 'network', tone: 'teal' }
      : { motif: 'index', tone: 'mint' };
  }

  if (doc.type === 'adr') {
    return { motif: 'ledger', tone: 'amber' };
  }

  if (doc.type === 'troubleshooting') {
    return { motif: 'probe', tone: 'rose' };
  }

  return { motif: 'atlas', tone: 'violet' };
}

function readJson<T>(relativePath: string): T {
  const fullPath = path.join(REPO_ROOT, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as T;
}

let cachedBundle: {
  catalog: CatalogData;
  graph: GraphData;
  stats: StatsData;
  allItems: KbDocItem[];
  byId: Map<string, KbDocItem>;
  byRouteKey: Map<string, KbDocItem>;
  neighborsById: Map<string, NeighborRelation[]>;
} | null = null;

export function loadKbData() {
  if (cachedBundle && import.meta.env.PROD) {
    return cachedBundle;
  }

  const catalog = readJson<CatalogData>('data/catalog.json');
  const graph = readJson<GraphData>('data/graph.json');
  const stats = readJson<StatsData>('data/stats.json');

  const allItems: KbDocItem[] = [
    ...catalog.projects,
    ...catalog.topics,
    ...catalog.adrs,
    ...catalog.troubleshooting,
    ...catalog.synthesis,
  ];
  const byId = new Map<string, KbDocItem>(allItems.map((item) => [item.id, item]));
  const byRouteKey = new Map<string, KbDocItem>(
    allItems.map((item) => [normalizeDocKey(item.route), item]),
  );

  // Aggregate neighbor relationships with edge kind & direction
  const rawMap = new Map<
    string,
    Map<string, { kinds: Set<'frontmatter' | 'wikilink'>; out: boolean; in: boolean }>
  >();

  const ensurePair = (a: string, b: string) => {
    if (!rawMap.has(a)) rawMap.set(a, new Map());
    const inner = rawMap.get(a)!;
    if (!inner.has(b)) {
      inner.set(b, { kinds: new Set(), out: false, in: false });
    }
    return inner.get(b)!;
  };

  for (const edge of graph.edges || []) {
    if (edge.source === edge.target) continue;
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const forward = ensurePair(edge.source, edge.target);
    forward.kinds.add(edge.kind);
    forward.out = true;

    const backward = ensurePair(edge.target, edge.source);
    backward.kinds.add(edge.kind);
    backward.in = true;
  }

  const typeOrder: Record<KbDocItem['type'], number> = {
    project: 0,
    topic: 1,
    adr: 2,
    troubleshooting: 3,
    synthesis: 4,
  };

  const neighborsById = new Map<string, NeighborRelation[]>();
  for (const [id, map] of rawMap.entries()) {
    const list: NeighborRelation[] = [];
    for (const [otherId, info] of map.entries()) {
      const other = byId.get(otherId);
      if (!other) continue;
      list.push({
        item: other,
        kinds: Array.from(info.kinds).sort(),
        direction: info.out && info.in ? 'both' : info.out ? 'out' : 'in',
      });
    }
    list.sort((a, b) => {
      const sA = a.kinds.includes('frontmatter') ? 0 : 1;
      const sB = b.kinds.includes('frontmatter') ? 0 : 1;
      return (
        sA - sB ||
        typeOrder[a.item.type] - typeOrder[b.item.type] ||
        a.item.id.localeCompare(b.item.id)
      );
    });
    neighborsById.set(id, list);
  }

  const bundle = {
    catalog,
    graph,
    stats,
    allItems,
    byId,
    byRouteKey,
    neighborsById,
  };

  if (import.meta.env.PROD) {
    cachedBundle = bundle;
  }
  return bundle;
}

const rawSourceCache = new Map<string, string>();

function readSourceMarkdown(sourcePath: string): string {
  if (import.meta.env.PROD && rawSourceCache.has(sourcePath)) {
    return rawSourceCache.get(sourcePath)!;
  }
  const fullPath = path.join(REPO_ROOT, sourcePath);
  const content = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
  if (import.meta.env.PROD) {
    rawSourceCache.set(sourcePath, content);
  }
  return content;
}

/**
 * Resolve all fixed-SHA source evidence links across published docs.
 * Prefers structured `item.evidence_links` emitted by the backend index pipeline,
 * falling back to read-only Markdown extraction until the backend upgrade lands.
 */
export function getEvidenceCatalog(bundle = loadKbData()) {
  const repoToProjectId = new Map<string, string>(
    bundle.catalog.projects.map((p) => [p.repo.toLowerCase(), p.id]),
  );

  const items: ResolvedEvidenceItem[] = [];
  let fromBackend = false;

  for (const doc of bundle.allItems) {
    let rawLinks: EvidenceLinkEntry[];
    if (Array.isArray(doc.evidence_links)) {
      fromBackend = true;
      rawLinks = doc.evidence_links;
    } else {
      const md = readSourceMarkdown(doc.source_path);
      rawLinks = md ? extractEvidenceLinks(md, repoToProjectId) : [];
    }

    for (const entry of rawLinks) {
      const safeUrl = safeExternalUrl(entry.url);
      if (!safeUrl || !isCommitSha(entry.commit)) continue;
      const projectId =
        entry.project_id || repoToProjectId.get(entry.repo.toLowerCase()) || undefined;
      const baseHref = withDocRoute(doc.route);
      const docHref = entry.section_slug ? `${baseHref}#${entry.section_slug}` : baseHref;
      items.push({
        ...entry,
        url: safeUrl,
        ...(projectId ? { project_id: projectId } : {}),
        doc_id: doc.id,
        doc_title: doc.title,
        doc_type: doc.type,
        doc_route: doc.route,
        doc_href: docHref,
      });
    }
  }

  return { items, fromBackend };
}

/**
 * Resolve all top-level Mermaid diagrams across published docs.
 * Prefers structured `item.diagrams` emitted by the backend index pipeline,
 * falling back to read-only Markdown extraction until the backend upgrade lands.
 */
export function getDiagramCatalog(bundle = loadKbData()) {
  const items: ResolvedDiagramItem[] = [];
  let fromBackend = false;

  for (const doc of bundle.allItems) {
    let rawDiagrams: DiagramEntry[];
    if (Array.isArray(doc.diagrams)) {
      fromBackend = true;
      rawDiagrams = doc.diagrams;
    } else {
      const md = readSourceMarkdown(doc.source_path);
      rawDiagrams = md ? extractDiagrams(md, doc.title) : [];
    }

    const relatedProjects =
      doc.type === 'project' ? [doc.id] : doc.related_projects || [];

    for (const entry of rawDiagrams) {
      if (!entry.source?.trim()) continue;
      const baseHref = withDocRoute(doc.route);
      const docHref = entry.section_slug ? `${baseHref}#${entry.section_slug}` : baseHref;
      items.push({
        ...entry,
        doc_id: doc.id,
        doc_title: doc.title,
        doc_type: doc.type,
        doc_route: doc.route,
        doc_href: docHref,
        doc_tags: doc.tags || [],
        related_projects: relatedProjects,
      });
    }
  }

  return { items, fromBackend };
}
