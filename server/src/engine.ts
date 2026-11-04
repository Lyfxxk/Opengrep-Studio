import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, engineExecutableName, engineSource } from './config.js';
import { HttpError } from './errors.js';
import { engineTarget, engineToolDir } from './engine-manifest.js';
import {
  compareVersions,
  errorInfo,
  fetchLatestRelease,
  findAsset,
  installEngineAsset,
  normalizeVersion,
  platformKey,
  probeVersion,
} from '../scripts/engine-install.mjs';

export function engineInstallHint(binPath: string = config.opengrepBin): string {
  if (engineSource === 'env') {
    return [
      `OPENGREP_BIN 指向的引擎不存在或不可读：${binPath}`,
      '请检查路径是否正确；或取消该环境变量后，在仓库根目录运行 npm run setup:engine 安装引擎。',
    ].join('\n');
  }
  const lines = [
    `未找到 opengrep 引擎：${binPath}`,
    '请在仓库根目录运行 npm run setup:engine 自动下载并校验引擎（约 50MB，按平台自动选择），',
    '或设置环境变量 OPENGREP_BIN 指向已安装的引擎可执行文件。',
  ];
  if (process.platform === 'darwin') {
    lines.push(
      'macOS 提示：浏览器手动下载的二进制会被 Gatekeeper 拦截（"无法验证开发者"/"已损坏"），',
      '执行 xattr -d com.apple.quarantine <引擎路径> 后即可使用；npm run setup:engine 下载的不受影响。',
    );
  }
  return lines.join('\n');
}

export function engineAvailable(): boolean {
  return fs.existsSync(config.opengrepBin);
}

export function engineNotRunnableHint(binPath: string = config.opengrepBin): string {
  const lines = [
    `引擎文件存在但无法运行：${binPath}`,
    '可能是文件损坏、不完整，或被杀毒软件隔离/拦截。',
    '请在仓库根目录运行 npm run setup:engine --force 重新下载并校验引擎，',
    '或设置环境变量 OPENGREP_BIN 指向可正常运行的引擎可执行文件。',
  ];
  if (process.platform === 'darwin') {
    lines.push(
      'macOS 提示：执行 xattr -d com.apple.quarantine <引擎路径> 清除 Gatekeeper 隔离标记后重试。',
    );
  }
  return lines.join('\n');
}

export function engineInstallHintInfo(): { code: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { bin: config.opengrepBin };
  if (process.platform === 'darwin') params.macos = true;
  return engineSource === 'env'
    ? { code: 'engine.installHintEnv', params }
    : { code: 'engine.installHint', params };
}

export function engineNotRunnableHintInfo(): { code: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { bin: config.opengrepBin };
  if (process.platform === 'darwin') params.macos = true;
  return { code: 'engine.notRunnableHint', params };
}

export function engineDisplayPath(): string {
  return path.resolve(config.opengrepBin);
}

let engineVersionPromise: Promise<string | undefined> | null = null;

export function getEngineVersion(): Promise<string | undefined> {
  engineVersionPromise ??= probeVersion(config.opengrepBin).then((version) => {
    if (version === undefined) engineVersionPromise = null;
    return version;
  });
  return engineVersionPromise;
}

function resetEngineVersionCache(): void {
  engineVersionPromise = null;
}

const MAX_ENGINE_OUTPUT_BYTES = 64 * 1024 * 1024;

const MAX_ENGINE_STDERR_BYTES = 1024 * 1024;

const trackedChildren = new Set<ChildProcess>();

export function trackChildProcess(child: ChildProcess): void {
  trackedChildren.add(child);
  child.once('close', () => trackedChildren.delete(child));
}

export function terminateTrackedChildren(): void {
  for (const child of trackedChildren) {
    child.kill('SIGKILL');
  }
  trackedChildren.clear();
}

export interface EngineRunResult {
  stdoutTruncated: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runEngine(
  args: string[],
  cwd: string,
  options: { timeoutMs: number; logLabel: string; onSpawn?: (child: ChildProcess) => void },
): Promise<EngineRunResult> {
  return new Promise((resolve) => {
    console.error(
      `[${options.logLabel}] opengrep ${args.map((arg) => JSON.stringify(arg)).join(' ')}`,
    );
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.opengrepBin, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, OPENGREP_ENABLE_VERSION_CHECK: '0' },
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), timedOut: false, stdoutTruncated: false });
      return;
    }
    trackChildProcess(child);
    options.onSpawn?.(child);
    let timedOut = false;
    let stdoutTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const decode = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8');
    const killTimers: NodeJS.Timeout[] = [];
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      killTimers.push(setTimeout(() => child.kill('SIGKILL'), 5000));
      killTimers.push(
        setTimeout(() => {
          resolve({
            code: -1,
            stdout: decode(stdoutChunks),
            stderr: `${decode(stderrChunks)}\n引擎超时且终止失败，已放弃等待`,
            timedOut: true,
            stdoutTruncated,
          });
        }, 15000),
      );
    }, options.timeoutMs);
    const stopKillTimers = () => {
      clearTimeout(timer);
      for (const t of killTimers) clearTimeout(t);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_ENGINE_OUTPUT_BYTES) {
        stdoutTruncated = true;
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_ENGINE_STDERR_BYTES) return;
      stderrChunks.push(chunk);
    });
    child.on('error', (error) => {
      stopKillTimers();
      resolve({
        code: -1,
        stdout: decode(stdoutChunks),
        stderr: `${decode(stderrChunks)}\n${String(error)}`,
        timedOut,
        stdoutTruncated,
      });
    });
    child.on('close', (code) => {
      stopKillTimers();
      resolve({
        code: code ?? -1,
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
        timedOut,
        stdoutTruncated,
      });
    });
  });
}

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

function errorReasonParams(error: unknown): Record<string, unknown> {
  const info = errorInfo(error);
  if (info) {
    return { reasonCode: info.code, ...(info.params ? { reasonParams: info.params } : {}) };
  }
  return { reason: messageOf(error) };
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
      errorParams: errorReasonParams(error),
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
                messageParams: { ...errorReasonParams(error), from },
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
