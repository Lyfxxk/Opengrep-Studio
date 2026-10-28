import { isActiveIssue } from './db.js';
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

interface ReportMeta {
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

interface ReportTotals {
  /** 当前问题总数（不含基线对比产生的"已修复"项，与 scan.issueCount 口径一致） */
  total: number;
  bySeverity: Record<Severity, number>;
  byComparison: Record<ComparisonStatus, number>;
}

interface ReportRuleAgg {
  ruleId: string;
  count: number;
  /** 该规则命中的最高严重度 */
  severity: Severity;
  rulepackName?: string;
}

interface ReportFileAgg {
  filePath: string;
  count: number;
  maxSeverity: Severity;
}

interface ReportDirAgg {
  dir: string;
  count: number;
}

interface ReportReviewSummary {
  /** 已人工复核的问题数（确认 + 误报 + 有条件接受） */
  reviewed: number;
  confirmed: number;
  falsePositives: number;
  accepted: number;
}

interface ReportIssueReview {
  status: ReviewStatus;
  reason?: string;
  reviewer?: string;
  updatedAt?: string;
}

/** 结论的结构化载荷：code 前端按 report.conclusion.<code> 翻译，message 是中文兜底 */
export interface ConclusionPayload {
  code: string;
  params: Record<string, unknown>;
  message: string;
}

export interface ReportData {
  meta: ReportMeta;
  totals: ReportTotals;
  conclusion: string;
  /** 在线报告页按语言重拼结论用；旧扫描缓存或异常场景可能缺失（前端回落 conclusion 原文） */
  conclusionCode?: ConclusionPayload | null;
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

export type ReportLang = 'zh' | 'zh-Hant' | 'en';

const HANT_SEVERITY: Record<Severity, string> = {
  critical: '嚴重',
  high: '高危',
  medium: '中危',
  low: '低危',
};
const HANT_COMPARISON: Record<ComparisonStatus, string> = {
  new: '新增',
  fixed: '已修復',
  remaining: '遺留',
};
const HANT_REVIEW: Record<ReviewStatus, string> = {
  pending: '待複核',
  confirmed: '已確認',
  false_positive: '誤報',
  accepted: '已接受',
};

/** 自包含 HTML 报告的界面文案：简体为原文，繁体走台灣用語；结论句按 conclusionCode 参数重拼 */
const REPORT_TEXT_ZH = {
  htmlLang: 'zh-CN',
  brand: 'Opengrep Studio · 码审工作台',
  docTitle: '代码审计测试报告',
  titleSuffix: '测试报告',
  severity: SEVERITY_LABEL,
  comparison: COMPARISON_LABEL,
  review: REVIEW_LABEL,
  sections: {
    summary: '一、扫描概要',
    conclusion: '二、总体结论',
    distribution: '三、风险分布',
    issues: '四、问题明细',
  },
  meta: {
    projectName: '项目名称',
    projectDescription: '项目描述',
    language: '主要语言',
    scanId: '扫描编号',
    scannedAt: '扫描时间',
    duration: '引擎耗时',
    fileCount: '检查文件数',
    baseline: '基线扫描',
    engine: '扫描引擎',
    sourceHash: '源码哈希',
    commandLine: '引擎命令行',
    rulepacks: '生效规则包',
    generatedAt: '报告生成时间',
  },
  fileCountUnit: (n: number) => `${n} 个`,
  durationSeconds: (s: number) => `${s} 秒`,
  durationMinutes: (m: number, s: number) => `${m} 分 ${s} 秒`,
  totalIssues: '问题总数',
  reviewed: '已人工复核',
  confirmed: '复核确认',
  falsePositive: '判定误报',
  accepted: '有条件接受',
  vsBaseline: '（对比基线）',
  bySeverity: '按严重度',
  topRules: (n: number) => `高频规则 Top ${n}`,
  topFiles: (n: number) => `热点文件 Top ${n}`,
  dirDist: '目录分布',
  thRule: '规则',
  thSeverity: '描述最高严重度',
  thHits: '命中',
  thPack: '规则包',
  thFile: '文件',
  thMaxSeverity: '最高严重度',
  noRules: '无命中规则',
  noFiles: '无命中文件',
  noData: '无数据',
  issueTableHead: ['#', '位置', '规则', '描述', '状态', '人工复核', '规则包'],
  reviewPending: '待复核',
  reviewerLabel: '复核人',
  severityHeading: (label: string, count: number) => `${label}问题（${count} 项）`,
  fixedHeading: (count: number) => `已修复（对比基线，${count} 项）`,
  snippetOverflow: (limit: number) =>
    `代码片段超过上限，仅展示前 ${limit} 条，其余请结合扫描结果页查看。`,
  noIssues: '本次扫描未发现风险问题。',
  footer: (time: string) =>
    `本报告由 Opengrep Studio 码审工作台自动生成 · 生成时间 ${time} · 规则命中与严重度由 opengrep 引擎产出，请结合业务上下文人工复核。`,
  summaryReview: (s: ReportReviewSummary) =>
    ` 人工复核已完成 ${s.reviewed} 项（确认 ${s.confirmed}、误报 ${s.falsePositives}、有条件接受 ${s.accepted}）。`,
  listSeparator: '、',
  sentenceSeparator: '',
  severityPhrase: (label: string, count: number) => `${label} ${count} 项`,
  conclusionNoIssues: (files: string) =>
    `本次扫描共检查 ${files} 个源码文件，未命中任何已启用规则，未发现风险问题。`,
  conclusionSummary: (files: string, total: number, sevText: string) =>
    `本次扫描共检查 ${files} 个源码文件，发现 ${total} 个风险问题（${sevText}）。`,
  comparisonSentence: (baseline: string, added: number, remaining: number, fixed: number) =>
    `与基线扫描 ${baseline} 相比：新增 ${added} 项、遗留 ${remaining} 项、已修复 ${fixed} 项。`,
  urgentHint: (urgent: number) => `建议优先处理严重与高危问题（共 ${urgent} 项），修复后重新扫描回归验证。`,
};

const REPORT_TEXT_HANT: typeof REPORT_TEXT_ZH = {
  htmlLang: 'zh-Hant',
  brand: 'Opengrep Studio · 碼審工作台',
  docTitle: '程式碼稽核測試報告',
  titleSuffix: '測試報告',
  severity: HANT_SEVERITY,
  comparison: HANT_COMPARISON,
  review: HANT_REVIEW,
  sections: {
    summary: '一、掃描概要',
    conclusion: '二、總體結論',
    distribution: '三、風險分佈',
    issues: '四、問題明細',
  },
  meta: {
    projectName: '專案名稱',
    projectDescription: '專案描述',
    language: '主要語言',
    scanId: '掃描編號',
    scannedAt: '掃描時間',
    duration: '引擎耗時',
    fileCount: '檢查檔案數',
    baseline: '基線掃描',
    engine: '掃描引擎',
    sourceHash: '原始碼雜湊',
    commandLine: '引擎命令列',
    rulepacks: '生效規則包',
    generatedAt: '報告產生時間',
  },
  fileCountUnit: (n: number) => `${n} 個`,
  durationSeconds: (s: number) => `${s} 秒`,
  durationMinutes: (m: number, s: number) => `${m} 分 ${s} 秒`,
  totalIssues: '問題總數',
  reviewed: '已人工複核',
  confirmed: '複核確認',
  falsePositive: '判定誤報',
  accepted: '有條件接受',
  vsBaseline: '（對比基線）',
  bySeverity: '按嚴重度',
  topRules: (n: number) => `高頻規則 Top ${n}`,
  topFiles: (n: number) => `熱點檔案 Top ${n}`,
  dirDist: '目錄分佈',
  thRule: '規則',
  thSeverity: '最高嚴重度',
  thHits: '命中',
  thPack: '規則包',
  thFile: '檔案',
  thMaxSeverity: '最高嚴重度',
  noRules: '無命中規則',
  noFiles: '無命中檔案',
  noData: '無資料',
  issueTableHead: ['#', '位置', '規則', '描述', '狀態', '人工複核', '規則包'],
  reviewPending: '待複核',
  reviewerLabel: '複核人',
  severityHeading: (label: string, count: number) => `${label}問題（${count} 項）`,
  fixedHeading: (count: number) => `已修復（對比基線，${count} 項）`,
  snippetOverflow: (limit: number) =>
    `程式碼片段超過上限，僅展示前 ${limit} 條，其餘請結合掃描結果頁查看。`,
  noIssues: '本次掃描未發現風險問題。',
  footer: (time: string) =>
    `本報告由 Opengrep Studio 碼審工作台自動產生 · 產生時間 ${time} · 規則命中與嚴重度由 opengrep 引擎產出，請結合業務上下文人工複核。`,
  summaryReview: (s: ReportReviewSummary) =>
    ` 人工複核已完成 ${s.reviewed} 項（確認 ${s.confirmed}、誤報 ${s.falsePositives}、有條件接受 ${s.accepted}）。`,
  listSeparator: '、',
  sentenceSeparator: '',
  severityPhrase: (label: string, count: number) => `${label} ${count} 項`,
  conclusionNoIssues: (files: string) =>
    `本次掃描共檢查 ${files} 個原始碼檔案，未命中任何已啟用規則，未發現風險問題。`,
  conclusionSummary: (files: string, total: number, sevText: string) =>
    `本次掃描共檢查 ${files} 個原始碼檔案，發現 ${total} 個風險問題（${sevText}）。`,
  comparisonSentence: (baseline: string, added: number, remaining: number, fixed: number) =>
    `與基線掃描 ${baseline} 相比：新增 ${added} 項、遺留 ${remaining} 項、已修復 ${fixed} 項。`,
  urgentHint: (urgent: number) => `建議優先處理嚴重與高危問題（共 ${urgent} 項），修復後重新掃描回歸驗證。`,
};

const EN_SEVERITY: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
const EN_COMPARISON: Record<ComparisonStatus, string> = {
  new: 'New',
  fixed: 'Fixed',
  remaining: 'Remaining',
};
const EN_REVIEW: Record<ReviewStatus, string> = {
  pending: 'Pending review',
  confirmed: 'Confirmed',
  false_positive: 'False positive',
  accepted: 'Accepted',
};

const REPORT_TEXT_EN: typeof REPORT_TEXT_ZH = {
  htmlLang: 'en',
  brand: 'Opengrep Studio · Code Audit Workbench',
  docTitle: 'Code Audit Test Report',
  titleSuffix: 'Test Report',
  severity: EN_SEVERITY,
  comparison: EN_COMPARISON,
  review: EN_REVIEW,
  sections: {
    summary: '1. Scan summary',
    conclusion: '2. Overall conclusion',
    distribution: '3. Risk distribution',
    issues: '4. Issue details',
  },
  meta: {
    projectName: 'Project name',
    projectDescription: 'Description',
    language: 'Primary language',
    scanId: 'Scan ID',
    scannedAt: 'Scanned at',
    duration: 'Engine time',
    fileCount: 'Files checked',
    baseline: 'Baseline scan',
    engine: 'Scan engine',
    sourceHash: 'Source SHA-256',
    commandLine: 'Engine command line',
    rulepacks: 'Rule packs used',
    generatedAt: 'Report generated at',
  },
  fileCountUnit: (n: number) => `${n} files`,
  durationSeconds: (s: number) => `${s}s`,
  durationMinutes: (m: number, s: number) => `${m}m ${s}s`,
  totalIssues: 'Total issues',
  reviewed: 'Reviewed',
  confirmed: 'Confirmed',
  falsePositive: 'False positive',
  accepted: 'Accepted',
  vsBaseline: ' (vs baseline)',
  bySeverity: 'By severity',
  topRules: (n: number) => `Top ${n} rules`,
  topFiles: (n: number) => `Top ${n} files`,
  dirDist: 'By directory',
  thRule: 'Rule',
  thSeverity: 'Max severity',
  thHits: 'Hits',
  thPack: 'Rule pack',
  thFile: 'File',
  thMaxSeverity: 'Max severity',
  noRules: 'No rule hits',
  noFiles: 'No file hits',
  noData: 'No data',
  issueTableHead: ['#', 'Location', 'Rule', 'Description', 'Status', 'Review', 'Rule pack'],
  reviewPending: 'Pending review',
  reviewerLabel: 'Reviewer',
  severityHeading: (label: string, count: number) => `${label} issues (${count})`,
  fixedHeading: (count: number) => `Fixed (vs baseline, ${count})`,
  snippetOverflow: (limit: number) =>
    `Snippet limit reached — showing the first ${limit}; open the scan result page for the rest.`,
  noIssues: 'No risk issues were found in this scan.',
  footer: (time: string) =>
    `Generated by Opengrep Studio · ${time} · Rule hits and severities come from the opengrep engine; review them in business context.`,
  summaryReview: (s: ReportReviewSummary) =>
    ` Manual review: ${s.reviewed} reviewed (${s.confirmed} confirmed, ${s.falsePositives} false positive, ${s.accepted} accepted).`,
  listSeparator: ', ',
  sentenceSeparator: ' ',
  severityPhrase: (label: string, count: number) => `${label} ${count}`,
  conclusionNoIssues: (files: string) =>
    `This scan checked ${files} source files, matched no enabled rules, and found no risk issues.`,
  conclusionSummary: (files: string, total: number, sevText: string) =>
    `This scan checked ${files} source files and found ${total} risk issues (${sevText}).`,
  comparisonSentence: (baseline: string, added: number, remaining: number, fixed: number) =>
    `Compared with baseline scan ${baseline}: ${added} new, ${remaining} remaining, ${fixed} fixed.`,
  urgentHint: (urgent: number) =>
    `Prioritize critical and high issues (${urgent} in total), then rescan to verify.`,
};

type ReportText = typeof REPORT_TEXT_ZH;

const REPORT_TEXT: Record<ReportLang, ReportText> = {
  zh: REPORT_TEXT_ZH,
  'zh-Hant': REPORT_TEXT_HANT,
  en: REPORT_TEXT_EN,
};

/** 按 conclusionCode 的参数重拼结论句，避免繁体报告里夹一段简体 */
function localizedConclusion(data: ReportData, text: ReportText): string {
  const payload = data.conclusionCode;
  const params = payload?.params ?? {};
  const num = (key: string) => Number(params[key] ?? 0);
  const files = params.files === undefined || params.files === 0 ? '—' : String(params.files);
  let base: string;
  if (!payload) {
    // 旧扫描缺少结构化载荷，只能沿用中文结论原文
    base = data.conclusion;
  } else if (payload.code === 'summary') {
    const sevText = SEVERITY_ORDER.filter((sev) => num(sev) > 0)
      .map((sev) => text.severityPhrase(text.severity[sev], num(sev)))
      .join(text.listSeparator);
    const parts = [text.conclusionSummary(files, num('total'), sevText)];
    if (params.baseline) {
      parts.push(
        text.comparisonSentence(
          String(params.baseline),
          num('baselineNew'),
          num('baselineRemaining'),
          num('baselineFixed'),
        ),
      );
    }
    if (num('urgent') > 0) parts.push(text.urgentHint(num('urgent')));
    base = parts.join(text.sentenceSeparator);
  } else {
    base = text.conclusionNoIssues(files);
  }
  const review = data.reviewStats;
  return review && review.reviewed > 0 ? `${base}${text.summaryReview(review)}` : base;
}

const TOP_RULES_LIMIT = 10;
const TOP_FILES_LIMIT = 10;
const TOP_DIRS_LIMIT = 8;
/** HTML 报告内嵌代码片段的条数上限（严重+高危合计），避免大扫描把报告撑到几十 MB */
const SNIPPET_LIMIT = 100;

export function buildReportData(
  scan: ScanRecord,
  project: Project,
  issues: IssueRow[],
  engineVersion?: string,
  reviews: Review[] = [],
): ReportData {
  // 严重度分布只统计"当前存在"的问题；已修复项单独出现在对比统计里
  const current = issues.filter(isActiveIssue);
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
    conclusionCode: buildConclusionPayload(scan, current.length, bySeverity, byComparison),
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

/**
 * 结论的结构化载荷：code+params 供在线报告页按当前语言重拼；
 * message（中文兜底）供自包含 HTML 报告与前后端版本错位场景直接使用。
 * 复核句不在载荷内——它属于统计呈现，由前端 reviewStats 独立渲染。
 */
function buildConclusionPayload(
  scan: ScanRecord,
  total: number,
  bySeverity: Record<Severity, number>,
  byComparison: Record<ComparisonStatus, number>,
): ConclusionPayload | null {
  const fileCount = scan.fileCount ?? 0;
  const urgent = bySeverity.critical + bySeverity.high;
  if (total === 0) {
    return {
      code: 'noIssues',
      params: { files: fileCount, baseline: scan.baselineScanId ?? '' },
      message: `本次扫描共检查 ${fileCount || '—'} 个源码文件，未命中任何已启用规则，未发现风险问题。`,
    };
  }
  return {
    code: 'summary',
    params: {
      files: fileCount,
      total,
      critical: bySeverity.critical,
      high: bySeverity.high,
      medium: bySeverity.medium,
      low: bySeverity.low,
      baseline: scan.baselineScanId ?? '',
      baselineNew: byComparison.new,
      baselineRemaining: byComparison.remaining,
      baselineFixed: byComparison.fixed,
      urgent,
    },
    message: buildConclusion(scan, total, bySeverity, byComparison),
  };
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

function formatDuration(seconds: number, text: ReportText): string {
  if (seconds < 60) return text.durationSeconds(seconds);
  return text.durationMinutes(Math.floor(seconds / 60), seconds % 60);
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
  text: ReportText,
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
        ? `<span class="tag" style="background:${REVIEW_COLOR[issue.review.status]}1a;color:${REVIEW_COLOR[issue.review.status]}" title="${escapeHtml([`${text.reviewerLabel}：${issue.review.reviewer ?? '—'}`, issue.review.reason].filter(Boolean).join('；'))}">${text.review[issue.review.status]}</span>`
        : `<span class="tag tag-pending">${text.reviewPending}</span>`;
      return `<tr>
          <td class="cell-num">${index + 1}</td>
          <td class="cell-mono">${escapeHtml(issue.filePath)}:${issue.startLine}</td>
          <td class="cell-mono">${escapeHtml(issue.ruleId)}</td>
          <td>${escapeHtml(issue.message)}</td>
          <td><span class="tag tag-${issue.comparisonStatus}">${text.comparison[issue.comparisonStatus]}</span></td>
          <td>${reviewTag}</td>
          <td class="cell-sub">${escapeHtml(issue.rulepackName ?? '—')}</td>
        </tr>${snippetHtml}`;
    })
    .join('');
  return `
    <table class="issue-table">
      <thead>
        <tr>${text.issueTableHead.map((th) => `<th>${th}</th>`).join('')}</tr>
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
  lang: ReportLang = 'zh',
): string {
  const { meta, totals, topRules, topFiles, topDirs, reviewStats } = data;
  const text = REPORT_TEXT[lang];
  const current = issues.filter(isActiveIssue);
  const fixed = issues.filter((issue) => issue.comparisonStatus === 'fixed');

  const snippets = new Map<string, string>();
  if (options.includeSnippets) {
    for (const issue of issues) {
      if (issue.matchedLines) snippets.set(issue.id, issue.matchedLines);
    }
  }
  const snippetBudget = { left: SNIPPET_LIMIT };

  const severityStats = SEVERITY_ORDER.map((sev) => ({
    label: text.severity[sev],
    count: totals.bySeverity[sev],
    color: SEVERITY_COLOR[sev],
  }));
  const comparisonStats: Array<{ label: string; count: number; color: string }> = meta.baselineScanId
    ? [
        { label: text.comparison.new, count: totals.byComparison.new, color: '#d92b2b' },
        { label: text.comparison.remaining, count: totals.byComparison.remaining, color: '#e8930c' },
        { label: text.comparison.fixed, count: totals.byComparison.fixed, color: '#1e9e6a' },
      ]
    : [];

  const metaRows: Array<[string, string]> = [
    [text.meta.projectName, escapeHtml(meta.projectName)],
    ...(meta.projectDescription ? ([[text.meta.projectDescription, escapeHtml(meta.projectDescription)]] as Array<[string, string]>) : []),
    ...(meta.language ? ([[text.meta.language, escapeHtml(meta.language)]] as Array<[string, string]>) : []),
    [text.meta.scanId, `<span class="cell-mono">${escapeHtml(meta.scanId)}</span>`],
    [text.meta.scannedAt, formatDateTime(meta.scannedAt)],
    ...(meta.durationSeconds !== undefined
      ? ([[text.meta.duration, formatDuration(meta.durationSeconds, text)]] as Array<[string, string]>)
      : []),
    [text.meta.fileCount, meta.fileCount ? text.fileCountUnit(meta.fileCount) : '—'],
    ...(meta.baselineScanId
      ? ([[text.meta.baseline, `<span class="cell-mono">${escapeHtml(meta.baselineScanId)}</span>`]] as Array<[string, string]>)
      : []),
    ...(meta.engineVersion ? ([[text.meta.engine, `opengrep v${escapeHtml(meta.engineVersion)}`]] as Array<[string, string]>) : []),
    ...(meta.sourceHash
      ? ([[text.meta.sourceHash, `<span class="cell-mono">${escapeHtml(meta.sourceHash)}</span>`]] as Array<[string, string]>)
      : []),
    ...(meta.commandLine
      ? ([[text.meta.commandLine, `<span class="cell-mono" style="word-break:break-all">${escapeHtml(meta.commandLine)}</span>`]] as Array<[string, string]>)
      : []),
    [
      text.meta.rulepacks,
      meta.rulepacks?.length
        ? meta.rulepacks.map((pack) => escapeHtml(pack.name)).join('、')
        : meta.rules
          ? escapeHtml(meta.rules)
          : '—',
    ],
    [text.meta.generatedAt, formatDateTime(meta.generatedAt)],
  ];

  const detailSections = SEVERITY_ORDER.map((sev) => {
    const list = current.filter((issue) => issue.severity === sev);
    if (list.length === 0) return '';
    const urgent = sev === 'critical' || sev === 'high';
    return `
      <h3><span class="sev-dot" style="background:${SEVERITY_COLOR[sev]}"></span>${text.severityHeading(text.severity[sev], list.length)}</h3>
      ${issueTableHtml(list, snippets, snippetBudget, text)}
      ${urgent && options.includeSnippets && snippetBudget.left <= 0
        ? `<p class="note">${text.snippetOverflow(SNIPPET_LIMIT)}</p>`
        : ''}`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="${text.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text.titleSuffix} · ${escapeHtml(meta.projectName)} · ${escapeHtml(meta.scanId)}</title>
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
    <div class="brand">${text.brand}</div>
    <h1>${text.docTitle}</h1>
    <div class="subtitle">${escapeHtml(meta.projectName)}<span class="cell-mono" style="margin-left:10px;font-size:13px;color:#6b7689">${escapeHtml(meta.scanId)}</span></div>
  </header>

  <section>
    <h2>${text.sections.summary}</h2>
    <table class="meta-table">
      <tbody>
        ${metaRows.map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join('')}
      </tbody>
    </table>
  </section>

  <section>
    <h2>${text.sections.conclusion}</h2>
    <p class="conclusion">${escapeHtml(lang === 'zh' ? data.conclusion : localizedConclusion(data, text))}</p>
    <div class="stat-grid">
      ${severityStats
        .map(
          (item) =>
            `<div class="stat-card"><div class="num" style="color:${item.color}">${item.count}</div><div class="label">${item.label}</div></div>`,
        )
        .join('')}
      <div class="stat-card"><div class="num">${totals.total}</div><div class="label">${text.totalIssues}</div></div>
    </div>
    ${
      comparisonStats.length
        ? `<div class="stat-grid">${comparisonStats
            .map(
              (item) =>
                `<div class="stat-card"><div class="num" style="color:${item.color}">${item.count}</div><div class="label">${item.label}${text.vsBaseline}</div></div>`,
            )
            .join('')}</div>`
        : ''
    }
    ${
      reviewStats
        ? `<div class="stat-grid">
            <div class="stat-card"><div class="num" style="color:#1f7fe0">${reviewStats.reviewed}</div><div class="label">${text.reviewed}</div></div>
            <div class="stat-card"><div class="num" style="color:#d92b2b">${reviewStats.confirmed}</div><div class="label">${text.confirmed}</div></div>
            <div class="stat-card"><div class="num" style="color:#1e9e6a">${reviewStats.falsePositives}</div><div class="label">${text.falsePositive}</div></div>
            <div class="stat-card"><div class="num" style="color:#e8930c">${reviewStats.accepted}</div><div class="label">${text.accepted}</div></div>
          </div>`
        : ''
    }
  </section>

  <section>
    <h2>${text.sections.distribution}</h2>
    <h3>${text.bySeverity}</h3>
    ${barRows(severityStats)}
    <h3>${text.topRules(topRules.length)}</h3>
    <table>
      <thead><tr><th>${text.thRule}</th><th>${text.thSeverity}</th><th>${text.thHits}</th><th>${text.thPack}</th></tr></thead>
      <tbody>
        ${
          topRules.length
            ? topRules
                .map(
                  (row) =>
                    `<tr><td class="cell-mono">${escapeHtml(row.ruleId)}</td><td><span style="color:${SEVERITY_COLOR[row.severity]};font-weight:600">${text.severity[row.severity]}</span></td><td class="cell-num">${row.count}</td><td class="cell-sub">${escapeHtml(row.rulepackName ?? '—')}</td></tr>`,
                )
                .join('')
            : '<tr><td colspan="4" class="note">${text.noRules}</td></tr>'
        }
      </tbody>
    </table>
    <h3>${text.topFiles(topFiles.length)}</h3>
    <table>
      <thead><tr><th>${text.thFile}</th><th>${text.thMaxSeverity}</th><th>${text.thHits}</th></tr></thead>
      <tbody>
        ${
          topFiles.length
            ? topFiles
                .map(
                  (row) =>
                    `<tr><td class="cell-mono">${escapeHtml(row.filePath)}</td><td><span style="color:${SEVERITY_COLOR[row.maxSeverity]};font-weight:600">${text.severity[row.maxSeverity]}</span></td><td class="cell-num">${row.count}</td></tr>`,
                )
                .join('')
            : '<tr><td colspan="3" class="note">${text.noFiles}</td></tr>'
        }
      </tbody>
    </table>
    <h3>${text.dirDist}</h3>
    ${topDirs.length ? barRows(topDirs.map((row) => ({ label: row.dir, count: row.count, color: '#1f7fe0' }))) : '<p class="note">' + text.noData + '</p>'}
  </section>

  <section>
    <h2>${text.sections.issues}</h2>
    ${
      current.length === 0
        ? '<p class="conclusion">' + text.noIssues + '</p>'
        : detailSections
    }
    ${
      fixed.length
        ? `<h3>${text.fixedHeading(fixed.length)}</h3>${issueTableHtml(fixed, snippets, { left: 0 }, text)}`
        : ''
    }
  </section>

  <footer>
    ${text.footer(formatDateTime(meta.generatedAt))}
  </footer>
</div>
</body>
</html>`;
}
