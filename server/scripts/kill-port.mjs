import { execSync } from 'node:child_process';

const ports = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);
if (ports.length === 0) {
  console.log('[kill-port] 用法: node server/scripts/kill-port.mjs <端口> [端口...]');
  process.exit(0);
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'pipe' });
      } else {
        process.kill(Number(pid), 'SIGKILL');
      }
      console.log(`[kill-port] 已结束残留进程 PID ${pid}`);
    } catch {
      console.log(`[kill-port] PID ${pid} 结束失败（可能需要管理员权限）`);
    }
  }
}

if (process.platform === 'win32') {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === 'TCP' && cols[3] === 'LISTENING') {
      const port = Number((cols[1] ?? '').split(':').pop());
      if (ports.includes(port) && cols[4] && cols[4] !== '0') pids.add(cols[4]);
    }
  }
  if (pids.size === 0) console.log(`[kill-port] 端口 ${ports.join(', ')} 未被占用，直接启动`);
  else killPids(pids);
} else {
  for (const port of ports) {
    try {
      const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' });
      killPids(out.split(/\r?\n/).filter(Boolean));
    } catch {
    }
  }
}
