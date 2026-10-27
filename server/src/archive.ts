import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import * as sevenzz from '7z-wasm';
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
    throw new HttpError(400, `压缩包或文件列表中含不安全的路径条目：${raw}`);
  }
  if (ILLEGAL_PATH_CHARS.test(normalized)) {
    throw new HttpError(400, `路径含当前平台不允许的文件名字符：${raw}`);
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
 * 递归复制目录。
 * 不要改成 fs.cpSync：Node 22.x 在 Windows 上源路径字符串含非 ASCII 字符时
 * 会无任何输出直接终止进程（子项含非 ASCII 不受影响，故扫描快照不受此坑影响）。
 */
export function copyDirectorySync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirectorySync(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function removeAndThrow(dir: string, message: string): never {
  fs.rmSync(dir, { recursive: true, force: true });
  throw new HttpError(400, message);
}

/** 解压后统一限额校验（文件数 / 总体积），返回实际文件数 */
function enforceExtractLimits(dir: string, label: string): number {
  const { files, bytes } = walkAndStripSymlinks(dir);
  if (files > config.maxImportEntries) {
    removeAndThrow(dir, `${label}解压后文件数超过 ${config.maxImportEntries} 上限`);
  }
  if (bytes > config.maxExtractedBytes) {
    removeAndThrow(dir, `${label}解压后总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`);
  }
  if (files === 0) {
    removeAndThrow(dir, `${label}中没有文件（压缩包可能已损坏或格式不受支持）`);
  }
  return files;
}

/** ZIP：保留原有的元数据前置校验（条目数 / 体积在解压前即可判定） */
export function extractZipSafely(buffer: Buffer, destDir: string): number {
  const zip = new AdmZip(buffer);
  const fileEntries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (fileEntries.length === 0) throw new HttpError(400, 'ZIP 包内没有文件');
  if (fileEntries.length > config.maxImportEntries) {
    throw new HttpError(400, `ZIP 包内文件数超过 ${config.maxImportEntries} 上限`);
  }

  let totalBytes = 0;
  for (const entry of fileEntries) {
    const name = safeRelativePath(entry.entryName);
    // 声明体积为 0 却带压缩数据 = 骗过预检的炸弹条目：adm-zip 对声明 0 的条目解压不设上限
    if (entry.header.size === 0 && entry.header.compressedSize > 0) {
      throw new HttpError(400, `ZIP 包内含伪造体积的条目：${entry.entryName}`);
    }
    totalBytes += entry.header.size;
    if (totalBytes > config.maxExtractedBytes) {
      throw new HttpError(400, `ZIP 解压后总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`);
    }
    if (!name) throw new HttpError(400, `ZIP 包内含不安全的路径条目：${entry.entryName}`);
  }

  fs.rmSync(destDir, { recursive: true, force: true });
  let extractedBytes = 0;
  for (const entry of fileEntries) {
    const target = path.join(destDir, safeRelativePath(entry.entryName));
    if (!isPathWithin(destDir, target)) {
      throw new HttpError(400, `ZIP 包内含不安全的路径条目：${entry.entryName}`);
    }
    const data = entry.getData();
    // 实际字节数复核：中央目录的声明可伪造，只有解出来的数据可信
    extractedBytes += data.length;
    if (extractedBytes > config.maxExtractedBytes) {
      throw new HttpError(400, `ZIP 解压后总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
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
  try {
    tar.x({
      file: tmpFile,
      cwd: destDir,
      sync: true,
      gzip: lower.endsWith('.tar.gz') || lower.endsWith('.tgz'),
    });
  } catch (error) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw new HttpError(400, `TAR 压缩包解压失败：${error instanceof Error ? error.message : String(error)}`);
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

/** 遍历解压产物，按扩展名聚合各语言的字节数（跳过 node_modules / .git / 符号链接） */
export function collectLanguageStats(dir: string): Record<string, number> {
  const stats: Record<string, number> = {};
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ALWAYS_SKIP_DIR_NAMES.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const language = languageOf(entry.name);
        if (!language) continue;
        try {
          stats[language] = (stats[language] ?? 0) + fs.statSync(full).size;
        } catch {
        }
      }
    }
  };
  walk(dir);
  return stats;
}

function copyMemFsDir(seven: sevenzz.SevenZipModule, memDir: string, diskDir: string): void {
  for (const name of seven.FS.readdir(memDir)) {
    if (name === '.' || name === '..') continue;
    const memFull = `${memDir}/${name}`;
    const diskFull = path.join(diskDir, name);
    const stat = seven.FS.lstat(memFull);
    if (seven.FS.isDir(stat.mode)) {
      fs.mkdirSync(diskFull, { recursive: true });
      copyMemFsDir(seven, memFull, diskFull);
    } else if (seven.FS.isFile(stat.mode)) {
      fs.mkdirSync(path.dirname(diskFull), { recursive: true });
      fs.writeFileSync(diskFull, seven.FS.readFile(memFull) as Buffer);
    }
  }
}

/** 7Z / RAR：经 7z-wasm 解压；优先挂载 NODEFS 直写磁盘，失败则回退内存 FS 拷贝 */
async function extractSevenZ(buffer: Buffer, destDir: string, fileName: string): Promise<void> {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const ext = path.extname(fileName).toLowerCase() || '.7z';
  let stderr = '';
  // NodeNext 下该 UMD 包的 default 导出被互操作包装成命名空间，运行时实际就是工厂函数
  const init7z = sevenzz.default as unknown as sevenzz.SevenZipModuleFactory;
  let seven: sevenzz.SevenZipModule;
  try {
    seven = await init7z({
      printErr: (line: string) => {
        stderr += `${line}\n`;
      },
    });
  } catch (error) {
    throw new HttpError(500, `解压组件初始化失败：${error instanceof Error ? error.message : String(error)}`);
  }

  seven.FS.writeFile(`input${ext}`, buffer);
  let mountedDirect = false;
  try {
    seven.FS.mkdir('/out');
    seven.FS.mount(seven.NODEFS, { root: destDir }, '/out');
    mountedDirect = true;
  } catch {
    mountedDirect = false;
  }

  try {
    seven.callMain(['x', '-y', `input${ext}`, '-o/out']);
  } catch (error) {
    const detail = stderr.trim().split('\n').pop() ?? '';
    throw new HttpError(
      400,
      `压缩包解压失败：${detail || (error instanceof Error ? error.message : String(error))}`,
    );
  }
  if (!mountedDirect) copyMemFsDir(seven, '/out', destDir);
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
      return extractZipSafely(buffer, destDir);
    }
    if (TAR_RE.test(lower)) {
      extractTarArchive(buffer, destDir, fileName);
      return enforceExtractLimits(destDir, 'TAR 压缩包');
    }
    await extractSevenZ(buffer, destDir, fileName);
    return enforceExtractLimits(destDir, '压缩包');
  } catch (error) {
    fs.rmSync(destDir, { recursive: true, force: true });
    if (error instanceof HttpError) throw error;
    // adm-zip 等解析库抛的是普通 Error（如损坏的 ZIP），统一按 400 客户端错误回传
    throw new HttpError(
      400,
      `压缩包解压失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
