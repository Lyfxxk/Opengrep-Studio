import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbPath } from './config.js';
import type { PackManifest } from './pack-format.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type ComparisonStatus = 'new' | 'fixed' | 'remaining';
type ScanStatus = 'scanning' | 'completed' | 'failed';

/** 规则包引用快照（扫描发起时落库，之后配置变更不影响历史展示） */
export interface RulePackRef {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  language: string;
  createdAt: string;
  baselineScanId?: string;
  configId?: string;
  /** 最近一次上传源码的语言分布（语言 → 字节数），上传时覆盖 */
  languageStats?: Record<string, number>;
}

export interface ScanConfig {
  id: string;
  name: string;
  description?: string;
  rulePackIds: string[];
  excludes: string[];
  includes: string[];
  timeoutSeconds: number;
  jobs: number;
  maxTargetBytes: number;
  createdAt: string;
}

export interface RulePack {
  id: string;
  name: string;
  language: string;
  builtin: boolean;
  enabled: boolean;
  ruleCount: number;
  createdAt: string;
  /** 可移植格式清单（目录包必有；单文件包为空） */
  version?: string;
  manifest?: PackManifest | null;
  /** 样本文件总数（正例 + 反例） */
  sampleCount?: number;
  /** 目录式包（可移植格式），单文件包为 false */
  isDir?: boolean;
  /** 最近一次质量检查结果摘要 */
  lastCheck?: PackCheckSummary | null;
}

export interface PackCheckSummary {
  tier: 'verified' | 'basic';
  passed: number;
  failed: number;
  errors: number;
  unverified: number;
  checkedAt: string;
}

export interface ScanRecord {
  id: string;
  projectId: string;
  status: ScanStatus;
  issueCount: number;
  scannedAt: string;
  finishedAt?: string;
  baselineScanId?: string;
  rules?: string;
  /** 本次扫描实际生效的规则包快照（旧记录 / 旧式目录扫描无此字段） */
  rulepacks?: RulePackRef[];
  /** 本次扫描覆盖的源码文件数（不含 node_modules / .git） */
  fileCount: number;
  message?: string;
  /** 源码快照 SHA-256（对排序后的"相对路径\0文件内容"序列计算），可复现清单用 */
  srcHash?: string;
  /** 发起扫描时的完整引擎命令行（不含引擎二进制绝对路径以外的环境） */
  commandLine?: string;
  /** 发起扫描时的规则/配置快照（规则文件哈希 + 引擎参数），可复现清单用 */
  configSnapshot?: ScanConfigSnapshot;
  /** 发起扫描时的引擎版本（升级引擎后旧记录仍保留当日版本，报告与可复现清单不失真） */
  engineVersion?: string;
}

/** 扫描发起时的规则与引擎参数快照（manifest.json 的组成部分） */
export interface ScanConfigSnapshot {
  rulesLabel: string;
  rulepacks: RulePackRef[];
  ruleFiles: Array<{ file: string; sha256: string }>;
  excludes: string[];
  includes: string[];
  timeoutSeconds: number;
  jobs: number;
  maxTargetBytes: number;
}

export interface Issue {
  id: string;
  scanId: string;
  severity: Severity;
  comparisonStatus: ComparisonStatus;
  ruleId: string;
  message: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** 命中规则所属的规则包（快照，旧记录可能没有） */
  rulepackId?: string;
  rulepackName?: string;
  /** 污点传播链（taint 规则命中才有，JSON 序列化的 TaintStep[]，旧记录没有） */
  dataflowTrace?: string;
}

export interface IssueRow extends Issue {
  fingerprint: string;
  matchedLines?: string;
}

/** 「当前存在」问题的统一口径：已修复（fixed）不计入现存统计（issueCount / 报告 / 列表共用） */
export function isActiveIssue(issue: IssueRow): boolean {
  return issue.comparisonStatus !== 'fixed';
}

export type ReviewStatus = 'pending' | 'confirmed' | 'false_positive' | 'accepted';

