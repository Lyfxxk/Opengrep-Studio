import { engineExecutableName, engineSource } from './config.js';
import { HttpError } from './errors.js';
import { getEngineVersion, resetEngineVersionCache } from './engine.js';
import { engineTarget, engineToolDir } from './engine-manifest.js';
import {
  compareVersions,
  fetchLatestRelease,
  findAsset,
  installEngineAsset,
  normalizeVersion,
  platformKey,
} from '../scripts/engine-install.mjs';

export interface EngineUpdateInfo {
  current?: string;
  pinned?: string;
  latest?: string;
  latestTag?: string;
  updateAvailable: boolean;
  canUpgrade: boolean;
  assetName?: string;
  assetUrl?: string;
  assetSha256?: string;
  releaseUrl?: string;
  publishedAt?: string;
  checkedAt: string;
  reason?: string;
  reasonCode?: string;
  reasonParams?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, unknown>;
}

export type EngineUpgradePhase = 'downloading' | 'verifying' | 'installing';

export interface EngineUpgradeState {
  state: 'idle' | 'running' | 'done' | 'error';
  phase?: EngineUpgradePhase;
  percent?: number;
  from?: string;
  to?: string;
  message?: string;
  messageCode?: string;
  messageParams?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
}

const CHECK_TTL_MS = 30 * 60_000;
const FAILURE_TTL_MS = 5 * 60_000;

let cachedCheck: { at: number; info: EngineUpdateInfo } | undefined;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildUpdateInfo(): Promise<EngineUpdateInfo> {
  const current = await getEngineVersion();
  const target = engineTarget();
  const base: EngineUpdateInfo = {
    current,
    pinned: target ? normalizeVersion(target.version) : undefined,
    assetName: target?.assetFile,
    updateAvailable: false,
    canUpgrade: false,
    checkedAt: new Date().toISOString(),
  };

  if (engineSource === 'env') {
    return {
      ...base,
      reason: '引擎由环境变量 OPENGREP_BIN 指定，请您自行管理版本',
      reasonCode: 'engine.sourceEnv',
    };
  }
  if (engineSource === 'path') {
    return {
      ...base,
      reason: '引擎来自系统 PATH，请用原来的安装方式升级',
      reasonCode: 'engine.sourcePath',
    };
  }
  if (!target) {
    return {
      ...base,
      reason: `当前平台 ${platformKey()} 没有可用的自动升级资产`,
      reasonCode: 'engine.noAssetForPlatform',
      reasonParams: { platform: platformKey() },
    };
  }
  if (!current) {
    return {
      ...base,
      reason: '未探测到已安装引擎的版本，请先运行 npm run setup:engine 安装',
      reasonCode: 'engine.versionUnprobed',
    };
  }

  let release: Record<string, unknown>;
  try {
    release = (await fetchLatestRelease()) as Record<string, unknown>;
  } catch (error) {
    return {
      ...base,
      error: `无法获取上游最新版本：${messageOf(error)}`,
      errorCode: 'engine.checkFailed',
      errorParams: { reason: messageOf(error) },
    };
  }

  const latestTag = String(release?.tag_name ?? '');
  const latest = normalizeVersion(latestTag);
  if (!latest) {
    return {
      ...base,
      error: '上游最新版本响应缺少 tag_name，无法判断是否有更新',
      errorCode: 'engine.tagMissing',
    };
  }

  const asset = findAsset(release, target.assetFile);
  const info: EngineUpdateInfo = {
    ...base,
    latest,
    latestTag,
    assetUrl: asset?.url,
    assetSha256: asset?.sha256,
    releaseUrl: typeof release?.html_url === 'string' ? release.html_url : undefined,
    publishedAt: typeof release?.published_at === 'string' ? release.published_at : undefined,
    updateAvailable: compareVersions(latest, current) > 0,
  };
  if (!info.updateAvailable) {
    return {
      ...info,
      reason: `已是最新 stable 版本（v${current}）`,
      reasonCode: 'engine.upToDateVersion',
      reasonParams: { version: current },
    };
  }
  if (!asset) {
    return {
      ...info,
      reason: `上游 ${latestTag} 缺少资产 ${target.assetFile}，暂不支持自动升级`,
      reasonCode: 'engine.assetMissing',
      reasonParams: { tag: latestTag, asset: target.assetFile },
    };
  }
  if (!asset.sha256) {
    return {
      ...info,
      reason: `上游 ${latestTag} 未提供 sha256 摘要，暂不支持自动升级`,
      reasonCode: 'engine.digestMissing',
      reasonParams: { tag: latestTag },
    };
  }
  return { ...info, canUpgrade: true };
}

