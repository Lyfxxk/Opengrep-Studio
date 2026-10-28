import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { trackChildProcess } from './engine.js';
import { HttpError } from './errors.js';
import { walkAndStripSymlinks } from './fs-walk.js';

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

/** 校验仓库 URL：仅允许 http(s)，拒绝 ssh://、file:// 等会交互或读本地的协议 */
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

/** 校验分支/Tag：拒绝 - 开头等会被 git 当作命令行参数的写法（如 --upload-pack） */
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
    trackChildProcess(child);
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

/** 日志与回传错误脱敏：URL 内嵌凭据（https://user:token@host/...）不能进控制台或落库 */
function redactSecrets(text: string, parsed: URL): string {
  const userinfo = `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}`;
  return userinfo ? text.split(`${userinfo}@`).join('***@') : text;
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

  console.log(`[git-clone] git ${redactSecrets(args.map((a) => JSON.stringify(a)).join(' '), parsed)}`);
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
    // git 的报错行会原样带上带凭据的 URL，回传前必须脱敏
    throw gitFail(redactSecrets(detail, parsed));
  }

  fs.rmSync(path.join(destDir, '.git'), { recursive: true, force: true });
  const { files, bytes } = walkAndStripSymlinks(destDir);
  if (files === 0) {
    fail('仓库没有任何文件（可能是空仓库，或默认分支不含源码），请确认后重试');
  }
  if (files > config.maxImportEntries) {
    fail(`仓库文件数超过 ${config.maxImportEntries} 上限，请改用 ZIP 上传部分源码`);
  }
  if (bytes > config.maxExtractedBytes) {
    fail(`仓库源码总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限，请改用 ZIP 上传部分源码`);
  }
  return { fileCount: files };
}
