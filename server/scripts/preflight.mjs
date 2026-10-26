#!/usr/bin/env node
// npm run dev 前的引擎预检：只提示、不联网下载（下载交给一键启动脚本或 npm run setup:engine）。
// 与 server/src/config.ts 的解析规则保持一致（env → opengrep-tool 安装位 → PATH）；
// 版本信息优先读 opengrep-tool/installed.json（界面一键升级会写它），否则回落到 engines.json。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeVersion, readInstalledManifest, resolveTarget } from './engine-install.mjs';
import { engineExecutableName } from './engine-name.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, '..', '..');
const toolDir = path.join(repoRoot, 'opengrep-tool');
const envBin = process.env.OPENGREP_BIN?.trim();
const bundled = path.join(toolDir, engineExecutableName);

/** 安装位引擎的版本（读取失败时返回 undefined，不影响预检结论） */
function bundledVersion() {
  try {
    const installed = readInstalledManifest(toolDir);
    if (installed) return `${normalizeVersion(installed.version)}（安装记录）`;
    const catalog = JSON.parse(fs.readFileSync(path.join(scriptDir, 'engines.json'), 'utf8'));
    return normalizeVersion(resolveTarget({ catalog, installed: undefined, platform: process.platform }).version);
  } catch {
    return undefined;
  }
}

function findOnPath() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, engineExecutableName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
    }
  }
  return undefined;
}

if (envBin) {
  if (fs.existsSync(envBin)) {
    console.log(`[preflight] 引擎已就绪（OPENGREP_BIN）：${envBin}`);
  } else {
    console.warn(`[preflight] 警告：OPENGREP_BIN 指向的引擎不存在：${envBin}，扫描将失败。`);
  }
} else if (fs.existsSync(bundled)) {
  const version = bundledVersion();
  console.log(`[preflight] 引擎已就绪：${bundled}${version ? `（opengrep ${version}）` : ''}`);
} else if (findOnPath()) {
  console.log(`[preflight] 引擎已就绪（系统 PATH 中找到 ${engineExecutableName}）`);
} else {
  console.warn(
    '[preflight] 提示：未发现扫描引擎，服务可启动但无法扫描。\n' +
      '[preflight] 运行 npm run setup:engine 自动下载（github.com 不可达时会自动降级到 api.github.com 通道），' +
      '或设置 OPENGREP_BIN 指向引擎可执行文件。',
  );
}
