import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  config,
  scanSourceDir,
} from './config.js';
import { engineInstallHint, engineNotRunnableHint, getEngineVersion, runEngine } from './engine.js';
import { HttpError } from './errors.js';

/**
 * 扫描失败错误：message 落库并作为兜底文案（语言切换后旧记录仍是原文，属可接受折衷），
 * code + params 同时落库（scans.error_code / error_params），前端按界面语言重拼——
 * 英文界面看到中文失败原因才是问题，兜底只在未带 code 的意外异常时生效。
 */
export class ScanError extends Error {
  constructor(
    public code: string,
    message: string,
    public params?: Record<string, unknown>,
  ) {
    super(message);
  }
}
import { relativizeToRoot, stripRuleIdPrefix } from './engine-output.js';
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


/** 最多同时运行 2 个扫描（opengrep 自身已用 -j 并行，2 个扫描足以利用多核又不会撑爆内存） */
const MAX_CONCURRENT_SCANS = 2;
let activeScans = 0;
const scanWaitQueue: Array<() => void> = [];

/** 占用扫描槽位；无空闲槽位时返回 queued=true，调用方需先给扫描打"排队中"标记，轮到时再清除 */
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

/** 运行中扫描的引擎子进程登记（scanId → child）：取消接口据此终止引擎 */
const runningEngines = new Map<string, ChildProcess>();

/** 已请求取消且引擎正在运行的扫描：runEngine 返回后据此落"已被手动取消"，而不是引擎原始退出码 */
const cancelRequested = new Set<string>();

/**
 * 取消扫描：引擎运行中则终止进程（复用 runEngine 既有 kill 链：温和终止 → 5s SIGKILL → 15s 兜底），
 * runScan 收尾按"已被手动取消"落库；返回 false 表示引擎尚未启动（排队中/快照准备阶段），
 * 此时由调用方直接落库失败（槽位轮到时 runScan 复查状态会自动退出，不会覆盖取消结果）。
 */
export function requestScanCancel(scanId: string): boolean {
  const child = runningEngines.get(scanId);
  if (!child) return false;
  cancelRequested.add(scanId);
  child.kill();
  return true;
}

export function enqueueScan(scanId: string, plan: ScanPlan): void {
  const slot = acquireScanSlot();
  if (slot.queued) {
    // 排队标记立刻落库（status 仍 scanning）：列表/结果页据此区分"排队中"与"扫描中"
    updateScan(scanId, { queuedAt: new Date().toISOString() });
  }
  void slot.ready
    .then(() => {
      // 排队期间用户可能已取消（取消路由直接把记录落成 failed，且此时引擎还没起，
      // requestScanCancel 无从介入）：状态不是 scanning 就什么也别做，
      // 否则槽位轮到时会把已取消的扫描跑完并覆盖回 completed，取消形同无效
      const current = getScan(scanId);
      if (!current || current.status !== 'scanning') return;
      // 轮到本扫描开跑：清掉排队标记，前端从"排队中"切回"扫描中"
      if (slot.queued) updateScan(scanId, { queuedAt: null });
      return runScan(scanId, plan);
    })
    .catch((error) => {
      console.error(`[scan-runner] 扫描 ${scanId} 执行异常:`, error);
    })
    .finally(() => {
      cancelRequested.delete(scanId);
      releaseScanSlot();
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


/** 是否有扫描在跑（引擎升级要等扫描结束：Windows 不允许替换运行中的 exe） */
export function hasRunningScan(): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM scans WHERE status = 'scanning'").get() as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0) > 0;
}

/** 判定「不可能还在跑」的宽限：引擎到点必 kill（温和 5s、兜底 15s），再留 2 分钟吸收时钟与调度抖动 */
const STALE_SCAN_GRACE_MS = 2 * 60 * 1000;

/**
 * 服务启动时清理中断在 scanning 的记录：只处理已超过「引擎硬超时 + 宽限」的行。
 * 判据不能是「所有 scanning」——dev.mjs 允许第二个实例共用同一个数据目录（AI 改代码时
 * 也会起项目，两边必须互不干扰），无判据会把另一个实例正在跑的扫描直接打成失败。
 * 超过超时仍在 scanning 的行，任何存活进程都不可能产生（引擎侧到点必终止），只可能是崩溃残骸。
 */
export function markStaleScansFailed(): void {
  const cutoff = new Date(Date.now() - (config.scanTimeoutMs + STALE_SCAN_GRACE_MS)).toISOString();
  const rows = db.prepare(
    `SELECT id FROM scans
     WHERE status = 'scanning' AND COALESCE(started_at, queued_at, scanned_at) < ?`,
  ).all(cutoff) as Array<{ id: string }>;
  for (const row of rows) {
    updateScan(row.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      message: '服务重启导致扫描中断，请重新发起',
      errorCode: 'scan.interrupted',
      // 排队标记的契约是"status 仍 scanning 且有值 = 排队中"（见 db.ts ScanRecord.queuedAt）；
      // 重启后不再有槽位轮转来清它，这里必须一并置 null，否则失败记录永久残留排队标记
      queuedAt: null,
    });
  }
}

/** 统计快照内的源码文件数（跳过扫描时本就排除的 node_modules / .git）；异步遍历避免大快照冻结事件循环 */
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

/**
 * 引擎 glob 语义与标准 globstar 有出入（opengrep 1.33 实测）：
 * - 中间 `src/**​/f` 只匹配「一层及以上」目录，不含 src 的直接子文件；
 * - 末尾 `dir/**` 只匹配直接子文件（等价 dir/*），深层文件扫不到；
 * - 仅起步的 `**​/` 是零层及以上；
 * - `--exclude` 对带通配符的路径模式基本不可用（`src/*` 甚至会产出重复结果），
 *   只能可靠匹配文件名或精确相对路径。
 * 因此 include 把一条 globstar 展开成「零层 + 一层以上」两种引擎能正确执行的模式；
 * exclude 保持保守近似（`**​/` 折叠为 basename/前缀，末尾 `/**` 折叠为目录名）。
 */
function expandGlobstarSegments(pattern: string): string[] {
  const idx = pattern.indexOf('**/');
  if (idx === -1) return [pattern];
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
    ? (() => {
        const prefix = pattern.slice(0, -3);
        return [`${prefix}/*`, `${prefix}/**/*`];
      })()
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

/**
 * 源码快照的 SHA-256 可复现指纹：对"排序后的相对路径 + \0 + 文件内容 + \0"序列计算。
 * 路径参与哈希保证增删文件会改变结果；排序保证遍历顺序跨平台稳定。
 * 异步逐文件读：大快照哈希期间事件循环保持响应。
 */
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

/** 规则文件路径转为相对 rules/ 目录的稳定展示路径（绝对路径兜底） */
function rulesRelativePath(file: string): string {
  const rel = path.relative(config.rulesDir, file).replace(/\\/g, '/');
  return rel.startsWith('..') ? file : rel;
}

/** 可复现清单：完整命令行 + 规则文件哈希 + 引擎参数快照 + 引擎版本，扫描引擎运行前落库 */
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
    // 记录"这次扫描用的是哪版引擎"：升级后重新生成报告时不能按当前版本标注
    ...(engineVersion ? { engineVersion } : {}),
  });
}

