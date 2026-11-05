import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeDir = path.resolve(here, '..');
const serverDir = path.resolve(codeDir, '..', 'server');
const tmpDir = path.join(here, '.tmp');
const dataDir = path.join(tmpDir, 'data');
const rulesDir = path.join(tmpDir, 'rules');
const PORT = '8799';

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(rulesDir, { recursive: true });

if (process.env.E2E_SKIP_BUILD !== '1') {
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: codeDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    console.error('[e2e] 前端构建失败');
    process.exit(build.status ?? 1);
  }
}

const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: serverDir,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT,
    DATA_DIR: dataDir,
    CUSTOM_RULES_DIR: rulesDir,
  },
  stdio: 'inherit',
});

let closing = false;

function stop(code) {
  if (closing) return;
  closing = true;
  if (server.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      server.kill('SIGTERM');
    }
  }
  process.exit(code);
}

process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
process.on('SIGHUP', () => stop(0));

server.on('exit', (code, signal) => {
  if (closing) return;
  console.error(`[e2e] 后端提前退出（code=${code} signal=${signal}）`);
  process.exit(code ?? 1);
});
