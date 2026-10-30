import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ALWAYS_SKIP_DIR_NAMES } from './fs-walk.js';

/**
 * 无 Git 双快照 diff：对两次扫描的不可变源码快照做文件级 + 行级对比。
 * - 方向固定为 before（旧快照）→ after（新快照）：added = 只在 after、removed = 只在 before，
 *   行级 addedLines/removedLines 同样相对 before→after
 * - 文件级：sha256（大文件只哈希前 5MB + 体积）分类为 added / removed / modified
 * - 行级：modified 文件做"前后缀裁剪 + LCS"行差异统计；中段过大时放弃行级计数（diffable=false）
 */

const HASH_READ_CAP = 5 * 1024 * 1024;
/** 行级 LCS 的规模上限（行列乘积），超过则不做行级统计 */
const DIFF_MATRIX_CAP = 1_000_000;
/** 三个差异列表（added/removed/modified）各自的条数上限，防大仓库撑爆响应 */
const DIFF_LIST_CAP = 500;

interface FileEntry {
  sha256: string;
  size: number;
}

interface FileDiffEntry {
  path: string;
  /** 行级统计（diffable=false 时为 null） */
  addedLines: number | null;
  removedLines: number | null;
  diffable: boolean;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  modified: FileDiffEntry[];
  /** 与扫描一致的可比文件总数（不含 node_modules/.git） */
  filesA: number;
  filesB: number;
}

/** 流式哈希：大于 5MB 的文件只读前 5MB 参与哈希，size 一起进哈希避免不同大文件碰撞 */
async function hashFile(file: string): Promise<FileEntry> {
  const hash = createHash('sha256');
  const stat = await fs.promises.stat(file);
  const fd = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, HASH_READ_CAP));
    await fd.read(buffer, 0, buffer.length, 0);
    hash.update(buffer);
  } finally {
    await fd.close();
  }
  hash.update(`|${stat.size}`);
  return { sha256: hash.digest('hex'), size: stat.size };
}

/** 遍历快照目录：跳过 node_modules/.git 与符号链接，返回 相对路径 → 文件信息 */
async function hashSnapshot(dir: string): Promise<Map<string, FileEntry>> {
  const map = new Map<string, FileEntry>();
  const walk = async (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        try {
          map.set(rel, await hashFile(full));
        } catch {
        }
      }
    }
  };
  await walk(dir);
  return map;
}

/** 行级差异：裁掉公共前后缀后对中段做 LCS（超限返回 null） */
function countLineDiff(a: string, b: string): { added: number; removed: number } | null {
  const aLines = a.split(/\r?\n/);
  const bLines = b.split(/\r?\n/);
  let start = 0;
  while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) start += 1;
  let endA = aLines.length;
  let endB = bLines.length;
  while (endA > start && endB > start && aLines[endA - 1] === bLines[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = aLines.slice(start, endA);
  const midB = bLines.slice(start, endB);
  if (midA.length === 0) return { added: midB.length, removed: 0 };
  if (midB.length === 0) return { added: 0, removed: midA.length };
  if (midA.length * midB.length > DIFF_MATRIX_CAP) return null;

  // LCS 长度表（滚动行，省内存）
  const prev = new Uint32Array(midB.length + 1);
  const curr = new Uint32Array(midB.length + 1);
  for (let i = 1; i <= midA.length; i += 1) {
    for (let j = 1; j <= midB.length; j += 1) {
      curr[j] = midA[i - 1] === midB[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], curr[j - 1]);
    }
    prev.set(curr);
  }
  const lcs = prev[midB.length];
  return { added: midB.length - lcs, removed: midA.length - lcs };
}

const READ_CAP_BYTES = 2 * 1024 * 1024;
const READ_CAP_LINES = 20_000;

async function readForDiff(file: string): Promise<string> {
  const stat = await fs.promises.stat(file);
  const cap = Math.min(stat.size, READ_CAP_BYTES);
  const fd = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(cap);
    await fd.read(buffer, 0, cap, 0);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    return lines.slice(0, READ_CAP_LINES).join('\n');
  } finally {
    await fd.close();
  }
}

/** 对比两份源码快照（before 旧、after 新；调用方需保证两目录存在且属于已完成扫描） */
export async function diffSnapshots(beforeDir: string, afterDir: string): Promise<SnapshotDiff> {
  const [before, after] = [await hashSnapshot(beforeDir), await hashSnapshot(afterDir)];
  const added: string[] = [];
  const removed: string[] = [];
  const modified: FileDiffEntry[] = [];

  for (const [rel, entryBefore] of before) {
    const entryAfter = after.get(rel);
    if (!entryAfter) {
      removed.push(rel);
      continue;
    }
    if (entryBefore.sha256 === entryAfter.sha256) continue;
    // 与 added/removed 同口径：超过上限不再追加，否则大仓库会把响应撑到全部文件量级
    if (modified.length >= DIFF_LIST_CAP) continue;
    let lineStatsRaw: { added: number; removed: number } | null = null;
    try {
      lineStatsRaw = countLineDiff(
        await readForDiff(path.join(beforeDir, rel)),
        await readForDiff(path.join(afterDir, rel)),
      );
    } catch {
      lineStatsRaw = null;
    }
    // 行级统计读出 0/0 但文件哈希不同 = 差异落在读取窗口（2MB / 2 万行）之外，
    // 与 LCS 超限同口径返回 null，界面按「内容有变但无法逐行统计」呈现而不是「+0 / -0」
    const lineStats = lineStatsRaw && (lineStatsRaw.added > 0 || lineStatsRaw.removed > 0)
      ? lineStatsRaw
      : null;
    modified.push({
      path: rel,
      addedLines: lineStats?.added ?? null,
      removedLines: lineStats?.removed ?? null,
      diffable: lineStats !== null,
    });
  }
  for (const rel of after.keys()) {
    if (!before.has(rel)) added.push(rel);
  }
  return {
    added: added.sort().slice(0, DIFF_LIST_CAP),
    removed: removed.sort().slice(0, DIFF_LIST_CAP),
    modified: modified.sort((x, y) => x.path.localeCompare(y.path)),
    filesA: before.size,
    filesB: after.size,
  };
}
