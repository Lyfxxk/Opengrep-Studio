import { createHash, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  config,
  scanSourceDir,
} from './config.js';
import {
  engineInstallHint,
  engineInstallHintInfo,
  engineNotRunnableHint,
  engineNotRunnableHintInfo,
  getEngineVersion,
  runEngine,
} from './engine.js';
import { relativizeToRoot, stripRuleIdPrefix } from './fs-walk.js';
import { extractTaintFlow, relativizeTaintFlow } from './taint.js';
import {
  db,
  getScan,
  isActiveIssue,
  listIssues,
  replaceIssues,
  updateScan,
  type IssueRow,
  type ScanConfigSnapshot,
  type ScanRecord,
  type Severity,
} from './db.js';

export class ScanError extends Error {
  constructor(
    public code: string,
    message: string,
    public params?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ScanPlan {
  rulesLabel: string;
  configFiles: string[];
  rulepacks?: Array<{ id: string; name: string }>;
  filePacks?: Record<string, { id: string; name: string }>;
  timeoutSeconds: number;
  jobs: number;
  maxTargetBytes: number;
  excludes: string[];
  includes: string[];
}


const MAX_CONCURRENT_SCANS = 2;
let activeScans = 0;
const scanWaitQueue: Array<() => void> = [];

const INSTANCE_TOKEN = randomUUID();
const INSTANCE_HEARTBEAT_MS = 15_000;
const INSTANCE_STALE_MS = 60_000;

function touchScanInstance(): void {
  db.prepare(
    'INSERT INTO scan_instances (token, last_seen) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET last_seen = excluded.last_seen',
  ).run(INSTANCE_TOKEN, new Date().toISOString());
}

touchScanInstance();
setInterval(() => {
  try {
    touchScanInstance();
  } catch (error) {
    console.error('[scan-runner] 实例心跳写入失败，跳过本轮:', error);
  }
}, INSTANCE_HEARTBEAT_MS).unref();

export function getScanInstanceToken(): string {
  return INSTANCE_TOKEN;
}

function acquireScanSlot(): { queued: boolean; ready: Promise<void> } {
  if (activeScans < MAX_CONCURRENT_SCANS) {
    activeScans += 1;
    return { queued: false, ready: Promise.resolve() };
  }
  return { queued: true, ready: new Promise((resolve) => scanWaitQueue.push(resolve)) };
}

function releaseScanSlot(): void {
  const next = scanWaitQueue.shift();
  if (next) next();
  else activeScans -= 1;
}

const runningEngines = new Map<string, ChildProcess>();

const cancelRequested = new Set<string>();

export function requestScanCancel(scanId: string): boolean {
  const child = runningEngines.get(scanId);
  if (!child) return false;
  cancelRequested.add(scanId);
  if (child.exitCode !== null || child.signalCode !== null) return true;
  child.kill();
  return true;
}

export function enqueueScan(scanId: string, plan: ScanPlan): void {
  const slot = acquireScanSlot();
  void slot.ready
    .then(() => {
      const current = getScan(scanId);
      if (!current || current.status !== 'scanning') return;
      if (slot.queued) {
        updateScan(scanId, {
          queuedAt: null,
          dequeuedAt: new Date().toISOString(),
        });
      }
      return runScan(scanId, plan);
    })
    .catch((error) => {
      console.error(`[scan-runner] 扫描 ${scanId} 执行异常:`, error);
    })
    .finally(() => {
      cancelRequested.delete(scanId);
      releaseScanSlot();
    });
  if (slot.queued) {
    try {
      updateScan(scanId, { queuedAt: new Date().toISOString(), queueOwner: INSTANCE_TOKEN });
    } catch (error) {
      console.error(`[scan-runner] 扫描 ${scanId} 排队标记写入失败:`, error);
    }
  }
}


interface OpengrepFinding {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  extra: {
    message: string;
    severity: string;
    fingerprint?: string;
    lines?: string;
    dataflow_trace?: unknown;
    metadata?: Record<string, unknown>;
  };
}

interface OpengrepOutput {
  version?: string;
  results?: OpengrepFinding[];
  errors?: Array<{ level?: string; message?: string }>;
}

function mapSeverity(finding: OpengrepFinding): Severity {
  const score = Number(finding.extra.metadata?.['security-severity'] ?? 0);
  if (Number.isFinite(score) && score >= 9) return 'critical';
  switch (finding.extra.severity) {
    case 'ERROR': return 'high';
    case 'WARNING': return 'medium';
    default: return 'low';
  }
}

function collectRuleIdsByFile(configFiles: string[]): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const file of configFiles) {
    const ids = new Set<string>();
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/^\s*-\s+id:\s*(\S+)/gm)) {
        ids.add(match[1]);
      }
    } catch {
    }
    byFile.set(file, ids);
  }
  return byFile;
}


