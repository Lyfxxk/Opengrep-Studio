import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 引擎可执行文件名按平台解析：Windows 是 opengrep.exe，其余平台是 opengrep */
function engineNameFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'opengrep.exe' : 'opengrep';
}

export const engineExecutableName = engineNameFor(process.platform);

/** 引擎解析来源（供 /api/health 与启动日志展示） */
export type EngineSource = 'env' | 'bundled-dir' | 'path' | 'missing';

export interface ResolvedEngine {
  bin: string;
  source: EngineSource;
}

/**
 * 引擎三级解析：
 *   1. OPENGREP_BIN 环境变量（用户自管，路径由用户负责）
 *   2. opengrep-tool/ 安装位（npm run setup:engine 的安装位置）
 *   3. 系统 PATH 查找（覆盖手动安装到 /usr/local/bin 等场景）
 * 全部落空时返回安装位路径并标记 missing，让报错信息能指引到 setup:engine。
 * deps 仅供测试注入；运行时无参调用。
 */
export function resolveEngineBin(deps?: {
  envBin?: string;
  bundledPath?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
}): ResolvedEngine {
  const platform = deps?.platform ?? process.platform;
  const executableName = engineNameFor(platform);
  const envBin = deps?.envBin ?? process.env.OPENGREP_BIN?.trim();
  if (envBin) return { bin: envBin, source: 'env' };
  const bundled =
    deps?.bundledPath ?? path.join(serverRoot, '..', 'opengrep-tool', executableName);
  if (fs.existsSync(bundled)) return { bin: bundled, source: 'bundled-dir' };
  const pathEnv = deps?.pathEnv ?? process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, executableName);
    try {
      if (fs.statSync(candidate).isFile()) return { bin: candidate, source: 'path' };
    } catch {
      // 目录不可读/无权限：跳过，继续看下一个 PATH 目录
    }
  }
  return { bin: bundled, source: 'missing' };
}

const resolvedEngine = resolveEngineBin();

export const engineSource = resolvedEngine.source;

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** 默认只监听本机回环地址（与"本地优先、代码不出机器"的定位一致）；Docker 等场景用 HOST 放开 */
  host: process.env.HOST ?? '127.0.0.1',
  dataDir: process.env.DATA_DIR ?? path.join(serverRoot, 'data'),
  rulesDir: path.join(serverRoot, 'rules'),
  /** 自定义规则包落盘目录；Docker 里指入数据卷，避免重建容器丢失用户规则包 */
  customRulesDir:
    process.env.CUSTOM_RULES_DIR ?? path.join(serverRoot, 'rules', 'custom'),
  opengrepBin: resolvedEngine.bin,
  maxUploadBytes: 200 * 1024 * 1024,
  maxExtractedBytes: 1024 * 1024 * 1024,
  /** 单次导入的条目上限（ZIP 条目 / 解压文件数 / 克隆文件数 / SARIF 结果数共用同一闸） */
  maxImportEntries: 50000,
  scanTimeoutMs: 10 * 60 * 1000,
  cloneTimeoutMs: (Number(process.env.CLONE_TIMEOUT_SECONDS) || 240) * 1000,
  /** 7z 解压 worker 的时限（wasm callMain 不可中断，超时只能靠终止整个 worker 实现） */
  sevenZipTimeoutMs: (Number(process.env.SEVEN_Z_TIMEOUT_SECONDS) || 120) * 1000,
  ruleLabTimeoutMs: (Number(process.env.RULE_LAB_TIMEOUT_SECONDS) || 30) * 1000,
  snippetContextLines: 5,
  maxSnippetFileBytes: 2 * 1024 * 1024,
};

const workspaceDir = path.join(config.dataDir, 'workspace');
export const dbPath = path.join(config.dataDir, 'studio.db');

export function projectWorkspace(projectId: string): string {
  return path.join(workspaceDir, projectId);
}

export function pendingSourceDir(projectId: string): string {
  return path.join(projectWorkspace(projectId), 'pending', 'src');
}

/** 扫描快照根目录：目录本身由 POST /scans 创建、DELETE 负责清理，两处必须同一份路径 */
export function scanSnapshotRoot(projectId: string, scanId: string): string {
  return path.join(projectWorkspace(projectId), scanId);
}

export function scanSourceDir(projectId: string, scanId: string): string {
  return path.join(scanSnapshotRoot(projectId, scanId), 'src');
}
