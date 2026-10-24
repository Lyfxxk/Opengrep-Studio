import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
import type { IScanResult } from '@/data/scanresults';
import { api, type UploadItem } from '@/lib/api';
import ScanHistoryTable from './ScanHistoryTable';
import UploadZone, { type UploadZoneState } from './UploadZone';

const POLL_INTERVAL_MS = 1500;

export default function ProjectDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<IProject | null>(null);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [scans, setScans] = useState<IScanResult[]>([]);
  const [configs, setConfigs] = useState<IConfig[]>([]);
  const [upload, setUpload] = useState<UploadZoneState>({ status: 'idle' });
  const pollTimerRef = useRef<number | null>(null);
  const prevScansRef = useRef<IScanResult[]>([]);
  // 轮询期间后端瞬断只弹一次错误，恢复后重置（避免每 1.5s 轰炸 toast）
  const pollErrorShownRef = useRef(false);
  // 竞态守卫：id 切换/组件卸载后丢弃 in-flight 响应
  const requestSeqRef = useRef(0);

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
      setProject(projects.find((item) => item.id === id) ?? null);
      for (const scan of scanList) {
        const before = prevScansRef.current.find((item) => item.id === scan.id);
        if (before?.status === 'scanning' && scan.status === 'completed') {
          toast.success(`扫描完成，发现 ${scan.issueCount} 个问题`);
        } else if (before?.status === 'scanning' && scan.status === 'failed') {
          toast.error(`扫描失败：${scan.message ?? '未知原因'}`);
        }
      }
      prevScansRef.current = scanList;
      setScans(scanList);
      pollErrorShownRef.current = false;
    } catch (error) {
      if (requestSeqRef.current !== seq) return;
      if (!pollErrorShownRef.current) {
        pollErrorShownRef.current = true;
        toast.error(`加载项目失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (requestSeqRef.current === seq) {
        setProjectsLoaded(true);
      }
    }
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
  }, []);

  const handleConfigChange = async (configId: string) => {
    if (!id) return;
    try {
      const updated = await api.updateProject(id, { configId });
      setProject(updated);
      toast.success('扫描配置已更新');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const activeConfig = configs.find(
    (config) => config.id === project?.configId,
  );

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
        : `${items[0].relativePath?.split('/')[0] ?? '上传'}（${items.length} 个文件）`;
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
      toast.success(
        [
          result.fileCount > 0 ? `源码上传成功，共 ${result.fileCount} 个文件` : '源码上传成功',
          result.ignoredCount ? `已按 .gitignore 忽略 ${result.ignoredCount} 个文件` : '',
          '可以开始扫描',
        ]
          .filter(Boolean)
          .join('，'),
      );
      if (result.languageStats) {
        setProject((prev) => (prev ? { ...prev, languageStats: result.languageStats } : prev));
        setUpload((prev) =>
          prev.status === 'uploaded' ? { ...prev, languageStats: result.languageStats } : prev,
        );
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
      fileName: ref ? `${url}（${ref}）` : url,
    });
    try {
      const result = await api.cloneSource(id, url, ref || undefined);
      setUpload({ status: 'uploaded', sourceType: 'clone', fileName: url });
      toast.success(`仓库克隆成功，共 ${result.fileCount} 个文件，可以开始扫描`);
      if (result.languageStats) {
        setProject((prev) => (prev ? { ...prev, languageStats: result.languageStats } : prev));
        setUpload((prev) =>
          prev.status === 'uploaded' ? { ...prev, languageStats: result.languageStats } : prev,
        );
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
      toast.info('扫描任务已提交，引擎单并发执行中…');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSetBaseline = async (scanId: string) => {
    if (!id) return;
    try {
      const updated = await api.updateProject(id, { baselineScanId: scanId });
      setProject(updated);
      toast.info('已设为基线扫描，后续扫描将自动对比');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleUnsetBaseline = async () => {
    if (!id) return;
    try {
      const updated = await api.updateProject(id, { baselineScanId: null });
      setProject(updated);
      toast.info('已取消基线，后续扫描不再自动对比');
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
        `SARIF 导入成功：${scan.issueCount} 个问题${
          project?.baselineScanId ? '，已与基线对比' : ''
        }，可在扫描历史查看`,
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
          <p className="text-sm text-muted-foreground">项目不存在或已被删除</p>
          <Button className="mt-4" onClick={() => navigate('/projects')}>
            返回项目列表
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
                基线 {project.baselineScanId}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {project.description || '暂无描述'} · 创建于{' '}
            {formatDateTime(project.createdAt)}
          </p>
          {configs.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">扫描配置</span>
              <Select
                value={project.configId ?? ''}
                onValueChange={(value) => void handleConfigChange(value)}
              >
                <SelectTrigger className="h-8 w-52">
                  <SelectValue placeholder="未绑定（无法扫描）" />
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
                  规则包 {activeConfig.rulePackIds.length} 个 · 排除路径{' '}
                  {activeConfig.excludes.length} 条
                </span>
              )}
              <Link to="/configs" className="text-xs text-primary hover:underline">
                查看配置
              </Link>
              {!project.configId && (
                <span className="text-xs text-warning">请先绑定扫描配置，否则无法发起扫描</span>
              )}
            </div>
          ) : (
            <p className="mt-3 text-xs text-warning">
              尚未创建任何扫描配置，请先到
              <Link to="/configs" className="mx-1 text-primary hover:underline">
                扫描配置
              </Link>
              创建配置（规则包可到
              <Link to="/rules" className="mx-1 text-primary hover:underline">
                规则中心
              </Link>
              管理），再回来绑定
            </p>
          )}
        </div>
        <Button
          className="gap-1"
          disabled={upload.status !== 'uploaded' || isScanning || !project.configId}
          title={project.configId ? undefined : '请先绑定扫描配置'}
          onClick={() => void handleStartScan()}
        >
          {isScanning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          {isScanning ? '扫描执行中…' : '开始扫描'}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">导入源码</CardTitle>
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
          <CardTitle className="text-base">扫描历史</CardTitle>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              外部工具的扫描结果（SARIF 2.x）可导入后统一查看与对比
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
              {importingSarif ? '导入中…' : '导入 SARIF'}
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
