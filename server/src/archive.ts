import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { walkAndStripSymlinks, ALWAYS_SKIP_DIR_NAMES } from './fs-walk.js';

/** 服务端支持的压缩包格式（解压通道见 extractArchive） */
const ARCHIVE_EXTS = ['.zip', '.7z', '.rar', '.tar', '.tar.gz', '.tgz'];
const TAR_RE = /\.(tar|tar\.gz|tgz)$/i;

export function isArchiveFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTS.some((ext) => lower.endsWith(ext));
}

/** 当前平台文件名不允许的字符（Windows 另保留 <>:"|?*；控制在两侧都非法） */
const ILLEGAL_PATH_CHARS =
  process.platform === 'win32' ? /[\u0000-\u001f<>:"|?*]/ : /[\u0000-\u001f]/;

/** 归一化相对路径并拒绝绝对路径 / 盘符 / 上跳目录（Zip-Slip 同源防护） */
export function safeRelativePath(raw: string): string {
  const normalized = raw.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || parts.includes('..')) {
    throw new HttpError(
      400,
      `压缩包或文件列表中含不安全的路径条目：${raw}`,
      { code: 'archive.unsafePath', params: { raw } },
    );
  }
  if (ILLEGAL_PATH_CHARS.test(normalized)) {
    throw new HttpError(
      400,
      `路径含当前平台不允许的文件名字符：${raw}`,
      { code: 'archive.illegalChars', params: { raw } },
    );
  }
  return parts.filter((part) => part && part !== '.').join('/');
}

/**
 * 路径遏制不变量：target 解析后必须位于 root 之下（不含 root 本身）。
 * 上传落盘与 snippet 读取共用，加固时只需改这一处。
 */
export function isPathWithin(root: string, target: string): boolean {
  return path.resolve(target).startsWith(path.resolve(root) + path.sep);
}

/**
 * 递归复制目录（异步：整棵源码树的复制不再冻结事件循环，复制期间健康检查/轮询照常响应）。
 * 不要改成 fs.cpSync：Node 22.x 在 Windows 上源路径字符串含非 ASCII 字符时
 * 会无任何输出直接终止进程（子项含非 ASCII 不受影响，故扫描快照不受此坑影响）。
 */
export async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await fs.promises.copyFile(from, to);
  }
}

function removeAndThrow(dir: string, code: string, message: string): never {
  fs.rmSync(dir, { recursive: true, force: true });
  throw new HttpError(400, message, { code });
}

/** 解压后统一限额校验（文件数 / 总体积），返回实际文件数；kind 决定错误码前缀 */
function enforceExtractLimits(dir: string, kind: 'tar' | 'archive'): number {
  const { files, bytes } = walkAndStripSymlinks(dir);
  const label = kind === 'tar' ? 'TAR 压缩包' : '压缩包';
  const codePrefix = kind === 'tar' ? 'archive.tarExtract' : 'archive.extract';
  if (files > config.maxImportEntries) {
    removeAndThrow(
      dir,
      `${codePrefix}TooManyFiles`,
      `${label}解压后文件数超过 ${config.maxImportEntries} 上限`,
    );
  }
  if (bytes > config.maxExtractedBytes) {
    removeAndThrow(
      dir,
      `${codePrefix}TooLarge`,
      `${label}解压后总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`,
    );
  }
  if (files === 0) {
    removeAndThrow(
      dir,
      `${codePrefix}Empty`,
      `${label}中没有文件（压缩包可能已损坏或格式不受支持）`,
    );
  }
  return files;
}

/**
 * ZIP：保留原有的元数据前置校验（条目数 / 体积在解压前即可判定）。
 * 落盘循环走异步 I/O（copyDirectory 同款手法）：3 万条目的 zip 逐条同步 writeFileSync
 * 会把事件循环冻住数秒，health 等其余接口全程无响应；每条 await 让出后请求照常调度。
 */