export function hasRunningScan(): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM scans WHERE status = 'scanning'").get() as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0) > 0;
}

const STALE_SCAN_GRACE_MS = 2 * 60 * 1000;

function reapOrphanedQueuedScans(): void {
  const aliveCutoff = new Date(Date.now() - INSTANCE_STALE_MS).toISOString();
  const runCutoff = new Date(Date.now() - (config.scanTimeoutMs + STALE_SCAN_GRACE_MS)).toISOString();
  const rows = db.prepare(
    `SELECT id, queued_at, started_at, dequeued_at FROM scans
     WHERE status = 'scanning'
       AND (queue_owner IS NULL OR queue_owner NOT IN (
         SELECT token FROM scan_instances WHERE last_seen >= ?
       ))
       AND (queued_at IS NOT NULL
         OR COALESCE(started_at, dequeued_at, scanned_at) < ?)`,
  ).all(aliveCutoff, runCutoff) as Array<{ id: string }>;
  for (const row of rows) {
    updateScan(row.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      message: '服务重启导致扫描中断，请重新发起',
      errorCode: 'scan.interrupted',
      queuedAt: null,
      queueOwner: null,
    });
  }
  db.prepare('DELETE FROM scan_instances WHERE last_seen < ?').run(
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  );
}

setInterval(() => {
  try {
    reapOrphanedQueuedScans();
  } catch (error) {
    console.error('[scan-runner] 孤儿扫描清理失败，跳过本轮:', error);
  }
}, 30_000).unref();

export function markStaleScansFailed(): void {
  reapOrphanedQueuedScans();
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const walk = async (current: string) => {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) count += 1;
    }
  };
  await walk(dir);
  return count;
}

export function applyBaselineComparison(
  issues: IssueRow[],
  scanId: string,
  baselineScanId: string | undefined,
): void {
  if (!baselineScanId) return;
  const baselineIssues = listIssues(baselineScanId).filter((issue) => issue.comparisonStatus !== 'fixed');
  const baselineFps = new Map(baselineIssues.map((issue) => [issue.fingerprint, issue]));
  const currentFps = new Set(issues.map((issue) => issue.fingerprint));
  for (const issue of issues) {
    issue.comparisonStatus = baselineFps.has(issue.fingerprint) ? 'remaining' : 'new';
  }
  const seen = new Set<string>();
  for (const issue of baselineIssues) {
    if (currentFps.has(issue.fingerprint) || seen.has(issue.fingerprint)) continue;
    seen.add(issue.fingerprint);
    issues.push({
      ...issue,
      id: '',
      scanId,
      comparisonStatus: 'fixed',
      matchedLines: issue.matchedLines,
    });
  }
}

export const MAX_PATH_FILTER_GLOBSTARS = 4;

