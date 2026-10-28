// 开发启动器（npm run dev 的入口）：先为前后端协调端口，再把两半拉起来。
// 核心原则：端口被占用时绝不杀既有进程——那很可能是人工正在使用的实例
//（AI 改代码时也会启动项目，两边必须互不干扰），而是从基准端口向后顺延。
// 已知残留进程需要手动清理时：node server/scripts/kill-port.mjs <端口>
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const HOST = '127.0.0.1';
const BACKEND_BASE = 8787;
const WEB_BASE = 1022;
/** 最多向后顺延的端口个数，避免找不到端口时无限爬 */
const PORT_TRIES = 10;

/** 试绑定探测端口空闲（立即释放，仅作启动前协调；竞态由后端 EADDRINUSE 兜底提示） */
function probeFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, HOST);
  });
}

async function pickPort(base, label) {
  for (let offset = 0; offset <= PORT_TRIES; offset += 1) {
    const port = base + offset;
    if (await probeFree(port)) return port;
    console.log(`[dev] ${label}端口 ${port} 已被占用（可能是另一个使用中的实例，不杀），顺延到 ${port + 1}…`);
  }
  console.error(
    `[dev] ${base} ~ ${base + PORT_TRIES} 全部被占用。请关闭不再使用的实例后重试；` +
    `确认是残留进程（无窗口在跑）时，可执行 node server/scripts/kill-port.mjs <端口> 清理`,
  );
  process.exit(1);
}

// PORT 环境变量是显式钉端口：不顺延，占用时让后端自己报错退出
const backendPort = Number(process.env.PORT) || (await pickPort(BACKEND_BASE, '后端'));
const webPort = await pickPort(WEB_BASE, '前端');
console.log(`[dev] 后端 http://${HOST}:${backendPort}    前端 http://${HOST}:${webPort}`);

// 找 concurrently 的真实 bin（devDependency），用 node 直接执行避免 Windows 下 npm.cmd 的 shell 拼接
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const concurrentPkg = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'node_modules', 'concurrently', 'package.json'), 'utf8'),
);
const concurrentBin = path.join(
  rootDir, 'node_modules', 'concurrently', concurrentPkg.bin.concurrently,
);

const isWin = process.platform === 'win32';

/** 结束整棵子进程树：Windows 用 taskkill /T，POSIX 结束独立进程组 */
function killTree(pid) {
  if (!pid) return;
  if (isWin) {
    // 用绝对路径：部分受限环境（IDE/AI 终端）的 PATH 里没有 System32，直接 taskkill 会解析失败
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    // POSIX 下父子同组：终端关闭时系统会把 SIGHUP 发给整组，这里只需补一刀给直接子进程
    process.kill(pid, 'SIGTERM');
  } catch {
  }
}

const child = spawn(
  process.execPath,
  [
    concurrentBin,
    '--kill-others', // 本组任一进程退出即结束另一半
    '-n', 'server,web',
    '-c', 'blue,green',
    'npm --prefix server run dev',
    `npm --prefix code run dev -- --port ${webPort}`,
  ],
  {
    stdio: 'inherit',
    // PORT 决定后端绑定端口；API_TARGET 让这一组前端的 /api 代理跟着同一后端走
    env: { ...process.env, PORT: String(backendPort), API_TARGET: `http://${HOST}:${backendPort}` },
  },
);

// 关窗口/被强杀时 dev.mjs 来不及执行收尾，Windows 会把孙进程留成孤儿。
// 挂一个 detached 哨兵：父进程消失后由它按仓库路径清理整棵 dev 进程树。
if (isWin) {
  const reaper = spawn(
    process.execPath,
    [
      path.join(rootDir, 'server', 'scripts', 'dev-reaper.mjs'),
      String(process.pid),
      rootDir,
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

child.on('exit', (code) => shutdown(code ?? 1));

// Ctrl+C / 关窗 / 系统注销：先收掉整棵树再退出，避免 tsx watch 继续重启子进程
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(signal, () => shutdown(0));
  } catch {
    // 当前平台不支持该信号时忽略
  }
}
