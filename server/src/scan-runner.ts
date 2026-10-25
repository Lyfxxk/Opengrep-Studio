import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  config,
  scanSourceDir,
} from './config.js';
import { engineInstallHint, runEngine } from './engine.js';
import { normalizePath, stripRuleIdPrefix } from './engine-output.js';
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

export interface ScanPlan {
  rulesLabel: string;
  configFiles: string[];
  /** 本次实际生效的规则包快照（旧式目录扫描没有） */
  rulepacks?: Array<{ id: string; name: string }>;
  /** 规则文件 → 规则包映射，用于把命中结果归属到来源包 */
  filePacks?: Record<string, { id: string; name: string }>;
  timeoutSeconds: number;
  jobs: number;
  maxTargetBytes: number;
  excludes: string[];
  includes: string[];
}


let chain: Promise<void> = Promise.resolve();

export function enqueueScan(scanId: string, plan: ScanPlan): void {
  chain = chain
    .then(() => runScan(scanId, plan))
    .catch((error) => {
      console.error(`[scan-runner] 扫描 ${scanId} 执行异常:`, error);
    });
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

function relativizeToSrc(p: string, srcDir: string): string {
  // 两侧统一剥前导斜杠再比对：引擎在 Linux 上返回绝对路径（/home/...），
  // 只剥一侧会让 norm（home/...）永远匹配不上带斜杠的 prefix（/home/...）
  const stripRoot = (s: string) => normalizePath(s).replace(/^\/+/, '');
  const norm = stripRoot(p);
  const prefix = `${stripRoot(srcDir).replace(/\/+$/, '')}/`;
  if (norm.toLowerCase().startsWith(prefix.toLowerCase())) {
    return norm.slice(prefix.length);
  }
  return norm;
}

/** 服务重启时把上次中断在 scanning 的记录标记为失败（引擎进程已丢失，无法续跑） */
export function markStaleScansFailed(): void {
  const rows = db.prepare("SELECT id FROM scans WHERE status = 'scanning'").all() as Array<{ id: string }>;
  for (const row of rows) {
    updateScan(row.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      message: '服务重启导致扫描中断，请重新发起',
    });
  }
}

/** 统计快照内的源码文件数（跳过扫描时本就排除的 node_modules / .git） */
function countFiles(dir: string): number {
  let count = 0;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.isDirectory()) walk(path.join(current, entry.name));
      else if (entry.isFile()) count += 1;
    }
  };
  walk(dir);
  return count;
}

/**
 * 基线对比：命中=遗留、未命中=新增、基线独有=已修复（fixed 项追加进 issues 一起落库）。
 * 引擎扫描与 SARIF 导入共用同一套口径，原地修改传入的 issues。
 */
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