async function runScan(scanId: string, plan: ScanPlan): Promise<void> {
  const scan: ScanRecord | undefined = getScan(scanId);
  if (!scan || scan.status !== 'scanning') return;

  const srcDir = scanSourceDir(scan.projectId, scanId);
  try {
    if (!fs.existsSync(srcDir)) throw new ScanError('scan.snapshotMissing', '找不到扫描源码快照');
    if (plan.configFiles.length === 0) throw new ScanError('scan.noRuleFiles', '没有可用的规则文件');
    if (!fs.existsSync(config.opengrepBin)) throw new Error(engineInstallHint());
    // 引擎文件在但探测不到版本（损坏/被杀软拦截，Windows 同步抛 spawn EFTYPE）= 跑不起来：
    // 在发起引擎前挡下，落库可执行的修复指引而不是裸 spawn 报错；
    // 版本本来就要探测（复现清单需要），这里复用同一份结果，不增加探测次数
    const engineVersion = await getEngineVersion();
    if (!engineVersion) throw new Error(engineNotRunnableHint());
    const fileCount = await countFiles(srcDir);
    // 心跳进度：文件数尽早落库，结果页扫描中即可展示"已扫 N 文件"而不是纯转圈
    //（完成时同值还会再落一次，无副作用；写库频率只有这一次，远低于 1 秒一次的共享连接约束）
    updateScan(scanId, { fileCount });

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
      ...plan.excludes.flatMap((pattern) => normalizeGlob(pattern, 'exclude')).flatMap((pattern) => ['--exclude', pattern]),
      ...plan.includes.flatMap((pattern) => normalizeGlob(pattern, 'include')).flatMap((pattern) => ['--include', pattern]),
      '--max-target-bytes', String(plan.maxTargetBytes),
      '--timeout', String(plan.timeoutSeconds),
      '-j', String(plan.jobs),
      srcDir,
    ];
    console.log(`[scan-runner] 扫描 ${scanId} 使用规则: ${plan.rulesLabel}（${plan.configFiles.length} 个规则文件）`);
    await buildReproducibilityRecord(scanId, srcDir, plan, args, engineVersion);
    // 引擎启动前复查：排队或快照准备阶段被取消的扫描已被取消接口落库失败，
    // 这里直接退出，避免取消之后仍把引擎拉起来或用最终结果覆盖取消记录
    if (getScan(scanId)?.status !== 'scanning') return;
    // 实际开跑时间：排队等待与快照哈希/复现清单落库都在此之前，不应计入「引擎耗时」
    updateScan(scanId, { startedAt: new Date().toISOString() });
    const { code, stdout, stderr, timedOut, stdoutTruncated } = await runEngine(args, srcDir, {
      timeoutMs: config.scanTimeoutMs,
      logLabel: 'scan-runner',
      // 登记本次引擎子进程：取消接口按 scanId 找到它并终止（复用 runEngine 的 kill 链）
      onSpawn: (child) => runningEngines.set(scanId, child),
    });
    // runEngine resolve 即引擎已退出（close/error 任一路径都会 resolve）：从登记表移除，取消接口不再对其生效
    runningEngines.delete(scanId);
    // 引擎被手动取消：按取消语义落库，而不是把 kill 后的空输出/非零退出码报成引擎故障
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
    // 结论与 message 同形（不带额外冒号），保证前端按 code 重拼的结果与落库兜底文案一致
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
        (p) => relativizeToRoot(p, srcDir),
      );
      return {
        id: '',
        scanId,
        fingerprint: finding.extra.fingerprint ?? `${finding.check_id}:${finding.path}:${finding.start.line}`,
        ruleId,
        severity: mapSeverity(finding),
        comparisonStatus: 'remaining',
        message: finding.extra.message,
        filePath: relativizeToRoot(finding.path, srcDir),
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
      // 带 code 的已知失败连同参数一起落库，前端按界面语言重拼；意外异常只留兜底文案
      ...(error instanceof ScanError
        ? { errorCode: error.code, errorParams: error.params }
        : {}),
    });
    console.error(`[scan-runner] 扫描 ${scanId} 失败: ${message}`);
  }
}