export async function extractZipSafely(buffer: Buffer, destDir: string): Promise<number> {
  const zip = new AdmZip(buffer);
  const fileEntries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (fileEntries.length === 0) throw new HttpError(400, 'ZIP 包内没有文件', { code: 'archive.zipEmpty' });
  if (fileEntries.length > config.maxImportEntries) {
    throw new HttpError(
      400,
      `ZIP 包内文件数超过 ${config.maxImportEntries} 上限`,
      { code: 'archive.zipTooManyFiles', params: { limit: config.maxImportEntries } },
    );
  }

  let totalBytes = 0;
  for (const entry of fileEntries) {
    const name = safeRelativePath(entry.entryName);
    // 声明体积为 0 却带压缩数据 = 骗过预检的炸弹条目：adm-zip 对声明 0 的条目解压不设上限
    if (entry.header.size === 0 && entry.header.compressedSize > 0) {
      throw new HttpError(
        400,
        `ZIP 包内含伪造体积的条目：${entry.entryName}`,
        { code: 'archive.zipFakeSize', params: { entry: entry.entryName } },
      );
    }
    totalBytes += entry.header.size;
    if (totalBytes > config.maxExtractedBytes) {
      throw new HttpError(
        400,
        `ZIP 解压后总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`,
        { code: 'archive.zipTooLarge', params: { gb: config.maxExtractedBytes / 1024 ** 3 } },
      );
    }
    if (!name) {
      throw new HttpError(
        400,
        `ZIP 包内含不安全的路径条目：${entry.entryName}`,
        { code: 'archive.zipUnsafePath', params: { entry: entry.entryName } },
      );
    }
  }

  await fs.promises.rm(destDir, { recursive: true, force: true });
  let extractedBytes = 0;
  for (const entry of fileEntries) {
    const target = path.join(destDir, safeRelativePath(entry.entryName));
    if (!isPathWithin(destDir, target)) {
      throw new HttpError(
        400,
        `ZIP 包内含不安全的路径条目：${entry.entryName}`,
        { code: 'archive.zipUnsafePath', params: { entry: entry.entryName } },
      );
    }
    const data = entry.getData();
    // 实际字节数复核：中央目录的声明可伪造，只有解出来的数据可信
    extractedBytes += data.length;
    if (extractedBytes > config.maxExtractedBytes) {
      throw new HttpError(
        400,
        `ZIP 解压后总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`,
        { code: 'archive.zipTooLarge', params: { gb: config.maxExtractedBytes / 1024 ** 3 } },
      );
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data);
  }
  return fileEntries.length;
}

/** TAR / TAR.GZ / TGZ（bz2/xz 不在支持清单里，入口 isArchiveFileName 已提前拒绝） */
function extractTarArchive(buffer: Buffer, destDir: string, fileName: string): void {
  const lower = fileName.toLowerCase();
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const tmpFile = path.join(
    os.tmpdir(),
    `ogsrc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar`,
  );
  fs.writeFileSync(tmpFile, buffer);
  // tar 头自带每个条目的原始体积：边解压边计数，炸弹在写盘前就被拦下
  let entries = 0;
  let bytes = 0;
  try {
    tar.x({
      file: tmpFile,
      cwd: destDir,
      sync: true,
      gzip: lower.endsWith('.tar.gz') || lower.endsWith('.tgz'),
      filter: (_entryPath, stat) => {
        entries += 1;
        bytes += Number(stat.size);
        if (entries > config.maxImportEntries) {
          throw new HttpError(
            400,
            `TAR 压缩包文件数超过 ${config.maxImportEntries} 上限`,
            { code: 'archive.tarTooManyFiles', params: { limit: config.maxImportEntries } },
          );
        }
        if (bytes > config.maxExtractedBytes) {
          throw new HttpError(
            400,
            `TAR 压缩包解压后总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`,
            { code: 'archive.tarTooLarge', params: { gb: config.maxExtractedBytes / 1024 ** 3 } },
          );
        }
        return true;
      },
    });
  } catch (error) {
    fs.rmSync(destDir, { recursive: true, force: true });
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      `TAR 压缩包解压失败：${error instanceof Error ? error.message : String(error)}`,
      { code: 'archive.tarFailed', params: { reason: error instanceof Error ? error.message : String(error) } },
    );
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

/** 扩展名 → 语言（GitHub Linguist 简化版，用于源码语言分布统计） */
const EXT_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  vue: 'Vue',
  html: 'HTML', htm: 'HTML',
  css: 'CSS', scss: 'SCSS', sass: 'SCSS', less: 'Less',
  py: 'Python',
  java: 'Java',
  go: 'Go',
  rb: 'Ruby',
  php: 'PHP',
  rs: 'Rust',
  kt: 'Kotlin', kts: 'Kotlin',
  swift: 'Swift',
  c: 'C', h: 'C',
  cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++',
  cs: 'C#',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  sql: 'SQL',
  yml: 'YAML', yaml: 'YAML',
  json: 'JSON',
  md: 'Markdown', mdx: 'Markdown',
  xml: 'XML', toml: 'TOML', ini: 'INI', gradle: 'Gradle', properties: 'INI',
};

