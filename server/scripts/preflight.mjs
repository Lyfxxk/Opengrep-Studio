#!/usr/bin/env node
// npm run dev 前的引擎预检：只提示、不联网下载（下载交给一键启动脚本或 npm run setup:engine）。
// 与 server/src/config.ts 的解析规则保持一致（env → opengrep-tool 安装位 → PATH）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executableName = process.platform === 'win32' ? 'opengrep.exe' : 'opengrep';
const envBin = process.env.OPENGREP_BIN?.trim();
const bundled = path.join(repoRoot, 'opengrep-tool', executableName);

function findOnPath() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, executableName);
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
  console.log(`[preflight] 引擎已就绪：${bundled}`);
} else if (findOnPath()) {
  console.log(`[preflight] 引擎已就绪（系统 PATH 中找到 ${executableName}）`);
} else {
  console.warn(
    '[preflight] 提示：未发现扫描引擎，服务可启动但无法扫描。\n' +
      '[preflight] 运行 npm run setup:engine 自动下载，或设置 OPENGREP_BIN 指向引擎可执行文件。',
  );
}
