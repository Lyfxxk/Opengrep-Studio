import { spawn } from 'node:child_process';
import { config } from './config.js';
import type {
  ComparisonStatus,
  Issue,
  IssueRow,
  Project,
  Review,
  ReviewStatus,
  RulePackRef,
  ScanRecord,
  Severity,
} from './db.js';

export interface ReportMeta {
  projectName: string;
  projectDescription?: string;
  language: string;
  scanId: string;
  scannedAt: string;
  finishedAt?: string;
  durationSeconds?: number;
  fileCount: number;
  baselineScanId?: string;
  rulepacks?: RulePackRef[];
  rules?: string;
  engineVersion?: string;
  /** 源码快照 SHA-256（可复现清单，旧扫描记录可能没有） */
  sourceHash?: string;
  /** 发起扫描时的完整引擎命令行 */
  commandLine?: string;
  generatedAt: string;
}

export interface ReportTotals {
  /** 当前问题总数（不含基线对比产生的"已修复"项，与 scan.issueCount 口径一致） */
  total: number;
  bySeverity: Record<Severity, number>;
  byComparison: Record<ComparisonStatus, number>;
}

export interface ReportRuleAgg {
  ruleId: string;
  count: number;
  /** 该规则命中的最高严重度 */
  severity: Severity;
  rulepackName?: string;
}

export interface ReportFileAgg {
  filePath: string;
  count: number;
  maxSeverity: Severity;
}

export interface ReportDirAgg {
  dir: string;
  count: number;
}

export interface ReportReviewSummary {
  /** 已人工复核的问题数（确认 + 误报 + 有条件接受） */
  reviewed: number;
  confirmed: number;
  falsePositives: number;
  accepted: number;
}

export interface ReportIssueReview {
  status: ReviewStatus;
  reason?: string;
  reviewer?: string;
  updatedAt?: string;
}

export interface ReportData {
  meta: ReportMeta;
  totals: ReportTotals;
  conclusion: string;
  topRules: ReportRuleAgg[];
  topFiles: ReportFileAgg[];
  topDirs: ReportDirAgg[];
  issues: Array<Issue & { review?: ReportIssueReview }>;
  /** 人工复核统计（无复核记录时为 undefined） */
  reviewStats?: ReportReviewSummary;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_LABEL: Record<Severity, string> = { critical: '严重', high: '高危', medium: '中危', low: '低危' };
const COMPARISON_LABEL: Record<ComparisonStatus, string> = {
  new: '新增',
  fixed: '已修复',
  remaining: '遗留',
};
const REVIEW_LABEL: Record<ReviewStatus, string> = {
  pending: '待复核',
  confirmed: '已确认',
  false_positive: '误报',
  accepted: '已接受',
};
const REVIEW_COLOR: Record<ReviewStatus, string> = {
  pending: '#8a94a6',
  confirmed: '#d92b2b',
  false_positive: '#1e9e6a',
  accepted: '#e8930c',
};

export const TOP_RULES_LIMIT = 10;
export const TOP_FILES_LIMIT = 10;
export const TOP_DIRS_LIMIT = 8;
/** HTML 报告内嵌代码片段的条数上限（严重+高危合计），避免大扫描把报告撑到几十 MB */
export const SNIPPET_LIMIT = 100;

let engineVersionPromise: Promise<string | undefined> | null = null;

/** 惰性探测引擎版本（只 spawn 一次，失败不缓存重试） */
export function getEngineVersion(): Promise<string | undefined> {
  engineVersionPromise ??= new Promise((resolve) => {
    const child = spawn(config.opengrepBin, ['--version'], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const match = out.match(/\d+\.\d+\.\d+/);
      resolve(match ? match[0] : out.trim().split(/\r?\n/)[0] || undefined);
    });
  });
  return engineVersionPromise;
}


