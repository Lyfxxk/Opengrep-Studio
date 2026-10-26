import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, DownloadCloud, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { api, type HealthInfo, type IEngineUpgradeState, type IEngineUpdateInfo } from '@/lib/api';

interface EngineCardProps {
  health: HealthInfo | null;
  /** 有扫描在跑：Windows 不允许替换运行中的 exe，此时禁用升级 */
  scanRunning: boolean;
  /** 升级完成后重新拉取 health，让卡片显示新版本 */
  onUpgraded: () => void;
}

const PHASE_LABELS: Record<NonNullable<IEngineUpgradeState['phase']>, string> = {
  downloading: '下载中',
  verifying: '校验中',
  installing: '安装中',
};

/**
 * 引擎状态卡片：实际版本 + 来源 + 检查更新 + 一键升级。
 * 升级在服务端后台跑（50MB 下载），这里只负责发起与轮询进度。
 */
export default function EngineCard({ health, scanRunning, onUpgraded }: EngineCardProps) {
  const ready = Boolean(health?.engine && health.engine !== 'MISSING');
  const managed = health?.engineManaged === true;
  const [update, setUpdate] = useState<IEngineUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [upgrade, setUpgrade] = useState<IEngineUpgradeState | null>(null);
  const running = upgrade?.state === 'running';

  const check = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      setUpdate(await api.checkEngineUpdate(force));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }, []);

  // 进入看板自动查一次：服务端有 10 分钟缓存，不会把 GitHub 匿名配额打光
  useEffect(() => {
    if (ready && managed) void check(false);
  }, [ready, managed, check]);

  // 升级完成后提示并刷新 health；失败只提示，现有引擎不受影响
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await api.engineUpgradeState();
          if (cancelled) return;
          setUpgrade(next);
          if (next.state === 'done') {
            toast.success(next.message ?? '引擎已升级，建议重新扫描并重建基线');
            void check(true);
            onUpgraded();
          } else if (next.state === 'error') {
            toast.error(next.message ?? '引擎升级失败');
          }
        } catch {
          // 轮询失败忽略：升级在服务端继续，下一轮再取状态
        }
      })();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running, check, onUpgraded]);

  const startUpgrade = async () => {
    setUpgrade({ state: 'running', phase: 'downloading', percent: 0 });
    try {
      setUpgrade(await api.startEngineUpgrade());
    } catch (error) {
      setUpgrade(null);
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="shrink-0 pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">引擎状态</CardTitle>
          {ready && managed && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              disabled={checking || running}
              onClick={() => void check(true)}
              title="向 GitHub 查询最新 stable 版本"
            >
              {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              检查更新
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col justify-center gap-2 overflow-y-auto text-sm">
        {health === null ? (
          <p className="text-muted-foreground">加载中…</p>
        ) : ready ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <CheckCircle2 className="size-4 text-success" />
              <span>引擎就绪</span>
              {health.engineVersion && (
                <Badge variant="secondary" className="font-normal">
                  v{health.engineVersion}
                </Badge>
              )}
              {health.engineVersion &&
                health.enginePinnedVersion &&
                health.engineVersion !== health.enginePinnedVersion && (
                  <span className="text-xs text-muted-foreground">
                    清单 v{health.enginePinnedVersion}
                  </span>
                )}
            </div>
            <p className="text-xs text-muted-foreground">
              来源：{health.engineSourceLabel ?? health.engineSource ?? '未知'} · 由 manifest 可复现每次扫描
            </p>

            {!managed && (
              <p className="text-xs text-muted-foreground">
                引擎由您自行管理（OPENGREP_BIN 或系统 PATH），不支持一键升级。
              </p>
            )}

            {managed && running && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {PHASE_LABELS[upgrade?.phase ?? 'downloading']}…
                    {upgrade?.to ? ` 目标 v${upgrade.to}` : ''}
                  </span>
                  <span className="tabular-nums">{upgrade?.percent ?? 0}%</span>
                </div>
                <Progress value={upgrade?.percent ?? 0} />
              </div>
            )}

            {managed && !running && upgrade?.state === 'error' && (
              <p className="text-xs text-destructive">{upgrade.message}</p>
            )}

            {managed && !running && upgrade?.state === 'done' && (
              <p className="text-xs text-success">{upgrade.message}</p>
            )}

            {managed && !running && update?.updateAvailable && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-warning">发现新版本 v{update.latest}</span>
                <Button
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={!update.canUpgrade || scanRunning || running}
                  onClick={() => void startUpgrade()}
                  title={scanRunning ? '扫描运行期间不能替换引擎文件' : undefined}
                >
                  <DownloadCloud className="size-3.5" />
                  一键升级
                </Button>
                {scanRunning && update.canUpgrade && (
                  <span className="text-xs text-muted-foreground">扫描进行中，暂不可升级</span>
                )}
                {!update.canUpgrade && update.reason && (
                  <span className="text-xs text-muted-foreground">{update.reason}</span>
                )}
              </div>
            )}

            {managed &&
              update &&
              !update.updateAvailable &&
              !update.error &&
              upgrade?.state !== 'done' && (
                <p className="text-xs text-muted-foreground">{update.reason ?? '已是最新版本'}</p>
              )}

            {update?.error && (
              <p className="break-words text-xs text-muted-foreground">检查更新失败：{update.error}</p>
            )}
          </>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <XCircle className="size-4 text-destructive" />
              <span>引擎不可用</span>
            </div>
            {health.engineHint && (
              <p className="whitespace-pre-line text-xs text-muted-foreground">{health.engineHint}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
