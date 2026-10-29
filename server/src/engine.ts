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

/** 引擎解析来源的中文标注（health / 启动日志 / 排障展示用） */
export function engineSourceLabel(): string {
  return SOURCE_LABELS[engineSource] ?? engineSource;
}

/** 引擎缺失时的统一修复指引（要求给出可操作的中文错误，而不是引擎原始报错） */
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

/**
 * 引擎文件存在但无法执行时的统一修复指引（--version 探测不到版本）。
 * 常见于下载损坏、文件不完整或被杀毒软件隔离；与 engineInstallHint 区分口径，避免误导用户去"安装"一个已存在的引擎。
 */
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

/** 供 /api/health 与启动日志展示的解析后路径 */
export function engineDisplayPath(): string {
  return path.resolve(config.opengrepBin);
}

let engineVersionPromise: Promise<string | undefined> | null = null;

/** 惰性探测引擎版本：成功才缓存；失败（引擎损坏/不可执行）不缓存，下次调用重探——修复引擎后无需重启即可自愈 */
export function getEngineVersion(): Promise<string | undefined> {
  engineVersionPromise ??= probeVersion(config.opengrepBin).then((version) => {
    if (version === undefined) engineVersionPromise = null;
    return version;
  });
  return engineVersionPromise;
}

/** 升级替换引擎后必须失效缓存，否则界面与报告仍显示旧版本 */
export function resetEngineVersionCache(): void {
  engineVersionPromise = null;
}

/** 引擎单次输出上限：超限即停止拼接（异常巨量输出会先打爆内存再打爆 JSON.parse） */
const MAX_ENGINE_OUTPUT_BYTES = 64 * 1024 * 1024;

/** stderr 单独用更小的上限：它只用于错误信息展示，1MB 足够排障，超限不算失败 */
const MAX_ENGINE_STDERR_BYTES = 1024 * 1024;

/** 运行中的引擎/git 子进程登记表：服务退出时统一终止，避免孤儿进程占着引擎文件（Windows 上锁死升级） */
const trackedChildren = new Set<ChildProcess>();

/** 登记子进程（引擎、git 克隆共用）；子进程自然退出时自动移除 */
export function trackChildProcess(child: ChildProcess): void {
  trackedChildren.add(child);
  child.once('close', () => trackedChildren.delete(child));
}

/** 服务退出时强制终止全部子进程（SIGKILL，Windows 等价 TerminateProcess） */
export function terminateTrackedChildren(): void {
  for (const child of trackedChildren) {
    child.kill('SIGKILL');
  }
  trackedChildren.clear();
}

export interface EngineRunResult {
  /** stdout 超过上限被截断：内容不完整，调用方必须按失败处理而不是尝试解析 */
  stdoutTruncated: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 运行一次 opengrep 引擎并收集输出（scan-runner 的全量扫描与 rule-lab 的单规则实验共用）。
 * - 命令行回显到 stderr：调用方可能直接消费本进程 stdout（如 pack-regression CLI 的 --json），stdout 保持纯净
 * - 超时终止（5 秒后升级 SIGKILL，仍无响应则兜底强制返回 timedOut=true），由调用方决定失败语义
 */
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
      // Windows 对非可执行文件在 spawn 内部同步抛 spawn EFTYPE，error 事件监听器挂不上：
      // 与下方 error 事件分支同口径转成失败结果（此刻尚未创建 kill 定时器，无需 stopKillTimers）
      resolve({ code: -1, stdout: '', stderr: String(error), timedOut: false, stdoutTruncated: false });
      return;
    }
    trackChildProcess(child);
    // spawn 成功即回调：取消扫描需要拿到这次运行的子进程句柄（scan-runner 按 scanId 登记），
    // 全局 trackedChildren 只有 Set 没有归属信息，定位不到单个扫描的引擎
    options.onSpawn?.(child);
    let timedOut = false;
    let stdoutTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    // 逐 chunk toString 会把跨 chunk 边界的多字节 UTF-8 截成 U+FFFD（中文规则说明与引擎报错都会踩），
    // 因此攒 Buffer、在 resolve 前一次性解码
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const decode = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8');
    // 引擎若无视终止信号，Promise 永不 resolve，会把扫描串行链整体卡死并锁死引擎升级：
    // 温和终止无效则 5 秒后 SIGKILL（Windows 等价 TerminateProcess），再不行兜底强制返回
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
      // 超限即停止拼接，内容已不完整，调用方按截断报错
      if (stdoutTruncated) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_ENGINE_OUTPUT_BYTES) {
        stdoutTruncated = true;
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // 超限即停止拼接：stderr 只用于错误信息展示，防异常引擎刷屏打爆内存，不按失败处理
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
