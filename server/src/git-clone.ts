import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './errors.js';

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

/** 校验仓库 URL：仅允许 http(s)，拒绝 ssh://、file:// 等会交互或读本地的协议 */
export function parseRepoUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, '仓库地址格式不正确，请输入 https:// 开头的 Git 仓库 URL');
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
    throw new HttpError(400, '仅支持 http(s):// 形式的 Git 仓库地址');
  }
  return parsed;
}

/** 校验分支/Tag：拒绝 - 开头等会被 git 当作命令行参数的写法（如 --upload-pack） */
export function validateGitRef(ref: string): string {
  if (!ref) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..')) {
    throw new HttpError(400, '分支/Tag 名称只允许字母、数字与 . _ / - 字符，且不能以点开头');
  }
  return ref;
}

interface GitRunResult {
  code: number;
  stderr: string;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
}

function runGit(args: string[], timeoutMs: number): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      windowsHide: true,
      // 禁用终端/图形凭据交互：私有仓库直接失败回传，而不是挂起等待输入
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GCM_INTERACTIVE: 'Never',
      },
    });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr, timedOut, spawnError: error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr, timedOut });
    });
  });
}

interface WalkResult {
  files: number;
  bytes: number;
}

/** 统计克隆产物并剔除符号链接（与压缩包解压同源防护，防止软链指向工作区外） */
function walkCloned(dir: string): WalkResult {
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

function gitFail(detail: string): HttpError {
  if (detail.includes('could not read Username') || detail.includes('Authentication failed')) {
    return new HttpError(400, '克隆失败：该仓库需要认证。请使用公开仓库，私有仓库请改用 ZIP 上传');
  }
  return new HttpError(400, `克隆失败：${detail}`);
}

/**
 * 浅克隆仓库到目标目录（替换已有内容）。
 * 克隆完成后剥离 .git 并做文件数/体积限额校验，与 ZIP 上传保持同一套约束。
 */
export async function cloneRepo(
  url: string,
  ref: string,
  destDir: string,
): Promise<{ fileCount: number }> {
  const parsed = parseRepoUrl(url);
  validateGitRef(ref);
  fs.rmSync(destDir, { recursive: true, force: true });

  const args = [
    '-c', 'credential.helper=',
    'clone', '--depth', '1', '--single-branch', '--no-tags',
  ];
  if (ref) args.push('--branch', ref);
  args.push(parsed.toString(), destDir);

  console.log(`[git-clone] git ${args.map((a) => JSON.stringify(a)).join(' ')}`);
  const { code, stderr, timedOut, spawnError } = await runGit(args, config.cloneTimeoutMs);
  const fail = (message: string): never => {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw new HttpError(400, message);
  };

  if (spawnError?.code === 'ENOENT') {
    fail('服务器未安装 Git，无法使用仓库直扫；请安装 Git 后重试，或改用 ZIP 上传');
  }
  if (timedOut) {
    fail(`克隆超过 ${Math.round(config.cloneTimeoutMs / 60000)} 分钟被终止，请确认地址可访问，或改用 ZIP 上传`);
  }
  if (code !== 0) {
    const detail = stderr.trim().split('\n').filter(Boolean).pop() ?? `git exit ${code}`;
    fs.rmSync(destDir, { recursive: true, force: true });
    throw gitFail(detail);
  }

  fs.rmSync(path.join(destDir, '.git'), { recursive: true, force: true });
  const { files, bytes } = walkCloned(destDir);
  if (files === 0) {
    fail('仓库没有任何文件（可能是空仓库，或默认分支不含源码），请确认后重试');
  }
  if (files > config.maxZipEntries) {
    fail(`仓库文件数超过 ${config.maxZipEntries} 上限，请改用 ZIP 上传部分源码`);
  }
  if (bytes > config.maxExtractedBytes) {
    fail('仓库源码总体积超过 1GB 上限，请改用 ZIP 上传部分源码');
  }
  return { fileCount: files };
}
