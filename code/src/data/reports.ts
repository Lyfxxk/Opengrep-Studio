import { mockIssuesForScan, type IIssue } from '@/data/issues';
import type { IReportReviewStats } from '@/data/diffs';
import type { IScanResult } from '@/data/scanresults';
import i18n from '@/i18n';
import { SEVERITY_ORDER } from '@/lib/severity';

interface IReportMeta {
  projectId: string;
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
  sourceHash?: string;
  commandLine?: string;
  generatedAt: string;
}

interface IReportTotals {
  total: number;
  bySeverity: Record<IIssue['severity'], number>;
  byComparison: Record<IIssue['comparisonStatus'], number>;
}

interface IReportFileAgg {
  filePath: string;
  count: number;
  maxSeverity: IIssue['severity'];
  topRule?: string;
}

interface IReportConclusionCode {
  code: string;
  params: Record<string, unknown>;
  message: string;
}

export interface IReportData {
  meta: IReportMeta;
  totals: IReportTotals;
  conclusion: string;
  conclusionCode?: IReportConclusionCode | null;
  topFiles: IReportFileAgg[];
  issues: IIssue[];
  reviewStats?: IReportReviewStats;
}

const SEVERITY_RANK = Object.fromEntries(
  SEVERITY_ORDER.map((severity, index) => [severity, index]),
) as Record<IIssue['severity'], number>;

export function buildMockReport(scan: IScanResult, projectName: string): IReportData {
  const issues = mockIssuesForScan(scan.id);
  const current = issues.filter((issue) => issue.comparisonStatus !== 'fixed');

  const bySeverity: IReportTotals['bySeverity'] = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of current) bySeverity[issue.severity] += 1;
  const byComparison: IReportTotals['byComparison'] = { new: 0, fixed: 0, remaining: 0 };
  for (const issue of issues) byComparison[issue.comparisonStatus] += 1;

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
      projectId: scan.projectId,
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
