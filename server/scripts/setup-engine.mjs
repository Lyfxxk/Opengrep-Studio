#!/usr/bin/env node
// 下载 opengrep 引擎二进制并做 SHA256 校验（零第三方依赖，Node ≥ 22.5）。
// 版本、各平台资产名与哈希统一维护在 server/scripts/engines.json；升级引擎 = 更新该文件后重跑本脚本。
//
// 用法：npm run setup:engine [-- --force] [-- --version v1.31.0]
//   --force          引擎已存在且校验通过时也强制重新下载
//   --version <tag>  临时改用其他版本下载（资产名与 SHA256 仍取自 engines.json，
//                    版本不一致时校验会失败——升级请直接更新 engines.json）
//
// 环境变量：
//   OPENGREP_DOWNLOAD_BASE  覆盖下载基址（路径形态须与 GitHub 一致：<base>/<tag>/<资产名>），
//                           国内网络可指向 GitHub 加速镜像
//   OPENGREP_BIN            设置后引擎路径由用户自管，服务端不再使用本脚本的安装位置

import { createHash } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, '..', '..');
const toolDir = path.join(repoRoot, 'opengrep-tool');
const catalog = JSON.parse(readFileSync(path.join(scriptDir, 'engines.json'), 'utf8'));

const args = process.argv.slice(2);
const force = args.includes('--force');
const versionIdx = args.indexOf('--version');
const versionArg = versionIdx !== -1 ? args[versionIdx + 1] : undefined;
const version = versionArg ?? catalog.version;
const baseUrl = (process.env.OPENGREP_DOWNLOAD_BASE ?? catalog.baseUrl).replace(/\/+$/, '');

/** 安装名与 server/src/config.ts 的 engineExecutableName 保持一致 */
const installedName = process.platform === 'win32' ? 'opengrep.exe' : 'opengrep';
const installedPath = path.join(toolDir, installedName);

const manualHint = [
  `手动安装替代方案：`,
  `  1. 打开 https://github.com/opengrep/opengrep/releases/tag/${version}`,
  '  2. 下载对应平台的二进制并重命名为 ' + installedName,
  `  3. 放入 ${toolDir}（或放到任意位置并设置环境变量 OPENGREP_BIN 指向它）`,
].join('\n');

function fail(message) {
  console.error(`\n[setup:engine] ${message}`);
  const envHint = process.platform === 'win32' ? 'set' : 'export';
  console.error(`[setup:engine] 网络受限时可设置镜像后重试：${envHint} OPENGREP_DOWNLOAD_BASE=<镜像基址>（路径形态：<base>/${version}/<资产名>）`);
  console.error(manualHint);
  process.exit(1);
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

async function downloadTo(url, target) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败（HTTP ${res.status}）：${url}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;
  let lastPct = -1;
  await pipeline(Readable.fromWeb(res.body), async function* (source) {
    for await (const chunk of source) {
      received += chunk.length;
      if (total > 0) {
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          process.stdout.write(`\r[setup:engine] 下载中 ${pct}%（${Math.round(received / 1048576)}MB / ${Math.round(total / 1048576)}MB）`);
        }
      }
      yield chunk;
    }
  }, createWriteStream(target));
  process.stdout.write('\r[setup:engine] 下载完成                                          \n');
}

async function main() {
  const asset = catalog.assets[platformKey()];
  if (!asset) {
    console.error(`[setup:engine] 暂无 ${platformKey()} 平台的自动下载支持（可用平台：${Object.keys(catalog.assets).join('、')}）。`);
    console.error(manualHint);
    process.exit(1);
  }

  const url = `${baseUrl}/${version}/${asset.file}`;
  const expected = asset.sha256.toLowerCase();

  if (!force && existsSync(installedPath)) {
    const actual = sha256File(installedPath);
    if (actual === expected) {
      console.log(`[setup:engine] 引擎已就绪且校验通过，跳过下载：${installedPath}`);
      console.log(`[setup:engine] 如需重新下载请加 --force`);
      return;
    }
    console.log(`[setup:engine] 现有引擎与清单不匹配（版本或文件损坏），将重新下载。`);
  }

  mkdirSync(toolDir, { recursive: true });
  const downloadPath = `${installedPath}.download`;
  rmSync(downloadPath, { force: true });

  console.log(`[setup:engine] 版本 ${version}  平台 ${platformKey()}`);
  console.log(`[setup:engine] 资产 ${asset.file}`);
  console.log(`[setup:engine] 地址 ${url}`);
  try {
    await downloadTo(url, downloadPath);
  } catch (error) {
    rmSync(downloadPath, { force: true });
    fail(`${error instanceof Error ? error.message : String(error)}`);
  }

  const actual = sha256File(downloadPath);
  if (actual !== expected) {
    rmSync(downloadPath, { force: true });
    fail(`SHA256 校验失败，已删除下载文件。\n  期望：${expected}\n  实际：${actual}\n若上游重新发布了该版本资产，请更新 server/scripts/engines.json。`);
  }
  console.log(`[setup:engine] SHA256 校验通过：${actual}`);

  rmSync(installedPath, { force: true });
  renameSync(downloadPath, installedPath);
  if (process.platform !== 'win32') chmodSync(installedPath, 0o755);

  const sizeMb = (statSync(installedPath).size / 1048576).toFixed(1);
  console.log(`[setup:engine] 已安装：${installedPath}（${sizeMb}MB，opengrep ${version}）`);
  console.log('[setup:engine] 引擎来自上游 opengrep/opengrep（LGPL-2.1），未做任何修改；该目录不入 git 仓库。');
}

main();
