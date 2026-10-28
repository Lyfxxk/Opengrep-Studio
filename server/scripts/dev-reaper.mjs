// dev 进程树的清理哨兵（仅 Windows 需要）：
// 关闭控制台窗口或 dev.mjs 被强杀时，Windows 不会把 npm → cmd → tsx/vite 这层孙进程一起收走，
// 它们会变成孤儿继续占用端口。本进程由 dev.mjs 以 detached + unref 启动，父进程消失后
// 沿父子关系只清理 dev.mjs 拉起的整棵进程树：其他 dev 实例的树根是它们自己的 dev.mjs pid，
// 与本进程记录的父 pid 无关，结构上就不会被误杀（端口顺延本就支持多实例共存）。
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const parentPid = Number(process.argv[2]);
if (process.platform !== 'win32' || !parentPid) process.exit(0);

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

// 只认父进程死亡之前就已创建的进程（留 2 秒余量防时钟粒度）：树里任一 pid 在父进程
// 死后被系统复用时，新进程的后代创建时间必然晚于截止点，按此过滤避免把无关进程收进树
const cutoff = new Date(Date.now() - 2000);

// String.raw 保留反斜杠原样：普通模板串会把 \t 吃成制表符，taskkill 路径就坏了
const script = String.raw`
$rootPid = [int]$env:OG_ROOTPID
$cutoff = [datetime]$env:OG_CUTOFF
$self = [int]$env:OG_SELF
$taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'

# 孤儿子进程的 ParentProcessId 仍指向已死的父 pid，所以按「父 pid → 子 pid」建索引
# 回溯整棵树，中间进程先死也不影响收集
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

# 从 rootPid 沿父子关系收集整棵树；跳过哨兵自己和它拉起的 PowerShell；
# 创建时间晚于截止点的不收也不下钻（其后代只会更晚，不存在漏收）
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
# 逐个 /T 强杀：前面的调用已顺带清掉后代时，后面只是对已死 pid 报错，静默即可
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
