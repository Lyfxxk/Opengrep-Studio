import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ALWAYS_SKIP_DIR_NAMES } from './fs-walk.js';


const HASH_CHUNK_BYTES = 1024 * 1024;
const DIFF_MATRIX_CAP = 1_000_000;
const DIFF_LIST_CAP = 500;

interface FileEntry {
  sha256: string;
  size: number;
}

interface FileDiffEntry {
  path: string;
  addedLines: number | null;
  removedLines: number | null;
  diffable: boolean;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  modified: FileDiffEntry[];
  filesA: number;
  filesB: number;
}

async function hashFile(file: string): Promise<FileEntry> {
  const hash = createHash('sha256');
  const stat = await fs.promises.stat(file);
  const fd = await fs.promises.open(file, 'r');
  try {
    const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await fd.read(chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (bytesRead <= 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await fd.close();
  }
  hash.update(`|${stat.size}`);
  return { sha256: hash.digest('hex'), size: stat.size };
}

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
