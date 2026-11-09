import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { Worker } from 'node:worker_threads';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { config, serverRoot } from './config.js';
import { HttpError } from './errors.js';
import { walkAndStripSymlinks, ALWAYS_SKIP_DIR_NAMES } from './fs-walk.js';

const ARCHIVE_EXTS = ['.zip', '.7z', '.rar', '.tar', '.tar.gz', '.tgz'];
const TAR_RE = /\.(tar|tar\.gz|tgz)$/i;

export function isArchiveFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTS.some((ext) => lower.endsWith(ext));
}

const ILLEGAL_PATH_CHARS =
  process.platform === 'win32' ? /[\u0000-\u001f<>:"|?*]/ : /[\u0000-\u001f]/;

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

export function isPathWithin(root: string, target: string): boolean {
  return path.resolve(target).startsWith(path.resolve(root) + path.sep);
}

export function rethrowLongPath(error: unknown, raw: string): void {
  if ((error as NodeJS.ErrnoException | null)?.code === 'ENAMETOOLONG') {
    const shown = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    throw new HttpError(
      400,
      `文件路径过长，无法写入：${shown}`,
      { code: 'archive.pathTooLong', params: { raw: shown } },
    );
  }
}

interface ZipEntryNameLike {
  entryName: string;
  rawEntryName: Buffer;
  header: { flags: number };
}

let zipUtf8Strict: TextDecoder | undefined;
let zipGbk: TextDecoder | undefined;

function decodeZipEntryName(entry: ZipEntryNameLike): string {
  if ((entry.header.flags & 0x800) === 0) {
    if (!zipUtf8Strict) zipUtf8Strict = new TextDecoder('utf-8', { fatal: true });
    try {
      return zipUtf8Strict.decode(entry.rawEntryName);
    } catch {
    }
    if (!zipGbk) {
      try {
        zipGbk = new TextDecoder('gbk');
      } catch {
        return entry.entryName;
      }
    }
    return zipGbk.decode(entry.rawEntryName);
  }
  return entry.entryName;
}

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

  const names: string[] = [];
  let totalBytes = 0;
  for (const entry of fileEntries) {
    const raw = decodeZipEntryName(entry);
    const name = safeRelativePath(raw);
    if (!name) {
      throw new HttpError(
        400,
        `ZIP 包内含不安全的路径条目：${raw}`,
        { code: 'archive.zipUnsafePath', params: { entry: raw } },
      );
    }
    if (entry.header.size === 0 && entry.header.compressedSize > 0) {
      throw new HttpError(
        400,
        `ZIP 包内含伪造体积的条目：${raw}`,
        { code: 'archive.zipFakeSize', params: { entry: raw } },
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
    names.push(name);
  }

  await fs.promises.rm(destDir, { recursive: true, force: true });
  let extractedBytes = 0;
  for (let index = 0; index < fileEntries.length; index += 1) {
    const entry = fileEntries[index];
    const target = path.join(destDir, names[index]);
    if (!isPathWithin(destDir, target)) {
      throw new HttpError(
        400,
        `ZIP 包内含不安全的路径条目：${entry.entryName}`,
        { code: 'archive.zipUnsafePath', params: { entry: entry.entryName } },
      );
    }
    const data = entry.getData();
    extractedBytes += data.length;
    if (extractedBytes > config.maxExtractedBytes) {
      throw new HttpError(
        400,
        `ZIP 解压后总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`,
        { code: 'archive.zipTooLarge', params: { gb: config.maxExtractedBytes / 1024 ** 3 } },
      );
    }
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, data);
    } catch (error) {
      rethrowLongPath(error, names[index]);
      throw error;
    }
  }
  return fileEntries.length;
}

async function extractTarArchive(buffer: Buffer, destDir: string, fileName: string): Promise<void> {
  const lower = fileName.toLowerCase();
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const tmpFile = path.join(
    os.tmpdir(),
    `ogsrc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar`,
  );
  await fs.promises.writeFile(tmpFile, buffer);
  let entries = 0;
  let bytes = 0;
  try {
    await tar.x({
      file: tmpFile,
      cwd: destDir,
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

async function extractSevenZ(buffer: Buffer, destDir: string, fileName: string): Promise<void> {
  const ext = path.extname(fileName).toLowerCase() || '.7z';
  let abortReason: string | null = null;
  let abortCode: string | null = null;
  const worker = new Worker(path.join(serverRoot, 'src', 'seven-z-worker.mjs'));
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
      worker.once('exit', (exitCode) => {
        settle({ ok: false, message: abortReason ?? `解压线程意外退出（code ${exitCode}）` });
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
      await extractTarArchive(buffer, destDir, fileName);
      return enforceExtractLimits(destDir, 'tar');
    }
    await extractSevenZ(buffer, destDir, fileName);
    return enforceExtractLimits(destDir, 'archive');
  } catch (error) {
    fs.rmSync(destDir, { recursive: true, force: true });
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      `压缩包解压失败：${error instanceof Error ? error.message : String(error)}`,
      { code: 'archive.extractFailed', params: { reason: error instanceof Error ? error.message : String(error) } },
    );
  }
}
