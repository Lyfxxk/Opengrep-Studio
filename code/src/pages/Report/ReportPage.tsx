import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { usePackDisplayName } from '@/lib/packName';
import { ArrowLeft, Download, Loader2, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { REVIEW_BADGE_CLASS, type IIssue } from '@/data/issues';
import { COMPARISON_VISUALS } from '@/data/constants';
import { formatDateTime, formatDuration } from '@/lib/format';
import { api } from '@/lib/api';
import { type IReportData } from '@/data/reports';
import { lookupRuleMessage, useRuleMessageMap } from '@/lib/ruleMessages';
import {
  SEVERITY_BADGE_CLASS,
  SEVERITY_BAR_CLASS,
  SEVERITY_BORDER_CLASS,
  SEVERITY_ORDER,
  SEVERITY_TEXT_CLASS,
} from '@/lib/severity';
import { cn } from '@/lib/utils';

type Severity = IIssue['severity'];

/** 明细条目的一句话说明：取中文说明/引擎消息首句，与离线 HTML 报告同口径 */
function firstSentence(value: string): string {
  const cut = value.trim().split(/(?<=[。！？])/)[0] || value;
  return cut.length > 64 ? `${cut.slice(0, 64)}…` : cut;
}

/** 路径拆「目录 + 文件名」：目录允许断行，文件名不折断，避免按字符断词 */
function splitPath(path: string) {
  const cut = path.lastIndexOf('/') + 1;
  return { dir: path.slice(0, cut), name: path.slice(cut) };
}

function PathLabel({ path, className }: { path: string; className?: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className={cn('min-w-0 text-xs', className)}>
      <span className="break-all text-muted-foreground">{dir}</span>
      <span className="whitespace-nowrap">{name}</span>
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 border-b pb-1.5 text-base font-semibold print:break-after-avoid">
      {children}
    </h2>
  );
}

function DistBar({
  label,
  count,
  max,
  barClass,
  total,
}: {
  label: string;
  count: number;
  max: number;
  barClass: string;
  total: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex w-16 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn('size-2 rounded-full', barClass)} />
        {label}
      </span>
      <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full border border-border/60 bg-muted">
        <span
          className={cn('block h-full rounded-full', barClass)}
          style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }}
        />
      </span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {count}
        <em className="ml-1 not-italic opacity-70">{total > 0 ? Math.round((count / total) * 100) : 0}%</em>
      </span>
    </div>
  );
}

interface FileAgg {
  path: string;
  count: number;
  bySev: Record<Severity, number>;
  maxSev: Severity;
  topRule: string;
}

interface RuleAgg {
  id: string;
  count: number;
  files: number;
  maxSev: Severity;
}

