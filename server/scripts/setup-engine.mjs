#!/usr/bin/env node
// 下载 opengrep 引擎二进制并做 SHA256 校验（零第三方依赖，Node ≥ 22.12）。
//
// 版本与哈希的优先级：
//   1. 命令行 --version / --sha256（界面"一键升级"走这条，新版本哈希来自 release 资产 digest）
//   2. opengrep-tool/installed.json（记录实际安装的版本；比 engines.json 新时优先，
//      保证升级过的引擎不会被重跑本脚本降级回去）
//   3. server/scripts/engines.json（仓库钉住的已知好版本，也是随时可用的恢复路径）
//
// 用法：npm run setup:engine [-- --force] [-- --version vX.Y.Z [-- --sha256 <hex>]]
//   --force           引擎已就绪时也强制重新下载
//   --version <tag>   临时改用其他版本下载（资产名仍取自 engines.json）
//   --sha256 <hex>    配合 --version 使用：指定该版本的 SHA-256
//                     （不指定时若与本机已装版本一致，复用 installed.json 里的哈希）
//
// 环境变量：
//   OPENGREP_DOWNLOAD_BASE  覆盖下载基址（路径形态须与 GitHub 一致：<base>/<tag>/<资产名>），
//                           国内网络可指向 GitHub 加速镜像；镜像失败后仍会自动回落到
//                           github.com 与 api.github.com 通道
//   OPENGREP_BIN            设置后引擎路径由用户自管，服务端不再使用本脚本的安装位置

import {
  DOWNLOAD_CHANNEL_HINT,
  GITHUB_REPO,
  INSTALLED_MANIFEST_NAME,
  compareVersions,
  installEngineAsset,
  platformKey,
  readInstalledManifest,
  resolveTarget,
  sha256File,
} from './engine-install.mjs';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineExecutableName } from './engine-name.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, '..', '..');
const toolDir = path.join(repoRoot, 'opengrep-tool');
const catalog = JSON.parse(readFileSync(path.join(scriptDir, 'engines.json'), 'utf8'));

const args = process.argv.slice(2);
const force = args.includes('--force');

/**
 * 读取 `--flag <值>`：缺值、值本身是另一个 flag、或格式不符都直接报错退出。
 * 原来用 args[indexOf+1] 直取，`-- --version`（本想查版本）会静默回落到清单版本
 * 开始下 50MB，`-- --version --force` 则把 --force 当成版本名去拼下载链接。
 */
function flagValue(flag, pattern, expect) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--') || !pattern.test(value)) {
    console.error(`[setup:engine] ${flag} 需要${expect}，实际拿到：${value ?? '（空）'}`);
    console.error('[setup:engine] 用法：npm run setup:engine [-- --force] [-- --version vX.Y.Z [-- --sha256 <64位十六进制>]]');
    process.exit(2);
  }
  return value;
}

const explicitVersion = flagValue('--version', /^v?\d+\.\d+\.\d+$/, '形如 v1.33.0 的版本号');
const explicitSha = flagValue('--sha256', /^[0-9a-fA-F]{64}$/, '64 位十六进制 SHA-256');

/** 安装名取自脚本侧唯一源头（engine-name.mjs，与 server/src/config.ts 的 engineNameFor 同步维护） */
const installedName = engineExecutableName;
const installedPath = path.join(toolDir, installedName);
const installedManifest = readInstalledManifest(toolDir);

const manualHint = [
  `手动安装替代方案：`,
  `  1. 打开 https://github.com/${GITHUB_REPO}/releases/tag/${explicitVersion ?? catalog.version}`,
  '  2. 下载对应平台的二进制并重命名为 ' + installedName,
  `  3. 放入 ${toolDir}（或放到任意位置并设置环境变量 OPENGREP_BIN 指向它）`,
].join('\n');

function fail(message) {
  console.error(`\n[setup:engine] ${message}`);
  if (existsSync(installedPath)) {
    console.error('[setup:engine] 现有引擎保持原样，可正常用于扫描。');
  }
  const envHint = process.platform === 'win32' ? 'set' : 'export';
  console.error(`[setup:engine] ${DOWNLOAD_CHANNEL_HINT}`);
  console.error(`[setup:engine] 也可用镜像覆盖首选通道：${envHint} OPENGREP_DOWNLOAD_BASE=<镜像基址>（路径形态：<base>/${explicitVersion ?? catalog.version}/<资产名>）`);
  console.error(manualHint);
  process.exit(1);
}

