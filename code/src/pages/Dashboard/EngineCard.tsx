import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CheckCircle2, DownloadCloud, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { api, translateApiError, type HealthInfo, type IEngineUpgradeState, type IEngineUpdateInfo } from '@/lib/api';

interface EngineCardProps {
  health: HealthInfo | null;
  scanRunning: boolean;
  onUpgraded: () => void;
}

export default function EngineCard({ health, scanRunning, onUpgraded }: EngineCardProps) {
  const { t } = useTranslation();
  const ready = health?.engineReady === true && Boolean(health.engineVersion);
  const managed = health?.engineManaged === true;
  const [update, setUpdate] = useState<IEngineUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [upgrade, setUpgrade] = useState<IEngineUpgradeState | null>(null);
  const running = upgrade?.state === 'running';

  const sourceLabel = health?.engineSource
    ? t(`engineSource.${health.engineSource}`)
    : t('engine.sourceUnknown');
  const hintText = health
    ? [
        translateApiError(health.engineHintCode, health.engineHintParams, health.engineHint ?? ''),
        health.engineHintMacos ? t('engine.hintMacosQuarantine') : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const upgradeMessage = upgrade
    ? translateApiError(upgrade.messageCode, upgrade.messageParams, upgrade.message ?? '')
    : '';
  const updateReason = update
    ? translateApiError(update.reasonCode, update.reasonParams, update.reason ?? '')
    : '';
  const updateError = update
    ? translateApiError(update.errorCode, update.errorParams, update.error ?? '')
    : '';

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

  useEffect(() => {
    if (ready && managed) void check(false);
  }, [ready, managed, check]);

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
              {t('engine.source', { source: sourceLabel })}
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
                <p className="text-xs text-destructive">{upgradeMessage}</p>
              )}

              {managed && !running && upgrade?.state === 'done' && (
                <p className="text-xs text-success">{upgradeMessage}</p>
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
                  {!update.canUpgrade && updateReason && (
                    <span className="text-xs text-muted-foreground">{updateReason}</span>
                  )}
                </div>
              )}

              {managed &&
                update &&
                !update.updateAvailable &&
                !updateError &&
                upgrade?.state !== 'done' && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="size-3.5 text-success" />
                    {updateReason || t('engine.upToDate')}
                  </p>
                )}

              {updateError && (
                <p className="break-words text-xs text-muted-foreground">
                  {t('engine.checkFailed', { error: updateError })}
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
            {hintText && (
              <p className="whitespace-pre-line text-xs text-muted-foreground">{hintText}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