export async function checkEngineUpdate(force = false): Promise<EngineUpdateInfo> {
  const ttl = cachedCheck?.info.error ? FAILURE_TTL_MS : CHECK_TTL_MS;
  if (!force && cachedCheck && Date.now() - cachedCheck.at < ttl) {
    return cachedCheck.info;
  }
  const info = await buildUpdateInfo();
  cachedCheck = { at: Date.now(), info };
  return info;
}

let upgradeState: EngineUpgradeState = { state: 'idle' };
let upgradePending: Promise<void> | null = null;

export function engineUpgradeState(): EngineUpgradeState {
  return upgradeState;
}

export function engineUpgradeRunning(): boolean {
  return upgradePending !== null;
}

export async function startEngineUpgrade(): Promise<EngineUpgradeState> {
  if (upgradePending) {
    throw new HttpError(409, '引擎升级正在进行中，请稍候', { code: 'srv.upgradePending' });
  }

  upgradePending = Promise.resolve();
  try {
    const info = await checkEngineUpdate(true);
    if (info.error) {
      throw new HttpError(
        502,
        `${info.error}${info.current ? `；当前 v${info.current} 可正常使用` : ''}`,
        {
          code:
            info.errorCode === 'engine.tagMissing'
              ? 'engine.tagMissing'
              : info.current
                ? 'engine.checkFailedCurrent'
                : 'engine.checkFailed',
          params:
            info.errorCode === 'engine.tagMissing'
              ? undefined
              : info.current
                ? { ...(info.errorParams ?? {}), current: info.current }
                : (info.errorParams ?? {}),
        },
      );
    }
    if (!info.canUpgrade || !info.latestTag || !info.assetName || !info.assetSha256) {
      throw new HttpError(409, info.reason ?? '当前没有可升级的版本', {
        code: info.reasonCode ?? 'srv.noUpgradeTarget',
        params: info.reasonParams,
      });
    }

    const from = info.current;
    const to = normalizeVersion(info.latestTag);
    const { latestTag: tag, assetName, assetSha256: sha256, assetUrl } = info;

    upgradeState = {
      state: 'running',
      phase: 'downloading',
      percent: 0,
      from,
      to,
      startedAt: new Date().toISOString(),
    };

    upgradePending = (async () => {
      try {
        const result = await installEngineAsset({
          tag,
          assetFile: assetName,
          sha256,
          assetUrl,
          toolDir: engineToolDir,
          installedName: engineExecutableName,
          onProgress: ({ phase, percent }: { phase: EngineUpgradePhase; percent?: number }) => {
            upgradeState = { ...upgradeState, phase, percent: percent ?? upgradeState.percent };
          },
          log: (message: string) => console.log(`[engine-upgrade] ${message}`),
        });
        resetEngineVersionCache();
        cachedCheck = undefined;
        upgradeState = {
          ...upgradeState,
          state: 'done',
          phase: undefined,
          percent: 100,
          to: result.version,
          message: `引擎已升级到 v${result.version}，建议重新扫描并重建基线`,
          messageCode: 'engine.upgraded',
          messageParams: { version: result.version },
          finishedAt: new Date().toISOString(),
        };
        console.log(`[engine-upgrade] 升级完成：v${from} → v${result.version}（${result.channel}）`);
      } catch (error) {
        const detail = messageOf(error);
        upgradeState = {
          ...upgradeState,
          state: 'error',
          phase: undefined,
          message: `${detail}${from ? `；现有引擎 v${from} 未改动，可继续正常扫描` : ''}`,
          ...(from
            ? {
                messageCode: 'engine.upgradeFailedKeepCurrent',
                messageParams: { detail, from },
              }
            : {}),
          finishedAt: new Date().toISOString(),
        };
        console.error(`[engine-upgrade] 升级失败：${detail}`);
      } finally {
        upgradePending = null;
      }
    })();

    return upgradeState;
  } catch (error) {
    upgradePending = null;
    throw error;
  }
}