export function buildReportData(
  scan: ScanRecord,
  project: Project,
  issues: IssueRow[],
  engineVersion?: string,
  reviews: Review[] = [],
): ReportData {
  // 严重度分布只统计"当前存在"的问题；已修复项单独出现在对比统计里
  const current = issues.filter((issue) => issue.comparisonStatus !== 'fixed');
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of current) bySeverity[issue.severity] += 1;
  const byComparison: Record<ComparisonStatus, number> = { new: 0, fixed: 0, remaining: 0 };
  for (const issue of issues) byComparison[issue.comparisonStatus] += 1;

  // 人工复核（以 fingerprint 为键跨扫描继承）：挂到问题明细并汇总
  const reviewMap = new Map(reviews.map((review) => [review.fingerprint, review]));
  const reviewStats: ReportReviewSummary = { reviewed: 0, confirmed: 0, falsePositives: 0, accepted: 0 };
  const attachReview = (issue: IssueRow): Issue & { review?: ReportIssueReview } => {
    const review = reviewMap.get(issue.fingerprint);
    const { fingerprint: _fp, matchedLines: _ml, ...rest } = issue;
    if (!review || review.status === 'pending') return rest;
    reviewStats.reviewed += 1;
    if (review.status === 'confirmed') reviewStats.confirmed += 1;
    else if (review.status === 'false_positive') reviewStats.falsePositives += 1;
    else if (review.status === 'accepted') reviewStats.accepted += 1;
    return {
      ...rest,
      review: {
        status: review.status,
        ...(review.reason ? { reason: review.reason } : {}),
        ...(review.reviewer ? { reviewer: review.reviewer } : {}),
        ...(review.updatedAt ? { updatedAt: review.updatedAt } : {}),
      },
    };
  };

  const ruleAgg = new Map<string, ReportRuleAgg>();
  for (const issue of current) {
    const entry = ruleAgg.get(issue.ruleId);
    if (entry) {
      entry.count += 1;
      if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[entry.severity]) {
        entry.severity = issue.severity;
      }
      entry.rulepackName ??= issue.rulepackName;
    } else {
      ruleAgg.set(issue.ruleId, {
        ruleId: issue.ruleId,
        count: 1,
        severity: issue.severity,
        rulepackName: issue.rulepackName,
      });
    }
  }
  const topRules = [...ruleAgg.values()]
    .sort((a, b) => b.count - a.count || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, TOP_RULES_LIMIT);

  const fileAgg = new Map<string, ReportFileAgg>();
  for (const issue of current) {
    const entry = fileAgg.get(issue.filePath);
    if (entry) {
      entry.count += 1;
      if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[entry.maxSeverity]) {
        entry.maxSeverity = issue.severity;
      }
    } else {
      fileAgg.set(issue.filePath, {
        filePath: issue.filePath,
        count: 1,
        maxSeverity: issue.severity,
      });
    }
  }
  const topFiles = [...fileAgg.values()]
    .sort((a, b) => b.count - a.count || SEVERITY_RANK[a.maxSeverity] - SEVERITY_RANK[b.maxSeverity])
    .slice(0, TOP_FILES_LIMIT);

  const dirAgg = new Map<string, number>();
  for (const issue of current) {
    const sep = issue.filePath.indexOf('/');
    const dir = sep > 0 ? issue.filePath.slice(0, sep) : '（根目录）';
    dirAgg.set(dir, (dirAgg.get(dir) ?? 0) + 1);
  }
  const topDirs = [...dirAgg.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_DIRS_LIMIT);

  const durationSeconds =
    scan.finishedAt && scan.scannedAt
      ? Math.max(
          0,
          Math.round(
            (new Date(scan.finishedAt).getTime() - new Date(scan.scannedAt).getTime()) / 1000,
          ),
        )
      : undefined;

  const meta: ReportMeta = {
    projectName: project.name,
    projectDescription: project.description,
    language: project.language,
    scanId: scan.id,
    scannedAt: scan.scannedAt,
    finishedAt: scan.finishedAt,
    durationSeconds,
    fileCount: scan.fileCount,
    baselineScanId: scan.baselineScanId,
    rulepacks: scan.rulepacks,
    rules: scan.rules,
    engineVersion,
    sourceHash: scan.srcHash,
    commandLine: scan.commandLine,
    generatedAt: new Date().toISOString(),
  };

  const mappedIssues = issues.map(attachReview);
  const conclusion = buildConclusion(scan, current.length, bySeverity, byComparison);
  const reviewSentence = reviewStats.reviewed > 0
    ? ` 人工复核已完成 ${reviewStats.reviewed} 项（确认 ${reviewStats.confirmed}、误报 ${reviewStats.falsePositives}、有条件接受 ${reviewStats.accepted}）。`
    : '';
  return {
    meta,
    totals: { total: current.length, bySeverity, byComparison },
    conclusion: `${conclusion}${reviewSentence}`,
    topRules,
    topFiles,
    topDirs,
    issues: mappedIssues,
    ...(reviewStats.reviewed > 0 ? { reviewStats } : {}),
  };
}

