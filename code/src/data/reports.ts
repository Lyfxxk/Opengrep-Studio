import { MOCK_ISSUES, type IIssue } from '@/data/issues';
import type { IReportReviewStats } from '@/data/diffs';
import type { IScanResult } from '@/data/scanresults';

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

export interface IReportTotals {
  /** 当前问题总数（不含"已修复"项，与 issueCount 口径一致） */
  total: number;
  bySeverity: Record<IIssue['severity'], number>;
  byComparison: Record<IIssue['comparisonStatus'], number>;
}

export interface IReportRuleAgg {
  ruleId: string;
  count: number;
  severity: IIssue['severity'];
  rulepackName?: string;
}

export interface IReportFileAgg {
  filePath: string;
  count: number;
  maxSeverity: IIssue['severity'];
}

export interface IReportDirAgg {
  dir: string;
  count: number;
}

export interface IReportData {
  meta: IReportMeta;
  totals: IReportTotals;
  conclusion: string;
  topRules: IReportRuleAgg[];
  topFiles: IReportFileAgg[];
  topDirs: IReportDirAgg[];
  issues: IIssue[];
  /** 人工复核统计（无复核记录时为 undefined） */
  reviewStats?: IReportReviewStats;
}

export const REPORT_SEVERITY_ORDER: Array<IIssue['severity']> = [
  'critical',
  'high',
  'medium',
  'low',
];

const SEVERITY_RANK: Record<IIssue['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** 演示模式下从本地扫描/问题数据聚合报告（与服务端 buildReportData 同口径） */
export function buildMockReport(scan: IScanResult, projectName: string): IReportData {
  const issues = MOCK_ISSUES.filter((issue) => issue.scanId === scan.id);
  const current = issues.filter((issue) => issue.comparisonStatus !== 'fixed');

  const bySeverity: IReportTotals['bySeverity'] = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of current) bySeverity[issue.severity] += 1;
  const byComparison: IReportTotals['byComparison'] = { new: 0, fixed: 0, remaining: 0 };
  for (const issue of issues) byComparison[issue.comparisonStatus] += 1;

  const ruleAgg = new Map<string, IReportRuleAgg>();
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

  const fileAgg = new Map<string, IReportFileAgg>();
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

  const dirAgg = new Map<string, number>();
  for (const issue of current) {
    const sep = issue.filePath.indexOf('/');
    const dir = sep > 0 ? issue.filePath.slice(0, sep) : '（根目录）';
    dirAgg.set(dir, (dirAgg.get(dir) ?? 0) + 1);
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
      ? '本次扫描未命中任何已启用规则，未发现风险问题。'
      : `本次扫描发现 ${current.length} 个风险问题，其中严重 ${bySeverity.critical} 项、高危 ${bySeverity.high} 项、中危 ${bySeverity.medium} 项、低危 ${bySeverity.low} 项。`;

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
    topRules: [...ruleAgg.values()]
      .sort((a, b) => b.count - a.count || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
      .slice(0, 10),
    topFiles: [...fileAgg.values()]
      .sort((a, b) => b.count - a.count || SEVERITY_RANK[a.maxSeverity] - SEVERITY_RANK[b.maxSeverity])
      .slice(0, 10),
    topDirs: [...dirAgg.entries()]
      .map(([dir, count]) => ({ dir, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    issues,
  };
}
