import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatDateTime, formatDuration } from '@/lib/format';
import { usePackDisplayName } from '@/lib/displayNames';
import {
  CheckCircle2,
  FileDown,
  FileSearch,
  FileText,
  GitCompare,
  ListChecks,
  Loader2,
  Package,
  Timer,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import ScanStatusBadge from '@/components/ScanStatusBadge';
import type { IIssue } from '@/data/issues';
import { COMPARISON_VISUALS } from '@/data/constants';
import type { IProject } from '@/data/projects';
import type { IScanResult } from '@/data/scanresults';
import { api, translateApiError } from '@/lib/api';
import CodeSnippetViewer from './CodeSnippetViewer';
import IssueFilterList from './IssueFilterList';
import ReviewDialog from './ReviewDialog';
import CompareDialog from './CompareDialog';
import KnowledgeSheet from './KnowledgeSheet';

const POLL_INTERVAL_MS = 1500;

function ComparisonSummary({ issues }: { issues: IIssue[] }) {
  const { t } = useTranslation();
  const stats = useMemo(
    () => ({
      newCount: issues.filter((issue) => issue.comparisonStatus === 'new').length,
      fixedCount: issues.filter((issue) => issue.comparisonStatus === 'fixed').length,
      remainingCount: issues.filter(
        (issue) => issue.comparisonStatus === 'remaining',
      ).length,
    }),
    [issues],
  );

  const items = [
    { key: 'summaryNew', value: stats.newCount, ...COMPARISON_VISUALS.new },
    { key: 'summaryFixed', value: stats.fixedCount, ...COMPARISON_VISUALS.fixed },
    { key: 'summaryRemaining', value: stats.remainingCount, ...COMPARISON_VISUALS.remaining },
  ] as const;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Card key={item.key}>
            <CardContent className="flex items-center gap-4 p-5">
              <div
                className={`flex size-10 shrink-0 items-center justify-center rounded-full ${item.bg}`}
              >
                <Icon className={`size-5 ${item.tone}`} />
              </div>
              <div className="min-w-0">
                <div className={`text-2xl font-bold tabular-nums ${item.tone}`}>
                  {item.value}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {t(`comparison.${item.key}`)}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export default function ScanResultPage() {
  const { t } = useTranslation();
  const { id, scanId } = useParams();
  const [project, setProject] = useState<IProject | null>(null);
  const [scan, setScan] = useState<IScanResult | null>(null);
  const [baselineScan, setBaselineScan] = useState<IScanResult | null>(null);
  const [issues, setIssues] = useState<IIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<IIssue | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [knowledgeRuleId, setKnowledgeRuleId] = useState<string | null>(null);
  const [packsOpen, setPacksOpen] = useState(false);
  const packDisplayName = usePackDisplayName();
  const pollErrorShownRef = useRef(false);
  const requestSeqRef = useRef(0);
  const loadedOnceRef = useRef(false);

  const load = useCallback(async () => {
    if (!scanId) return;
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    try {
      const scanData = await api.getScan(scanId);
      if (requestSeqRef.current !== seq) return;
      if (id && scanData.projectId !== id) {
        setScan(null);
        setProject(null);
        setLoadFailed(false);
        loadedOnceRef.current = true;
        return;
      }
      setScan(scanData);
      const settled = scanData.status === 'completed';
      const needMeta = settled || !loadedOnceRef.current;
      const [projects, issueList, baseline] = await Promise.all([
        needMeta && id ? api.listProjects() : Promise.resolve([]),
        settled ? api.listIssues(scanId) : Promise.resolve([]),
        needMeta && scanData.baselineScanId
          ? api.getScan(scanData.baselineScanId).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (requestSeqRef.current !== seq) return;
      if (needMeta) {
        setProject(projects.find((item) => item.id === id) ?? null);
        setBaselineScan(baseline);
      }
      setIssues(issueList);
      pollErrorShownRef.current = false;
      loadedOnceRef.current = true;
      setLoadFailed(false);
    } catch (error) {
      if (requestSeqRef.current !== seq) return;
      if (!loadedOnceRef.current) setLoadFailed(true);
      if (!pollErrorShownRef.current) {
        pollErrorShownRef.current = true;
        toast.error(t('scanResult.loadFailedToast', { error: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      if (requestSeqRef.current === seq) {
        setLoading(false);
      }
    }
  }, [id, scanId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setProject(null);
    setScan(null);
    setBaselineScan(null);
    setIssues([]);
    setLoading(true);
    setLoadFailed(false);
    setSelectedIssueId(null);
    setReviewTarget(null);
    setKnowledgeRuleId(null);
    setCompareOpen(false);
    setPacksOpen(false);
    loadedOnceRef.current = false;
    pollErrorShownRef.current = false;
  }, [id, scanId]);

  const isScanning = scan?.status === 'scanning';
  useEffect(() => {
    if (!isScanning) return;
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isScanning, load]);

  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    if (!scanId) return;
    setCancelling(true);
    try {
      await api.cancelScan(scanId);
      toast.success(t('scanResult.cancelRequestedToast'));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelling(false);
    }
  };

  const selectedIssue =
    issues.find((issue) => issue.id === selectedIssueId) ?? issues[0] ?? null;

  const durationLabel = (() => {
    if (!scan?.finishedAt) return null;
    return formatDuration(
      Math.round(
        (new Date(scan.finishedAt).getTime() - new Date(scan.startedAt ?? scan.scannedAt).getTime()) /
          1000,
      ),
    );
  })();

  if (loading) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <Loader2 className="size-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('scanResult.loading')}</p>
        </CardContent>
      </Card>
    );
  }

  if (!project || !scan) {
    return (
      <div className="rounded-lg border border-dashed p-16 text-center">
        <p className="text-sm text-muted-foreground">
          {loadFailed ? t('common.loadFailedHint') : t('scanResult.notFound')}
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

  return (
    <div className="flex flex-col gap-6 lg:h-full">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t('scanResult.title', { id: scan.id })}</h1>
        <ScanStatusBadge status={scan.status} queued={Boolean(scan.queuedAt)} />
        <span className="text-sm text-muted-foreground">
          {t('scanResult.scannedAt', { time: formatDateTime(scan.scannedAt) })}
        </span>
        {scan.status === 'completed' && (
          <>
            <Button
              variant="outline"
              className="ml-auto h-8"
              onClick={() => setCompareOpen(true)}
            >
              <GitCompare className="size-4" />
              {t('scanResult.compareBtn')}
            </Button>
            {!api.isMockMode && (
              <Button asChild variant="outline" className="h-8">
                <a
                  href={api.scanSarifUrl(scan.id)}
                  download
                >
                  <FileDown className="size-4" />
                  {t('scanResult.exportSarif')}
                </a>
              </Button>
            )}
            <Button asChild className="h-8">
              <Link to={`/projects/${scan.projectId}/scans/${scan.id}/report`}>
                <FileText className="size-4" />
                {t('scanResult.genReport')}
              </Link>
            </Button>
          </>
        )}
      </div>

      {scan.status !== 'failed' && (scan.rulepacks?.length || scan.rules || scan.importSource === 'sarif') && (
        <div
          className="relative"
          onMouseEnter={() => setPacksOpen(true)}
          onMouseLeave={() => setPacksOpen(false)}
        >
          {scan.rulepacks?.length ? (
            <Button
              variant="outline"
              className="h-8 gap-1.5 px-2.5 text-xs font-normal"
              onClick={() => setPacksOpen((open) => !open)}
            >
              <ListChecks className="size-3.5" />
              {t('scanResult.packsBtn')}
              <Badge className="h-4 rounded-sm px-1 font-normal tabular-nums">
                {scan.rulepacks?.length}
                {t('scanResult.packsUnit')}
              </Badge>
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t('scanResult.rulesetDir', {
                rules:
                  scan.importSource === 'sarif'
                    ? scan.toolName
                      ? t('scanResult.sarifImportTool', { tool: scan.toolName })
                      : t('scanResult.sarifImport')
                    : scan.rules,
              })}
            </span>
          )}
          {packsOpen && (scan.rulepacks?.length ?? 0) > 0 && (
            <div className="absolute left-0 top-full z-50 mt-1 w-80 rounded-lg border bg-popover p-1.5 shadow-md">
              {scan.rulepacks?.map((pack) => (
                <Link
                  key={pack.id}
                  to={`/rules?tab=packs&pack=${encodeURIComponent(pack.id)}`}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent"
                >
                  <span className="min-w-0 truncate">{packDisplayName(pack.name, pack.id)}</span>
                  <span className="shrink-0 font-mono text-muted-foreground">{pack.id}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {scan.status === 'failed' ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <XCircle className="size-8 text-destructive" />
            <p className="text-sm font-medium">{t('scanResult.failedTitle')}</p>
            {scan.message && (
              <p className="max-w-[640px] whitespace-pre-line break-all font-mono text-xs text-muted-foreground">
                {[
                  translateApiError(scan.errorCode, scan.errorParams, scan.message),
                  scan.errorParams?.macos ? t('engine.hintMacosQuarantine') : '',
                ]
                  .filter(Boolean)
                  .join('\n')}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('scanResult.failedHint')}</p>
          </CardContent>
        </Card>
      ) : scan.status === 'scanning' ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Loader2 className="size-8 animate-spin text-primary" />
            {scan.queuedAt ? (
              <p className="text-sm text-muted-foreground">{t('scanResult.queuedHint')}</p>
            ) : (
              <>
                {scan.fileCount ? (
                  <p className="text-xs text-muted-foreground">
                    {t('scanResult.scannedFiles', { count: scan.fileCount })}
                  </p>
                ) : null}
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={cancelling}
              onClick={() => void handleCancel()}
            >
              <XCircle className="size-4" />
              {t('scanResult.cancelBtn')}
            </Button>
          </CardContent>
        </Card>
      ) : issues.length === 0 ? (
        <div className="grid flex-1 grid-cols-1 gap-6 lg:min-h-0 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
          <Card className="flex flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                {t('scanResult.summaryTitle')}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1">
              <dl className="text-sm">
                <div className="flex items-center justify-between gap-3 border-b py-2.5">
                  <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <FileSearch className="size-4" />
                    {t('scanResult.dtFiles')}
                  </dt>
                  <dd className="min-w-0 text-right font-medium">
                    {scan.fileCount ? t('scanResult.filesCount', { count: scan.fileCount }) : '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-b py-2.5">
                  <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <ListChecks className="size-4" />
                    {t('scanResult.dtRuleset')}
                  </dt>
                  <dd className="min-w-0 truncate font-medium">
                    {scan.importSource === 'sarif'
                      ? scan.toolName
                        ? t('scanResult.sarifImportTool', { tool: scan.toolName })
                        : t('scanResult.sarifImport')
                      : scan.rules && !scan.rules.startsWith('cfg-')
                        ? scan.rules
                        : '—'}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-3 border-b py-2.5">
                  <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <Package className="size-4" />
                    {t('scans.colRulePacks')}
                  </dt>
                  <dd className="min-w-0 text-right text-xs leading-5">
                    {scan.rulepacks?.length ? (
                      scan.rulepacks
                        .map((pack) => packDisplayName(pack.name, pack.id))
                        .join(t('common.listSeparator'))
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-b py-2.5">
                  <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <Timer className="size-4" />
                    {t('scanResult.dtDuration')}
                  </dt>
                  <dd className="min-w-0 text-right font-medium">
                    {durationLabel || '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-2.5">
                  <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <GitCompare className="size-4" />
                    {t('scanResult.dtBaseline')}
                  </dt>
                  <dd className="min-w-0 text-right">
                    {scan.baselineScanId ? (
                      <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                        <span className="font-mono text-xs">{scan.baselineScanId}</span>
                        {baselineScan &&
                          scan.engineVersion &&
                          baselineScan.engineVersion &&
                          baselineScan.engineVersion !== scan.engineVersion && (
                            <Badge
                              className="bg-warning/15 px-1.5 font-normal text-warning"
                              title={t('scanResult.engineVersionDiffTitle', {
                                baseline: baselineScan.engineVersion,
                                current: scan.engineVersion,
                              })}
                            >
                              {t('scanResult.engineVersionDiff')}
                            </Badge>
                          )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t('scanResult.baselineNotSet')}</span>
                    )}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
          <Card className="flex flex-col items-center justify-center gap-4 py-14 text-center lg:col-span-2">
            <span className="flex size-14 items-center justify-center rounded-full bg-success/10">
              <CheckCircle2 className="size-8 text-success" />
            </span>
            <p className="text-lg font-semibold">{t('scanResult.allClearTitle')}</p>
            <Button variant="outline" asChild>
              <Link to={`/projects/${scan.projectId}`}>{t('common.backToProjects')}</Link>
            </Button>
          </Card>
        </div>
      ) : (
        <>
          {scan.baselineScanId && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <GitCompare className="size-4 text-primary" />
                {t('scanResult.vsBaseline', { id: scan.baselineScanId })}
              </div>
              <ComparisonSummary issues={issues} />
            </div>
          )}

          <div className="grid flex-1 grid-cols-1 gap-6 lg:min-h-0 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
            <div className="lg:min-h-0">
              <IssueFilterList
                projectId={project.id}
                issues={issues}
                selectedIssueId={selectedIssue?.id ?? null}
                onSelect={setSelectedIssueId}
                onOpenKnowledge={setKnowledgeRuleId}
                onReviewed={() => void load()}
              />
            </div>
            <div className="lg:min-h-0 lg:col-span-2">
              <CodeSnippetViewer
                scanId={scan.id}
                issue={selectedIssue}
                onOpenReview={(target) => setReviewTarget(target)}
                onOpenKnowledge={setKnowledgeRuleId}
              />
            </div>
          </div>
        </>
      )}

      {project && (
        <ReviewDialog
          projectId={project.id}
          issue={reviewTarget}
          onClose={() => setReviewTarget(null)}
          onSaved={() => void load()}
        />
      )}
      {compareOpen && scanId && <CompareDialog scanId={scanId} onClose={() => setCompareOpen(false)} />}
      <KnowledgeSheet ruleId={knowledgeRuleId} onClose={() => setKnowledgeRuleId(null)} />
    </div>
  );
}
