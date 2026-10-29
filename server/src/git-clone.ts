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
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    trackChildProcess(child);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    // 攒 Buffer 一次解码：git 的中文/UTF-8 报错跨 chunk 时逐段 toString 会出乱码
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

/**
 * 日志与回传错误脱敏：URL 内嵌凭据（https://user:token@host/...）不能进控制台或落库。
 * git 回显的是命令行里的原始（百分号编码）URL，不能拿 URL 解码后的 username/password
 * 去比对——密码含 @ : / 等字符时解码结果与回显永远对不上；这里直接按 URL 形态匹配。
 */
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

/**
 * 浅克隆仓库到目标目录（成功后整体替换已有内容）。
 * 克隆先落到 destDir 的兄弟临时目录，全部校验通过后才替换 destDir：
 * 失败路径（私有仓库/地址写错/超时/没装 git/超限）只清临时目录，
 * 用户此前上传的源码（destDir）原样保留。克隆完成后在临时目录上剥离 .git
 * 并做文件数/体积限额校验，与 ZIP 上传保持同一套约束。
 */
export async function cloneRepo(
  url: string,
  ref: string,
  destDir: string,
): Promise<{ fileCount: number }> {
  const parsed = parseRepoUrl(url);
  validateGitRef(ref);
  // 临时目录与 destDir 同在 workspace/<projectId>/pending/ 下（同盘保证 rename 原子）；
  // 固定临时名即可——importingProjects 互斥保证同项目不会并发克隆，入口先清一次还能
  // 顺带回收上次进程崩溃留下的残骸。临时目录是 pending/src 的兄弟而非子目录，
  // 不会被后续扫描快照（只复制 pending/src）带进去
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
  // 所有失败路径只清临时目录：删 destDir 会把用户已上传的源码一起丢掉
  const fail = (message: string): never => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // git 的报错行会原样带上带凭据的 URL，回传前必须脱敏
    throw gitFail(redactSecrets(detail));
  }

  // .git 剥离与限额校验都在临时目录上进行，保证 destDir 里出现的永远是校验通过的完整源码
  fs.rmSync(path.join(tmpDir, '.git'), { recursive: true, force: true });
  const { files, bytes } = walkAndStripSymlinks(tmpDir);
  if (files === 0) {
    fail('仓库没有任何文件（可能是空仓库，或默认分支不含源码），请确认后重试');
  }
  if (files > config.maxImportEntries) {
    fail(`仓库文件数超过 ${config.maxImportEntries} 上限，请改用 ZIP 上传部分源码`);
  }
  if (bytes > config.maxExtractedBytes) {
    fail(`仓库源码总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限，请改用 ZIP 上传部分源码`);
  }

  // Windows 上 rename 目标已存在会 EPERM，只能先删旧再换新；两步之间进程崩溃会留下
  // 「已删旧、未换新」的窗口——与旧实现「入口先删 destDir」同损，可接受，
  // 残留的临时目录由下次克隆入口清理
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, destDir);
  return { fileCount: files };
}