function expandGlobstarSegments(pattern: string): string[] {
  const idx = pattern.indexOf('**/');
  if (idx === -1) return [pattern];
  if ((pattern.match(/\*\*\//g)?.length ?? 0) > MAX_PATH_FILTER_GLOBSTARS) {
    throw new ScanError(
      'scan.includeGlobstarsTooMany',
      `单条 include 的 **/ 段超过 ${MAX_PATH_FILTER_GLOBSTARS} 个：段数按指数展开，请简化扫描配置的路径过滤后重试`,
      { limit: MAX_PATH_FILTER_GLOBSTARS },
    );
  }
  const head = pattern.slice(0, idx);
  const tail = pattern.slice(idx + 3);
  const out: string[] = [];
  for (const variant of expandGlobstarSegments(tail)) {
    out.push(`${head}${variant}`, `${head}**/${variant}`);
  }
  return [...new Set(out)];
}

export function normalizeGlob(pattern: string, mode: 'include' | 'exclude'): string[] {
  if (mode === 'exclude') {
    const normalized = pattern
      .replace(/\*\*\//g, '')
      .replace(/\/\*\*$/, '')
      .replace(/\*\*/g, '*');
    return normalized ? [normalized] : [];
  }
  const expanded = pattern.endsWith('/**')
    ? expandGlobstarSegments(pattern.slice(0, -3)).flatMap((prefix) => [`${prefix}/*`, `${prefix}/**/*`])
    : expandGlobstarSegments(pattern);
  return [...new Set(
    expanded
      .map((item) => item.replace(/\*\*(?!\/)/g, '*'))
      .filter(Boolean),
  )];
}

function sha256File(file: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

async function hashDirectory(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  };
  await walk(dir);
  files.sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await fs.promises.readFile(path.join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function rulesRelativePath(file: string): string {
  const rel = path.relative(config.rulesDir, file).replace(/\\/g, '/');
  return rel.startsWith('..') ? file : rel;
}

async function buildReproducibilityRecord(
  scanId: string,
  srcDir: string,
  plan: ScanPlan,
  args: string[],
  engineVersion: string | undefined,
): Promise<void> {
  const commandLine = `opengrep ${args
    .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
    .join(' ')}`;
  const configSnapshot: ScanConfigSnapshot = {
    rulesLabel: plan.rulesLabel,
    rulepacks: plan.rulepacks ?? [],
    ruleFiles: plan.configFiles.map((file) => ({
      file: rulesRelativePath(file),
      sha256: sha256File(file),
    })),
    excludes: plan.excludes,
    includes: plan.includes,
    timeoutSeconds: plan.timeoutSeconds,
    jobs: plan.jobs,
    maxTargetBytes: plan.maxTargetBytes,
  };
  updateScan(scanId, {
    srcHash: await hashDirectory(srcDir),
    commandLine,
    configSnapshot,
    ...(engineVersion ? { engineVersion } : {}),
  });
}

function mapFindingsToIssues(
  findings: OpengrepFinding[],
  options: {
    scanId: string;
    srcDir: string;
    knownRuleIds: Set<string>;
    ruleIdToPack: Map<string, { id: string; name: string }>;
  },
): IssueRow[] {
  return findings.map((finding) => {
    const ruleId = stripRuleIdPrefix(finding.check_id, options.knownRuleIds);
    const pack = options.ruleIdToPack.get(ruleId);
    const taintFlow = relativizeTaintFlow(
      extractTaintFlow(finding.extra.dataflow_trace),
      (p) => relativizeToRoot(p, options.srcDir),
    );
    const relativePath = relativizeToRoot(finding.path, options.srcDir);
    return {
      id: '',
      scanId: options.scanId,
      fingerprint:
        finding.extra.fingerprint ?? `${finding.check_id}:${relativePath}:${finding.start.line}`,
      ruleId,
      severity: mapSeverity(finding),
      comparisonStatus: 'remaining',
      message: finding.extra.message,
      filePath: relativePath,
      startLine: finding.start.line,
      endLine: finding.end.line,
      matchedLines: finding.extra.lines,
      ...(taintFlow ? { dataflowTrace: JSON.stringify(taintFlow) } : {}),
      rulepackId: pack?.id,
      rulepackName: pack?.name,
    };
  });
}

async function runScan(scanId: string, plan: ScanPlan): Promise<void> {
  const scan: ScanRecord | undefined = getScan(scanId);
  if (!scan || scan.status !== 'scanning') return;

  const srcDir = scanSourceDir(scan.projectId, scanId);
  try {
    if (!fs.existsSync(srcDir)) throw new ScanError('scan.snapshotMissing', '找不到扫描源码快照');
    if (plan.configFiles.length === 0) throw new ScanError('scan.noRuleFiles', '没有可用的规则文件');
    if (!fs.existsSync(config.opengrepBin)) {
      const hint = engineInstallHintInfo();
      throw new ScanError(hint.code, engineInstallHint(), hint.params);
    }
    const engineVersion = await getEngineVersion();
    if (!engineVersion) {
      const hint = engineNotRunnableHintInfo();
      throw new ScanError(hint.code, engineNotRunnableHint(), hint.params);
    }
    const fileCount = await countFiles(srcDir);
    updateScan(scanId, { fileCount });

    const args = [
      'scan',
      ...plan.configFiles.flatMap((file) => ['--config', file]),
      '--json',
      '--dataflow-traces',
      '--no-git-ignore',
      '--exclude', 'node_modules',
      '--exclude', '.git',
      ...plan.excludes.flatMap((pattern) => normalizeGlob(pattern, 'exclude')).flatMap((pattern) => ['--exclude', pattern]),
      ...plan.includes.flatMap((pattern) => normalizeGlob(pattern, 'include')).flatMap((pattern) => ['--include', pattern]),
      '--max-target-bytes', String(plan.maxTargetBytes),
      '--timeout', String(plan.timeoutSeconds),
      '-j', String(plan.jobs),
      srcDir,
    ];
    console.log(`[scan-runner] 扫描 ${scanId} 使用规则: ${plan.rulesLabel}（${plan.configFiles.length} 个规则文件）`);
    await buildReproducibilityRecord(scanId, srcDir, plan, args, engineVersion);
    if (getScan(scanId)?.status !== 'scanning') return;
    updateScan(scanId, { startedAt: new Date().toISOString() });
    const { code, stdout, stderr, timedOut, stdoutTruncated } = await runEngine(args, srcDir, {
      timeoutMs: config.scanTimeoutMs,
      logLabel: 'scan-runner',
      onSpawn: (child) => {
        runningEngines.set(scanId, child);
        if (getScan(scanId)?.status !== 'scanning') child.kill();
      },
    });
    runningEngines.delete(scanId);
    if (getScan(scanId)?.status !== 'scanning') return;
    if (cancelRequested.has(scanId)) {
      throw new ScanError('scan.cancelled', '已被手动取消');
    }

    if (timedOut) {
      throw new ScanError(
        'scan.timedOut',
        `扫描超过 ${Math.round(config.scanTimeoutMs / 60000)} 分钟被终止，请缩小源码范围后重试`,
        { minutes: Math.round(config.scanTimeoutMs / 60000) },
      );
    }
    if (stdoutTruncated) {
      throw new ScanError(
        'scan.outputTruncated',
        '引擎输出超过 64MB 上限被截断，无法解析结果；请缩小源码范围或减少规则后重试',
      );
    }

    let output: OpengrepOutput;
    const stderrBrief = stderr.slice(0, 300);
    try {
      output = JSON.parse(stdout) as OpengrepOutput;
    } catch {
      throw new ScanError(
        'scan.outputUnparseable',
        `引擎输出无法解析（exit=${code}）${stderrBrief}`,
        { code, detail: stderrBrief },
      );
    }

    if (code !== 0) {
      const detail = (output.errors?.[0]?.message ?? stderrBrief).slice(0, 500);
      throw new ScanError(
        'scan.engineFailed',
        `引擎执行失败（exit=${code}）${detail}`,
        { code, detail },
      );
    }

    const ruleIdsByFile = collectRuleIdsByFile(plan.configFiles);
    const knownRuleIds = new Set<string>();
    for (const ids of ruleIdsByFile.values()) {
      for (const id of ids) knownRuleIds.add(id);
    }
    const ruleIdToPack = new Map<string, { id: string; name: string }>();
    for (const [file, ids] of ruleIdsByFile) {
      const pack = plan.filePacks?.[file];
      if (!pack) continue;
      for (const id of ids) {
        if (!ruleIdToPack.has(id)) ruleIdToPack.set(id, pack);
      }
    }

    const findings = output.results ?? [];
    const currentIssues = mapFindingsToIssues(findings, {
      scanId,
      srcDir,
      knownRuleIds,
      ruleIdToPack,
    });

    applyBaselineComparison(currentIssues, scanId, scan.baselineScanId);

    const issueCount = currentIssues.filter(isActiveIssue).length;
    replaceIssues(scanId, currentIssues);
    updateScan(scanId, {
      status: 'completed',
      issueCount,
      fileCount,
      finishedAt: new Date().toISOString(),
    });
    console.log(`[scan-runner] 扫描 ${scanId} 完成，检查 ${fileCount} 个文件，发现 ${issueCount} 个问题`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateScan(scanId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      message: message.slice(0, 1000),
      ...(error instanceof ScanError
        ? { errorCode: error.code, errorParams: error.params }
        : {}),
    });
    console.error(`[scan-runner] 扫描 ${scanId} 失败: ${message}`);
  }
}
