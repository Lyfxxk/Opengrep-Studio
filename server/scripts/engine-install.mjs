// 引擎资产下载 / 校验 / 安装的共享实现（零第三方依赖，Node ≥ 22.5）。
//
// 为什么独立成模块：setup-engine.mjs（命令行）与 server/src/engine-update.ts（界面一键升级）
// 必须走同一套下载通道与哈希口径，否则两条安装链路的校验规则会漂移。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const GITHUB_REPO = 'opengrep/opengrep';
export const GITHUB_DOWNLOAD_BASE = `https://github.com/${GITHUB_REPO}/releases/download`;
export const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;
/** 安装清单文件名（落在 toolDir，优先于 engines.json 表示"用户已经升级过"） */
export const INSTALLED_MANIFEST_NAME = 'installed.json';

/** 下载通道顺序的文案（错误信息与界面提示共用，改顺序时同步改这里） */
export const DOWNLOAD_CHANNEL_HINT = '下载通道顺序：OPENGREP_DOWNLOAD_BASE 镜像 → github.com 直链 → api.github.com 资产通道';

/** 匹配 `<tool>-<platform>-<arch>` 形态的平台键（engines.json 与 config.ts 共用口径） */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** v1.32.0 / 1.32.0 → '1.32.0' */
export function normalizeVersion(tag) {
  return String(tag ?? '').trim().replace(/^v/i, '');
}

