import fs from 'node:fs';
import path from 'node:path';

/**
 * 无论忽略规则如何都强制跳过的目录名（扫描剪枝、快照对比、压缩包解压统计共用）。
 * 与扫描引擎的 --exclude 口径保持一致；调整时三处消费方必须同时生效。
 */
export const ALWAYS_SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

interface WalkResult {
  files: number;
  bytes: number;
}

/**
 * 统计目录内文件数与总体积，并剔除符号链接。
 * 压缩包解压与 Git 克隆两条导入通道共用同一份防护（软链可能指向工作区之外），
 * 改动这里必须两条通道同时生效，不要在任何一边另起副本。
 */
export function walkAndStripSymlinks(dir: string): WalkResult {
  let files = 0;
  let bytes = 0;
  const symlinks: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(full);
        continue;
      }
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  };
  walk(dir);
  for (const link of symlinks) fs.rmSync(link, { force: true });
  return { files, bytes };
}
