import { spawn } from 'node:child_process';
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

/** 供 /api/health 与启动日志展示的解析后路径 */
export function engineDisplayPath(): string {
  return path.resolve(config.opengrepBin);
}

let engineVersionPromise: Promise<string | undefined> | null = null;

/** 惰性探测引擎版本（只 spawn 一次，失败不缓存重试）；与 runEngine 同一套 spawn 策略 */
export function getEngineVersion(): Promise<string | undefined> {
  engineVersionPromise ??= probeVersion(config.opengrepBin);
  return engineVersionPromise;
}

/** 升级替换引擎后必须失效缓存，否则界面与报告仍显示旧版本 */
export function resetEngineVersionCache(): void {
  engineVersionPromise = null;
}

export interface EngineRunResult {
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
  options: { timeoutMs: number; logLabel: string },
): Promise<EngineRunResult> {
  return new Promise((resolve) => {
    console.error(
      `[${options.logLabel}] opengrep ${args.map((arg) => JSON.stringify(arg)).join(' ')}`,
    );
    const child = spawn(config.opengrepBin, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, OPENGREP_ENABLE_VERSION_CHECK: '0' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // 引擎若无视终止信号，Promise 永不 resolve，会把扫描串行链整体卡死并锁死引擎升级：
    // 温和终止无效则 5 秒后 SIGKILL（Windows 等价 TerminateProcess），再不行兜底强制返回
    const killTimers: NodeJS.Timeout[] = [];
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      killTimers.push(setTimeout(() => child.kill('SIGKILL'), 5000));
      killTimers.push(
        setTimeout(() => {
          resolve({ code: -1, stdout, stderr: `${stderr}\n引擎超时且终止失败，已放弃等待`, timedOut: true });
        }, 15000),
      );
    }, options.timeoutMs);
    const stopKillTimers = () => {
      clearTimeout(timer);
      for (const t of killTimers) clearTimeout(t);
    };
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      stopKillTimers();
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(error)}`, timedOut });
    });
    child.on('close', (code) => {
      stopKillTimers();
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}
