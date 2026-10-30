import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

/**
 * 引擎状态卡片：实际版本 + 来源 + 检查更新 + 一键升级。
 * 升级在服务端后台跑（50MB 下载），这里只负责发起与轮询进度。
 */
export default function EngineCard({ health, scanRunning, onUpgraded }: EngineCardProps) {
  const { t } = useTranslation();
  // 引擎文件在但探测不到版本（health.engineVersion 为空）同样按不可用处理：
  // 显示「就绪」却没有版本徽章会误导用户以为引擎可正常扫描
  const ready = Boolean(health?.engine && health.engine !== 'MISSING' && health.engineVersion);
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

  // 进入看板自动查一次：服务端有 30 分钟缓存，不会把 GitHub 匿名配额打光
  useEffect(() => {
    if (ready && managed) void check(false);
  }, [ready, managed, check]);

  // 升级完成后刷新 health 让卡片显示新版本；成功/失败结果本身就渲染在卡片里，
  // 再弹一条 toast 只是把同一句话说两遍
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
            void check(true);
            onUpgraded();
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
          <CardTitle className="text-base">{t('engine.title')}</CardTitle>
          {ready && managed && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              disabled={checking || running}
              onClick={() => void check(true)}
            >
              {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {t('engine.checkUpdate')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col justify-start gap-0 overflow-y-auto text-sm">
        {health === null ? (
          <p className="text-muted-foreground">{t('common.loading')}</p>
        ) : ready ? (
          <>
            {/* 行式版式（与扫描概要一致）：状态 / 来源 / 更新 各占一行，填满卡片高度不显空洞 */}
            <div className="flex flex-wrap items-center gap-2 border-b py-3">
              <CheckCircle2 className="size-4 text-success" />
              <span className="font-medium">{t('engine.ready')}</span>
              {health.engineVersion && (
                <Badge variant="secondary" className="font-normal">
                  v{health.engineVersion}
                </Badge>
              )}
              {health.engineVersion &&
                health.enginePinnedVersion &&
                health.engineVersion !== health.enginePinnedVersion && (
                  <span className="text-xs text-muted-foreground">
                    {t('engine.pinnedVersion', { version: health.enginePinnedVersion })}
                  </span>
                )}
            </div>
            <p className="border-b py-3 text-xs text-muted-foreground">
              {t('engine.source', {
                source: health.engineSourceLabel ?? health.engineSource ?? t('engine.sourceUnknown'),
              })}
            </p>
            <div className="space-y-2 py-3">
              {!managed && (
                <p className="text-xs text-muted-foreground">{t('engine.selfManaged')}</p>
              )}

              {managed && running && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {t(`engine.${upgrade?.phase ?? 'downloading'}`)}…
                      {upgrade?.to ? t('engine.upgradeTarget', { version: upgrade.to }) : ''}
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
                  <span className="text-xs font-medium text-warning">
                    {t('engine.newVersion', { version: update.latest })}
                  </span>
                  <Button
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={!update.canUpgrade || scanRunning || running}
                    onClick={() => void startUpgrade()}
                  >
                    <DownloadCloud className="size-3.5" />
                    {t('engine.upgrade')}
                  </Button>
                  {scanRunning && update.canUpgrade && (
                    <span className="text-xs text-muted-foreground">{t('engine.upgradeBlockedByScan')}</span>
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
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="size-3.5 text-success" />
                    {update.reason ?? t('engine.upToDate')}
                  </p>
                )}

              {update?.error && (
                <p className="break-words text-xs text-muted-foreground">
                  {t('engine.checkFailed', { error: update.error })}
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-1 py-3">
            <div className="flex items-center gap-2">
              <XCircle className="size-4 text-destructive" />
              <span>{t('engine.unavailable')}</span>
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
