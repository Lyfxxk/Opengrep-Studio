import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { ALWAYS_SKIP_DIR_NAMES } from './fs-walk.js';

const IGNORE_FILE_NAMES = ['.gitignore', '.opengrepignore'];

interface RuleLevel {
  baseDir: string;
  ig: Ignore;
}

export interface PruneResult {
  keptFiles: number;
  ignoredFiles: number;
}

async function countFilesDeep(absDir: string): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) count += 1;
    }
  };
  await walk(absDir);
  return count;
}

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

export async function pruneIgnoredFiles(rootDir: string): Promise<PruneResult> {
  let keptFiles = 0;
  let ignoredFiles = 0;

  const walk = async (absDir: string, relDir: string, inherited: RuleLevel[]): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const levels = [...inherited];
    for (const name of IGNORE_FILE_NAMES) {
      let text: string;
      try {
        text = await fs.promises.readFile(path.join(absDir, name), 'utf8');
      } catch {
        continue;
      }
      levels.push({ baseDir: relDir, ig: ignore().add(text.replace(/\r\n/g, '\n')) });
    }

    for (const entry of entries) {
      const full = path.join(absDir, entry.name);
      const rel = relDir === '.' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        await fs.promises.rm(full, { force: true });
        continue;
      }
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIR_NAMES.has(entry.name)) {
          await fs.promises.rm(full, { recursive: true, force: true });
          continue;
        }
        if (isIgnored(`${rel}/`, levels)) {
          ignoredFiles += await countFilesDeep(full);
          await fs.promises.rm(full, { recursive: true, force: true });
          continue;
        }
        await walk(full, rel, levels);
      } else if (entry.isFile()) {
        if (isIgnored(rel, levels)) {
          await fs.promises.rm(full, { force: true });
          ignoredFiles += 1;
        } else {
          keptFiles += 1;
        }
      }
    }
  };

  await walk(rootDir, '.', []);
  return { keptFiles, ignoredFiles };
}
