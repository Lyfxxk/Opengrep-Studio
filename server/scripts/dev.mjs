import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const HOST = '127.0.0.1';
const BACKEND_BASE = 8787;
const WEB_BASE = 1022;
const PORT_TRIES = 10;

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

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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

const isWin = process.platform === 'win32';

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
    [
      path.join(rootDir, 'server', 'scripts', 'dev-reaper.mjs'),
      String(process.pid),
    ],
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
