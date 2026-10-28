import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatDateTime } from '@/lib/format';
import { FileUp, Flag, Loader2, Play } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { type IConfig } from '@/data/configs';
import type { IProject } from '@/data/projects';
import type { IRulePack } from '@/data/rulepacks';
import type { IScanResult } from '@/data/scanresults';
import { api, type UploadItem } from '@/lib/api';
import ScanHistoryTable from './ScanHistoryTable';
import UploadZone, { type UploadZoneState } from './UploadZone';

const POLL_INTERVAL_MS = 1500;

export default function ProjectDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<IProject | null>(null);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  /** 首次加载即失败（区别于"项目不存在"：网络/后端异常时提示重试而不是误报已删除） */
  const [loadFailed, setLoadFailed] = useState(false);
  const [scans, setScans] = useState<IScanResult[]>([]);
  const [configs, setConfigs] = useState<IConfig[]>([]);
  // 规则包启用态：配置摘要需要区分「勾选了 N 个」和「实际生效 N 个」，停用包扫描时会被静默跳过
  const [rulePacks, setRulePacks] = useState<IRulePack[]>([]);
  const [upload, setUpload] = useState<UploadZoneState>({ status: 'idle' });
  const pollTimerRef = useRef<number | null>(null);
  const prevScansRef = useRef<IScanResult[]>([]);
  // 轮询期间后端瞬断只弹一次错误，恢复后重置（避免每 1.5s 轰炸 toast）
  const pollErrorShownRef = useRef(false);
  // 竞态守卫：id 切换/组件卸载后丢弃 in-flight 响应
  const requestSeqRef = useRef(0);
  const loadedOnceRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    try {
      const [projects, scanList] = await Promise.all([
        api.listProjects(),
        api.listScans(id),
      ]);
      if (requestSeqRef.current !== seq) return;
      const found = projects.find((item) => item.id === id) ?? null;
      setProject(found);
      // 从后端恢复源码上传态：API 上传或页面刷新后扫描按钮不再丢失可用态
      if (found?.hasSource) {
        setUpload((prev) =>
          prev.status === 'idle'
            ? { status: 'uploaded', sourceType: 'upload', fileName: t('projectDetail.sourceRestored') }
            : prev,
        );
      }
      loadedOnceRef.current = true;
      for (const scan of scanList) {
        const before = prevScansRef.current.find((item) => item.id === scan.id);
        if (before?.status === 'scanning' && scan.status === 'completed') {
          toast.success(t('projectDetail.scanCompletedToast', { count: scan.issueCount }));
        } else if (before?.status === 'scanning' && scan.status === 'failed') {
          toast.error(
            t('projectDetail.scanFailedToast', {
              reason: scan.message ?? t('projectDetail.unknownReason'),
            }),
          );
        }
      }
      prevScansRef.current = scanList;
      setScans(scanList);
      pollErrorShownRef.current = false;
      setLoadFailed(false);
    } catch (error) {
      if (requestSeqRef.current !== seq) return;
      if (!loadedOnceRef.current) setLoadFailed(true);
      if (!pollErrorShownRef.current) {
        pollErrorShownRef.current = true;
        toast.error(t('projectDetail.loadFailedToast', { error: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      if (requestSeqRef.current === seq) {
        setProjectsLoaded(true);
      }
    }
  }, [id, t]);

  // 路由 :id 切换会复用同一组件实例：先重置上一个项目留下的状态，避免旧数据在新 URL 下闪现甚至误操作
  useEffect(() => {
    setProject(null);
    setScans([]);
    setLoadFailed(false);
    loadedOnceRef.current = false;
    prevScansRef.current = [];
    pollErrorShownRef.current = false;
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    api
      .listConfigs()
      .then(setConfigs)
      .catch(() => {
        setConfigs([]);
      });
    // 启用态拉取失败按空表处理：摘要退回原计数，不因次要数据阻塞页面
    api
      .listRulePacks()
      .then(setRulePacks)
      .catch(() => {
        setRulePacks([]);
      });
  }, []);

  const handleConfigChange = async (configId: string) => {
    if (!id) return;
    try {
      const updated = await api.updateProject(id, { configId });
      setProject(updated);
      toast.success(t('projectDetail.configUpdatedToast'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const activeConfig = configs.find(
    (config) => config.id === project?.configId,
  );

  // 已勾选但已停用的规则包数：这些包在扫描时会被静默跳过，摘要按原样报个数会让审阅者误信「已扫过」
  const activeConfigDisabledPacks = activeConfig
    ? activeConfig.rulePackIds.filter(
        (packId) => rulePacks.find((pack) => pack.id === packId)?.enabled === false,
      ).length
    : 0;

  const isScanning = scans.some((scan) => scan.status === 'scanning');

  useEffect(() => {
    if (!isScanning) return;
    pollTimerRef.current = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isScanning, refresh]);

  const handleUploadItems = async (
    items: UploadItem[],
    options: { respectGitignore: boolean },
  ) => {
    if (!id) return;
    const label =
      items.length === 1
        ? items[0].file.name
        : t('projectDetail.multiFileLabel', {
            dir: items[0].relativePath?.split('/')[0] ?? t('projectDetail.uploadFallback'),
            count: items.length,
          });
    const totalSize = items.reduce((sum, item) => sum + item.file.size, 0);
    setUpload({
      status: 'uploading',
      fileName: label,
      fileSize: totalSize,
      progress: 8,
    });
    try {
      const result = await api.uploadSource(id, items, {
        respectGitignore: options.respectGitignore,
        onProgress: (progress) => {
          setUpload((prev) =>
            prev.status === 'uploading' ? { ...prev, progress } : prev,
          );
        },
      });
      setUpload({
        status: 'uploaded',
        fileName: label,
        fileSize: totalSize,
        progress: 100,
        ignoredCount: result.ignoredCount,
      });
      const uploadToastKey =
        result.fileCount > 0
          ? result.ignoredCount
            ? 'projectDetail.uploadOkBoth'
            : 'projectDetail.uploadOkFiles'
          : result.ignoredCount
            ? 'projectDetail.uploadOkIgnored'
            : 'projectDetail.uploadOkPlain';
      toast.success(
        t(uploadToastKey, { files: result.fileCount, ignored: result.ignoredCount ?? 0 }),
      );
      if (result.languageStats) {
        setProject((prev) => (prev ? { ...prev, languageStats: result.languageStats } : prev));
      }
    } catch (error) {
      setUpload({ status: 'idle' });
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCloneSource = async (url: string, ref: string) => {
    if (!id) return;
    setUpload({
      status: 'uploading',
      sourceType: 'clone',
      fileName: ref ? t('projectDetail.cloneLabelWithRef', { url, ref }) : url,
    });
    try {
      const result = await api.cloneSource(id, url, ref || undefined);
      setUpload({ status: 'uploaded', sourceType: 'clone', fileName: url });
      toast.success(t('projectDetail.cloneSuccessToast', { count: result.fileCount }));
      if (result.languageStats) {
        setProject((prev) => (prev ? { ...prev, languageStats: result.languageStats } : prev));
      }
    } catch (error) {
      setUpload({ status: 'idle' });
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleStartScan = async () => {
    if (!id || !project) return;
    try {
      const record = await api.startScan(id, {
        baselineScanId: project.baselineScanId ?? null,
      });
      setScans((prev) => [record, ...prev]);
      setUpload({ status: 'idle' });
      toast.info(t('projectDetail.scanSubmittedToast'));
      // 服务端可能在提交时自动绑定了「默认扫描配置」，立即刷新让按钮与配置选择器同步
      void refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSetBaseline = async (scanId: string) => {
    if (!id) return;
    try {
      const updated = await api.updateProject(id, { baselineScanId: scanId });
      setProject(updated);
      toast.info(t('projectDetail.baselineSetToast'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleUnsetBaseline = async () => {
    if (!id) return;
    try {
      const updated = await api.updateProject(id, { baselineScanId: null });
      setProject(updated);
      toast.info(t('projectDetail.baselineUnsetToast'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  // SARIF 导入：把外部工具（Semgrep / CodeQL / 其他 Studio 实例）的结果引入为一条已完成扫描，
  // 默认对项目当前基线做对比，让外源结果也能参与 new/remaining/fixed
  const [importingSarif, setImportingSarif] = useState(false);
  const sarifInputRef = useRef<HTMLInputElement>(null);

  const handleImportSarif = async (file: File) => {
    if (!id) return;
    setImportingSarif(true);
    try {
      const scan = await api.importSarif(id, file, project?.baselineScanId ?? undefined);
      toast.success(
        project?.baselineScanId
          ? t('projectDetail.sarifImportedCompared', { count: scan.issueCount })
          : t('projectDetail.sarifImportedBase', { count: scan.issueCount }),
      );
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setImportingSarif(false);
    }
  };

  const recentScans = useMemo(() => scans.slice(0, 20), [scans]);

  if (projectsLoaded && !project) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-dashed p-16 text-center">
          <p className="text-sm text-muted-foreground">
            {loadFailed ? t('common.loadFailedHint') : t('projectDetail.notFound')}
          </p>
          <Button className="mt-4" onClick={() => navigate('/projects')}>
            {t('common.backToProjects')}
          </Button>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-4">
        <SkeletonBlock />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{project.name}</h1>
            {project.baselineScanId && (
              <Badge variant="outline" className="gap-1 font-normal">
                <Flag className="size-3" />
                {t('projectDetail.baselineBadge', { id: project.baselineScanId })}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {project.description || t('projectDetail.noDescription')} ·{' '}
            {t('projectDetail.createdAt', { time: formatDateTime(project.createdAt) })}
          </p>
          {configs.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('projectDetail.configLabel')}</span>
              <Select
                value={project.configId ?? ''}
                onValueChange={(value) => void handleConfigChange(value)}
              >
                <SelectTrigger className="h-8 w-52">
                  <SelectValue placeholder={t('projectDetail.configUnboundPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {configs.map((config) => (
                    <SelectItem key={config.id} value={config.id}>
                      {config.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeConfig && (
                <span className="text-xs text-muted-foreground">
                  {activeConfigDisabledPacks > 0
                    ? t('projectDetail.configSummaryWithDisabled', {
                        packs: activeConfig.rulePackIds.length,
                        disabled: activeConfigDisabledPacks,
                        excludes: activeConfig.excludes.length,
                      })
                    : t('projectDetail.configSummary', {
                        packs: activeConfig.rulePackIds.length,
                        excludes: activeConfig.excludes.length,
                      })}
                </span>
              )}
              <Link to="/configs" className="text-xs text-primary hover:underline">
                {t('projectDetail.viewConfigs')}
              </Link>
              {!project.configId && (
                <span className="text-xs text-warning">{t('projectDetail.unboundWarning')}</span>
              )}
            </div>
          ) : (
            <p className="mt-3 text-xs text-warning">
              {t('projectDetail.noConfigsPrefix')}
              <Link to="/configs" className="mx-1 text-primary hover:underline">
                {t('nav.configs')}
              </Link>
              {t('projectDetail.noConfigsMiddle')}
              <Link to="/rules" className="mx-1 text-primary hover:underline">
                {t('nav.rules')}
              </Link>
              {t('projectDetail.noConfigsSuffix')}
            </p>
          )}
        </div>
        <Button
          className="gap-1"
          disabled={upload.status !== 'uploaded' || isScanning}
          title={
            project.configId ? undefined : t('projectDetail.startScanUnboundTitle')
          }
          onClick={() => void handleStartScan()}
        >
          {isScanning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          {isScanning
            ? t('projectDetail.scanningBtn')
            : project.configId
              ? t('projectDetail.startScanBtn')
              : t('projectDetail.startScanAllPacks')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('projectDetail.importSourceTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <UploadZone
            state={upload}
            languageStats={project.languageStats}
            onSelectItems={(items, options) => void handleUploadItems(items, options)}
            onClone={(url, ref) => void handleCloneSource(url, ref)}
            onReset={() => setUpload({ status: 'idle' })}
          />
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{t('projectDetail.scanHistoryTitle')}</CardTitle>
          {/* 演示模式无后端：SARIF 导入没有 mock 实现，隐藏入口避免点了必失败 */}
          {!api.isMockMode && (
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {t('projectDetail.sarifHint')}
              </span>
              <Button
                variant="outline"
                className="h-8 gap-1"
                disabled={importingSarif}
                onClick={() => sarifInputRef.current?.click()}
              >
                {importingSarif ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <FileUp className="size-4" />
                )}
                {importingSarif ? t('projectDetail.importing') : t('projectDetail.importSarif')}
              </Button>
              <input
                ref={sarifInputRef}
                type="file"
                accept=".sarif,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void handleImportSarif(file);
                }}
              />
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <ScanHistoryTable
            scans={recentScans}
            baselineScanId={project.baselineScanId}
            onSetBaseline={(scanId) => void handleSetBaseline(scanId)}
            onUnsetBaseline={() => void handleUnsetBaseline()}
            onView={(scanId) => navigate(`/projects/${project.id}/scans/${scanId}`)}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function SkeletonBlock() {
  return (
    <Card>
      <CardContent className="space-y-3 p-6">
        <div className="h-6 w-40 animate-pulse rounded bg-muted" />
        <div className="h-4 w-64 animate-pulse rounded bg-muted" />
      </CardContent>
    </Card>
  );
}