function languageOf(fileName: string): string | undefined {
  if (fileName === 'Dockerfile' || fileName.startsWith('Dockerfile.')) return 'Dockerfile';
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  return EXT_LANG[ext];
}

/** 遍历解压产物，按扩展名聚合各语言的字节数（跳过 node_modules / .git / 符号链接）。
 *  异步遍历：大快照同步 statSync 数万次同样会冻结事件循环。 */
export async function collectLanguageStats(dir: string): Promise<Record<string, number>> {
  const stats: Record<string, number> = {};
  const walk = async (current: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ALWAYS_SKIP_DIR_NAMES.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const language = languageOf(entry.name);
        if (!language) continue;
        try {
          stats[language] = (stats[language] ?? 0) + (await fs.promises.stat(full)).size;
        } catch {
        }
      }
    }
  };
  await walk(dir);
  return stats;
}

/** 汇总目录体积（7z worker 落盘监控用；目录尚不存在返回 0） */
async function directoryBytes(dir: string): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else if (entry.isFile()) {
      try {
        total += (await fs.promises.stat(full)).size;
      } catch {
      }
    }
  }
  return total;
}

/**
 * 7Z / RAR：解压放独立 worker（callMain 同步阻塞且不可中断，放主线程会整段冻结还没法限时）。
 * 主线程对 worker 双保险：整体超时 terminate；每秒轮询落盘体积、超限 terminate。
 * 体积上限因此是准实时的（轮询间隔内的增量仍可能落盘，失败时随半成品目录一起清理）。
 */
async function extractSevenZ(buffer: Buffer, destDir: string, fileName: string): Promise<void> {
  const ext = path.extname(fileName).toLowerCase() || '.7z';
  let abortReason: string | null = null;
  let abortCode: string | null = null;
  const worker = new Worker(path.join(import.meta.dirname, 'seven-z-worker.mjs'));
  // worker 侧以 parentPort.on('message') 为入口：先建 Worker 再投递任务（加载期的消息会被缓存）
  worker.postMessage({ buffer, ext, destDir });
  try {
    const result = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
      const timer = setTimeout(() => {
        abortReason = `压缩包解压超过 ${Math.round(config.sevenZipTimeoutMs / 1000)} 秒被终止`;
        abortCode = 'archive.sevenZTimeout';
        void worker.terminate();
      }, config.sevenZipTimeoutMs);
      const watch = setInterval(() => {
        void directoryBytes(destDir).then((bytes) => {
          if (abortReason || bytes <= config.maxExtractedBytes) return;
          abortReason = `压缩包解压后总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`;
          abortCode = 'archive.sevenZTooLarge';
          void worker.terminate();
        });
      }, 1000);
      const settle = (value: { ok: boolean; message?: string }) => {
        clearTimeout(timer);
        clearInterval(watch);
        resolve(value);
      };
      worker.once('message', settle);
      worker.once('error', (error) => {
        settle({ ok: false, message: error instanceof Error ? error.message : String(error) });
      });
      worker.once('exit', () => {
        if (abortReason) settle({ ok: false, message: abortReason });
      });
    });
    if (!result.ok) {
      throw new HttpError(400, `压缩包解压失败：${result.message ?? '未知原因'}`, {
        code: abortCode ?? 'archive.sevenZFailed',
        params: { reason: result.message ?? '未知原因' },
      });
    }
  } finally {
    await worker.terminate();
  }
}

/** 按扩展名分发解压，返回文件数；失败时清理半成品目录 */
export async function extractArchive(
  buffer: Buffer,
  destDir: string,
  fileName: string,
): Promise<number> {
  const lower = fileName.toLowerCase();
  try {
    if (lower.endsWith('.zip')) {
      return await extractZipSafely(buffer, destDir);
    }
    if (TAR_RE.test(lower)) {
      extractTarArchive(buffer, destDir, fileName);
      return enforceExtractLimits(destDir, 'tar');
    }
    await extractSevenZ(buffer, destDir, fileName);
    return enforceExtractLimits(destDir, 'archive');
  } catch (error) {
    fs.rmSync(destDir, { recursive: true, force: true });
    if (error instanceof HttpError) throw error;
    // adm-zip 等解析库抛的是普通 Error（如损坏的 ZIP），统一按 400 客户端错误回传
    throw new HttpError(
      400,
      `压缩包解压失败：${error instanceof Error ? error.message : String(error)}`,
      { code: 'archive.extractFailed', params: { reason: error instanceof Error ? error.message : String(error) } },
    );
  }
}
