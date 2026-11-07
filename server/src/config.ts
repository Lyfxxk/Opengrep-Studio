import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const serverRoot =
  process.env.SERVER_ROOT ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function engineNameFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'opengrep.exe' : 'opengrep';
}

export const engineExecutableName = engineNameFor(process.platform);

export type EngineSource = 'env' | 'bundled-dir' | 'path' | 'missing';

export interface ResolvedEngine {
  bin: string;
  source: EngineSource;
}

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
    }
  }
  return { bin: bundled, source: 'missing' };
}

const resolvedEngine = resolveEngineBin();

export const engineSource = resolvedEngine.source;

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  dataDir: process.env.DATA_DIR ?? path.join(serverRoot, 'data'),
  rulesDir: path.join(serverRoot, 'rules'),
  customRulesDir:
    process.env.CUSTOM_RULES_DIR ?? path.join(serverRoot, 'rules', 'custom'),
  opengrepBin: resolvedEngine.bin,
  maxUploadBytes: 200 * 1024 * 1024,
  maxExtractedBytes: 1024 * 1024 * 1024,
  maxImportEntries: 50000,
  scanTimeoutMs: 10 * 60 * 1000,
  cloneTimeoutMs: (Number(process.env.CLONE_TIMEOUT_SECONDS) || 240) * 1000,
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

export function scanSnapshotRoot(projectId: string, scanId: string): string {
  return path.join(projectWorkspace(projectId), scanId);
}

export function scanSourceDir(projectId: string, scanId: string): string {
  return path.join(scanSnapshotRoot(projectId, scanId), 'src');
}
