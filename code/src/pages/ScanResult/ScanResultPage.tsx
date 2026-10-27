import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { formatDateTime, formatDuration } from '@/lib/format';
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
import { api } from '@/lib/api';
import CodeSnippetViewer from './CodeSnippetViewer';
import ComparisonSummary from './ComparisonSummary';
import IssueFilterList from './IssueFilterList';
import ReviewDialog from './ReviewDialog';
import CompareDialog from './CompareDialog';
import KnowledgeSheet from './KnowledgeSheet';

const POLL_INTERVAL_MS = 1500;

export default function ScanResultPage() {
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
        toast.error(`加载扫描结果失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (requestSeqRef.current === seq) {
        setLoading(false);
      }
    }
  }, [id, scanId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isScanning = scan?.status === 'scanning';
  useEffect(() => {
    if (!isScanning) return;
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isScanning, load]);

  const selectedIssue =
    issues.find((issue) => issue.id === selectedIssueId) ?? issues[0] ?? null;

  // 扫描完成 + 0 问题：这是审计的"绿色结论"，用专门的成功态呈现而不是"搜索无结果"
  const durationLabel = (() => {
    if (!scan?.finishedAt) return null;
    return formatDuration(
      Math.round((new Date(scan.finishedAt).getTime() - new Date(scan.scannedAt).getTime()) / 1000),
    );
  })();

  if (loading) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <Loader2 className="size-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">正在加载扫描结果…</p>
        </CardContent>
      </Card>
    );
  }

  if (!project || !scan) {
    return (
      <div className="rounded-lg border border-dashed p-16 text-center">
        <p className="text-sm text-muted-foreground">
          {loadFailed ? '加载失败，请检查后端服务后刷新重试' : '扫描记录不存在或已被删除'}
        </p>
        <Link
          to="/projects"
          className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
        >
          返回项目列表
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:h-full">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">扫描结果 · {scan.id}</h1>
        <ScanStatusBadge status={scan.status} />
        <span className="text-sm text-muted-foreground">
          扫描于 {formatDateTime(scan.scannedAt)}
        </span>
        {scan.status === 'completed' && (
          <>
            <Button
              variant="outline"
              className="ml-auto h-8"
              onClick={() => setCompareOpen(true)}
              title="任选另一次已完成扫描（可跨项目）做问题级 + 文件级对比"
            >
              <GitCompare className="size-4" />
              对比扫描
            </Button>
            {!api.isMockMode && (
              <Button asChild variant="outline" className="h-8">
                <a
                  href={api.scanSarifUrl(scan.id)}
                  download
                  title="SARIF 2.1.0，可导入 GitHub Code Scanning / DefectDojo 等工具链"
                >
                  <FileDown className="size-4" />
                  导出 SARIF
                </a>
              </Button>
            )}
            <Button asChild className="h-8">
              <Link to={`/projects/${scan.projectId}/scans/${scan.id}/report`}>
                <FileText className="size-4" />
                生成测试报告
              </Link>
            </Button>
          </>
        )}
      </div>

      {/* 本次扫描实际使用的规则包快照（配置后来怎么改都不影响这里） */}
      {(scan.rulepacks?.length || scan.rules) && scan.status !== 'failed' && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <ListChecks className="size-3.5 shrink-0" />
          {scan.rulepacks?.length ? (
            <>
              <span className="mr-1">本次扫描规则包：</span>
              {scan.rulepacks.map((pack) => (
                // 不截断包名：这行是自由换行的元信息，截断会让「JavaScript / TypeScript」这类长包名看不全
                <Badge key={pack.id} variant="outline" className="px-1.5 font-normal" title={pack.name}>
                  {pack.name}
                </Badge>
              ))}
            </>
          ) : (
            <span>规则集目录：{scan.rules}</span>
          )}
        </div>
      )}

      {scan.status === 'failed' ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <XCircle className="size-8 text-destructive" />
            <p className="text-sm font-medium">本次扫描执行失败</p>
            {scan.message && (
              <p className="max-w-[640px] break-all font-mono text-xs text-muted-foreground">
                {scan.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              请返回项目详情页重新上传源码并发起扫描
            </p>
          </CardContent>
        </Card>
      ) : scan.status === 'scanning' ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              扫描进行中，完成后此处将展示问题列表
            </p>
          </CardContent>
        </Card>
      ) : issues.length === 0 ? (
        // 与"有问题"状态共用同一套双栏骨架：左列承载扫描概要，右列是绿色结论
        <div className="grid flex-1 grid-cols-1 gap-6 lg:min-h-0 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
          <Card className="flex flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                扫描概要
                <Badge className="ml-auto border-transparent bg-success/10 text-xs font-normal text-success">
                  0 问题
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1">
              <dl className="text-sm">
                <div className="flex items-center justify-between gap-3 border-b py-2.5">
                  <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <FileSearch className="size-4" />
                    检查文件
                  </dt>
                  <dd className="min-w-0 text-right font-medium">
                    {scan.fileCount ? `${scan.fileCount} 个` : '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-b py-2.5">
                  <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <ListChecks className="size-4" />
                    规则集
                  </dt>
                  <dd className="min-w-0 truncate font-medium">
                    {scan.rules || '—'}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-3 border-b py-2.5">
                  <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <Package className="size-4" />
                    规则包
                  </dt>
                  <dd className="min-w-0 text-right text-xs leading-5">
                    {scan.rulepacks?.length ? (
                      <span title={scan.rulepacks.map((pack) => pack.name).join('、')}>
                        {scan.rulepacks.map((pack) => pack.name).join('、')}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-b py-2.5">
                  <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <Timer className="size-4" />
                    引擎耗时
                  </dt>
                  <dd className="min-w-0 text-right font-medium">
                    {durationLabel || '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-2.5">
                  <dt className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <GitCompare className="size-4" />
                    基线对比
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
                              title={`基线 v${baselineScan.engineVersion} · 本次 v${scan.engineVersion}，新增/修复项可能来自引擎升级`}
                            >
                              引擎版本不同
                            </Badge>
                          )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">未设置</span>
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
              <p className="text-lg font-semibold">扫描完成，未发现问题</p>
              <p className="mx-auto max-w-[520px] text-sm text-muted-foreground">
                本次扫描共检查 {scan.fileCount || '—'} 个源码文件，未命中任何已启用规则
                {scan.baselineScanId ? '，与基线相比无新增、无遗留问题' : ''}。
              </p>
            </div>
            <Button variant="outline" asChild>
              <Link to={`/projects/${scan.projectId}`}>返回项目详情</Link>
            </Button>
          </Card>
        </div>
      ) : (
        <>
          {scan.baselineScanId && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <GitCompare className="size-4 text-primary" />
                与基线扫描 {scan.baselineScanId} 对比
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
                issues={issues}
                selectedIssueId={selectedIssue?.id ?? null}
                onSelect={setSelectedIssueId}
                onOpenKnowledge={setKnowledgeRuleId}
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
