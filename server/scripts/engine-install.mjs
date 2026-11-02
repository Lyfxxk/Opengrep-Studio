
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
export const INSTALLED_MANIFEST_NAME = 'installed.json';

export const DOWNLOAD_CHANNEL_HINT = '下载通道顺序：OPENGREP_DOWNLOAD_BASE 镜像 → github.com 直链 → api.github.com 资产通道';

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function normalizeVersion(tag) {
  return String(tag ?? '').trim().replace(/^v/i, '');
}

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

export function parseDigest(digest) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(digest ?? '').trim());
  return match ? match[1].toLowerCase() : undefined;
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const LEGACY_CHANNEL_CODES = [
  [/^镜像 /, 'mirror'],
  [/^github\.com 直链$/, 'github-direct'],
  [/^api\.github\.com 资产通道$/, 'github-api'],
];

function normalizeChannel(raw) {
  const value = String(raw).trim();
  if (!value) return undefined;
  for (const [pattern, code] of LEGACY_CHANNEL_CODES) {
    if (pattern.test(value)) return code;
  }
  return value;
}

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
      channel: parsed?.channel ? normalizeChannel(parsed.channel) : undefined,
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

export function probeVersion(binPath, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(binPath, ['--version'], {
        windowsHide: true,
        env: { ...process.env, OPENGREP_ENABLE_VERSION_CHECK: '0' },
      });
    } catch {
      done(undefined);
      return;
    }
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

function describeHttpError(status) {
  if (status === 403 || status === 429) return `GitHub API 限流（匿名请求 60 次/小时，HTTP ${status}），请稍后重试`;
  if (status === 404) return `上游发布不存在（HTTP 404），请确认版本号是否正确`;
  if (status >= 500) return `GitHub 服务暂不可用（HTTP ${status}），请稍后重试`;
  return `GitHub API 返回 HTTP ${status}`;
}

export function fetchReleaseByTag(tag, timeoutMs = 20000) {
  return fetchJson(`${GITHUB_API_BASE}/releases/tags/${encodeURIComponent(tag)}`, timeoutMs);
}

export function fetchLatestRelease(timeoutMs = 20000) {
  return fetchJson(`${GITHUB_API_BASE}/releases/latest`, timeoutMs);
}

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
    channels.push({ code: 'mirror', name: `镜像 ${mirror}`, resolveUrl: () => `${mirror}/${tag}/${assetFile}` });
  }
  channels.push({
    code: 'github-direct',
    name: 'github.com 直链',
    resolveUrl: () => `${GITHUB_DOWNLOAD_BASE}/${tag}/${assetFile}`,
  });
  channels.push({
    code: 'github-api',
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
      return { channel: channel.code, bytes: statSync(target).size };
    } catch (error) {
      rmSync(target, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${channel.name}：${message}`);
      log?.(`${channel.name} 失败：${message}`);
    }
  }
  throw new Error(`所有下载通道均失败：\n  ${failures.join('\n  ')}`);
}

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
  const stagingPath = `${installedPath}.${process.pid}.download`;
  const backupPath = `${installedPath}.${process.pid}.old`;
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
      }
    }
    rmSync(stagingPath, { force: true });
    throw new Error(
      `替换引擎文件失败（可能有扫描或规则实验正在占用它）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  writeInstalledManifest(toolDir, {
    version: tag,
    assetFile,
    sha256: actual,
    channel,
  });
  try {
    rmSync(backupPath, { force: true });
  } catch {
    log?.(`备份文件 ${backupPath} 清理失败（可能仍被占用），已保留，可手工删除`);
  }
  if (process.platform !== 'win32') chmodSync(installedPath, 0o755);

  return { installedPath, version, sha256: actual, channel };
}
