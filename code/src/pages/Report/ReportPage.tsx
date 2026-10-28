import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ArrowLeft,
  CircleAlert,
  Download,
  Loader2,
  Printer,
} from 'lucide-react';
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
import { type IReportData, type IReportMeta } from '@/data/reports';
import { lookupRuleMessage, useRuleMessageMap } from '@/lib/ruleMessages';
import {
  SEVERITY_BADGE_CLASS,
  SEVERITY_BAR_CLASS,
  SEVERITY_ORDER,
  SEVERITY_TEXT_CLASS,
} from '@/lib/severity';
import { cn } from '@/lib/utils';

/** 在线明细表每组最多渲染的行数（超出的部分引导下载完整 HTML 报告） */
const GROUP_DISPLAY_LIMIT = 200;

const COMPARISON_STATS: Array<{
  status: IIssue['comparisonStatus'];
  icon: typeof CircleAlert;
  tone: string;
  bg: string;
}> = [
  { status: 'new', ...COMPARISON_VISUALS.new },
  { status: 'remaining', ...COMPARISON_VISUALS.remaining },
  { status: 'fixed', ...COMPARISON_VISUALS.fixed },
];


function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-dashed py-2 text-sm last:border-b-0">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium">{children}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-base font-semibold print:break-after-avoid">
      <span className="h-4 w-1 rounded-full bg-primary" />
      {children}
    </h2>
  );
}

function DistBar({
  label,
  count,
  max,
  barClass,
  mono = false,
}: {
  label: string;
  count: number;
  max: number;
  barClass: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          'w-44 shrink-0 truncate text-xs',
          mono && 'font-mono',
          'text-muted-foreground',
        )}
        title={label}
      >
        {label}
      </span>
      <span className="h-3.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn('block h-full rounded-full', barClass)}
          style={{ width: `${max > 0 ? (count / max) * 100 : 0}%` }}
        />
      </span>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