/** 明细条目：位置行（行号 + 规则）+ 一句话说明 + 状态标签 */
function IssueEntry({
  issue,
  messageMap,
}: {
  issue: IIssue;
  messageMap: Record<string, string>;
}) {
  const { t, i18n } = useTranslation();
  const lineRange =
    issue.endLine && issue.endLine !== issue.startLine
      ? `${issue.startLine}\u2013${issue.endLine}`
      : `${issue.startLine}`;
  // 中文语境优先规则说明（未命中回落引擎原文首句），英文直接引擎原文
  const note = lookupRuleMessage(messageMap, issue.ruleId, firstSentence(issue.message));
  return (
    <div className="border-b py-1.5 print:break-inside-avoid">
      <div className="flex items-baseline gap-2.5">
        <span className="w-14 shrink-0 font-mono text-[11px] leading-5 text-muted-foreground">
          :{lineRange}
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] leading-5">{issue.ruleId}</span>
      </div>
      <p className="ml-[66px] text-[13px] leading-5 text-foreground/80">{note}</p>
      {(issue.comparisonStatus !== 'remaining' || issue.review) && (
        <div className="ml-[66px] mt-1 flex gap-1.5">
          {issue.comparisonStatus !== 'remaining' && (
            <Badge
              className={cn(
                'px-1.5 text-[10px] font-normal',
                COMPARISON_VISUALS[issue.comparisonStatus].badge,
              )}
            >
              {t(`comparison.${issue.comparisonStatus}`)}
            </Badge>
          )}
          {issue.review && (
            <Badge
              className={cn('px-1.5 text-[10px] font-normal', REVIEW_BADGE_CLASS[issue.review.status])}
              title={issue.review.reason}
            >
              {t(`reviewStatus.${issue.review.status}`)}
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

/** 明细组：按严重度（或"已修复"）一组，组内按文件归并，同一文件的 N 条只写一次路径 */
function DetailGroup({
  title,
  sub,
  hint,
  borderClass,
  issues,
  messageMap,
}: {
  title: string;
  sub: string;
  hint?: string;
  borderClass: string;
  issues: IIssue[];
  messageMap: Record<string, string>;
}) {
  const byFile = useMemo(() => {
    const map = new Map<string, IIssue[]>();
    for (const issue of issues) {
      const bucket = map.get(issue.filePath);
      if (bucket) bucket.push(issue);
      else map.set(issue.filePath, [issue]);
    }
    return map;
  }, [issues]);

  return (
    <div className="mb-6">
      <h3
        className={cn(
          'mb-1 flex flex-wrap items-baseline gap-2 border-b border-l-4 pb-1 pl-2 text-sm font-semibold print:break-after-avoid',
          borderClass,
        )}
      >
        {title}
        <span className="text-xs font-normal text-muted-foreground">{sub}</span>
      </h3>
      {hint && <p className="mb-1.5 text-xs text-muted-foreground">{hint}</p>}
      {[...byFile.entries()].map(([filePath, list]) => (
        <div key={filePath}>
          <div className="mt-2.5 flex items-baseline justify-between gap-2 rounded-r-md border-l-[3px] border-primary bg-muted/60 px-2 py-0.5 print:break-after-avoid">
            <PathLabel path={filePath} className="min-w-0 text-xs font-semibold" />
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {list.length}
            </span>
          </div>
          {list.map((issue) => (
            <IssueEntry key={issue.id} issue={issue} messageMap={messageMap} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** 打印下让表格在纸宽内折行：覆盖 TableCell/TableHead 的 nowrap 与内层滚动容器 */
const PRINT_TABLE_FIX =
  '[&_[data-slot=table-container]]:print:overflow-visible [&_td]:print:whitespace-normal [&_th]:print:whitespace-normal [&_table]:print:table-fixed [&_td]:print:break-words';

export default function ReportPage() {
  const { t, i18n } = useTranslation();
  const packDisplayName = usePackDisplayName();
  const { id, scanId } = useParams();
  const [report, setReport] = useState<IReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  /** 报告不可用的具体原因（记录缺失 / 未完成 / 加载失败），直接展示而不是猜一个空态文案 */
  const [failReason, setFailReason] = useState('');
  const messageMap = useRuleMessageMap();

  useEffect(() => {
    let mounted = true;
    if (!scanId) return;
    setLoading(true);
    setNotFound(false);
    setFailReason('');
    api
      .getScanReport(scanId)
      .then((data) => {
        if (mounted) setReport(data);
      })
      .catch((error) => {
        if (!mounted) return;
        setNotFound(true);
        const message = error instanceof Error ? error.message : String(error);
        setFailReason(message);
        toast.error(t('report.loadFailedToast', { error: message }));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [scanId, t]);

  /** 文件级聚合（行动清单）与规则级聚合（附录），口径与离线 HTML 报告一致 */
  const { fileList, ruleList } = useMemo(() => {
    if (!report) return { fileList: [] as FileAgg[], ruleList: [] as RuleAgg[] };
    const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const files = new Map<
      string,
      FileAgg & { ruleCounts: Map<string, number> }
    >();
    const rules = new Map<string, RuleAgg & { fileSet: Set<string> }>();
    for (const issue of report.issues) {
      if (issue.comparisonStatus === 'fixed') continue;
      let file = files.get(issue.filePath);
      if (!file) {
        file = {
          path: issue.filePath,
          count: 0,
          bySev: { critical: 0, high: 0, medium: 0, low: 0 },
          maxSev: issue.severity,
          topRule: '',
          ruleCounts: new Map(),
        };
        files.set(issue.filePath, file);
      }
      file.count += 1;
      file.bySev[issue.severity] += 1;
      file.ruleCounts.set(issue.ruleId, (file.ruleCounts.get(issue.ruleId) ?? 0) + 1);
      if (rank[issue.severity] < rank[file.maxSev]) file.maxSev = issue.severity;

      let rule = rules.get(issue.ruleId);
      if (!rule) {
        rule = { id: issue.ruleId, count: 0, files: 0, maxSev: issue.severity, fileSet: new Set() };
        rules.set(issue.ruleId, rule);
      }
      rule.count += 1;
      rule.fileSet.add(issue.filePath);
      if (rank[issue.severity] < rank[rule.maxSev]) rule.maxSev = issue.severity;
    }
    const files2 = [...files.values()].map(({ ruleCounts, ...rest }) => {
      const [topRule] = [...ruleCounts.entries()].sort((a, b) => b[1] - a[1]);
      return { ...rest, topRule: topRule?.[0] ?? '' };
    });
    files2.sort((a, b) => rank[a.maxSev] - rank[b.maxSev] || b.count - a.count);
    const rules2 = [...rules.values()].map(({ fileSet, ...rest }) => ({ ...rest, files: fileSet.size }));
    rules2.sort((a, b) => rank[a.maxSev] - rank[b.maxSev] || b.count - a.count);
    return { fileList: files2, ruleList: rules2 };
  }, [report]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <Loader2 className="size-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('report.loading')}</p>
        </CardContent>
      </Card>
    );
  }

  if (notFound || !report) {
    return (
      <div className="rounded-lg border border-dashed p-16 text-center">
        <p className="text-sm text-muted-foreground">
          {t('report.unavailable')}
          {failReason
            ? t('report.unavailableReasonSuffix', { reason: failReason })
            : t('report.unavailableNoReason')}
        </p>
        <Link
          to="/projects"
          className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
        >
          {t('common.backToProjects')}
        </Link>
      </div>
    );
  }

  const { meta, totals, conclusion, conclusionCode, topFiles, issues, reviewStats } = report;
  // 结论按语言重拼；载荷缺失（演示模式/旧缓存）回落服务端原文。
  // urgent=0 时没有可"优先处理"的对象，切到 NoUrgent 键，与服务端 buildConclusion 的中低危兜底句口径一致
  const conclusionKey =
    conclusionCode?.code === 'summary'
      ? `${conclusionCode.params.baseline ? 'summaryBaseline' : 'summary'}${
          Number(conclusionCode.params.urgent) > 0 ? '' : 'NoUrgent'
        }`
      : conclusionCode?.code;
  const conclusionText = conclusionCode
    ? t(`reportConclusion.${conclusionKey}`, {
        ...conclusionCode.params,
        defaultValue: conclusion,
      })
    : conclusion;
  const current = issues.filter((issue) => issue.comparisonStatus !== 'fixed');
  const fixed = issues.filter((issue) => issue.comparisonStatus === 'fixed');
  const severityMax = Math.max(1, ...Object.values(totals.bySeverity));
  const groupHint: Record<Severity, string> = {
    critical: t('report.groupHintCritical'),
    high: t('report.groupHintHigh'),
    medium: t('report.groupHintMedium'),
    low: t('report.groupHintLow'),
  };
  const isZh = i18n.language?.startsWith('zh');

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
      {/* 动作条不随报告打印 */}
      <div className="no-print flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="outline" asChild>
          <Link to={`/projects/${id}/scans/${scanId}`}>
            <ArrowLeft className="size-4" />
            {t('report.backToScan')}
          </Link>
        </Button>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="size-4" />
            {t('report.printBtn')}
          </Button>
          {!api.isMockMode && (
            <Button asChild>
              <a
                href={api.scanReportHtmlUrl(scanId ?? '')}
                download
                title={t('report.downloadHtmlTitle')}
              >
                <Download className="size-4" />
                {t('report.downloadHtml')}
              </a>
            </Button>
          )}
        </div>
      </div>

      {/* 报告正文（纸张样式，打印时铺满页面） */}
      <article className="report-paper rounded-xl border bg-card px-6 py-8 shadow-sm sm:px-10 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
        {/* P1 结论：决策者 30 秒看完的一页 */}
        <section className="mb-8">
          <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b-2 pb-4">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">
                {t('report.headerTagline')}
              </div>
              <h1 className="mt-1.5 text-2xl font-bold">{t('report.docTitle')}</h1>
              <div className="mt-1 text-sm text-muted-foreground">
                {meta.projectName}
                {meta.projectDescription ? ` · ${meta.projectDescription}` : ''}
              </div>
            </div>
            <div className="text-right text-xs leading-6 text-muted-foreground">
              <div className="font-mono">{meta.scanId}</div>
              <div>
                {meta.finishedAt
                  ? formatDateTime(meta.finishedAt, { withSeconds: true })
                  : formatDateTime(meta.scannedAt, { withSeconds: true })}
              </div>
              <div>
                {meta.engineVersion ? `opengrep v${meta.engineVersion}` : '—'}
                {meta.rules ? ` · ${meta.rules}` : ''}
              </div>
            </div>
          </header>

          <p className="mb-4 rounded-r-md border-l-[3px] border-primary bg-muted/50 px-4 py-3 text-sm leading-6">
            {conclusionText}
          </p>

          <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {(
              [
                [t('report.metricTotal'), totals.total, ''],
                [t('severity.critical'), totals.bySeverity.critical, SEVERITY_TEXT_CLASS.critical],
                [t('severity.high'), totals.bySeverity.high, SEVERITY_TEXT_CLASS.high],
                [t('report.metricFiles'), fileList.length, ''],
              ] as const
            ).map(([label, value, tone]) => (
              <div key={label} className="rounded-lg border bg-muted/30 px-3 py-2 print:break-inside-avoid">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className={cn('text-2xl font-semibold tabular-nums leading-8', tone)}>
                  {value}
                </div>
              </div>
            ))}
          </div>

          <SectionTitle>{t('report.distTitle')}</SectionTitle>
          <div className="mb-5 space-y-2">
            {SEVERITY_ORDER.map((sev) => (
              <DistBar
                key={sev}
                label={t(`severity.${sev}`)}
                count={totals.bySeverity[sev]}
                max={severityMax}
                total={totals.total}
                barClass={SEVERITY_BAR_CLASS[sev]}
              />
            ))}
          </div>

          <h3 className="mb-1 text-sm font-semibold">{t('report.top5Title')}</h3>
          <p className="mb-2 text-xs text-muted-foreground">{t('report.top5Hint')}</p>
          <div className={cn('mb-5 rounded-lg border', PRINT_TABLE_FIX)}>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>{t('report.thFile')}</TableHead>
                  <TableHead className="w-14 text-right">{t('report.thCount')}</TableHead>
                  {SEVERITY_ORDER.filter((sev) => sev !== 'low' && totals.bySeverity[sev] > 0).map(
                    (sev) => (
                      <TableHead key={sev} className="w-14 text-right">
                        {t(`severity.${sev}`)}
                      </TableHead>
                    ),
                  )}
                  <TableHead className="w-20">{t('report.thMaxSeverity')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...fileList]
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 5)
                  .map((file) => (
                    <TableRow key={file.path}>
                      <TableCell>
                        <PathLabel path={file.path} />
                      </TableCell>
                      <TableCell className="text-right text-xs font-semibold tabular-nums">
                        {file.count}
                      </TableCell>
                      {SEVERITY_ORDER.filter((sev) => sev !== 'low' && totals.bySeverity[sev] > 0).map(
                        (sev) => (
                          <TableCell
                            key={sev}
                            className="text-right text-xs tabular-nums text-muted-foreground"
                          >
                            {file.bySev[sev] || '—'}
                          </TableCell>
                        ),
                      )}
                      <TableCell>
                        <Badge
                          className={cn(
                            'px-1.5 text-xs font-normal',
                            SEVERITY_BADGE_CLASS[file.maxSev],
                          )}
                        >
                          {t(`severity.${file.maxSev}`)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>

          <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t('report.scopeLabel')}</dt>
            <dd className="min-w-0">
              {meta.fileCount ? t('scanResult.filesCount', { count: meta.fileCount }) : '—'}
              {meta.language ? ` · ${meta.language}` : ''}
            </dd>
            <dt className="text-muted-foreground">{t('report.baselineLabel')}</dt>
            <dd className="min-w-0 break-all">
              {meta.baselineScanId
                ? t('report.baselineSentence', {
                    id: meta.baselineScanId,
                    added: totals.byComparison.new,
                    remaining: totals.byComparison.remaining,
                    fixed: totals.byComparison.fixed,
                  })
                : t('report.firstScanNoBaseline')}
            </dd>
            <dt className="text-muted-foreground">{t('report.distLabel')}</dt>
            <dd className="min-w-0">
              {t('report.distSentence', {
                total: totals.total,
                files: fileList.length,
                rules: ruleList.length,
              })}
            </dd>
          </dl>

        </section>

        {/* P2 行动清单：按文件归并，研发负责人自上而下安排修复 */}
        <section className="mb-8 print:break-before-page">
          <SectionTitle>{t('report.sectionActions')}</SectionTitle>
          <p className="mb-2 text-xs text-muted-foreground">
            {t('report.actionsHint', { files: fileList.length })}
          </p>
          <div className={cn('overflow-x-auto rounded-lg border print:overflow-visible', PRINT_TABLE_FIX)}>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>{t('report.thFileMainIssue')}</TableHead>
                  <TableHead className="w-14 text-right">{t('report.thCount')}</TableHead>
                  <TableHead className="w-14 text-right">{t('severity.high')}</TableHead>
                  <TableHead className="w-14 text-right">{t('severity.medium')}</TableHead>
                  <TableHead className="w-14 text-right">{t('severity.low')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fileList.map((file) => (
                  <TableRow key={file.path}>
                    <TableCell className="min-w-0">
                      <PathLabel path={file.path} />
                      {file.topRule && (
                        <div className="font-mono text-[11px] text-muted-foreground/70">
                          {file.topRule}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs font-semibold tabular-nums">
                      {file.count}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-warning">
                      {file.bySev.high || '—'}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-primary">
                      {file.bySev.medium || '—'}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {file.bySev.low || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        {/* P3 明细：按严重度分组、组内按文件归并的条目式；附录规则说明紧随其后不分页 */}
        <section className="mb-8 print:break-before-page">
          <SectionTitle>{t('report.sectionDetails')}</SectionTitle>
          {current.length === 0 ? (
            <p className="rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-sm text-success">
              {t('report.noIssues')}
            </p>
          ) : (
            SEVERITY_ORDER.map((sev) => {
              const list = current.filter((issue) => issue.severity === sev);
              if (list.length === 0) return null;
              const fileCount = new Set(list.map((issue) => issue.filePath)).size;
              return (
                <DetailGroup
                  key={sev}
                  title={t(`severity.${sev}`)}
                  sub={t('report.groupCount', { count: list.length, files: fileCount })}
                  hint={groupHint[sev]}
                  borderClass={SEVERITY_BORDER_CLASS[sev]}
                  issues={list}
                  messageMap={messageMap}
                />
              );
            })
          )}
          {fixed.length > 0 && (
            <DetailGroup
              title={t('report.fixedGroupTitle')}
              sub=""
              borderClass="border-success"
              issues={fixed}
              messageMap={messageMap}
            />
          )}
          <p className="text-xs leading-5 text-muted-foreground">{t('report.disclaimer')}</p>

          <h2 className="mb-3 mt-8 border-b pb-1.5 text-base font-semibold print:break-after-avoid">
            {t('report.sectionRulesAppendix')}
          </h2>
          <p className="mb-2 text-xs text-muted-foreground">
            {t('report.appendixHint', { rules: ruleList.length })}
          </p>
          <div>
            {ruleList.map((rule, index) => {
              const note = lookupRuleMessage(messageMap, rule.id, '');
              return (
                <div key={rule.id} className="border-b py-2 print:break-inside-avoid">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 break-all font-mono text-xs font-semibold">
                      {rule.id}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                      {t('report.ruleStat', { count: rule.count, files: rule.files })}
                      <span
                        className={cn(
                          'mx-1.5 inline-block size-2 rounded-full align-baseline',
                          SEVERITY_BAR_CLASS[rule.maxSev],
                        )}
                      />
                      {t(`severity.${rule.maxSev}`)}
                    </span>
                  </div>
                  {note ? (
                    <p className="ml-6 mt-0.5 text-xs leading-5 text-foreground/80">{note}</p>
                  ) : isZh ? (
                    <p className="ml-6 mt-0.5 text-xs text-muted-foreground">
                      {t('report.noMessage')}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        {/* P4 方法与证据 */}
        <section className="mb-4 print:break-before-page">
          <SectionTitle>{t('report.sectionMethod')}</SectionTitle>

          <h3 className="mb-1.5 text-sm font-semibold text-foreground/80">
            {t('report.methodSubPacks')}
          </h3>
          <div className={cn('mb-4 overflow-x-auto rounded-lg border print:overflow-visible', PRINT_TABLE_FIX)}>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>{t('report.packThName')}</TableHead>
                  <TableHead className="w-40">{t('report.packThId')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {meta.rulepacks?.length ? (
                  meta.rulepacks.map((pack) => (
                    <TableRow key={pack.id}>
                      <TableCell className="text-xs">{packDisplayName(pack.name, pack.id)}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {pack.id}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={2} className="text-xs text-muted-foreground">
                      {meta.rules ?? t('report.noPacks')}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <h3 className="mb-1.5 text-sm font-semibold text-foreground/80">
            {t('report.methodSubRepro')}
          </h3>
          <dl className="mb-3 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-xs sm:grid-cols-[110px_1fr]">
            <dt className="text-muted-foreground">opengrep</dt>
            <dd className="min-w-0">
              v{meta.engineVersion ?? '—'}
              {meta.durationSeconds !== undefined
                ? ` · ${formatDuration(meta.durationSeconds)}`
                : ''}
            </dd>
            <dt className="text-muted-foreground">{t('report.metaManifest')}</dt>
            <dd className="min-w-0 break-all font-mono">
              {meta.sourceHash ? (
                <a
                  href={api.scanManifestUrl(meta.scanId)}
                  className="text-primary hover:underline"
                  title={t('report.metaManifestTitle')}
                >
                  {t('report.metaManifestLink', { hash: meta.sourceHash.slice(0, 12) })}
                </a>
              ) : (
                <span className="text-muted-foreground">{t('report.metaManifestMissing')}</span>
              )}
            </dd>
            <dt className="text-muted-foreground">{t('report.metaGenerated')}</dt>
            <dd className="min-w-0">{formatDateTime(meta.generatedAt, { withSeconds: true })}</dd>
          </dl>

          <h3 className="mb-1.5 text-sm font-semibold text-foreground/80">
            {t('report.methodSubReview')}
          </h3>
          <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-xs sm:grid-cols-[110px_1fr]">
            <dt className="text-muted-foreground">{t('report.reviewLabel')}</dt>
            <dd className="min-w-0">
              {reviewStats
                ? t('report.reviewLine', {
                    reviewed: reviewStats.reviewed,
                    confirmed: reviewStats.confirmed,
                    falsePositives: reviewStats.falsePositives,
                    accepted: reviewStats.accepted,
                  })
                : t('report.reviewNone')}
            </dd>
            <dt className="text-muted-foreground">{t('report.filesChecked')}</dt>
            <dd className="min-w-0">
              {meta.fileCount ? t('scanResult.filesCount', { count: meta.fileCount }) : '—'}
            </dd>
            <dt className="text-muted-foreground">{t('report.methodSubExclusions')}</dt>
            <dd className="min-w-0">{t('report.exclusions')}</dd>
            <dt className="text-muted-foreground">{t('report.methodSubBoundaries')}</dt>
            <dd className="min-w-0">{t('report.notCovered')}</dd>
          </dl>
        </section>

        <footer className="mt-8 border-t pt-3 text-xs text-muted-foreground">
          {t('report.footer', {
            time: formatDateTime(meta.generatedAt, { withSeconds: true }),
          })}
        </footer>
      </article>
    </div>
  );
}
