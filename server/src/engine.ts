import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, engineSource, type EngineSource } from './config.js';
import { probeVersion } from '../scripts/engine-install.mjs';

const SOURCE_LABELS: Record<EngineSource, string> = {
  env: '环境变量 OPENGREP_BIN 指定',
  'bundled-dir': 'opengrep-tool 安装位（npm run setup:engine）',
  path: '系统 PATH 查找',
  missing: '未找到',
};

export function engineSourceLabel(): string {
  return SOURCE_LABELS[engineSource] ?? engineSource;
}

export function engineInstallHint(binPath: string = config.opengrepBin): string {
  if (engineSource === 'env') {
    return [
      `OPENGREP_BIN 指向的引擎不存在或不可读：${binPath}`,
      '请检查路径是否正确；或取消该环境变量后，在仓库根目录运行 npm run setup:engine 安装引擎。',
    ].join('\n');
  }
  const lines = [
    `未找到 opengrep 引擎：${binPath}`,
    '请在仓库根目录运行 npm run setup:engine 自动下载并校验引擎（约 50MB，按平台自动选择），',
    '或设置环境变量 OPENGREP_BIN 指向已安装的引擎可执行文件。',
  ];
  if (process.platform === 'darwin') {
    lines.push(
      'macOS 提示：浏览器手动下载的二进制会被 Gatekeeper 拦截（"无法验证开发者"/"已损坏"），',
      '执行 xattr -d com.apple.quarantine <引擎路径> 后即可使用；npm run setup:engine 下载的不受影响。',
    );
  }
  return lines.join('\n');
}

export function engineAvailable(): boolean {
  return fs.existsSync(config.opengrepBin);
}

export function engineNotRunnableHint(binPath: string = config.opengrepBin): string {
  const lines = [
    `引擎文件存在但无法运行：${binPath}`,
    '可能是文件损坏、不完整，或被杀毒软件隔离/拦截。',
    '请在仓库根目录运行 npm run setup:engine --force 重新下载并校验引擎，',
    '或设置环境变量 OPENGREP_BIN 指向可正常运行的引擎可执行文件。',
  ];
  if (process.platform === 'darwin') {
    lines.push(
      'macOS 提示：执行 xattr -d com.apple.quarantine <引擎路径> 清除 Gatekeeper 隔离标记后重试。',
    );
  }
  return lines.join('\n');
}

export function engineDisplayPath(): string {
  return path.resolve(config.opengrepBin);
}

let engineVersionPromise: Promise<string | undefined> | null = null;

export function getEngineVersion(): Promise<string | undefined> {
  engineVersionPromise ??= probeVersion(config.opengrepBin).then((version) => {
    if (version === undefined) engineVersionPromise = null;
    return version;
  });
  return engineVersionPromise;
}

export function resetEngineVersionCache(): void {
  engineVersionPromise = null;
}

const MAX_ENGINE_OUTPUT_BYTES = 64 * 1024 * 1024;

const MAX_ENGINE_STDERR_BYTES = 1024 * 1024;

const trackedChildren = new Set<ChildProcess>();

export function trackChildProcess(child: ChildProcess): void {
  trackedChildren.add(child);
  child.once('close', () => trackedChildren.delete(child));
}

export function terminateTrackedChildren(): void {
  for (const child of trackedChildren) {
    child.kill('SIGKILL');
  }
  trackedChildren.clear();
}

export interface EngineRunResult {
  stdoutTruncated: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runEngine(
  args: string[],
  cwd: string,
  options: { timeoutMs: number; logLabel: string; onSpawn?: (child: ChildProcess) => void },
): Promise<EngineRunResult> {
  return new Promise((resolve) => {
    console.error(
      `[${options.logLabel}] opengrep ${args.map((arg) => JSON.stringify(arg)).join(' ')}`,
    );
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.opengrepBin, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, OPENGREP_ENABLE_VERSION_CHECK: '0' },
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), timedOut: false, stdoutTruncated: false });
      return;
    }
    trackChildProcess(child);
    options.onSpawn?.(child);
    let timedOut = false;
    let stdoutTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const decode = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8');
    const killTimers: NodeJS.Timeout[] = [];
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      killTimers.push(setTimeout(() => child.kill('SIGKILL'), 5000));
      killTimers.push(
        setTimeout(() => {
          resolve({
            code: -1,
            stdout: decode(stdoutChunks),
            stderr: `${decode(stderrChunks)}\n引擎超时且终止失败，已放弃等待`,
            timedOut: true,
            stdoutTruncated,
          });
        }, 15000),
      );
    }, options.timeoutMs);
    const stopKillTimers = () => {
      clearTimeout(timer);
      for (const t of killTimers) clearTimeout(t);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_ENGINE_OUTPUT_BYTES) {
        stdoutTruncated = true;
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_ENGINE_STDERR_BYTES) return;
      stderrChunks.push(chunk);
    });
    child.on('error', (error) => {
      stopKillTimers();
      resolve({
        code: -1,
        stdout: decode(stdoutChunks),
        stderr: `${decode(stderrChunks)}\n${String(error)}`,
        timedOut,
        stdoutTruncated,
      });
    });
    child.on('close', (code) => {
      stopKillTimers();
      resolve({
        code: code ?? -1,
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
        timedOut,
        stdoutTruncated,
      });
    });
  });
}
