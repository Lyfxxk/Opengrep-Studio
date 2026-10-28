import { mockIssuesForScan, type IIssue } from '@/data/issues';
import type { IReportReviewStats } from '@/data/diffs';
import type { IScanResult } from '@/data/scanresults';
import i18n from '@/i18n';
import { SEVERITY_ORDER } from '@/lib/severity';

export interface IReportMeta {
  projectName: string;
  projectDescription?: string;
  language: string;
  scanId: string;
  scannedAt: string;
  finishedAt?: string;
  durationSeconds?: number;
  fileCount: number;
  baselineScanId?: string;
  rulepacks?: Array<{ id: string; name: string }>;
  rules?: string;
  engineVersion?: string;
  /** 源码快照 SHA-256（可复现清单，旧记录可能没有） */
  sourceHash?: string;
  /** 发起扫描时的完整引擎命令行 */
  commandLine?: string;
  generatedAt: string;
}

interface IReportTotals {
  /** 当前问题总数（不含"已修复"项，与 issueCount 口径一致） */
  total: number;
  bySeverity: Record<IIssue['severity'], number>;
  byComparison: Record<IIssue['comparisonStatus'], number>;
}

interface IReportFileAgg {
  filePath: string;
  count: number;
  maxSeverity: IIssue['severity'];
  /** 该文件命中次数最多的规则（行动清单副行用） */
  topRule?: string;
}

/** 服务端结论的结构化载荷：code 对应 i18n 键 reportConclusion.<code>，message 为中文兜底 */
export interface IReportConclusionCode {
  code: string;
  params: Record<string, unknown>;
  message: string;
}

export interface IReportData {
  meta: IReportMeta;
  totals: IReportTotals;
  conclusion: string;
  /** 服务端下发的结论载荷（演示模式与旧数据缺失，此时回落 conclusion 原文） */
  conclusionCode?: IReportConclusionCode | null;
  topFiles: IReportFileAgg[];
  issues: IIssue[];
  /** 人工复核统计（无复核记录时为 undefined） */
  reviewStats?: IReportReviewStats;
}

/** severity → 排序权重：由展示顺序（lib/severity.ts 的 SEVERITY_ORDER）派生，新增/调级只改那一处 */
const SEVERITY_RANK = Object.fromEntries(
  SEVERITY_ORDER.map((severity, index) => [severity, index]),
) as Record<IIssue['severity'], number>;

/** 演示模式下从本地扫描/问题数据聚合报告（与服务端 buildReportData 同口径） */
export function buildMockReport(scan: IScanResult, projectName: string): IReportData {
  const issues = mockIssuesForScan(scan.id);
  const current = issues.filter((issue) => issue.comparisonStatus !== 'fixed');

  const bySeverity: IReportTotals['bySeverity'] = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of current) bySeverity[issue.severity] += 1;
  const byComparison: IReportTotals['byComparison'] = { new: 0, fixed: 0, remaining: 0 };
  for (const issue of issues) byComparison[issue.comparisonStatus] += 1;

  // 文件级聚合带每个文件的代表规则，与服务端 buildReportData 同口径
  const fileAgg = new Map<string, IReportFileAgg & { ruleCounts: Map<string, number> }>();
  for (const issue of current) {
    let entry = fileAgg.get(issue.filePath);
    if (!entry) {
      entry = { filePath: issue.filePath, count: 0, maxSeverity: issue.severity, ruleCounts: new Map() };
      fileAgg.set(issue.filePath, entry);
    }
    entry.count += 1;
    entry.ruleCounts.set(issue.ruleId, (entry.ruleCounts.get(issue.ruleId) ?? 0) + 1);
    if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[entry.maxSeverity]) {
      entry.maxSeverity = issue.severity;
    }
  }

  const durationSeconds =
    scan.finishedAt && scan.scannedAt
      ? Math.max(
          0,
          Math.round(
            (new Date(scan.finishedAt).getTime() - new Date(scan.scannedAt).getTime()) / 1000,
          ),
        )
      : undefined;

  const conclusion =
    current.length === 0
      ? i18n.t('api.demoNoRiskConclusion')
      : i18n.t('api.demoConclusion', {
          total: current.length,
          critical: bySeverity.critical,
          high: bySeverity.high,
          medium: bySeverity.medium,
          low: bySeverity.low,
        });

  return {
    meta: {
      projectName,
      language: 'TypeScript',
      scanId: scan.id,
      scannedAt: scan.scannedAt,
      finishedAt: scan.finishedAt,
      durationSeconds,
      fileCount: scan.fileCount ?? 128,
      baselineScanId: scan.baselineScanId,
      rulepacks: scan.rulepacks ?? [{ id: 'builtin-js', name: 'JavaScript 内置安全规则包' }],
      generatedAt: new Date().toISOString(),
    },
    totals: { total: current.length, bySeverity, byComparison },
    conclusion,
    topFiles: [...fileAgg.values()]
      .map(({ ruleCounts, ...rest }) => {
        const [topRule] = [...ruleCounts.entries()].sort((a, b) => b[1] - a[1]);
        return topRule ? { ...rest, topRule: topRule[0] } : rest;
      })
      .sort((a, b) => b.count - a.count || SEVERITY_RANK[a.maxSeverity] - SEVERITY_RANK[b.maxSeverity])
      .slice(0, 10),
    issues,
  };
}
