import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  FolderOpen,
  Puzzle,
  Radar,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { IIssue } from '@/data/issues';
import { SEVERITY_LABELS } from '@/data/issues';
import type { IProject } from '@/data/projects';
import type { IRulePack } from '@/data/rulepacks';
import type { IScanResult } from '@/data/scanresults';
import { SEVERITY_BAR_CLASS, SEVERITY_ORDER } from '@/lib/severity';
import { cn } from '@/lib/utils';
import { api, type HealthInfo } from '@/lib/api';

/** 项目维度的最新风险快照：最近一次已完成扫描及其问题明细 */
interface ProjectRisk {
  project: IProject;
  latestScan?: IScanResult;
  issues: IIssue[];
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof FolderOpen;
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 py-5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-2xl font-semibold tabular-nums leading-tight">{value}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {label}
            {sub ? ` · ${sub}` : ''}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** 仪表看盘：项目 / 扫描 / 风险分布 / 规则资产的全局概览（自动刷新，无手动刷新入口） */
export default function DashboardPage() {
  const [projects, setProjects] = useState<IProject[] | null>(null);
  const [scans, setScans] = useState<IScanResult[] | null>(null);
  const [packs, setPacks] = useState<IRulePack[] | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [risks, setRisks] = useState<ProjectRisk[] | null>(null);

  // 序号守卫：interval 与 visibilitychange 可能并发触发 load，慢的旧响应后到不能覆盖新数据
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const [projectRes, scanRes, packRes, healthRes] = await Promise.allSettled([
      api.listProjects(),
      api.listAllScans(),
      api.listRulePacks(),
      api.getHealth(),
    ]);
    if (seq !== loadSeqRef.current) return;
    setProjects(projectRes.status === 'fulfilled' ? projectRes.value : []);
    setScans(scanRes.status === 'fulfilled' ? scanRes.value : []);
    setPacks(packRes.status === 'fulfilled' ? packRes.value : null);
    setHealth(healthRes.status === 'fulfilled' ? healthRes.value : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasScanning = useMemo(
    () => (scans ?? []).some((scan) => scan.status === 'scanning'),
    [scans],
  );

  // 自动刷新：常态每分钟一次；有扫描进行中时 5 秒一次（扫描落定立即反映）；切回本页时即时刷一次
  useEffect(() => {
    const timer = setInterval(() => void load(), hasScanning ? 5000 : 60_000);
    return () => clearInterval(timer);
  }, [load, hasScanning]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  /** 每个项目最近一次已完成扫描（风险口径以此为准） */
  const latestByProject = useMemo(() => {
    const map = new Map<string, IScanResult>();
    for (const scan of scans ?? []) {
      if (scan.status !== 'completed') continue;
      const prev = map.get(scan.projectId);
      if (!prev || new Date(scan.scannedAt) > new Date(prev.scannedAt)) {
        map.set(scan.projectId, scan);
      }
    }
    return map;
  }, [scans]);

  useEffect(() => {
    if (!projects) return;
    let mounted = true;
    void (async () => {
      const entries = await Promise.all(
        projects.map(async (project) => {
          const latest = latestByProject.get(project.id);
          const issues = latest
            ? (await api.listIssues(latest.id).catch(() => [] as IIssue[]))
                // 与报告口径一致：基线对比产生的"已修复"项不算当前风险
                .filter((issue) => issue.comparisonStatus !== 'fixed')
            : [];
          return { project, latestScan: latest, issues };
        }),
      );
      if (mounted) setRisks(entries);
    })();
    return () => {
      mounted = false;
    };
  }, [projects, latestByProject]);

  const completedScans = useMemo(
    () => (scans ?? []).filter((scan) => scan.status === 'completed'),
    [scans],
  );

  /** 全部项目"最近一次扫描"口径下的聚合（与项目风险速览一致，不含已修复项） */
  const aggregated = useMemo(() => {
    const allIssues = (risks ?? []).flatMap((risk) => risk.issues);
    const severityCounts = Object.fromEntries(
      SEVERITY_ORDER.map((severity) => [severity, 0]),
    ) as Record<IIssue['severity'], number>;
    const ruleCounter = new Map<string, { count: number; severity: IIssue['severity'] }>();
    for (const issue of allIssues) {
      severityCounts[issue.severity] += 1;
      const entry = ruleCounter.get(issue.ruleId);
      if (entry) entry.count += 1;
      else ruleCounter.set(issue.ruleId, { count: 1, severity: issue.severity });
    }
    const topRules = [...ruleCounter.entries()]
      .map(([ruleId, info]) => ({ ruleId, ...info }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
    const pendingReview = allIssues.filter((issue) => !issue.review).length;
    return { severityCounts, topRules, pendingReview, total: allIssues.length };
  }, [risks]);

  const maxSeverityCount = Math.max(1, ...SEVERITY_ORDER.map((s) => aggregated.severityCounts[s]));
  const builtinPacks = (packs ?? []).filter((pack) => pack.builtin).length;
  const customPacks = (packs ?? []).filter((pack) => !pack.builtin).length;
  const hasData = (projects ?? []).length > 0;

  return (
    // 整页锁定在视口内（lg 及以上）：统计卡固定行，主体卡片 flex 撑满剩余高度，内容超出走卡片内滚动
    <div className="flex flex-col gap-4 lg:h-full">
      <div className="grid shrink-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={FolderOpen}
          label="审计项目"
          value={projects?.length ?? '—'}
          sub={hasData ? undefined : '尚未建档'}
        />
        <StatCard
          icon={Radar}
          label="累计扫描"
          value={scans?.length ?? '—'}
          sub={
            scans
              ? `已完成 ${completedScans.length} · 失败 ${scans.filter((s) => s.status === 'failed').length}`
              : undefined
          }
        />
        <StatCard
          icon={ShieldAlert}
          label="累计检出问题"
          value={completedScans.reduce((sum, scan) => sum + scan.issueCount, 0)}
          sub={risks ? `当前活跃 ${aggregated.total} · 待复核 ${aggregated.pendingReview}` : undefined}
        />
        <StatCard
          icon={Puzzle}
          label="规则包"
          value={packs ? packs.length : '—'}
          sub={packs ? `内置 ${builtinPacks} · 自建 ${customPacks}` : undefined}
        />
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-3">
        <div className="flex min-h-0 flex-col gap-4 lg:col-span-2">
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="shrink-0 pb-3">
              <CardTitle className="text-base">
                风险分布
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  口径：各项目最近一次已完成扫描
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col justify-center gap-3 overflow-y-auto">
              {aggregated.total === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {hasData
                    ? '最近一轮扫描未检出问题，或尚无已完成的扫描'
                    : '暂无数据，到「项目管理」创建项目并完成一次扫描后，这里会展示风险分布'}
                </p>
              ) : (
                SEVERITY_ORDER.map((severity) => {
                  const count = aggregated.severityCounts[severity];
                  return (
                    <div key={severity} className="flex items-center gap-3">
                      <span className="w-10 shrink-0 text-sm text-muted-foreground">
                        {SEVERITY_LABELS[severity]}
                      </span>
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn('h-full rounded-full', SEVERITY_BAR_CLASS[severity])}
                          style={{ width: `${Math.round((count / maxSeverityCount) * 100)}%` }}
                        />
                      </div>
                      <span className="w-10 shrink-0 text-right text-sm tabular-nums font-medium">
                        {count}
                      </span>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="shrink-0 pb-3">
              <CardTitle className="text-base">高频命中规则</CardTitle>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto">
              {aggregated.topRules.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无命中数据</p>
              ) : (
                <div className="space-y-2.5">
                  {aggregated.topRules.map((rule) => (
                    <div key={rule.ruleId} className="flex items-center gap-3 text-sm">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={rule.ruleId}>
                        {rule.ruleId}
                      </span>
                      <Badge variant="outline" className="shrink-0 font-normal text-xs">
                        {SEVERITY_LABELS[rule.severity]}
                      </Badge>
                      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                        {rule.count} 次
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex min-h-0 flex-col gap-4">
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="shrink-0 pb-3">
              <CardTitle className="text-base">引擎状态</CardTitle>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col justify-center space-y-2 text-sm">
              {health === null ? (
                <p className="text-muted-foreground">加载中…</p>
              ) : health.ok ? (
                <>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-success" />
                    <span>引擎就绪</span>
                    {health.engineVersion && (
                      <Badge variant="secondary" className="font-normal">
                        v{health.engineVersion}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    来源：{health.engineSource ?? '未知'} · 由 manifest 可复现每次扫描
                  </p>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <XCircle className="size-4 text-destructive" />
                  <span>引擎不可用（演示模式或未安装）</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="shrink-0 pb-3">
              <CardTitle className="text-base">项目风险速览</CardTitle>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col justify-center gap-3 overflow-y-auto">
              {(risks ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {projects === null ? '加载中…' : '暂无项目'}
                </p>
              ) : (
                (risks ?? []).map(({ project, latestScan, issues }) => {
                  const critical = issues.filter((issue) => issue.severity === 'critical').length;
                  const high = issues.filter((issue) => issue.severity === 'high').length;
                  return (
                    <div key={project.id} className="flex items-center justify-between gap-2">
                      <Link
                        to={`/projects/${project.id}`}
                        className="min-w-0 flex-1 truncate text-sm hover:underline"
                        title={project.name}
                      >
                        {project.name}
                      </Link>
                      {latestScan ? (
                        <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
                          {critical > 0 && (
                            <Badge className="bg-destructive/15 px-1.5 font-normal text-destructive">
                              严重 {critical}
                            </Badge>
                          )}
                          {high > 0 && (
                            <Badge className="bg-warning/15 px-1.5 font-normal text-warning">
                              高危 {high}
                            </Badge>
                          )}
                          <span className="text-muted-foreground">共 {issues.length}</span>
                        </span>
                      ) : (
                        <span className="shrink-0 text-xs text-muted-foreground">未扫描</span>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