function buildConclusion(
  scan: ScanRecord,
  total: number,
  bySeverity: Record<Severity, number>,
  byComparison: Record<ComparisonStatus, number>,
): string {
  const parts: string[] = [];
  const fileText = scan.fileCount ? `${scan.fileCount}` : '—';
  if (total === 0) {
    parts.push(`本次扫描共检查 ${fileText} 个源码文件，未命中任何已启用规则，未发现风险问题。`);
  } else {
    const sevText = SEVERITY_ORDER.filter((sev) => bySeverity[sev] > 0)
      .map((sev) => `${SEVERITY_LABEL[sev]} ${bySeverity[sev]} 项`)
      .join('、');
    parts.push(`本次扫描共检查 ${fileText} 个源码文件，发现 ${total} 个风险问题（${sevText}）。`);
  }
  if (scan.baselineScanId) {
    parts.push(
      `与基线扫描 ${scan.baselineScanId} 相比：新增 ${byComparison.new} 项、遗留 ${byComparison.remaining} 项、已修复 ${byComparison.fixed} 项。`,
    );
  }
  const urgent = bySeverity.critical + bySeverity.high;
  if (urgent > 0) {
    parts.push(`建议优先处理严重与高危问题（共 ${urgent} 项），修复后重新扫描回归验证。`);
  } else if (total > 0) {
    parts.push('当前无严重/高危问题，建议按业务优先级安排中低危问题的修复。');
  }
  return parts.join('');
}


function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#d92b2b',
  high: '#e8930c',
  medium: '#1f7fe0',
  low: '#8a94a6',
};

function barRows(
  rows: Array<{ label: string; count: number; color: string }>,
): string {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return rows
    .map(
      (row) => `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(row.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(row.count / max) * 100}%;background:${row.color}"></span></span>
        <span class="bar-value">${row.count}</span>
      </div>`,
    )
    .join('');
}

