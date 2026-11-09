import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.dirname(scriptDir);
const repoRoot = path.dirname(serverDir);
const exePath = path.join(repoRoot, 'dist-exe', 'OpengrepStudio.exe');
const isWin = process.platform === 'win32';

const checks = [];
let childPid;
let tmpDir;
let dummy;
let output = '';

function baseFail(message, ...hints) {
  console.error(`[smoke] ${message}`);
  for (const hint of hints) console.error(`[smoke] ${hint}`);
  process.exit(1);
}

function killTree(pid) {
  if (!pid) return;
  const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.listen(0, '127.0.0.1');
  });
}

async function waitHealthy(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      const data = await res.json();
      if (data?.ok === true) return data;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(true);
    });
  });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function record(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail: String(detail) } : {}) });
  console.log(`[smoke] ${ok ? '✓' : '✗'} ${name}${detail !== undefined ? `：${detail}` : ''}`);
  if (!ok) throw new Error(`冒烟未通过：${name}`);
}

if (!isWin) baseFail('smoke:exe 仅支持在 Windows 上运行（对齐 build:exe 的交付口径）。');
if (!fs.existsSync(exePath)) {
  baseFail(`未找到 ${exePath}。`, '请先执行 npm run build:exe 构建 exe。');
}

const startedAt = Date.now();
const summary = { ok: false, exePath, checks };
const watchdog = setTimeout(() => {
  console.error(`[smoke] 冒烟超过 5 分钟未结束，强制退出。已完成的检查：${JSON.stringify(checks)}`);
  killTree(childPid);
  process.exit(1);
}, 300_000);

try {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-smoke-'));
  const dataDir = path.join(tmpDir, 'data');
  const customRulesDir = path.join(tmpDir, 'custom-rules');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(customRulesDir, { recursive: true });
  let port = await freePort();
  while (!(await portFree(port + 1))) port = await freePort();
  dummy = await listen(port);
  const appPort = port + 1;
  console.log(`[smoke] 端口 ${port} 预置为他家 TCP 服务，验证 exe 顺延到 ${appPort} …`);

  const env = {
    ...process.env,
    OPENGREP_NO_BROWSER: '1',
    PORT: String(port),
    DATA_DIR: dataDir,
    CUSTOM_RULES_DIR: customRulesDir,
  };
  const enginePath = path.join(repoRoot, 'opengrep-tool', 'opengrep.exe');
  if (fs.existsSync(enginePath)) env.OPENGREP_BIN = enginePath;

  console.log(`[smoke] 启动 exe（期望顺延至 ${appPort}，数据目录 ${dataDir}）…`);
  const child = spawn(exePath, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  childPid = child.pid;
  output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  child.once('exit', (code) => {
    console.log(`[smoke] exe 进程退出（code=${code}）`);
    if (code !== null && code !== 0 && checks.length === 0) {
      console.error(`[smoke] exe 提前退出：\n${output}`);
    }
  });

  const health = await waitHealthy(appPort, 90_000);
  record('health ok', health?.ok === true, health ? JSON.stringify(health) : '90 秒内未就绪');
  record('health app 标识', health?.app === 'opengrep-studio', health?.app);
  record(
    `被占端口 ${port} 顺延到 ${appPort}`,
    output.includes(`顺延到 ${appPort}`),
    output.trim().split('\n').find((line) => line.includes('顺延'))?.trim() ?? 'stdout 未出现顺延日志',
  );

  const page = await fetch(`http://127.0.0.1:${appPort}/`);
  const html = await page.text();
  record('首页 HTML', page.status === 200 && /<html/i.test(html), `status=${page.status} bytes=${html.length}`);

  const login = await fetch(`http://127.0.0.1:${appPort}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const sessionCookie = (login.headers.getSetCookie() ?? [])
    .find((item) => item.startsWith('og_session=')) ?? '';
  record('登录 admin/123456', login.status === 200 && sessionCookie !== '', `status=${login.status}`);

  const projects = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    headers: { cookie: sessionCookie.split(';')[0] ?? '' },
  });
  const projectsJson = await projects.json().catch(() => null);
  record(
    '带会话读取 /api/projects',
    projects.status === 200 && Array.isArray(projectsJson),
    `status=${projects.status}`,
  );

  console.log('[smoke] 启动第二实例（应识别已在运行并 exit 0）…');
  const second = spawnSync(exePath, [], {
    env: { ...env, PORT: String(appPort) },
    encoding: 'utf8',
    timeout: 60_000,
  });
  record(
    '第二实例 exit 0',
    second.status === 0,
    `exit=${second.status}${second.stderr ? ` stderr=${second.stderr.trim().slice(0, 200)}` : ''}`,
  );
  record('第二实例识别自家实例', typeof second.stdout === 'string' && second.stdout.includes('已在运行'));

  summary.ok = true;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  if (output.trim()) console.error(`[smoke] exe 输出末尾：\n${output.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  killTree(childPid);
  dummy?.close();
  if (tmpDir) {
    let cleaned = false;
    for (let attempt = 0; attempt < 5 && !cleaned; attempt += 1) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        cleaned = true;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
    }
    if (!cleaned) {
      console.warn(`[smoke] 临时目录清理失败（可手动删除）：${tmpDir}`);
    }
  }
  summary.durationMs = Date.now() - startedAt;
  clearTimeout(watchdog);
  console.log(JSON.stringify(summary));
}
