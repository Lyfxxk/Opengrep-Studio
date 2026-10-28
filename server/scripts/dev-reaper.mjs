// dev 进程树的清理哨兵（仅 Windows 需要）：
// 关闭控制台窗口或 dev.mjs 被强杀时，Windows 不会把 npm → cmd → tsx/vite 这层孙进程一起收走，
// 它们会变成孤儿继续占用端口。本进程由 dev.mjs 以 detached + unref 启动，父进程消失后
// 按“仓库路径 + 命令行特征 + 创建时间早于父进程死亡”三个条件清理，避免误杀刚启动的新实例。
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const parentPid = Number(process.argv[2]);
const repoRoot = process.argv[3] ?? '';
if (process.platform !== 'win32' || !parentPid || !repoRoot) process.exit(0);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

while (isAlive(parentPid)) {
  await sleep(1000);
}

// 只清理父进程死亡之前就已存在的进程：留 2 秒余量，避免误杀紧接着新启动的实例
const cutoff = new Date(Date.now() - 2000);

const script = `
$root = $env:OG_ROOT
$cutoff = [datetime]$env:OG_CUTOFF
$self = [int]$env:OG_SELF
$taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
Get-CimInstance Win32_Process |
  Where-Object {
    $_.ProcessId -ne $self -and
    $_.CommandLine -and
    $_.CommandLine.Contains($root) -and
    $_.CreationDate -lt $cutoff -and
    ($_.Name -eq 'node.exe' -or $_.Name -eq 'cmd.exe' -or $_.Name -eq 'esbuild.exe') -and
    ($_.CommandLine -match 'dev\\.mjs|concurrently|tsx|vite|esbuild')
  } |
  ForEach-Object { & $taskkill /PID $_.ProcessId /T /F 2>$null }
`;

spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
  env: {
    ...process.env,
    OG_ROOT: repoRoot,
    OG_CUTOFF: cutoff.toISOString(),
    OG_SELF: String(process.pid),
  },
  stdio: 'ignore',
  windowsHide: true,
});
