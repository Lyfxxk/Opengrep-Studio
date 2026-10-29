import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatDateTime, formatDuration } from '@/lib/format';
import { usePackDisplayName } from '@/lib/packName';
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
import type { IProject } from '@/data/projects';
import type { IScanResult } from '@/data/scanresults';
import { api, translateApiError } from '@/lib/api';
import CodeSnippetViewer from './CodeSnippetViewer';
import ComparisonSummary from './ComparisonSummary';
import IssueFilterList from './IssueFilterList';
import ReviewDialog from './ReviewDialog';
import CompareDialog from './CompareDialog';
import KnowledgeSheet from './KnowledgeSheet';

const POLL_INTERVAL_MS = 1500;

export default function ScanResultPage() {
  const { t } = useTranslation();
  const { id, scanId } = useParams();
  const [project, setProject] = useState<IProject | null>(null);
  const [scan, setScan] = useState<IScanResult | null>(null);
  /** 基线扫描记录：只用来比对引擎版本，跨版本基线对比会给标识 */
  const [baselineScan, setBaselineScan] = useState<IScanResult | null>(null);
  const [issues, setIssues] = useState<IIssue[]>([]);
  const [loading, setLoading] = useState(true);
  /** 首次加载即失败（区别于"记录不存在"：网络/后端异常时给出可重试的提示） */
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<IIssue | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [knowledgeRuleId, setKnowledgeRuleId] = useState<string | null>(null);
  /** 规则包悬浮面板的展开态（悬浮开合，点击面板内链接跳转规则中心） */
  const [packsOpen, setPacksOpen] = useState(false);
  const packDisplayName = usePackDisplayName();
  // 轮询期间后端瞬断只弹一次错误；序号守卫丢弃切换扫描后晚到的旧响应
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
      setScan(scanData);
      const settled = scanData.status === 'completed';
      // 项目列表与基线记录在扫描期间不会变化：只在首次加载与扫描完成时取，避免轮询每 1.5s 白拉两个接口
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

  // 路由 :id/:scanId 变化复用同一组件实例：先清掉上一个扫描留下的状态。
  // 不重置时 loadedOnceRef 仍为 true，新扫描在 scanning 期间不会重取 project，
  // 复核对话框会拿着旧项目的 id 提交（复核按 projectId + fingerprint 落库，直接写错归属）。
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

  /** 取消请求进行中：按钮短暂禁用防连点（运行中的取消要等引擎退出才落 failed，期间仍可看到扫描中） */
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    if (!scanId) return;
    setCancelling(true);
    try {
      await api.cancelScan(scanId);
      toast.success(t('scanResult.cancelRequestedToast'));
      // 排队中的取消后端已直接落 failed，刷新即见；运行中的会稍后在轮询里翻转为失败
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelling(false);
    }
  };

  const selectedIssue =
    issues.find((issue) => issue.id === selectedIssueId) ?? issues[0] ?? null;

  // 扫描完成 + 0 问题：这是审计的"绿色结论"，用专门的成功态呈现而不是"搜索无结果"
  const durationLabel = (() => {
    if (!scan?.finishedAt) return null;
    // 排队等待与快照准备不算引擎耗时；旧记录无 startedAt 时回落到 scannedAt
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
              title={t('scanResult.compareBtnTitle')}
            >
              <GitCompare className="size-4" />
              {t('scanResult.compareBtn')}
            </Button>
            {!api.isMockMode && (
              <Button asChild variant="outline" className="h-8">
                <a
                  href={api.scanSarifUrl(scan.id)}
                  download
                  title={t('scanResult.exportSarifTitle')}
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

      {/* 本次扫描规则包：收纳为一个悬浮按钮（不再占两行高度），悬浮展开面板列出各包，
          点击跳转规则中心；无规则包快照的旧扫描回落为纯文本说明 */}
      {scan.status !== 'failed' && (scan.rulepacks?.length || scan.rules) && (
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
              {t('scanResult.rulesetDir', { rules: scan.rules })}
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
              <p className="max-w-[640px] break-all font-mono text-xs text-muted-foreground">
                {translateApiError(scan.errorCode, scan.errorParams, scan.message)}
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
              // 并发池排队中（第 3 路及以后）：与"扫描中"区分，开跑后后端会清掉排队标记
              <p className="text-sm text-muted-foreground">{t('scanResult.queuedHint')}</p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t('scanResult.scanningHint')}</p>
                {/* 心跳进度：countFiles 落库后即可见；排队中恒为 0 不展示 */}
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
        // 与"有问题"状态共用同一套双栏骨架：左列承载扫描概要，右列是绿色结论
        <div className="grid flex-1 grid-cols-1 gap-6 lg:min-h-0 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
          <Card className="flex flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                {t('scanResult.summaryTitle')}
                <Badge className="ml-auto border-transparent bg-success/10 text-xs font-normal text-success">
                  {t('scanResult.zeroIssues')}
                </Badge>
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
                    {/* 旧扫描曾把配置内部 ID（cfg-xxx）当规则集落库：内部标识对用户无意义，按无信息占位 */}
                    {scan.rules && !scan.rules.startsWith('cfg-') ? scan.rules : '—'}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-3 border-b py-2.5">
                  <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <Package className="size-4" />
                    {t('scans.colRulePacks')}
                  </dt>
                  <dd className="min-w-0 text-right text-xs leading-5">
                    {scan.rulepacks?.length ? (
                      <span title={scan.rulepacks.map((pack) => packDisplayName(pack.name, pack.id)).join('、')}>
                        {scan.rulepacks.map((pack) => packDisplayName(pack.name, pack.id)).join('、')}
                      </span>
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
            <div className="space-y-1">
              <p className="text-lg font-semibold">{t('scanResult.allClearTitle')}</p>
              <p className="mx-auto max-w-[520px] text-sm text-muted-foreground">
                {t(
                  scan.baselineScanId ? 'scanResult.allClearDescBaseline' : 'scanResult.allClearDesc',
                  { count: scan.fileCount || '—' },
                )}
              </p>
            </div>
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
              <ComparisonSummary
                issues={issues}
                baselineScanId={scan.baselineScanId}
              />
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
