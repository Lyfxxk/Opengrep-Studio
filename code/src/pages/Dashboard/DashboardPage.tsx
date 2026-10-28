import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Puzzle, Radar, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { IIssue } from '@/data/issues';
import type { IProject } from '@/data/projects';
import type { IRulePack } from '@/data/rulepacks';
import type { IScanResult } from '@/data/scanresults';
import { SEVERITY_BAR_CLASS, SEVERITY_ORDER } from '@/lib/severity';
import { cn } from '@/lib/utils';
import { api, type HealthInfo } from '@/lib/api';
import EngineCard from '@/pages/Dashboard/EngineCard';

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
  const { t } = useTranslation();
  const [projects, setProjects] = useState<IProject[] | null>(null);
  const [scans, setScans] = useState<IScanResult[] | null>(null);
  const [packs, setPacks] = useState<IRulePack[] | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [risks, setRisks] = useState<ProjectRisk[] | null>(null);
  // 任一核心接口失败置位：失败要显式提示，不能把"加载失败"伪装成零数据
  const [loadFailed, setLoadFailed] = useState(false);

  // 序号守卫：interval 与 visibilitychange 可能并发触发 load，慢的旧响应后到不能覆盖新数据
  const loadSeqRef = useRef(0);
  // 风险速览拉取键：记录上次重拉 issues 时的输入签名，键不变就跳过重拉
  const riskKeyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const [projectRes, scanRes, packRes, healthRes] = await Promise.allSettled([
      api.listProjects(),
      api.listAllScans(),
      api.listRulePacks(),
      api.getHealth(),
    ]);
    if (seq !== loadSeqRef.current) return;
    setLoadFailed([projectRes, scanRes, packRes].some((res) => res.status === 'rejected'));
    // 失败保持 null（未加载态）：渲染成空数组会把失败伪装成"零数据/尚未建档"
    setProjects(projectRes.status === 'fulfilled' ? projectRes.value : null);
    setScans((prev) => {
      if (scanRes.status !== 'fulfilled') return null;
      // 基础数据未变时保留旧引用：轮询每轮换新数组会连锁重算 latestByProject 等下游 memo 与渲染
      return JSON.stringify(prev) === JSON.stringify(scanRes.value) ? prev : scanRes.value;
    });
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
    // 拉取键 = 项目集合 + 项目名 + 各项目最新已完成扫描 id：速览条目的渲染输入只有这三样，
    // issues 内容只随最新扫描 id 变化，键不变就跳过重拉（needMeta 思路，参照 ScanResultPage），
    // 避免轮询带来的新数组引用让每个项目每轮都白发一次 listIssues
    const key = JSON.stringify(
      projects.map((project) => [
        project.id,
        project.name,
        latestByProject.get(project.id)?.id ?? null,
      ]),
    );
    if (key === riskKeyRef.current) return;
    riskKeyRef.current = key;
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
      // 键守卫代替组件挂载标记：慢的旧响应后到时键已过期不能覆盖新数据（与 loadSeqRef 同型）；
      // 同键的并发重跑产生等价结果，后到覆盖无害，因此不做"仅挂载期生效"的丢弃
      if (riskKeyRef.current === key) setRisks(entries);
    })();
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
      {loadFailed && (
        <p className="shrink-0 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {t('dashboard.loadFailed')}
        </p>
      )}
      <div className="grid shrink-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={FolderOpen}
          label={t('dashboard.statsProjects')}
          value={projects?.length ?? '—'}
          sub={projects === null ? undefined : hasData ? undefined : t('dashboard.noProjectsYet')}
        />
        <StatCard
          icon={Radar}
          label={t('dashboard.statsScans')}
          value={scans?.length ?? '—'}
          sub={
            scans
              ? t('dashboard.scanStats', {
                  completed: completedScans.length,
                  failed: scans.filter((s) => s.status === 'failed').length,
                })
              : undefined
          }
        />
        <StatCard
          icon={ShieldAlert}
          label={t('dashboard.statsIssues')}
          value={completedScans.reduce((sum, scan) => sum + scan.issueCount, 0)}
          sub={
            risks
              ? t('dashboard.issueStats', { active: aggregated.total, pending: aggregated.pendingReview })
              : undefined
          }
        />
        <StatCard
          icon={Puzzle}
          label={t('dashboard.statsPacks')}
          value={packs ? packs.length : '—'}
          sub={packs ? t('dashboard.packStats', { builtin: builtinPacks, custom: customPacks }) : undefined}
        />
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-3">
        <div className="flex min-h-0 flex-col gap-4 lg:col-span-2">
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="shrink-0 pb-3">
              <CardTitle className="text-base">
                {t('dashboard.riskDistTitle')}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {t('dashboard.riskDistScope')}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col justify-center gap-3 overflow-y-auto">
              {aggregated.total === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {hasData
                    ? t('dashboard.riskDistEmpty')
                    : projects === null
                      ? t('dashboard.loadingData')
                      : t('dashboard.riskDistEmptyProject')}
                </p>
              ) : (
                SEVERITY_ORDER.map((severity) => {
                  const count = aggregated.severityCounts[severity];
                  return (
                    <div key={severity} className="flex items-center gap-3">
                      <span className="w-10 shrink-0 text-sm text-muted-foreground">
                        {t(`severity.${severity}`)}
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
              <CardTitle className="text-base">{t('dashboard.topRulesTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto">
              {aggregated.topRules.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('dashboard.topRulesEmpty')}</p>
              ) : (
                <div className="space-y-2.5">
                  {aggregated.topRules.map((rule) => (
                    <div key={rule.ruleId} className="flex items-center gap-3 text-sm">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={rule.ruleId}>
                        {rule.ruleId}
                      </span>
                      <Badge variant="outline" className="shrink-0 font-normal text-xs">
                        {t(`severity.${rule.severity}`)}
                      </Badge>
                      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                        {t('dashboard.hits', { count: rule.count })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex min-h-0 flex-col gap-4">
          <EngineCard health={health} scanRunning={hasScanning} onUpgraded={load} />

          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="shrink-0 pb-3">
              <CardTitle className="text-base">{t('dashboard.riskOverviewTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col justify-center gap-3 overflow-y-auto">
              {(risks ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {projects === null ? t('common.loading') : t('dashboard.noProjects')}
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
                        <Link
                          to={`/projects/${project.id}/scans/${latestScan.id}`}
                          className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums"
                          title={t('dashboard.viewScanResult', { id: latestScan.id })}
                        >
                          {critical > 0 && (
                            <Badge className="bg-destructive/15 px-1.5 font-normal text-destructive">
                              {t('severity.critical')} {critical}
                            </Badge>
                          )}
                          {high > 0 && (
                            <Badge className="bg-warning/15 px-1.5 font-normal text-warning">
                              {t('severity.high')} {high}
                            </Badge>
                          )}
                          <span className="text-muted-foreground hover:underline">
                            {t('dashboard.totalCount', { count: issues.length })}
                          </span>
                        </Link>
                      ) : (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {t('dashboard.unscanned')}
                        </span>
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
