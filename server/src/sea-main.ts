import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { getAsset, getAssetKeys, isSea } from 'node:sea';

declare const __SEA_VERSION__: string;

const RESOURCE_TREES = ['server', 'code'] as const;
const PORT_TRIES = 10;
const HEALTH_TIMEOUT_MS = 15_000;

function fail(lines: string[]): never {
  for (const line of lines) console.error(`[sea] ${line}`);
  process.exit(1);
}

function resourceBuildId(keys: string[]): string {
  const hash = createHash('sha256');
  for (const key of keys) {
    const bytes = Buffer.from(getAsset(key));
    hash.update(`${key}:${bytes.byteLength}:${createHash('sha256').update(bytes).digest('hex')};`);
  }
  return hash.digest('hex');
}

function extractResources(rootDir: string): void {
  const keys = getAssetKeys().slice().sort();
  if (keys.length === 0) {
    fail(['SEA 资源为空：exe 构建产物不完整，请重新执行 npm run build:exe。']);
  }
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('.resources-tmp.')) {
      fs.rmSync(path.join(rootDir, entry.name), { recursive: true, force: true });
    }
  }
  const buildId = resourceBuildId(keys);
  const markerPath = path.join(rootDir, '.resources-build.json');
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { buildId?: string };
    if (marker.buildId === buildId) {
      console.log('[sea] 内置资源已就位，跳过解压。');
      return;
    }
  } catch {
  }
  console.log(`[sea] 正在解压 ${keys.length} 个内置资源到 ${rootDir} …`);
  const staging = path.join(rootDir, `.resources-tmp.${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const key of keys) {
    const target = path.join(staging, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(getAsset(key)));
  }
  for (const tree of RESOURCE_TREES) {
    fs.rmSync(path.join(rootDir, tree), { recursive: true, force: true });
  }
  for (const tree of RESOURCE_TREES) {
    fs.renameSync(path.join(staging, tree), path.join(rootDir, tree));
  }
  fs.rmSync(staging, { recursive: true, force: true });
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify({ appVersion: __SEA_VERSION__, buildId, trees: RESOURCE_TREES }, null, 2)}\n`,
  );
  console.log('[sea] 内置资源解压完成。');
}

function portOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (occupied: boolean) => {
      socket.destroy();
      resolve(occupied);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(1000, () => settle(true));
  });
}

async function probeOwnInstance(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const data = (await res.json()) as { app?: string } | undefined;
    return data?.app === 'opengrep-studio';
  } catch {
    return false;
  }
}

async function pickPort(): Promise<{ kind: 'free' | 'own'; port: number }> {
  const startPort = Number(process.env.PORT) || 8787;
  for (let offset = 0; offset < PORT_TRIES; offset += 1) {
    const port = startPort + offset;
    if (!(await portOccupied(port))) return { kind: 'free', port };
    if (await probeOwnInstance(port)) return { kind: 'own', port };
    console.log(`[sea] 端口 ${port} 被其他程序占用，顺延到 ${port + 1} …`);
  }
  fail([
    `端口 ${startPort} ~ ${startPort + PORT_TRIES - 1} 全部被占用，无法启动。`,
    '请关闭不再使用的程序后重试；确认是残留进程时可用 node server/scripts/kill-port.mjs <端口> 清理。',
  ]);
}

function openBrowser(url: string): void {
  spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

function browserSkipped(): boolean {
  return process.env.OPENGREP_NO_BROWSER === '1' || process.env.OPENGREP_NO_BROWSER === 'true';
}

async function waitHealthy(url: string): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
      const data = (await res.json()) as { ok?: boolean } | undefined;
      if (data?.ok === true) return true;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main(): Promise<void> {
  if (!isSea()) {
    fail([
      '此程序需通过 OpengrepStudio.exe 运行（内置资源只存在于 exe 中）。',
      '开发调试请运行 npm run dev；重新构建请运行 npm run build:exe。',
    ]);
  }
  const rootDir = path.dirname(process.execPath);
  const picked = await pickPort();
  const url = `http://127.0.0.1:${picked.port}`;
  if (picked.kind === 'own') {
    console.log(`[sea] 检测到 Opengrep Studio 已在运行：${url}`);
    if (browserSkipped()) {
      console.log('[sea] OPENGREP_NO_BROWSER 已设置，跳过打开浏览器。');
    } else {
      openBrowser(url);
      console.log('[sea] 已在默认浏览器打开。');
    }
    return;
  }
  extractResources(rootDir);
  process.env.SERVER_ROOT = path.join(rootDir, 'server');
  process.env.DATA_DIR ??= path.join(rootDir, 'data');
  process.env.CUSTOM_RULES_DIR ??= path.join(rootDir, 'data', 'custom-rules');
  process.env.HOST ??= '127.0.0.1';
  process.env.PORT = String(picked.port);
  process.env.APP_VERSION = __SEA_VERSION__;
  console.log(`[sea] 使用端口 ${picked.port}，数据目录 ${process.env.DATA_DIR}`);
  await import('./index.js');
  if (!(await waitHealthy(url))) {
    fail([`服务未能在 15 秒内就绪（${url}），请查看上方日志定位问题。`]);
  }
  console.log(`[sea] Opengrep Studio v${__SEA_VERSION__} 已启动`);
  console.log(`[sea] 访问地址：${url}`);
  if (browserSkipped()) {
    console.log('[sea] OPENGREP_NO_BROWSER 已设置，跳过打开浏览器。');
  } else {
    openBrowser(url);
    console.log('[sea] 已在默认浏览器打开。');
  }
  console.log('[sea] 关闭此窗口即退出应用。');
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException).code;
  console.error(`[sea] 启动失败：${message}`);
  if (code === 'EACCES' || code === 'EPERM') {
    console.error('[sea] 请把 exe 放到可写目录（桌面、下载等）后重试，不要放在 Program Files。');
  } else {
    console.error('[sea] 解压可能被其他实例或杀毒软件占用文件中断，请关闭其他 Opengrep Studio 窗口后重新打开。');
  }
  process.exit(1);
});
