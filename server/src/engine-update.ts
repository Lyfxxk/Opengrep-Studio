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

/** 检查更新的结果（/api/engine/update，界面"检查更新"与一键升级共用） */
export interface EngineUpdateInfo {
  /** 本机实际探测到的版本（未安装/探测失败时为空） */
  current?: string;
  /** 清单钉住的版本（engines.json 或已升级的 installed.json） */
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
  /** 不可升级的人话原因（canUpgrade=false 时必定有值） */
  reason?: string;
  /** 上游不可达等网络异常的说明 */
  error?: string;
}

export type EngineUpgradePhase = 'downloading' | 'verifying' | 'installing';

export interface EngineUpgradeState {
  state: 'idle' | 'running' | 'done' | 'error';
  phase?: EngineUpgradePhase;
  percent?: number;
  from?: string;
  to?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** GitHub 匿名接口限额 60 次/小时，检查结果缓存 10 分钟，避免看板轮询把配额打光 */
const CHECK_TTL_MS = 10 * 60_000;

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

  // 只对安装位引擎开放升级：env / PATH 来源的引擎由用户自己管，换来的是不碰用户环境
  if (engineSource === 'env') {
    return { ...base, reason: '引擎由环境变量 OPENGREP_BIN 指定，请您自行管理版本' };
  }
  if (engineSource === 'path') {
    return { ...base, reason: '引擎来自系统 PATH，请用原来的安装方式升级' };
  }
  if (!target) {
    return { ...base, reason: `当前平台 ${platformKey()} 没有可用的自动升级资产` };
  }
  if (!current) {
    return { ...base, reason: '未探测到已安装引擎的版本，请先运行 npm run setup:engine 安装' };
  }

  let release: Record<string, unknown>;
  try {
    release = (await fetchLatestRelease()) as Record<string, unknown>;
  } catch (error) {
    return { ...base, error: `无法获取上游最新版本：${messageOf(error)}` };
  }

  const latestTag = String(release?.tag_name ?? '');
  const latest = normalizeVersion(latestTag);
  if (!latest) return { ...base, error: '上游最新版本响应缺少 tag_name，无法判断是否有更新' };

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
    return { ...info, reason: `已是最新 stable 版本（v${current}）` };
  }
  // 上游资产结构变化时明确拒绝，而不是下到一半才发现名字对不上
  if (!asset) {
    return { ...info, reason: `上游 ${latestTag} 缺少资产 ${target.assetFile}，暂不支持自动升级` };
  }
  if (!asset.sha256) {
    return { ...info, reason: `上游 ${latestTag} 未提供 sha256 摘要，暂不支持自动升级` };
  }
  return { ...info, canUpgrade: true };
}

/** 检查更新（force=true 跳过缓存，界面"检查更新"按钮用） */
export async function checkEngineUpdate(force = false): Promise<EngineUpdateInfo> {
  if (!force && cachedCheck && Date.now() - cachedCheck.at < CHECK_TTL_MS) {
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

/** 升级是否在跑（扫描/规则实验室入口据此互斥，Windows 也不允许替换运行中的 exe） */
export function engineUpgradeRunning(): boolean {
  return upgradePending !== null;
}

/**
 * 一键升级：下载 → SHA-256（release 资产 digest）校验 → --version 核对 → 原子替换 → 写 installed.json。
 * 全过程失败都不动现有引擎，状态通过 /api/engine/upgrade 轮询。
 */
export async function startEngineUpgrade(): Promise<EngineUpgradeState> {
  if (upgradePending) throw new HttpError(409, '引擎升级正在进行中，请稍候');

  // 先同步占住互斥位再走网络检查：检查要等 GitHub 往返（可达数秒），期间扫描/实验室
  // 若照常发起，随后替换二进制就会撞上运行中的引擎，升级与扫描两边一起失败
  upgradePending = Promise.resolve();
  try {
    const info = await checkEngineUpdate(true);
    if (info.error) {
      throw new HttpError(
        502,
        `${info.error}${info.current ? `；当前 v${info.current} 可正常使用` : ''}`,
      );
    }
    if (!info.canUpgrade || !info.latestTag || !info.assetName || !info.assetSha256) {
      throw new HttpError(409, info.reason ?? '当前没有可升级的版本');
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
        // 换的是同一个安装位：探测缓存必须失效，否则看板与报告还显示旧版本
        resetEngineVersionCache();
        cachedCheck = undefined;
        upgradeState = {
          ...upgradeState,
          state: 'done',
          phase: undefined,
          percent: 100,
          to: result.version,
          message: `引擎已升级到 v${result.version}，建议重新扫描并重建基线`,
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
          finishedAt: new Date().toISOString(),
        };
        console.error(`[engine-upgrade] 升级失败：${detail}`);
      } finally {
        upgradePending = null;
      }
    })();

    return upgradeState;
  } catch (error) {
    // 检查阶段失败：释放占位并把原本的 4xx/5xx 交回调用方
    upgradePending = null;
    throw error;
  }
}
