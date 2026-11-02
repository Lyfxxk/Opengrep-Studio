import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { engineExecutableName, normalizeVersion, readInstalledManifest, resolveTarget } from './engine-install.mjs';

const HOST = '127.0.0.1';
const BACKEND_BASE = 8787;
const WEB_BASE = 1022;
const PORT_TRIES = 10;
const isWin = process.platform === 'win32';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const selfPath = fileURLToPath(import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reapOrphans(parentPid) {
  if (!isWin || !parentPid) return;
  while (isAlive(parentPid)) await sleep(1000);

  const cutoff = new Date(Date.now() - 2000);

  const script = String.raw`
$rootPid = [int]$env:OG_ROOTPID
$cutoff = [datetime]$env:OG_CUTOFF
$self = [int]$env:OG_SELF
$taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
$byParent = @{}
$createdAt = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $createdAt[[int]$_.ProcessId] = $_.CreationDate
  $parentKey = [int]$_.ParentProcessId
  if (-not $byParent.ContainsKey($parentKey)) {
    $byParent[$parentKey] = New-Object System.Collections.Generic.List[int]
  }
  $byParent[$parentKey].Add([int]$_.ProcessId)
}
$pending = New-Object System.Collections.Queue
$pending.Enqueue($rootPid)
$targets = New-Object System.Collections.Generic.List[int]
$seen = New-Object 'System.Collections.Generic.HashSet[int]'
while ($pending.Count -gt 0) {
  $cur = [int]$pending.Dequeue()
  if (-not $byParent.ContainsKey($cur)) { continue }
  foreach ($childId in $byParent[$cur]) {
    if ($childId -eq $self -or $childId -eq $PID -or -not $seen.Add($childId)) { continue }
    if ($createdAt[$childId] -and $createdAt[$childId] -ge $cutoff) { continue }
    $targets.Add($childId)
    $pending.Enqueue($childId)
  }
}
foreach ($target in $targets) { & $taskkill /PID $target /T /F 2>$null }
`;

  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: {
      ...process.env,
      OG_ROOTPID: String(parentPid),
      OG_CUTOFF: cutoff.toISOString(),
      OG_SELF: String(process.pid),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
}

if (process.argv[2] === '--reaper') {
  await reapOrphans(Number(process.argv[3]));
  process.exit(0);
}

function bundledVersion() {
  try {
    const installed = readInstalledManifest(path.join(scriptDir, '..', '..', 'opengrep-tool'));
    if (installed) return `${normalizeVersion(installed.version)}（安装记录）`;
    const catalog = JSON.parse(fs.readFileSync(path.join(scriptDir, 'engines.json'), 'utf8'));
    return normalizeVersion(resolveTarget({ catalog, installed: undefined, platform: process.platform }).version);
  } catch {
    return undefined;
  }
}

function findOnPath() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, engineExecutableName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
    }
  }
  return undefined;
}

function enginePreflight() {
  const toolDir = path.join(scriptDir, '..', '..', 'opengrep-tool');
  const envBin = process.env.OPENGREP_BIN?.trim();
  const bundled = path.join(toolDir, engineExecutableName);

  if (envBin) {
    if (fs.existsSync(envBin)) {
      console.log(`[preflight] 引擎已就绪（OPENGREP_BIN）：${envBin}`);
    } else {
      console.warn(`[preflight] 警告：OPENGREP_BIN 指向的引擎不存在：${envBin}，扫描将失败。`);
    }
  } else if (fs.existsSync(bundled)) {
    const version = bundledVersion();
    console.log(`[preflight] 引擎已就绪：${bundled}${version ? `（opengrep ${version}）` : ''}`);
  } else if (findOnPath()) {
    console.log(`[preflight] 引擎已就绪（系统 PATH 中找到 ${engineExecutableName}）`);
  } else {
    console.warn(
      '[preflight] 提示：未发现扫描引擎，服务可启动但无法扫描。\n' +
        '[preflight] 运行 npm run setup:engine 自动下载（github.com 不可达时会自动降级到 api.github.com 通道），' +
        '或设置 OPENGREP_BIN 指向引擎可执行文件。',
    );
  }
}

enginePreflight();

function probeFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, HOST);
  });
}

async function pickPort(base, label) {
  for (let offset = 0; offset < PORT_TRIES; offset += 1) {
    const port = base + offset;
    if (await probeFree(port)) return port;
    console.log(`[dev] ${label}端口 ${port} 已被占用（可能是另一个使用中的实例，不杀），顺延到 ${port + 1}…`);
  }
  console.error(
    `[dev] ${base} ~ ${base + PORT_TRIES - 1} 全部被占用。请关闭不再使用的实例后重试；` +
    `确认是残留进程（无窗口在跑）时，可执行 node server/scripts/kill-port.mjs <端口> 清理`,
  );
  process.exit(1);
}

const backendPort = Number(process.env.PORT) || (await pickPort(BACKEND_BASE, '后端'));
const webPort = await pickPort(WEB_BASE, '前端');
console.log(`[dev] 后端 http://${HOST}:${backendPort}    前端 http://${HOST}:${webPort}`);

const rootDir = path.join(scriptDir, '..', '..');
let concurrentPkg;
try {
  concurrentPkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'node_modules', 'concurrently', 'package.json'), 'utf8'),
  );
} catch {
  console.error('[dev] 根目录缺少 concurrently 依赖：请先执行 npm run install:all 安装依赖后重试');
  process.exit(1);
}
const concurrentBin = path.join(
  rootDir, 'node_modules', 'concurrently', concurrentPkg.bin.concurrently,
);

function killTree(pid) {
  if (!pid) return;
  if (isWin) {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
  }
}

const child = spawn(
  process.execPath,
  [
    concurrentBin,
    '--kill-others',
    '-n', 'server,web',
    '-c', 'blue,green',
    'npm --prefix server run dev',
    `npm --prefix code run dev -- --port ${webPort}`,
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(backendPort), API_TARGET: `http://${HOST}:${backendPort}` },
  },
);

if (isWin) {
  const reaper = spawn(
    process.execPath,
    [selfPath, '--reaper', String(process.pid)],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  reaper.unref();
}

let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  killTree(child.pid);
  process.exit(code);
}

child.on('error', (error) => {
  console.error(`[dev] 启动 concurrently 失败：${error.message}`);
  shutdown(1);
});

child.on('exit', (code) => shutdown(code ?? 1));

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(signal, () => shutdown(0));
  } catch {
  }
}