function issueTableHtml(
  issues: Array<Issue & { review?: ReportIssueReview }>,
  snippets: Map<string, string>,
  snippetBudget: { left: number },
): string {
  const rows = issues
    .map((issue, index) => {
      let snippetHtml = '';
      if (
        snippetBudget.left > 0 &&
        (issue.severity === 'critical' || issue.severity === 'high')
      ) {
        const snippet = snippets.get(issue.id);
        if (snippet) {
          snippetBudget.left -= 1;
          snippetHtml = `<tr class="snippet-row"><td colspan="7"><pre>${escapeHtml(snippet)}</pre></td></tr>`;
        }
      }
      const reviewTag = issue.review
        ? `<span class="tag" style="background:${REVIEW_COLOR[issue.review.status]}1a;color:${REVIEW_COLOR[issue.review.status]}" title="${escapeHtml([`复核人：${issue.review.reviewer ?? '—'}`, issue.review.reason].filter(Boolean).join('；'))}">${REVIEW_LABEL[issue.review.status]}</span>`
        : '<span class="tag tag-pending">待复核</span>';
      return `<tr>
          <td class="cell-num">${index + 1}</td>
          <td class="cell-mono">${escapeHtml(issue.filePath)}:${issue.startLine}</td>
          <td class="cell-mono">${escapeHtml(issue.ruleId)}</td>
          <td>${escapeHtml(issue.message)}</td>
          <td><span class="tag tag-${issue.comparisonStatus}">${COMPARISON_LABEL[issue.comparisonStatus]}</span></td>
          <td>${reviewTag}</td>
          <td class="cell-sub">${escapeHtml(issue.rulepackName ?? '—')}</td>
        </tr>${snippetHtml}`;
    })
    .join('');
  return `
    <table class="issue-table">
      <thead>
        <tr><th>#</th><th>位置</th><th>规则</th><th>描述</th><th>状态</th><th>人工复核</th><th>规则包</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export interface HtmlRenderOptions {
  /** false 时省略全部代码片段（detail=summary） */
  includeSnippets: boolean;
}

/** 渲染自包含 HTML 报告：内联 CSS、无外部依赖，可直接离线打开或打印为 PDF */
export function renderReportHtml(
  data: ReportData,
  issues: IssueRow[],
  options: HtmlRenderOptions,
): string {
  const { meta, totals, topRules, topFiles, topDirs, reviewStats } = data;
  const current = issues.filter((issue) => issue.comparisonStatus !== 'fixed');
  const fixed = issues.filter((issue) => issue.comparisonStatus === 'fixed');

  const snippets = new Map<string, string>();
  if (options.includeSnippets) {
    for (const issue of issues) {
      if (issue.matchedLines) snippets.set(issue.id, issue.matchedLines);
    }
  }
  const snippetBudget = { left: SNIPPET_LIMIT };

  const severityStats = SEVERITY_ORDER.map((sev) => ({
    label: SEVERITY_LABEL[sev],
    count: totals.bySeverity[sev],
    color: SEVERITY_COLOR[sev],
  }));
  const comparisonStats: Array<{ label: string; count: number; color: string }> = meta.baselineScanId
    ? [
        { label: '新增', count: totals.byComparison.new, color: '#d92b2b' },
        { label: '遗留', count: totals.byComparison.remaining, color: '#e8930c' },
        { label: '已修复', count: totals.byComparison.fixed, color: '#1e9e6a' },
      ]
    : [];

  const metaRows: Array<[string, string]> = [
    ['项目名称', escapeHtml(meta.projectName)],
    ...(meta.projectDescription ? ([['项目描述', escapeHtml(meta.projectDescription)]] as Array<[string, string]>) : []),
    ...(meta.language ? ([['主要语言', escapeHtml(meta.language)]] as Array<[string, string]>) : []),
    ['扫描编号', `<span class="cell-mono">${escapeHtml(meta.scanId)}</span>`],
    ['扫描时间', formatDateTime(meta.scannedAt)],
    ...(meta.durationSeconds !== undefined
      ? ([['引擎耗时', formatDuration(meta.durationSeconds)]] as Array<[string, string]>)
      : []),
    ['检查文件数', meta.fileCount ? `${meta.fileCount} 个` : '—'],
    ...(meta.baselineScanId
      ? ([['基线扫描', `<span class="cell-mono">${escapeHtml(meta.baselineScanId)}</span>`]] as Array<[string, string]>)
      : []),
    ...(meta.engineVersion ? ([['扫描引擎', `opengrep v${escapeHtml(meta.engineVersion)}`]] as Array<[string, string]>) : []),
    ...(meta.sourceHash
      ? ([['源码哈希', `<span class="cell-mono">${escapeHtml(meta.sourceHash)}</span>`]] as Array<[string, string]>)
      : []),
    ...(meta.commandLine
      ? ([['引擎命令行', `<span class="cell-mono" style="word-break:break-all">${escapeHtml(meta.commandLine)}</span>`]] as Array<[string, string]>)
      : []),
    [
      '生效规则包',
      meta.rulepacks?.length
        ? meta.rulepacks.map((pack) => escapeHtml(pack.name)).join('、')
        : meta.rules
          ? escapeHtml(meta.rules)
          : '—',
    ],
    ['报告生成时间', formatDateTime(meta.generatedAt)],
  ];

  const detailSections = SEVERITY_ORDER.map((sev) => {
    const list = current.filter((issue) => issue.severity === sev);
    if (list.length === 0) return '';
    const urgent = sev === 'critical' || sev === 'high';
    return `
      <h3><span class="sev-dot" style="background:${SEVERITY_COLOR[sev]}"></span>${SEVERITY_LABEL[sev]}问题（${list.length} 项）</h3>
      ${issueTableHtml(list, snippets, snippetBudget)}
      ${urgent && options.includeSnippets && snippetBudget.left <= 0
        ? '<p class="note">代码片段超过上限，仅展示前 ' + SNIPPET_LIMIT + ' 条，其余请结合扫描结果页查看。</p>'
        : ''}`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>测试报告 · ${escapeHtml(meta.projectName)} · ${escapeHtml(meta.scanId)}</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; color: #1f2633; background: #f1f4f9;
    font-family: -apple-system, 'BlinkMacSystemFont', 'Helvetica Neue', Tahoma,
      'PingFang SC', 'Microsoft Yahei', 'Hiragino Sans GB', sans-serif;
    font-size: 14px; line-height: 1.6;
  }
  .doc { max-width: 860px; margin: 0 auto; padding: 40px 32px 32px; background: #fff; }
  .cover { border-bottom: 3px solid #1f7fe0; padding-bottom: 20px; margin-bottom: 24px; }
  .brand { font-size: 12px; letter-spacing: .08em; color: #6b7689; text-transform: uppercase; }
  .cover h1 { margin: 8px 0 4px; font-size: 28px; }
  .cover .subtitle { color: #4a5468; font-size: 16px; }
  section { margin: 28px 0; }
  h2 { font-size: 18px; margin: 0 0 12px; padding-left: 10px; border-left: 4px solid #1f7fe0; }
  h3 { font-size: 15px; margin: 20px 0 8px; }
  h3 .sev-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
  .conclusion { background: #f0f6ff; border: 1px solid #d4e6ff; border-radius: 8px; padding: 12px 16px; margin: 0 0 16px; }
  .stat-grid { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
  .stat-card { flex: 1 1 120px; border: 1px solid #e3e8f0; border-radius: 8px; padding: 10px 14px; }
  .stat-card .num { font-size: 24px; font-weight: 700; }
  .stat-card .label { font-size: 12px; color: #6b7689; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
  th, td { border: 1px solid #e3e8f0; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f5f7fb; font-size: 13px; }
  .meta-table th { width: 130px; background: #fafbfd; color: #4a5468; font-weight: 500; }
  .cell-num { color: #8a94a6; white-space: nowrap; }
  .cell-mono { font-family: 'JetBrains Mono', Consolas, monospace; font-size: 12.5px; }
  .cell-sub { color: #6b7689; font-size: 12.5px; }
  .tag { display: inline-block; padding: 0 8px; border-radius: 999px; font-size: 12px; line-height: 20px; white-space: nowrap; }
  .tag-new { background: #fbe9e9; color: #d92b2b; }
  .tag-remaining { background: #fdf1dd; color: #b26e05; }
  .tag-fixed { background: #e2f5ec; color: #1e9e6a; }
  .tag-pending { background: #eef1f6; color: #8a94a6; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
  .bar-label { flex: 0 0 190px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 14px; background: #eef1f6; border-radius: 7px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; border-radius: 7px; }
  .bar-value { flex: 0 0 44px; text-align: right; font-variant-numeric: tabular-nums; color: #4a5468; }
  .snippet-row td { background: #fafbfd; padding: 0 10px; }
  .snippet-row pre {
    margin: 6px 0; padding: 8px 10px; background: #0f172a; color: #dce4f2;
    border-radius: 6px; font-family: 'JetBrains Mono', Consolas, monospace;
    font-size: 12px; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-all;
  }
  .note { color: #8a94a6; font-size: 12.5px; }
  footer { margin-top: 36px; padding-top: 12px; border-top: 1px solid #e3e8f0; color: #8a94a6; font-size: 12px; }
  @media print {
    body { background: #fff; }
    .doc { max-width: none; padding: 0; }
    @page { size: A4; margin: 14mm 12mm; }
    thead { display: table-header-group; }
    tr, .stat-card, .bar-row, .conclusion { break-inside: avoid; }
    section { break-inside: auto; }
  }
</style>
</head>
<body>
<div class="doc">
  <header class="cover">
    <div class="brand">Opengrep Studio · 码审工作台</div>
    <h1>代码审计测试报告</h1>
    <div class="subtitle">${escapeHtml(meta.projectName)}<span class="cell-mono" style="margin-left:10px;font-size:13px;color:#6b7689">${escapeHtml(meta.scanId)}</span></div>
  </header>

  <section>
    <h2>一、扫描概要</h2>
    <table class="meta-table">
      <tbody>
        ${metaRows.map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join('')}
      </tbody>
    </table>
  </section>

  <section>
    <h2>二、总体结论</h2>
    <p class="conclusion">${escapeHtml(data.conclusion)}</p>
    <div class="stat-grid">
      ${severityStats
        .map(
          (item) =>
            `<div class="stat-card"><div class="num" style="color:${item.color}">${item.count}</div><div class="label">${item.label}</div></div>`,
        )
        .join('')}
      <div class="stat-card"><div class="num">${totals.total}</div><div class="label">问题总数</div></div>
    </div>
    ${
      comparisonStats.length
        ? `<div class="stat-grid">${comparisonStats
            .map(
              (item) =>
                `<div class="stat-card"><div class="num" style="color:${item.color}">${item.count}</div><div class="label">${item.label}（对比基线）</div></div>`,
            )
            .join('')}</div>`
        : ''
    }
    ${
      reviewStats
        ? `<div class="stat-grid">
            <div class="stat-card"><div class="num" style="color:#1f7fe0">${reviewStats.reviewed}</div><div class="label">已人工复核</div></div>
            <div class="stat-card"><div class="num" style="color:#d92b2b">${reviewStats.confirmed}</div><div class="label">复核确认</div></div>
            <div class="stat-card"><div class="num" style="color:#1e9e6a">${reviewStats.falsePositives}</div><div class="label">判定误报</div></div>
            <div class="stat-card"><div class="num" style="color:#e8930c">${reviewStats.accepted}</div><div class="label">有条件接受</div></div>
          </div>`
        : ''
    }
  </section>

  <section>
    <h2>三、风险分布</h2>
    <h3>按严重度</h3>
    ${barRows(severityStats)}
    <h3>高频规则 Top ${topRules.length}</h3>
    <table>
      <thead><tr><th>规则</th><th>描述最高严重度</th><th>命中</th><th>规则包</th></tr></thead>
      <tbody>
        ${
          topRules.length
            ? topRules
                .map(
                  (row) =>
                    `<tr><td class="cell-mono">${escapeHtml(row.ruleId)}</td><td><span style="color:${SEVERITY_COLOR[row.severity]};font-weight:600">${SEVERITY_LABEL[row.severity]}</span></td><td class="cell-num">${row.count}</td><td class="cell-sub">${escapeHtml(row.rulepackName ?? '—')}</td></tr>`,
                )
                .join('')
            : '<tr><td colspan="4" class="note">无命中规则</td></tr>'
        }
      </tbody>
    </table>
    <h3>热点文件 Top ${topFiles.length}</h3>
    <table>
      <thead><tr><th>文件</th><th>最高严重度</th><th>命中</th></tr></thead>
      <tbody>
        ${
          topFiles.length
            ? topFiles
                .map(
                  (row) =>
                    `<tr><td class="cell-mono">${escapeHtml(row.filePath)}</td><td><span style="color:${SEVERITY_COLOR[row.maxSeverity]};font-weight:600">${SEVERITY_LABEL[row.maxSeverity]}</span></td><td class="cell-num">${row.count}</td></tr>`,
                )
                .join('')
            : '<tr><td colspan="3" class="note">无命中文件</td></tr>'
        }
      </tbody>
    </table>
    <h3>目录分布</h3>
    ${topDirs.length ? barRows(topDirs.map((row) => ({ label: row.dir, count: row.count, color: '#1f7fe0' }))) : '<p class="note">无数据</p>'}
  </section>

  <section>
    <h2>四、问题明细</h2>
    ${
      current.length === 0
        ? '<p class="conclusion">本次扫描未发现风险问题。</p>'
        : detailSections
    }
    ${
      fixed.length
        ? `<h3>已修复（对比基线，${fixed.length} 项）</h3>${issueTableHtml(fixed, snippets, { left: 0 })}`
        : ''
    }
  </section>

  <footer>
    本报告由 Opengrep Studio 码审工作台自动生成 · 生成时间 ${formatDateTime(meta.generatedAt)} ·
    规则命中与严重度由 opengrep 引擎产出，请结合业务上下文人工复核。
  </footer>
</div>
</body>
</html>`;
}