/** 人工复核记录：以 (project_id, fingerprint) 为键，跨扫描继承 */
export interface Review {
  projectId: string;
  fingerprint: string;
  status: ReviewStatus;
  reason?: string;
  reviewer?: string;
  updatedAt: string;
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const db = new DatabaseSync(dbPath);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  language TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  baseline_scan_id TEXT,
  config_id TEXT,
  language_stats TEXT
);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  issue_count INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT NOT NULL,
  finished_at TEXT,
  file_count INTEGER,
  baseline_scan_id TEXT,
  rules TEXT,
  rulepacks TEXT,
  message TEXT,
  src_hash TEXT,
  command_line TEXT,
  config_snapshot TEXT,
  engine_version TEXT
);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  comparison_status TEXT NOT NULL DEFAULT 'remaining',
  matched_lines TEXT,
  dataflow_trace TEXT,
  rulepack_id TEXT,
  rulepack_name TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  project_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  reviewer TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_scans_project ON scans(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_scan ON issues(scan_id);

CREATE TABLE IF NOT EXISTS configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rule_pack_ids TEXT NOT NULL,
  excludes TEXT NOT NULL,
  includes TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL DEFAULT 5,
  jobs INTEGER NOT NULL DEFAULT 4,
  max_target_bytes INTEGER NOT NULL DEFAULT 1000000,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rulepacks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  rule_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`);

// 旧库平滑迁移：为 rulepacks 补可移植格式相关列（列已存在时报错忽略）
for (const sql of [
  'ALTER TABLE rulepacks ADD COLUMN version TEXT',
  'ALTER TABLE rulepacks ADD COLUMN manifest TEXT',
  'ALTER TABLE rulepacks ADD COLUMN sample_count INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE rulepacks ADD COLUMN is_dir INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE rulepacks ADD COLUMN last_check TEXT',
  // 扫描可复现清单（8.10）：源码哈希 / 引擎命令行 / 配置快照
  'ALTER TABLE scans ADD COLUMN src_hash TEXT',
  'ALTER TABLE scans ADD COLUMN command_line TEXT',
  'ALTER TABLE scans ADD COLUMN config_snapshot TEXT',
  'ALTER TABLE scans ADD COLUMN engine_version TEXT',
  // 污点路径可视化（P1-6）：taint 命中的 source→sink 传播链快照
  'ALTER TABLE issues ADD COLUMN dataflow_trace TEXT',
]) {
  try {
    db.exec(sql);
  } catch {
  }
}


type SqlRow = Record<string, null | string | number | bigint>;

function str(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value;
}

function parseLanguageStats(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const stats: Record<string, number> = {};
    for (const [key, count] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
        stats[key] = count;
      }
    }
    return Object.keys(stats).length > 0 ? stats : undefined;
  } catch {
    return undefined;
  }
}

function rowToProject(row: SqlRow): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    description: str(row.description as string | null),
    language: String(row.language ?? ''),
    createdAt: String(row.created_at),
    baselineScanId: str(row.baseline_scan_id as string | null),
    configId: str(row.config_id as string | null),
    languageStats: parseLanguageStats(row.language_stats),
  };
}

function parseRulePackRefs(value: unknown): RulePackRef[] | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const refs = parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({ id: String(item.id ?? ''), name: String(item.name ?? '') }))
      .filter((item) => item.id !== '');
    return refs.length > 0 ? refs : undefined;
  } catch {
    return undefined;
  }
}

function rowToScan(row: SqlRow): ScanRecord {
  const snapshotRaw = parseJsonObject(row.config_snapshot);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    status: String(row.status) as ScanStatus,
    issueCount: Number(row.issue_count ?? 0),
    scannedAt: String(row.scanned_at),
    finishedAt: str(row.finished_at as string | null),
    fileCount: Number(row.file_count ?? 0),
    baselineScanId: str(row.baseline_scan_id as string | null),
    rules: str(row.rules as string | null),
    rulepacks: parseRulePackRefs(row.rulepacks),
    message: str(row.message as string | null),
    srcHash: str(row.src_hash as string | null),
    commandLine: str(row.command_line as string | null),
    configSnapshot: snapshotRaw ? (snapshotRaw as unknown as ScanConfigSnapshot) : undefined,
    engineVersion: str(row.engine_version as string | null),
  };
}

function rowToIssueRow(row: SqlRow): IssueRow {
  return {
    id: String(row.id),
    scanId: String(row.scan_id),
    fingerprint: String(row.fingerprint),
    ruleId: String(row.rule_id),
    severity: String(row.severity) as Severity,
    comparisonStatus: String(row.comparison_status) as ComparisonStatus,
    message: String(row.message),
    filePath: String(row.file_path),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    matchedLines: str(row.matched_lines as string | null),
    dataflowTrace: str(row.dataflow_trace as string | null),
    rulepackId: str(row.rulepack_id as string | null),
    rulepackName: str(row.rulepack_name as string | null),
  };
}


export function listProjects(): Project[] {
  const rows = db.prepare('SELECT * FROM projects ORDER BY created_at ASC, id ASC').all() as SqlRow[];
  return rows.map(rowToProject);
}

export function getProject(id: string): Project | undefined {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? rowToProject(row) : undefined;
}

export function insertProject(project: Project): void {
  db.prepare(
    'INSERT INTO projects (id, name, description, language, created_at, baseline_scan_id, config_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    project.id,
    project.name,
    project.description ?? null,
    project.language,
    project.createdAt,
    project.baselineScanId ?? null,
    project.configId ?? null,
  );
}

export function updateProject(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    language?: string;
    baselineScanId?: string | null;
    configId?: string | null;
    languageStats?: Record<string, number> | null;
  },
): void {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
  if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description); }
  if (patch.language !== undefined) { sets.push('language = ?'); values.push(patch.language); }
  if (patch.baselineScanId !== undefined) { sets.push('baseline_scan_id = ?'); values.push(patch.baselineScanId); }
  if (patch.configId !== undefined) { sets.push('config_id = ?'); values.push(patch.configId); }
  if (patch.languageStats !== undefined) {
    sets.push('language_stats = ?');
    values.push(patch.languageStats ? JSON.stringify(patch.languageStats) : null);
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteProject(id: string): void {
  db.prepare('DELETE FROM issues WHERE scan_id IN (SELECT id FROM scans WHERE project_id = ?)').run(id);
  db.prepare('DELETE FROM scans WHERE project_id = ?').run(id);
  deleteProjectReviews(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}


export function getScan(id: string): ScanRecord | undefined {
  const row = db.prepare('SELECT * FROM scans WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? rowToScan(row) : undefined;
}

export function listScans(projectId: string): ScanRecord[] {
  const rows = db
    .prepare('SELECT * FROM scans WHERE project_id = ? ORDER BY scanned_at DESC, id DESC')
    .all(projectId) as SqlRow[];
  return rows.map(rowToScan);
}

/** 全量扫描列表（双快照对比的候选池，含跨项目来源） */
export function listAllScans(limit = 200): ScanRecord[] {
  const rows = db
    .prepare('SELECT * FROM scans ORDER BY scanned_at DESC, id DESC LIMIT ?')
    .all(limit) as SqlRow[];
  return rows.map(rowToScan);
}

export function insertScan(scan: ScanRecord): void {
  db.prepare(
    'INSERT INTO scans (id, project_id, status, issue_count, scanned_at, finished_at, file_count, baseline_scan_id, rules, rulepacks, message, src_hash, command_line, config_snapshot, engine_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    scan.id,
    scan.projectId,
    scan.status,
    scan.issueCount,
    scan.scannedAt,
    scan.finishedAt ?? null,
    scan.fileCount || null,
    scan.baselineScanId ?? null,
    scan.rules ?? null,
    scan.rulepacks?.length ? JSON.stringify(scan.rulepacks) : null,
    scan.message ?? null,
    scan.srcHash ?? null,
    scan.commandLine ?? null,
    scan.configSnapshot ? JSON.stringify(scan.configSnapshot) : null,
    scan.engineVersion ?? null,
  );
}

export function updateScan(id: string, patch: Partial<Omit<ScanRecord, 'id' | 'projectId'>>): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
  if (patch.issueCount !== undefined) { sets.push('issue_count = ?'); values.push(patch.issueCount); }
  if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); values.push(patch.finishedAt ?? null); }
  if (patch.fileCount !== undefined) { sets.push('file_count = ?'); values.push(patch.fileCount || null); }
  if (patch.message !== undefined) { sets.push('message = ?'); values.push(patch.message ?? null); }
  if (patch.srcHash !== undefined) { sets.push('src_hash = ?'); values.push(patch.srcHash ?? null); }
  if (patch.commandLine !== undefined) { sets.push('command_line = ?'); values.push(patch.commandLine ?? null); }
  if (patch.engineVersion !== undefined) { sets.push('engine_version = ?'); values.push(patch.engineVersion ?? null); }
  if (patch.configSnapshot !== undefined) {
    sets.push('config_snapshot = ?');
    values.push(patch.configSnapshot ? JSON.stringify(patch.configSnapshot) : null);
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE scans SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}


const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function listIssues(scanId: string): IssueRow[] {
  const rows = db.prepare('SELECT * FROM issues WHERE scan_id = ?').all(scanId) as SqlRow[];
  return rows
    .map(rowToIssueRow)
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine,
    );
}

export function getIssue(id: string): IssueRow | undefined {
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? rowToIssueRow(row) : undefined;
}

export function replaceIssues(scanId: string, issues: IssueRow[]): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM issues WHERE scan_id = ?').run(scanId);
    const insert = db.prepare(
      'INSERT INTO issues (scan_id, fingerprint, rule_id, severity, message, file_path, start_line, end_line, comparison_status, matched_lines, dataflow_trace, rulepack_id, rulepack_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const issue of issues) {
      insert.run(
        issue.scanId,
        issue.fingerprint,
        issue.ruleId,
        issue.severity,
        issue.message,
        issue.filePath,
        issue.startLine,
        issue.endLine,
        issue.comparisonStatus,
        issue.matchedLines ?? null,
        issue.dataflowTrace ?? null,
        issue.rulepackId ?? null,
        issue.rulepackName ?? null,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}


function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function rowToConfig(row: SqlRow): ScanConfig {
  return {
    id: String(row.id),
    name: String(row.name),
    description: str(row.description as string | null),
    rulePackIds: parseJsonArray(row.rule_pack_ids),
    excludes: parseJsonArray(row.excludes),
    includes: parseJsonArray(row.includes),
    timeoutSeconds: Number(row.timeout_seconds ?? 5),
    jobs: Number(row.jobs ?? 4),
    maxTargetBytes: Number(row.max_target_bytes ?? 1000000),
    createdAt: String(row.created_at),
  };
}

export function listConfigs(): ScanConfig[] {
  const rows = db
    .prepare('SELECT * FROM configs ORDER BY created_at DESC, id DESC')
    .all() as SqlRow[];
  return rows.map(rowToConfig);
}

export function getConfig(id: string): ScanConfig | undefined {
  const row = db.prepare('SELECT * FROM configs WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? rowToConfig(row) : undefined;
}

export function insertConfig(config: ScanConfig): void {
  db.prepare(
    'INSERT INTO configs (id, name, description, rule_pack_ids, excludes, includes, timeout_seconds, jobs, max_target_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    config.id,
    config.name,
    config.description ?? null,
    JSON.stringify(config.rulePackIds),
    JSON.stringify(config.excludes),
    JSON.stringify(config.includes),
    config.timeoutSeconds,
    config.jobs,
    config.maxTargetBytes,
    config.createdAt,
  );
}

export function updateConfig(
  id: string,
  patch: Partial<Omit<ScanConfig, 'id' | 'createdAt'>>,
): void {
  const existing = getConfig(id);
  if (!existing) return;
  const next: ScanConfig = { ...existing, ...patch };
  db.prepare(
    'UPDATE configs SET name = ?, description = ?, rule_pack_ids = ?, excludes = ?, includes = ?, timeout_seconds = ?, jobs = ?, max_target_bytes = ? WHERE id = ?',
  ).run(
    next.name,
    next.description ?? null,
    JSON.stringify(next.rulePackIds),
    JSON.stringify(next.excludes),
    JSON.stringify(next.includes),
    next.timeoutSeconds,
    next.jobs,
    next.maxTargetBytes,
    id,
  );
}

export function deleteConfig(id: string): void {
  db.prepare('DELETE FROM configs WHERE id = ?').run(id);
  db.prepare('UPDATE projects SET config_id = NULL WHERE config_id = ?').run(id);
}


function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function rowToRulePack(row: SqlRow): RulePack {
  const manifestRaw = parseJsonObject(row.manifest);
  const checkRaw = parseJsonObject(row.last_check);
  return {
    id: String(row.id),
    name: String(row.name),
    language: String(row.language),
    builtin: Number(row.builtin) === 1,
    enabled: Number(row.enabled) === 1,
    ruleCount: Number(row.rule_count ?? 0),
    createdAt: String(row.created_at),
    version: str(row.version as string | null),
    manifest: manifestRaw
      ? {
          name: String(manifestRaw.name ?? ''),
          version: String(manifestRaw.version ?? ''),
          description: typeof manifestRaw.description === 'string' ? manifestRaw.description : undefined,
          descriptionEn: typeof manifestRaw.descriptionEn === 'string' ? manifestRaw.descriptionEn : undefined,
          author: typeof manifestRaw.author === 'string' ? manifestRaw.author : undefined,
          license: typeof manifestRaw.license === 'string' ? manifestRaw.license : undefined,
          frameworks: Array.isArray(manifestRaw.frameworks) ? manifestRaw.frameworks.map(String) : [],
          cwe: Array.isArray(manifestRaw.cwe) ? manifestRaw.cwe.map(String) : [],
          owasp: Array.isArray(manifestRaw.owasp) ? manifestRaw.owasp.map(String) : [],
          changelog: typeof manifestRaw.changelog === 'string' ? manifestRaw.changelog : undefined,
        }
      : null,
    sampleCount: Number(row.sample_count ?? 0),
    isDir: Number(row.is_dir ?? 0) === 1,
    lastCheck: checkRaw
      ? {
          tier: checkRaw.tier === 'verified' ? 'verified' : 'basic',
          passed: Number(checkRaw.passed ?? 0),
          failed: Number(checkRaw.failed ?? 0),
          errors: Number(checkRaw.errors ?? 0),
          unverified: Number(checkRaw.unverified ?? 0),
          checkedAt: String(checkRaw.checkedAt ?? ''),
        }
      : null,
  };
}

export function listRulePacks(): RulePack[] {
  const rows = db
    .prepare('SELECT * FROM rulepacks ORDER BY builtin DESC, created_at DESC, id DESC')
    .all() as SqlRow[];
  return rows.map(rowToRulePack);
}

export function getRulePack(id: string): RulePack | undefined {
  const row = db.prepare('SELECT * FROM rulepacks WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? rowToRulePack(row) : undefined;
}

export function insertRulePack(pack: RulePack): void {
  db.prepare(
    'INSERT INTO rulepacks (id, name, language, builtin, enabled, rule_count, created_at, version, manifest, sample_count, is_dir, last_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    pack.id,
    pack.name,
    pack.language,
    pack.builtin ? 1 : 0,
    pack.enabled ? 1 : 0,
    pack.ruleCount,
    pack.createdAt,
    pack.version ?? null,
    pack.manifest ? JSON.stringify(pack.manifest) : null,
    pack.sampleCount ?? 0,
    pack.isDir ? 1 : 0,
    pack.lastCheck ? JSON.stringify(pack.lastCheck) : null,
  );
}

export function updateRulePack(
  id: string,
  patch: {
    enabled?: boolean;
    ruleCount?: number;
    name?: string;
    language?: string;
    version?: string;
    manifest?: PackManifest | null;
    sampleCount?: number;
    isDir?: boolean;
    lastCheck?: PackCheckSummary | null;
  },
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); values.push(patch.enabled ? 1 : 0); }
  if (patch.ruleCount !== undefined) { sets.push('rule_count = ?'); values.push(patch.ruleCount); }
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
  if (patch.language !== undefined) { sets.push('language = ?'); values.push(patch.language); }
  if (patch.version !== undefined) { sets.push('version = ?'); values.push(patch.version || null); }
  if (patch.manifest !== undefined) {
    sets.push('manifest = ?');
    values.push(patch.manifest ? JSON.stringify(patch.manifest) : null);
  }
  if (patch.sampleCount !== undefined) { sets.push('sample_count = ?'); values.push(patch.sampleCount); }
  if (patch.isDir !== undefined) { sets.push('is_dir = ?'); values.push(patch.isDir ? 1 : 0); }
  if (patch.lastCheck !== undefined) {
    sets.push('last_check = ?');
    values.push(patch.lastCheck ? JSON.stringify(patch.lastCheck) : null);
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE rulepacks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteRulePack(id: string): void {
  db.prepare('DELETE FROM rulepacks WHERE id = ?').run(id);
  const configs = listConfigs();
  for (const config of configs) {
    if (config.rulePackIds.includes(id)) {
      updateConfig(config.id, {
        rulePackIds: config.rulePackIds.filter((item) => item !== id),
      });
    }
  }
}


function rowToReview(row: SqlRow): Review {
  return {
    projectId: String(row.project_id),
    fingerprint: String(row.fingerprint),
    status: String(row.status) as ReviewStatus,
    reason: str(row.reason as string | null),
    reviewer: str(row.reviewer as string | null),
    updatedAt: String(row.updated_at),
  };
}

export function upsertReview(review: Review): void {
  db.prepare(
    `INSERT INTO reviews (project_id, fingerprint, status, reason, reviewer, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, fingerprint) DO UPDATE SET
       status = excluded.status, reason = excluded.reason,
       reviewer = excluded.reviewer, updated_at = excluded.updated_at`,
  ).run(
    review.projectId,
    review.fingerprint,
    review.status,
    review.reason ?? null,
    review.reviewer ?? null,
    review.updatedAt,
  );
}

export function listReviews(projectId: string): Review[] {
  const rows = db
    .prepare('SELECT * FROM reviews WHERE project_id = ? ORDER BY updated_at DESC')
    .all(projectId) as SqlRow[];
  return rows.map(rowToReview);
}

export function deleteReview(projectId: string, fingerprint: string): void {
  db.prepare('DELETE FROM reviews WHERE project_id = ? AND fingerprint = ?').run(
    projectId,
    fingerprint,
  );
}

function deleteProjectReviews(projectId: string): void {
  db.prepare('DELETE FROM reviews WHERE project_id = ?').run(projectId);
}
