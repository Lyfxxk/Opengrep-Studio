import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { trackChildProcess } from './engine.js';
import { HttpError } from './errors.js';
import { walkAndStripSymlinks } from './fs-walk.js';

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

function parseRepoUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, '仓库地址格式不正确，请输入 https:// 开头的 Git 仓库 URL', {
      code: 'git.badUrl',
    });
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
    throw new HttpError(400, '仅支持 http(s):// 形式的 Git 仓库地址', { code: 'git.schemeUnsupported' });
  }
  return parsed;
}

function validateGitRef(ref: string): string {
  if (!ref) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..')) {
    throw new HttpError(400, '分支/Tag 名称只允许字母、数字与 . _ / - 字符，且不能以点开头', {
      code: 'git.badRef',
    });
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
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GCM_INTERACTIVE: 'Never',
      },
    });
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    trackChildProcess(child);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const decode = () => Buffer.concat(stderrChunks).toString('utf8');
    child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: decode(), timedOut, spawnError: error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr: decode(), timedOut });
    });
  });
}

export function redactSecrets(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, '$1***@');
}

function gitFail(detail: string): HttpError {
  if (detail.includes('could not read Username') || detail.includes('Authentication failed')) {
    return new HttpError(
      400,
      '克隆失败：该仓库需要认证。请使用公开仓库，私有仓库请改用 ZIP 上传',
      { code: 'git.authRequired' },
    );
  }
  return new HttpError(400, `克隆失败：${detail}`, { code: 'git.cloneFailed', params: { reason: detail } });
}

export async function cloneRepo(
  url: string,
  ref: string,
  destDir: string,
): Promise<{ fileCount: number }> {
  const parsed = parseRepoUrl(url);
  validateGitRef(ref);
  const tmpDir = `${destDir}.cloning`;
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const args = [
    '-c', 'credential.helper=',
    'clone', '--depth', '1', '--single-branch', '--no-tags',
  ];
  if (ref) args.push('--branch', ref);
  args.push(parsed.toString(), tmpDir);

  console.log(`[git-clone] git ${redactSecrets(args.map((a) => JSON.stringify(a)).join(' '))}`);
  const { code, stderr, timedOut, spawnError } = await runGit(args, config.cloneTimeoutMs);
  const fail = (code: string, message: string, params?: Record<string, unknown>): never => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new HttpError(400, message, { code, params });
  };

  if (spawnError?.code === 'ENOENT') {
    fail('git.notInstalled', '服务器未安装 Git，无法使用仓库直扫；请安装 Git 后重试，或改用 ZIP 上传');
  }
  if (timedOut) {
    fail(
      'git.cloneTimeout',
      `克隆超过 ${Math.round(config.cloneTimeoutMs / 60000)} 分钟被终止，请确认地址可访问，或改用 ZIP 上传`,
      { minutes: Math.round(config.cloneTimeoutMs / 60000) },
    );
  }
  if (code !== 0) {
    const detail = stderr.trim().split('\n').filter(Boolean).pop() ?? `git exit ${code}`;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw gitFail(redactSecrets(detail));
  }

  fs.rmSync(path.join(tmpDir, '.git'), { recursive: true, force: true });
  const { files, bytes } = walkAndStripSymlinks(tmpDir);
  if (files === 0) {
    fail('git.emptyRepo', '仓库没有任何文件（可能是空仓库，或默认分支不含源码），请确认后重试');
  }
  if (files > config.maxImportEntries) {
    fail(
      'git.tooManyFiles',
      `仓库文件数超过 ${config.maxImportEntries} 上限，请改用 ZIP 上传部分源码`,
      { limit: config.maxImportEntries },
    );
  }
  if (bytes > config.maxExtractedBytes) {
    fail(
      'git.totalTooLarge',
      `仓库源码总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限，请改用 ZIP 上传部分源码`,
      { gb: config.maxExtractedBytes / 1024 ** 3 },
    );
  }

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, destDir);
  return { fileCount: files };
}