/** 比较语义化版本（只看 major.minor.patch，预发布后缀忽略）：前者更新返回 1，相同 0，更旧 -1 */
export function compareVersions(a, b) {
  const parts = (value) =>
    normalizeVersion(value)
      .split('.')
      .slice(0, 3)
      .map((piece) => Number.parseInt(piece, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/** GitHub release 资产的 digest 字段形如 `sha256:<hex>`；未提供时返回 undefined */
export function parseDigest(digest) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(digest ?? '').trim());
  return match ? match[1].toLowerCase() : undefined;
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 读取本地覆盖清单 opengrep-tool/installed.json（记录实际安装的版本与哈希）。
 * 文件缺失或结构损坏时返回 undefined，由调用方回落到 engines.json。
 */
export function readInstalledManifest(toolDir) {
  const file = path.join(toolDir, INSTALLED_MANIFEST_NAME);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const version = String(parsed?.version ?? '').trim();
    const sha256 = String(parsed?.sha256 ?? '').trim().toLowerCase();
    if (!version || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
    return {
      version,
      sha256,
      assetFile: parsed?.assetFile ? String(parsed.assetFile) : undefined,
      channel: parsed?.channel ? String(parsed.channel) : undefined,
      installedAt: parsed?.installedAt ? String(parsed.installedAt) : undefined,
    };
  } catch {
    return undefined;
  }
}

export function writeInstalledManifest(toolDir, info) {
  mkdirSync(toolDir, { recursive: true });
  const target = path.join(toolDir, INSTALLED_MANIFEST_NAME);
  const body = {
    version: info.version,
    assetFile: info.assetFile,
    sha256: info.sha256,
    channel: info.channel,
    installedAt: info.installedAt ?? new Date().toISOString(),
  };
  writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return target;
}

/**
 * 解析本次要安装的目标版本：
 *   - installed.json 记录的版本比 engines.json 新 → 用 installed.json（用户已升级，不允许被降级）
 *   - 否则用 engines.json（仓库钉住的已知好版本，也是恢复路径）
 */
export function resolveTarget({ catalog, installed, platform }) {
  const key = platformKey(platform);
  const asset = catalog?.assets?.[key];
  if (!asset) {
    const supported = Object.keys(catalog?.assets ?? {}).join('、') || '无';
    throw new Error(`暂无 ${key} 平台的自动下载支持（可用平台：${supported}）`);
  }
  if (installed?.version && compareVersions(installed.version, catalog.version) > 0) {
    return {
      version: installed.version,
      assetFile: installed.assetFile || asset.file,
      sha256: installed.sha256,
      source: INSTALLED_MANIFEST_NAME,
    };
  }
  return {
    version: catalog.version,
    assetFile: asset.file,
    sha256: String(asset.sha256 ?? '').toLowerCase(),
    source: 'engines.json',
  };
}

/** 探测二进制版本（`--version` 输出的第一个 x.y.z）；不可执行时返回 undefined */
export function probeVersion(binPath, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(binPath, ['--version'], {
      windowsHide: true,
      env: { ...process.env, OPENGREP_ENABLE_VERSION_CHECK: '0' },
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      done(undefined);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.stderr?.on('data', (chunk) => { out += String(chunk); });
    child.on('error', () => {
      clearTimeout(timer);
      done(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const match = out.match(/\d+\.\d+\.\d+/);
      done(match ? match[0] : undefined);
    });
  });
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'opengrep-studio' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(describeHttpError(res.status));
  return res.json();
}

/** 上游 HTTP 状态转成人话（匿名调用 GitHub API 只有 60 次/小时，限流是最常见的 403） */
function describeHttpError(status) {
  if (status === 403 || status === 429) return `GitHub API 限流（匿名请求 60 次/小时，HTTP ${status}），请稍后重试`;
  if (status === 404) return `上游发布不存在（HTTP 404），请确认版本号是否正确`;
  if (status >= 500) return `GitHub 服务暂不可用（HTTP ${status}），请稍后重试`;
  return `GitHub API 返回 HTTP ${status}`;
}

/** 查指定 tag 的 release（含资产列表） */
export function fetchReleaseByTag(tag, timeoutMs = 20000) {
  return fetchJson(`${GITHUB_API_BASE}/releases/tags/${encodeURIComponent(tag)}`, timeoutMs);
}

/** 查最新 stable release（GitHub 的 latest 天然排除 draft 与 pre-release） */
export function fetchLatestRelease(timeoutMs = 20000) {
  return fetchJson(`${GITHUB_API_BASE}/releases/latest`, timeoutMs);
}

/** 从 release JSON 中按资产名取下载地址与摘要（资产名缺失时返回 undefined） */
export function findAsset(release, assetName) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((item) => item?.name === assetName);
  if (!asset) return undefined;
  return {
    name: String(asset.name),
    url: String(asset.url ?? ''),
    size: Number(asset.size ?? 0),
    sha256: parseDigest(asset.digest),
  };
}

async function downloadTo(url, target, { headers, onProgress, timeoutMs }) {
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) {
    throw new Error(`${describeHttpError(res.status)}${res.status === 404 ? '（可能是该版本没有此平台的资产）' : ''}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;
  let lastPct = -1;
  await pipeline(Readable.fromWeb(res.body), async function* (source) {
    for await (const chunk of source) {
      received += chunk.length;
      if (total > 0) {
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress?.(pct, received, total);
        }
      }
      yield chunk;
    }
  }, createWriteStream(target));
}

/**
 * 按 镜像 → github.com → api.github.com 顺序下载到 target，任一条成功即返回。
 * api 通道必须带 Accept: application/octet-stream（否则拿回的是资产 JSON 元数据），
 * 并跟随 302 跳到 release-assets.githubusercontent.com 完成下载。
 * 传入 expectedSha256 时逐通道校验：坏镜像（返回错误页/残缺文件）会继续落到下一条通道，
 * 而不是直接判定整个安装失败。
 */
export async function downloadAsset({
  tag,
  assetFile,
  target,
  assetUrl,
  expectedSha256,
  onProgress,
  timeoutMs = 15 * 60_000,
  log,
}) {
  const mirror = process.env.OPENGREP_DOWNLOAD_BASE?.trim().replace(/\/+$/, '');
  const channels = [];
  if (mirror) {
    channels.push({ name: `镜像 ${mirror}`, resolveUrl: () => `${mirror}/${tag}/${assetFile}` });
  }
  channels.push({
    name: 'github.com 直链',
    resolveUrl: () => `${GITHUB_DOWNLOAD_BASE}/${tag}/${assetFile}`,
  });
  channels.push({
    name: 'api.github.com 资产通道',
    headers: { Accept: 'application/octet-stream' },
    resolveUrl: async () => {
      if (assetUrl) return assetUrl;
      const release = await fetchReleaseByTag(tag);
      const asset = findAsset(release, assetFile);
      if (!asset?.url) throw new Error(`发布 ${tag} 中找不到资产 ${assetFile}`);
      return asset.url;
    },
  });

  const failures = [];
  for (const channel of channels) {
    try {
      const url = await channel.resolveUrl();
      log?.(`下载通道：${channel.name}（${url}）`);
      rmSync(target, { force: true });
      await downloadTo(url, target, { headers: channel.headers, onProgress, timeoutMs });
      if (expectedSha256) {
        const hash = sha256File(target);
        if (hash !== expectedSha256) {
          throw new Error(`SHA-256 不符（期望 ${expectedSha256.slice(0, 12)}…，实际 ${hash.slice(0, 12)}…）`);
        }
      }
      return { channel: channel.name, bytes: statSync(target).size };
    } catch (error) {
      rmSync(target, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${channel.name}：${message}`);
      log?.(`${channel.name} 失败：${message}`);
    }
  }
  throw new Error(`所有下载通道均失败：\n  ${failures.join('\n  ')}`);
}

