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
import type { IProject } from '@/data/projects';
import type { IRulePack } from '@/data/rulepacks';
import type { IScanResult } from '@/data/scanresults';
import { SEVERITY_BAR_CLASS, SEVERITY_ORDER } from '@/lib/severity';
import { cn } from '@/lib/utils';
import { api, type HealthInfo, type IDashboardRiskSummary } from '@/lib/api';
import EngineCard from '@/pages/Dashboard/EngineCard';

const EMPTY_SEVERITY_COUNTS: Record<keyof typeof SEVERITY_BAR_CLASS, number> = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
};

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

export default function DashboardPage() {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<IProject[] | null>(null);
  const [scans, setScans] = useState<IScanResult[] | null>(null);
  const [packs, setPacks] = useState<IRulePack[] | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [summary, setSummary] = useState<IDashboardRiskSummary | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const [projectRes, scanRes, packRes, healthRes, summaryRes] = await Promise.allSettled([
      api.listProjects(),
      api.listAllScans(),
      api.listRulePacks(),
      api.getHealth(),
      api.getDashboardRiskSummary(),
    ]);
    if (seq !== loadSeqRef.current) return;
    setLoadFailed(
      [projectRes, scanRes, packRes, summaryRes].some((res) => res.status === 'rejected'),
    );
    setProjects(projectRes.status === 'fulfilled' ? projectRes.value : null);
    setScans((prev) => {
      if (scanRes.status !== 'fulfilled') return null;
      return JSON.stringify(prev) === JSON.stringify(scanRes.value) ? prev : scanRes.value;
    });
    setPacks(packRes.status === 'fulfilled' ? packRes.value : null);
    setHealth(healthRes.status === 'fulfilled' ? healthRes.value : null);
    setSummary(summaryRes.status === 'fulfilled' ? summaryRes.value : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasScanning = useMemo(
    () => (scans ?? []).some((scan) => scan.status === 'scanning'),
    [scans],
  );

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

  const completedScans = useMemo(
    () => (scans ?? []).filter((scan) => scan.status === 'completed'),
    [scans],
  );

  const riskById = useMemo(
    () => new Map((summary?.projects ?? []).map((item) => [item.projectId, item])),
    [summary],
  );
  const severityCounts = summary?.severityCounts ?? EMPTY_SEVERITY_COUNTS;
  const topRules = summary?.topRules ?? [];
  const maxSeverityCount = Math.max(
    1,
    ...SEVERITY_ORDER.map((severity) => severityCounts[severity]),
  );
  const riskTotal = summary
    ? summary.projects.reduce((sum, project) => sum + project.total, 0)
    : null;
  const builtinPacks = (packs ?? []).filter((pack) => pack.builtin).length;
  const customPacks = (packs ?? []).filter((pack) => !pack.builtin).length;
  const hasData = (projects ?? []).length > 0;

  return (
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
          value={riskTotal ?? '—'}
          sub={
            summary
              ? t('dashboard.issueStats', { active: summary.total, pending: summary.pendingReview })
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
              {(summary?.total ?? 0) === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {summary === null
                    ? loadFailed
                      ? t('common.loadFailedHint')
                      : t('common.loading')
                    : hasData
                      ? t('dashboard.riskDistEmpty')
                      : t('dashboard.noProjects')}
                </p>
              ) : (
                SEVERITY_ORDER.map((severity) => {
                  const count = severityCounts[severity];
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
              {topRules.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('dashboard.topRulesEmpty')}</p>
              ) : (
                <div className="space-y-2.5">
                  {topRules.map((rule) => (
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
              {(projects ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {projects === null ? t('common.loading') : t('dashboard.noProjects')}
                </p>
              ) : (
                (projects ?? []).map((project) => {
                  const risk = riskById.get(project.id);
                  return (
                    <div key={project.id} className="flex items-center justify-between gap-2">
                      <Link
                        to={`/projects/${project.id}`}
                        className="min-w-0 flex-1 truncate text-sm hover:underline"
                        title={project.name}
                      >
                        {project.name}
                      </Link>
                      {risk?.latestScanId ? (
                        <Link
                          to={`/projects/${project.id}/scans/${risk.latestScanId}`}
                          className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums"
                        >
                          {risk.critical > 0 && (
                            <Badge className="bg-destructive/15 px-1.5 font-normal text-destructive">
                              {t('severity.critical')} {risk.critical}
                            </Badge>
                          )}
                          {risk.high > 0 && (
                            <Badge className="bg-warning/15 px-1.5 font-normal text-warning">
                              {t('severity.high')} {risk.high}
                            </Badge>
                          )}
                          <span className="text-muted-foreground hover:underline">
                            {t('dashboard.totalCount', { count: risk.total })}
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