function IssueGroupTable({
  title,
  dotClass,
  issues,
  messageMap,
}: {
  title: string;
  dotClass: string;
  issues: IIssue[];
  messageMap: Record<string, string>;
}) {
  const { t } = useTranslation();
  const visible = issues.slice(0, GROUP_DISPLAY_LIMIT);
  return (
    <div className="mb-6">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold print:break-after-avoid">
        <span className={cn('size-2.5 rounded-full', dotClass)} />
        {title}
        <span className="text-xs font-normal text-muted-foreground">
          {t('report.groupItems', { count: issues.length })}
        </span>
      </h3>
      <div className="overflow-x-auto rounded-lg border print:overflow-visible">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-10 text-center">#</TableHead>
              <TableHead className="min-w-[220px]">{t('compare.thLocation')}</TableHead>
              <TableHead className="min-w-[140px]">{t('compare.thRule')}</TableHead>
              <TableHead className="min-w-[220px]">{t('compare.thDescription')}</TableHead>
              <TableHead className="w-16">{t('report.thStatus')}</TableHead>
              <TableHead className="w-24">{t('report.thReview')}</TableHead>
              <TableHead className="min-w-[120px]">{t('scans.colRulePacks')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((issue, index) => (
              <TableRow key={issue.id}>
                <TableCell className="text-center text-xs tabular-nums text-muted-foreground">
                  {index + 1}
                </TableCell>
                <TableCell className="break-all font-mono text-xs">
                  {issue.filePath}:{issue.startLine}
                </TableCell>
                <TableCell className="font-mono text-xs">{issue.ruleId}</TableCell>
                <TableCell className="text-xs">
                  {lookupRuleMessage(messageMap, issue.ruleId, issue.message)}
                </TableCell>
                <TableCell>
                  <Badge
                    className={cn(
                      'px-1.5 text-xs font-normal',
                      COMPARISON_VISUALS[issue.comparisonStatus].badge,
                    )}
                  >
                    {t(`comparison.${issue.comparisonStatus}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  {issue.review ? (
                    <Badge
                      className={cn('px-1.5 text-xs font-normal', REVIEW_BADGE_CLASS[issue.review.status])}
                      title={issue.review.reason}
                    >
                      {t(`reviewStatus.${issue.review.status}`)}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t('reviewStatus.pending')}</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {issue.rulepackName ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {issues.length > visible.length && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t('report.groupTruncated', {
            shown: GROUP_DISPLAY_LIMIT,
            rest: issues.length - visible.length,
          })}
        </p>
      )}
    </div>
  );
}

function MetaSummary({ meta }: { meta: IReportMeta }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
      <div>
        <MetaRow label={t('report.metaProjectName')}>{meta.projectName}</MetaRow>
        {meta.projectDescription && (
          <MetaRow label={t('report.metaProjectDesc')}>{meta.projectDescription}</MetaRow>
        )}
        {meta.language && <MetaRow label={t('report.metaLanguage')}>{meta.language}</MetaRow>}
        <MetaRow label={t('scans.colScanId')}>
          <span className="font-mono text-xs">{meta.scanId}</span>
        </MetaRow>
        <MetaRow label={t('scans.colTime')}>
          {formatDateTime(meta.scannedAt, { withSeconds: true })}
        </MetaRow>
        <MetaRow label={t('scanResult.dtDuration')}>{formatDuration(meta.durationSeconds)}</MetaRow>
      </div>
      <div>
        <MetaRow label={t('report.metaFileCount')}>
          {meta.fileCount ? t('scanResult.filesCount', { count: meta.fileCount }) : '—'}
        </MetaRow>
        <MetaRow label={t('report.metaBaseline')}>
          {meta.baselineScanId ? (
            <span className="font-mono text-xs">{meta.baselineScanId}</span>
          ) : (
            t('scanResult.baselineNotSet')
          )}
        </MetaRow>
        <MetaRow label={t('report.metaEngine')}>
          {meta.engineVersion ? `opengrep v${meta.engineVersion}` : '—'}
        </MetaRow>
        <MetaRow label={t('report.metaPacks')}>
          <span className="inline-flex max-w-full flex-wrap justify-end gap-1">
            {meta.rulepacks?.length ? (
              meta.rulepacks.map((pack) => (
                <Badge
                  key={pack.id}
                  variant="outline"
                  className="max-w-[180px] truncate px-1.5 text-xs font-normal"
                  title={pack.name}
                >
                  {pack.name}
                </Badge>
              ))
            ) : (
              <span className="font-mono text-xs">{meta.rules ?? '—'}</span>
            )}
          </span>
        </MetaRow>
        <MetaRow label={t('report.metaManifest')}>
          {meta.sourceHash ? (
            <a
              href={api.scanManifestUrl(meta.scanId)}
              className="font-mono text-xs text-primary hover:underline"
              title={t('report.metaManifestTitle')}
            >
              {t('report.metaManifestLink', { hash: meta.sourceHash.slice(0, 12) })}
            </a>
          ) : (
            <span className="text-muted-foreground">{t('report.metaManifestMissing')}</span>
          )}
        </MetaRow>
        <MetaRow label={t('report.metaGenerated')}>
          {formatDateTime(meta.generatedAt, { withSeconds: true })}
        </MetaRow>
      </div>
    </div>
  );
}

export default function ReportPage() {
  const { t } = useTranslation();
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

  const { meta, totals, conclusion, topRules, topFiles, topDirs, issues, reviewStats } = report;
  const current = issues.filter((issue) => issue.comparisonStatus !== 'fixed');
  const fixed = issues.filter((issue) => issue.comparisonStatus === 'fixed');
  const severityMax = Math.max(1, ...Object.values(totals.bySeverity));
  const dirMax = Math.max(1, ...topDirs.map((row) => row.count));

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4">
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
        <header className="mb-8 border-b-2 border-primary pb-5">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">
            {t('report.headerTagline')}
          </div>
          <h1 className="mt-2 text-2xl font-bold">{t('report.docTitle')}</h1>
          <div className="mt-1 flex flex-wrap items-baseline gap-3 text-muted-foreground">
            <span className="text-base font-medium text-foreground">{meta.projectName}</span>
            <span className="font-mono text-xs">{meta.scanId}</span>
          </div>
        </header>

        <section className="mb-8">
          <SectionTitle>{t('report.sectionSummary')}</SectionTitle>
          <MetaSummary meta={meta} />
        </section>

        <section className="mb-8">
          <SectionTitle>{t('report.sectionConclusion')}</SectionTitle>
          <p className="mb-4 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm leading-6">
            {conclusion}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {SEVERITY_ORDER.map((sev) => (
              <Card key={sev} className="py-4 print:break-inside-avoid">
                <CardContent className="px-4">
                  <div className={cn('text-2xl font-bold tabular-nums', SEVERITY_TEXT_CLASS[sev])}>
                    {totals.bySeverity[sev]}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{t(`severity.${sev}`)}</div>
                </CardContent>
              </Card>
            ))}
            <Card className="py-4 print:break-inside-avoid">
              <CardContent className="px-4">
                <div className="text-2xl font-bold tabular-nums">{totals.total}</div>
                <div className="mt-1 text-xs text-muted-foreground">{t('dashboard.statsIssues')}</div>
              </CardContent>
            </Card>
          </div>
          {meta.baselineScanId && (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {COMPARISON_STATS.map((item) => {
                const Icon = item.icon;
                return (
                  <Card key={item.status} className="py-4 print:break-inside-avoid">
                    <CardContent className="flex items-center gap-3 px-4">
                      <span
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-full',
                          item.bg,
                        )}
                      >
                        <Icon className={cn('size-4.5', item.tone)} />
                      </span>
                      <div>
                        <div className={cn('text-xl font-bold tabular-nums', item.tone)}>
                          {totals.byComparison[item.status]}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t(`comparison.${item.status}`)} · {t('report.vsBaseline')}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
          {reviewStats && (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Card className="py-4 print:break-inside-avoid">
                <CardContent className="px-4">
                  <div className="text-xl font-bold tabular-nums text-primary">
                    {reviewStats.reviewed}
                  </div>
                  <div className="text-xs text-muted-foreground">{t('report.reviewedCount')}</div>
                </CardContent>
              </Card>
              <Card className="py-4 print:break-inside-avoid">
                <CardContent className="px-4">
                  <div className="text-xl font-bold tabular-nums text-destructive">
                    {reviewStats.confirmed}
                  </div>
                  <div className="text-xs text-muted-foreground">{t('report.confirmedCount')}</div>
                </CardContent>
              </Card>
              <Card className="py-4 print:break-inside-avoid">
                <CardContent className="px-4">
                  <div className="text-xl font-bold tabular-nums text-success">
                    {reviewStats.falsePositives}
                  </div>
                  <div className="text-xs text-muted-foreground">{t('report.falsePositiveCount')}</div>
                </CardContent>
              </Card>
              <Card className="py-4 print:break-inside-avoid">
                <CardContent className="px-4">
                  <div className="text-xl font-bold tabular-nums text-warning">
                    {reviewStats.accepted}
                  </div>
                  <div className="text-xs text-muted-foreground">{t('report.acceptedCount')}</div>
                </CardContent>
              </Card>
            </div>
          )}
        </section>

        <section className="mb-8">
          <SectionTitle>{t('report.sectionDist')}</SectionTitle>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('report.bySeverity')}</h3>
          <div className="mb-5 space-y-2">
            {SEVERITY_ORDER.map((sev) => (
              <DistBar
                key={sev}
                label={t(`severity.${sev}`)}
                count={totals.bySeverity[sev]}
                max={severityMax}
                barClass={SEVERITY_BAR_CLASS[sev]}
              />
            ))}
          </div>

          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
            {t('report.topRulesTitle', { count: topRules.length })}
          </h3>
          <div className="mb-5 overflow-x-auto rounded-lg border print:overflow-visible">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="min-w-[160px]">{t('compare.thRule')}</TableHead>
                  <TableHead className="w-24">{t('report.thHighestSeverity')}</TableHead>
                  <TableHead className="w-16 text-right">{t('report.thHits')}</TableHead>
                  <TableHead className="min-w-[140px]">{t('scans.colRulePacks')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topRules.map((row) => (
                  <TableRow key={row.ruleId}>
                    <TableCell className="font-mono text-xs">{row.ruleId}</TableCell>
                    <TableCell>
                      <Badge
                        className={cn(
                          'px-1.5 text-xs font-normal',
                          SEVERITY_BADGE_CLASS[row.severity],
                        )}
                      >
                        {t(`severity.${row.severity}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {row.count}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.rulepackName ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
            {t('report.topFilesTitle', { count: topFiles.length })}
          </h3>
          <div className="mb-5 overflow-x-auto rounded-lg border print:overflow-visible">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="min-w-[240px]">{t('compare.thFile')}</TableHead>
                  <TableHead className="w-24">{t('report.thHighestSeverity')}</TableHead>
                  <TableHead className="w-16 text-right">{t('report.thHits')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topFiles.map((row) => (
                  <TableRow key={row.filePath}>
                    <TableCell className="break-all font-mono text-xs">
                      {row.filePath}
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={cn(
                          'px-1.5 text-xs font-normal',
                          SEVERITY_BADGE_CLASS[row.maxSeverity],
                        )}
                      >
                        {t(`severity.${row.maxSeverity}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {row.count}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {topDirs.length > 0 && (
            <>
              <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('report.topDirsTitle')}</h3>
              <div className="space-y-2">
                {topDirs.map((row) => (
                  <DistBar
                    key={row.dir}
                    label={row.dir}
                    count={row.count}
                    max={dirMax}
                    barClass="bg-primary"
                    mono
                  />
                ))}
              </div>
            </>
          )}
        </section>

        <section className="mb-4">
          <SectionTitle>{t('report.sectionIssues')}</SectionTitle>
          {current.length === 0 ? (
            <p className="rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-sm text-success">
              {t('report.noIssues')}
            </p>
          ) : (
            SEVERITY_ORDER.map((sev) => {
              const list = current.filter((issue) => issue.severity === sev);
              if (list.length === 0) return null;
              return (
                <IssueGroupTable
                  key={sev}
                  title={t('report.groupTitle', { label: t(`severity.${sev}`) })}
                  dotClass={SEVERITY_BAR_CLASS[sev]}
                  issues={list}
                  messageMap={messageMap}
                />
              );
            })
          )}
          {fixed.length > 0 && (
            <IssueGroupTable
              title={t('report.fixedGroupTitle')}
              dotClass="bg-success"
              issues={fixed}
              messageMap={messageMap}
            />
          )}
          <p className="text-xs leading-5 text-muted-foreground">{t('report.disclaimer')}</p>
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
