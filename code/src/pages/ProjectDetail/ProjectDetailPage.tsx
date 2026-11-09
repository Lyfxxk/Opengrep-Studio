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
import { api, translateApiError, type UploadItem } from '@/lib/api';
import { hasRole } from '@/lib/auth';
import { useConfigDisplayName } from '@/lib/displayNames';
import ScanHistoryTable from './ScanHistoryTable';
import UploadZone, { type UploadZoneState } from './UploadZone';

const POLL_INTERVAL_MS = 1500;

export default function ProjectDetailPage() {
  const { t } = useTranslation();
  const configDisplay = useConfigDisplayName();
  const { id } = useParams();
  const navigate = useNavigate();
  const canWrite = hasRole('auditor');
  const [project, setProject] = useState<IProject | null>(null);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [scans, setScans] = useState<IScanResult[]>([]);
  const [configs, setConfigs] = useState<IConfig[]>([]);
  const [rulePacks, setRulePacks] = useState<IRulePack[]>([]);
  const [upload, setUpload] = useState<UploadZoneState>({ status: 'idle' });
  const [startingScan, setStartingScan] = useState(false);
  const pollTimerRef = useRef<number | null>(null);
  const prevScansRef = useRef<IScanResult[]>([]);
  const pollErrorShownRef = useRef(false);
  const requestSeqRef = useRef(0);
  const activeIdRef = useRef(id);
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
      if (found?.hasSource && !loadedOnceRef.current) {
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
              reason: translateApiError(
                scan.errorCode,
                scan.errorParams,
                scan.message ?? t('projectDetail.unknownReason'),
              ),
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

  const [prevId, setPrevId] = useState(id);
  if (prevId !== id) {
    setPrevId(id);
    setProject(null);
    setScans([]);
    setLoadFailed(false);
    setUpload({ status: 'idle' });
    setStartingScan(false);
  }

  useEffect(() => {
    activeIdRef.current = id;
    loadedOnceRef.current = false;
    prevScansRef.current = [];
    pollErrorShownRef.current = false;
  }, [id]);

  useEffect(() => {
    void Promise.resolve().then(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    api
      .listConfigs()
      .then(setConfigs)
      .catch(() => {
        setConfigs([]);
      });
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const activeConfig = configs.find(
    (config) => config.id === project?.configId,
  );

  const activeConfigDisabledPacks = activeConfig
    ? activeConfig.rulePackIds.filter(
        (packId) => rulePacks.find((pack) => pack.id === packId)?.enabled === false,
      ).length
    : 0;

  const isScanning = scans.some((scan) => scan.status === 'scanning');
  const sourceReady =
    upload.status === 'uploading' ? false : project?.hasSource === true || upload.status === 'uploaded';
  const canStartScan = sourceReady && !isScanning && !startingScan;

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
    const requestId = id;
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
          if (activeIdRef.current !== requestId) return;
          setUpload((prev) =>
            prev.status === 'uploading' ? { ...prev, progress } : prev,
          );
        },
      });
      if (activeIdRef.current !== requestId) return;
      setUpload({
        status: 'uploaded',
        fileName: label,
        fileSize: totalSize,
        progress: 100,
        ignoredCount: result.ignoredCount,
      });
      if (result.languageStats) {
        setProject((prev) =>
          prev ? { ...prev, languageStats: result.languageStats, hasSource: true } : prev,
        );
      }
    } catch (error) {
      if (activeIdRef.current !== requestId) return;
      setUpload({ status: 'idle' });
      void refresh();
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCloneSource = async (url: string, ref: string) => {
    if (!id) return;
    const requestId = id;
    setUpload({
      status: 'uploading',
      sourceType: 'clone',
      fileName: ref ? t('projectDetail.cloneLabelWithRef', { url, ref }) : url,
    });
    try {
      const result = await api.cloneSource(id, url, ref || undefined);
      if (activeIdRef.current !== requestId) return;
      setUpload({ status: 'uploaded', sourceType: 'clone', fileName: url });
      if (result.languageStats) {
        setProject((prev) =>
          prev ? { ...prev, languageStats: result.languageStats, hasSource: true } : prev,
        );
      }
    } catch (error) {
      if (activeIdRef.current !== requestId) return;
      setUpload({ status: 'idle' });
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`${message}${t('projectDetail.cloneFailedSourceKept')}`);
    }
  };

  const handleStartScan = async () => {
    if (!id || !project) return;
    setStartingScan(true);
    try {
      const record = await api.startScan(id, {
        baselineScanId: project.baselineScanId ?? null,
      });
      setScans((prev) => [record, ...prev]);
      setUpload({ status: 'idle' });
      void refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setStartingScan(false);
    }
  };

  const handleSetBaseline = async (scanId: string) => {
    if (!id) return;
    try {
      const updated = await api.updateProject(id, { baselineScanId: scanId });
      setProject(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleUnsetBaseline = async () => {
    if (!id) return;
    try {
      const updated = await api.updateProject(id, { baselineScanId: null });
      setProject(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const [importingSarif, setImportingSarif] = useState(false);
  const sarifInputRef = useRef<HTMLInputElement>(null);

  const handleImportSarif = async (file: File) => {
    if (!id) return;
    setImportingSarif(true);
    try {
      await api.importSarif(id, file, project?.baselineScanId ?? undefined);
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
            {project.description ? `${project.description} · ` : ''}
            {t('projectDetail.createdAt', { time: formatDateTime(project.createdAt) })}
          </p>
          {configs.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('projectDetail.configLabel')}</span>
              <Select
                value={project.configId ?? ''}
                disabled={!canWrite}
                onValueChange={(value) => void handleConfigChange(value)}
              >
                <SelectTrigger className="h-8 w-52">
                  <SelectValue placeholder={t('projectDetail.configUnboundPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {configs.map((config) => (
                    <SelectItem key={config.id} value={config.id}>
                      {configDisplay(config).name}
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
        {canWrite && (
          <Button
            data-testid="start-scan"
            className="gap-1"
            disabled={!canStartScan}
            onClick={() => void handleStartScan()}
          >
            {isScanning || startingScan ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            {isScanning || startingScan
              ? t('projectDetail.scanningBtn')
              : project.configId
                ? t('projectDetail.startScanBtn')
                : t('projectDetail.startScanAllPacks')}
          </Button>
        )}
      </div>

      {canWrite && (
        <Card>
          <CardContent className="pt-6">
            <UploadZone
              state={upload}
              languageStats={project.languageStats}
              onSelectItems={(items, options) => void handleUploadItems(items, options)}
              onClone={(url, ref) => void handleCloneSource(url, ref)}
              onReset={() => setUpload({ status: 'idle' })}
            />
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{t('projectDetail.scanHistoryTitle')}</CardTitle>
          {!api.isMockMode && canWrite && (
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
            canSetBaseline={canWrite}
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