function normalizeGlob(pattern: string): string {
  return pattern
    .replace(/\*\*\//g, '')
    .replace(/\/\*\*$/g, '')
    .replace(/\*\*/g, '*');
}

function sha256File(file: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * 源码快照的 SHA-256 可复现指纹：对"排序后的相对路径 + \0 + 文件内容 + \0"序列计算。
 * 路径参与哈希保证增删文件会改变结果；排序保证遍历顺序跨平台稳定。
 */
function hashDirectory(dir: string): string {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  files.sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** 规则文件路径转为相对 rules/ 目录的稳定展示路径（绝对路径兜底） */
function rulesRelativePath(file: string): string {
  const rel = path.relative(config.rulesDir, file).replace(/\\/g, '/');
  return rel.startsWith('..') ? file : rel;
}

/** 可复现清单：完整命令行 + 规则文件哈希 + 引擎参数快照，扫描引擎运行前落库 */
function buildReproducibilityRecord(scanId: string, srcDir: string, plan: ScanPlan, args: string[]): void {
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
    srcHash: hashDirectory(srcDir),
    commandLine,
    configSnapshot,
  });
}

async function runScan(scanId: string, plan: ScanPlan): Promise<void> {
  const scan: ScanRecord | undefined = getScan(scanId);
  if (!scan || scan.status !== 'scanning') return;

  const srcDir = scanSourceDir(scan.projectId, scanId);
  try {
    if (!fs.existsSync(srcDir)) throw new Error('找不到扫描源码快照');
    if (plan.configFiles.length === 0) throw new Error('没有可用的规则文件');
    if (!fs.existsSync(config.opengrepBin)) throw new Error(engineInstallHint());
    const fileCount = countFiles(srcDir);

    const args = [
      'scan',
      ...plan.configFiles.flatMap((file) => ['--config', file]),
      '--json',
      // taint 规则附带污点传播链（extra.dataflow_trace），供结果页可视化
      '--dataflow-traces',
      // 上传的源码快照不是 git 工作区：跳过 gitignore/git 跟踪过滤，保证确定性全量扫描
      // （排除项由扫描配置的 excludes 显式下发）
      '--no-git-ignore',
      '--exclude', 'node_modules',
      '--exclude', '.git',
      ...plan.excludes.map(normalizeGlob).filter(Boolean).flatMap((pattern) => ['--exclude', pattern]),
      ...plan.includes.map(normalizeGlob).filter(Boolean).flatMap((pattern) => ['--include', pattern]),
      '--max-target-bytes', String(plan.maxTargetBytes),
      '--timeout', String(plan.timeoutSeconds),
      '-j', String(plan.jobs),
      srcDir,
    ];
    console.log(`[scan-runner] 扫描 ${scanId} 使用规则: ${plan.rulesLabel}（${plan.configFiles.length} 个规则文件）`);
    buildReproducibilityRecord(scanId, srcDir, plan, args);
    const { code, stdout, stderr, timedOut } = await runEngine(args, srcDir, {
      timeoutMs: config.scanTimeoutMs,
      logLabel: 'scan-runner',
    });

    if (timedOut) {
      throw new Error(`扫描超过 ${Math.round(config.scanTimeoutMs / 60000)} 分钟被终止，请缩小源码范围后重试`);
    }

    let output: OpengrepOutput;
    try {
      output = JSON.parse(stdout) as OpengrepOutput;
    } catch {
      throw new Error(
        `引擎输出无法解析（exit=${code}）${stderr ? `：${stderr.slice(0, 300)}` : ''}`,
      );
    }

    if (code !== 0) {
      const detail = output.errors?.[0]?.message ?? stderr.slice(0, 300) ?? '';
      throw new Error(`引擎执行失败（exit=${code}）${detail ? `：${detail.slice(0, 500)}` : ''}`.trim());
    }

    const ruleIdsByFile = collectRuleIdsByFile(plan.configFiles);
    const knownRuleIds = new Set<string>();
    for (const ids of ruleIdsByFile.values()) {
      for (const id of ids) knownRuleIds.add(id);
    }
    // 规则 ID → 来源规则包：同一个规则文件里的所有规则都归属该文件对应的包
    const ruleIdToPack = new Map<string, { id: string; name: string }>();
    for (const [file, ids] of ruleIdsByFile) {
      const pack = plan.filePacks?.[file];
      if (!pack) continue;
      for (const id of ids) {
        if (!ruleIdToPack.has(id)) ruleIdToPack.set(id, pack);
      }
    }

    const findings = output.results ?? [];
    const currentIssues: IssueRow[] = findings.map((finding) => {
      const ruleId = stripRuleIdPrefix(finding.check_id, knownRuleIds);
      const pack = ruleIdToPack.get(ruleId);
      const taintFlow = relativizeTaintFlow(
        extractTaintFlow(finding.extra.dataflow_trace),
        (p) => relativizeToSrc(p, srcDir),
      );
      return {
        id: '',
        scanId,
        fingerprint: finding.extra.fingerprint ?? `${finding.check_id}:${finding.path}:${finding.start.line}`,
        ruleId,
        severity: mapSeverity(finding),
        comparisonStatus: 'remaining',
        message: finding.extra.message,
        filePath: relativizeToSrc(finding.path, srcDir),
        startLine: finding.start.line,
        endLine: finding.end.line,
        matchedLines: finding.extra.lines,
        ...(taintFlow ? { dataflowTrace: JSON.stringify(taintFlow) } : {}),
        rulepackId: pack?.id,
        rulepackName: pack?.name,
      };
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
    });
    console.error(`[scan-runner] 扫描 ${scanId} 失败: ${message}`);
  }
}
