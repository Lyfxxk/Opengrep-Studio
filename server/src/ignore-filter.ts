import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';

/**
 * 上传快照的忽略规则剪枝：让手动上传（压缩包 / 文件夹）与 Git 仓库直扫
 * （git clone 天然只含被跟踪文件）的结果集口径一致。
 *
 * 语义与 git 对齐：
 * - 自顶向下遍历，每层目录读取规则文件压栈，深层规则覆盖浅层；
 * - 目录一旦命中忽略规则即整棵剪除——git 不允许重新包含已被排除目录内的文件，
 *   因此嵌套 .gitignore 的否定规则只能复活未被整目录排除的文件；
 * - 模式按各规则文件所在目录解析（.gitignore 只影响其所在目录及以下）。
 */

/** 无论规则如何都强制排除的目录（与扫描引擎的 --exclude 保持一致，不计入忽略统计） */
const ALWAYS_IGNORED_DIRS = new Set(['.git', 'node_modules']);

/** 每层目录会读取的忽略规则文件，靠后的优先级更高（同目录内覆盖靠前的） */
const IGNORE_FILE_NAMES = ['.gitignore', '.opengrepignore'];

interface RuleLevel {
  /** 规则文件所在目录（相对快照根，'.' 表示根目录） */
  baseDir: string;
  ig: Ignore;
}

export interface PruneResult {
  /** 剪枝后剩余的文件数 */
  keptFiles: number;
  /** 因忽略规则被删除的文件数（含被整棵剪除目录内的文件） */
  ignoredFiles: number;
}

function countFilesDeep(absDir: string): number {
  let count = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) count += 1;
    }
  };
  walk(absDir);
  return count;
}

/** 深层规则优先：从栈顶（最近的规则文件）往下找第一个有明确判定的层级 */
function isIgnored(relPath: string, levels: RuleLevel[]): boolean {
  for (let i = levels.length - 1; i >= 0; i -= 1) {
    const level = levels[i];
    const rel =
      level.baseDir === '.'
        ? relPath
        : relPath.startsWith(`${level.baseDir}/`)
          ? relPath.slice(level.baseDir.length + 1)
          : null;
    if (rel === null || rel === '') continue;
    const verdict = level.ig.test(rel);
    if (verdict.ignored) return true;
    if (verdict.unignored) return false;
  }
  return false;
}

/**
 * 对快照目录执行忽略规则剪枝（原地删除被忽略的文件/目录），返回剩余与被忽略的文件数。
 * 目录不存在时返回全零，由调用方决定空结果的报错方式。
 */
export function pruneIgnoredFiles(rootDir: string): PruneResult {
  let keptFiles = 0;
  let ignoredFiles = 0;

  const walk = (absDir: string, relDir: string, inherited: RuleLevel[]): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const levels = [...inherited];
    for (const name of IGNORE_FILE_NAMES) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(absDir, name), 'utf8');
      } catch {
        continue;
      }
      levels.push({ baseDir: relDir, ig: ignore().add(text.replace(/\r\n/g, '\n')) });
    }

    for (const entry of entries) {
      const full = path.join(absDir, entry.name);
      const rel = relDir === '.' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        fs.rmSync(full, { force: true });
        continue;
      }
      if (entry.isDirectory()) {
        if (ALWAYS_IGNORED_DIRS.has(entry.name)) {
          fs.rmSync(full, { recursive: true, force: true });
          continue;
        }
        // 目录判定带尾部斜杠，使 build/ 这类仅匹配目录的模式生效
        if (isIgnored(`${rel}/`, levels)) {
          ignoredFiles += countFilesDeep(full);
          fs.rmSync(full, { recursive: true, force: true });
          continue;
        }
        walk(full, rel, levels);
      } else if (entry.isFile()) {
        if (isIgnored(rel, levels)) {
          fs.rmSync(full, { force: true });
          ignoredFiles += 1;
        } else {
          keptFiles += 1;
        }
      }
    }
  };

  walk(rootDir, '.', []);
  return { keptFiles, ignoredFiles };
}