function progress({ phase, percent }) {
  if (phase === 'downloading' && typeof percent === 'number') {
    process.stdout.write(`\r[setup:engine] 下载中 ${percent}%`);
  } else if (phase === 'verifying') {
    process.stdout.write('\r[setup:engine] 校验下载文件（SHA-256 + 版本探测）…          \n');
  } else if (phase === 'installing') {
    process.stdout.write('[setup:engine] 正在替换引擎文件…\n');
  }
}

/** 目标版本：命令行 > installed.json（比清单新时）> engines.json */
function resolveInstallTarget() {
  if (!explicitVersion && !explicitSha) return resolveTarget({ catalog, installed: installedManifest });
  const asset = assetForPlatform();
  const version = explicitVersion ?? catalog.version;
  const sameAsInstalled =
    installedManifest !== undefined && compareVersions(installedManifest.version, version) === 0;
  // --version 指向清单外的新版本时哈希无从得知（新版本哈希不预存），必须由调用方给出
  if (!explicitSha && !sameAsInstalled && compareVersions(version, catalog.version) !== 0) {
    console.error(`[setup:engine] 版本 ${version} 不在 engines.json 中，缺少可校验的 SHA-256。`);
    console.error('[setup:engine] 请加 --sha256 <hex>（可从该版本 release 资产的 digest 字段取得），或更新 engines.json 后重试。');
    process.exit(1);
  }
  return {
    version,
    assetFile: asset.file,
    // --version 指向已安装版本时复用 installed.json 的哈希（新版哈希不在 engines.json 里）
    sha256: (explicitSha ?? (sameAsInstalled ? installedManifest.sha256 : asset.sha256)).toLowerCase(),
    source: '命令行指定',
  };
}

function assetForPlatform() {
  const asset = catalog.assets[platformKey()];
  if (!asset) {
    console.error(`[setup:engine] 暂无 ${platformKey()} 平台的自动下载支持（可用平台：${Object.keys(catalog.assets).join('、')}）。`);
    console.error(manualHint);
    process.exit(1);
  }
  return asset;
}

async function main() {
  const target = resolveInstallTarget();

  if (!force && existsSync(installedPath)) {
    const actual = sha256File(installedPath);
    if (actual === target.sha256) {
      console.log(`[setup:engine] 引擎已就绪且校验通过，跳过下载：${installedPath}`);
      console.log(`[setup:engine] 当前版本 ${target.version}（来源：${target.source}），如需重新下载请加 --force`);
      if (installedManifest && installedManifest.sha256 === actual) {
        console.log(`[setup:engine] 安装记录：${path.join(toolDir, INSTALLED_MANIFEST_NAME)}（${installedManifest.version}）`);
      }
      return;
    }
    console.log('[setup:engine] 现有引擎与目标版本或哈希不一致，将重新下载。');
  }

  console.log(`[setup:engine] 版本 ${target.version}  平台 ${platformKey()}（来源：${target.source}）`);
  console.log(`[setup:engine] 资产 ${target.assetFile}`);

  let result;
  try {
    result = await installEngineAsset({
      tag: target.version,
      assetFile: target.assetFile,
      sha256: target.sha256,
      toolDir,
      installedName,
      onProgress: progress,
      log: (message) => console.log(`[setup:engine] ${message}`),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const sizeMb = (statSync(result.installedPath).size / 1048576).toFixed(1);
  const upgradedFrom =
    installedManifest && compareVersions(installedManifest.version, result.version) !== 0
      ? `（原 ${installedManifest.version}）`
      : '';
  console.log(`[setup:engine] 已安装：${result.installedPath}（${sizeMb}MB，opengrep ${result.version}${upgradedFrom}）`);
  console.log(`[setup:engine] 下载通道：${result.channel}`);
  console.log('[setup:engine] 引擎来自上游 opengrep/opengrep（LGPL-2.1），未做任何修改；该目录不入 git 仓库。');
}

await main();