/**
 * 完整安装流程，任一步失败都不动现有引擎：
 *   下载（多通道）→ SHA-256 校验 → 运行 --version 核对版本 → 原子替换 → 写 installed.json
 * 替换用"旧文件先让位、新文件就位后再删"的方式：Windows 不允许 rename 覆盖已存在文件，
 * 中途失败会把旧引擎挪回原位，最坏结果是"没升成"而不是"引擎坏了"。
 */
export async function installEngineAsset({
  tag,
  assetFile,
  sha256,
  assetUrl,
  toolDir,
  installedName,
  onProgress,
  log,
}) {
  const expected = String(sha256 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error('缺少可用的 SHA-256 摘要，无法校验下载文件，已放弃安装');
  }

  mkdirSync(toolDir, { recursive: true });
  const installedPath = path.join(toolDir, installedName);
  const stagingPath = `${installedPath}.download`;
  const backupPath = `${installedPath}.old`;
  rmSync(stagingPath, { force: true });
  rmSync(backupPath, { force: true });

  const { channel } = await downloadAsset({
    tag,
    assetFile,
    target: stagingPath,
    assetUrl,
    expectedSha256: expected,
    log,
    onProgress: (pct) => onProgress?.({ phase: 'downloading', percent: pct }),
  });

  const actual = sha256File(stagingPath);
  if (actual !== expected) {
    rmSync(stagingPath, { force: true });
    throw new Error(`SHA-256 校验失败，已删除下载文件\n  期望：${expected}\n  实际：${actual}`);
  }

  onProgress?.({ phase: 'verifying' });
  if (process.platform !== 'win32') chmodSync(stagingPath, 0o755);
  const version = await probeVersion(stagingPath);
  if (!version) {
    rmSync(stagingPath, { force: true });
    throw new Error('下载的引擎无法运行（--version 无输出），已放弃安装');
  }
  if (compareVersions(version, tag) !== 0) {
    rmSync(stagingPath, { force: true });
    throw new Error(`下载的引擎版本 ${version} 与目标 ${tag} 不一致，已放弃安装`);
  }

  onProgress?.({ phase: 'installing' });
  let parked = false;
  try {
    if (existsSync(installedPath)) {
      renameSync(installedPath, backupPath);
      parked = true;
    }
    renameSync(stagingPath, installedPath);
  } catch (error) {
    if (parked && !existsSync(installedPath)) {
      try {
        renameSync(backupPath, installedPath);
      } catch {
        // 回滚失败时保留 .old 文件，让用户能手工恢复
      }
    }
    rmSync(stagingPath, { force: true });
    throw new Error(
      `替换引擎文件失败（可能有扫描或规则实验正在占用它）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  rmSync(backupPath, { force: true });
  if (process.platform !== 'win32') chmodSync(installedPath, 0o755);

  writeInstalledManifest(toolDir, {
    version: tag,
    assetFile,
    sha256: actual,
    channel,
  });

  return { installedPath, version, sha256: actual, channel };
}
