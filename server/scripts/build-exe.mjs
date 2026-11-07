import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.dirname(scriptDir);
const repoRoot = path.dirname(serverDir);
const distExeDir = path.join(repoRoot, 'dist-exe');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function fail(message, ...hints) {
  console.error(`[build-exe] ${message}`);
  for (const hint of hints) console.error(`[build-exe] ${hint}`);
  process.exit(1);
}

function system32(name) {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);
}

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 20)) return;
  fail(
    `SEA 构建需要 Node >= 22.20（node:sea getAssetKeys 自该版本提供），当前 ${process.versions.node}。`,
    '仓库 .nvmrc 为 26，请切换 Node 版本后重试。',
  );
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function collectAssets() {
  const assets = {};
  const addDir = (keyPrefix, dir, skip) => {
    for (const file of walkFiles(dir)) {
      const rel = path.relative(dir, file).split(path.sep).join('/');
      if (skip?.(rel)) continue;
      assets[`${keyPrefix}${rel}`] = file;
    }
  };
  addDir('code/dist/', path.join(repoRoot, 'code', 'dist'));
  addDir('server/rules/', path.join(serverDir, 'rules'), (rel) =>
    rel === 'custom' || rel.startsWith('custom/'),
  );
  assets['server/scripts/engines.json'] = path.join(serverDir, 'scripts', 'engines.json');
  assets['server/src/seven-z-worker.mjs'] = path.join(serverDir, 'src', 'seven-z-worker.mjs');
  addDir('server/node_modules/7z-wasm/', path.join(serverDir, 'node_modules', '7z-wasm'));
  return assets;
}

function findSigntool() {
  const where = spawnSync(system32('where.exe'), ['signtool'], { encoding: 'utf8' });
  if (where.status === 0) {
    const hit = String(where.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && fs.existsSync(line));
    if (hit) return hit;
  }
  const patterns = [
    'C:/Program Files (x86)/Windows Kits/10/bin/*/x64/signtool.exe',
    'C:/Program Files (x86)/Windows Kits/10/App Certification Kit/signtool.exe',
  ];
  for (const pattern of patterns) {
    try {
      const hits = fs.globSync(pattern).sort();
      if (hits.length > 0) return hits.at(-1);
    } catch {
    }
  }
  return undefined;
}

async function main() {
  if (process.platform !== 'win32') {
    fail('此脚本仅支持在 Windows 上构建 exe（SEA 产物按 Windows 分发）。');
  }
  checkNodeVersion();

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  if (!fs.existsSync(path.join(repoRoot, 'code', 'dist', 'index.html'))) {
    fail('缺少前端构建产物 code/dist/index.html。', '请先执行 npm --prefix code run build 后重试。');
  }
  if (!fs.existsSync(path.join(serverDir, 'scripts', 'engines.json'))) {
    fail('缺少引擎清单 server/scripts/engines.json。', '该文件随仓库分发，请确认工作区完整。');
  }
  if (!fs.existsSync(path.join(serverDir, 'node_modules', '7z-wasm', '7zz.umd.js'))) {
    fail('缺少 7z-wasm 依赖（server/node_modules/7z-wasm）。', '请先执行 npm --prefix server install 后重试。');
  }

  fs.mkdirSync(distExeDir, { recursive: true });
  const bundlePath = path.join(distExeDir, 'bundle.cjs');
  const blobPath = path.join(distExeDir, 'sea-prep.blob');
  const seaConfigPath = path.join(distExeDir, 'sea-config.json');
  const exePath = path.join(distExeDir, 'OpengrepStudio.exe');

  console.log('[build-exe] 1/6 打包后端（esbuild CJS bundle）…');
  await esbuild.build({
    entryPoints: [path.join(serverDir, 'src', 'sea-main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    define: { __SEA_VERSION__: JSON.stringify(pkg.version) },
    logLevel: 'warning',
  });

  console.log('[build-exe] 2/6 生成 sea-config.json（资产 key=仓库相对路径，值=绝对路径）…');
  const assets = collectAssets();
  fs.writeFileSync(
    seaConfigPath,
    `${JSON.stringify(
      { main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true, assets },
      null,
      2,
    )}\n`,
  );

  console.log('[build-exe] 3/6 生成 SEA blob …');
  const prep = spawnSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
    stdio: 'inherit',
  });
  if (prep.status !== 0) {
    fail(`生成 SEA blob 失败（exit ${prep.status}）。`, '请把上方完整输出反馈给维护者。');
  }

  console.log('[build-exe] 4/6 复制 Node 运行时 …');
  try {
    fs.copyFileSync(process.execPath, exePath);
  } catch (error) {
    fail(
      `复制 node.exe 失败：${error instanceof Error ? error.message : String(error)}`,
      '若 OpengrepStudio.exe 正在运行，请先关闭它再重试。',
    );
  }

  console.log('[build-exe] 5/6 移除 node.exe 原始签名（可选）…');
  const signtool = findSigntool();
  if (!signtool) {
    console.log('[build-exe] 未找到 signtool，跳过签名移除；postject 会警告「签名损坏」，属预期，exe 可正常运行。');
    console.log('[build-exe] 如需消除该警告，请安装 Windows SDK（https://developer.microsoft.com/windows/downloads/windows-sdk/）后重跑。');
  } else {
    console.log(`[build-exe] 使用 signtool：${signtool}`);
    const removed = spawnSync(signtool, ['remove', '/s', exePath], { stdio: 'inherit' });
    if (removed.status !== 0) {
      console.log('[build-exe] 签名移除未成功（可能本就无签名），继续注入。');
    }
  }

  console.log('[build-exe] 6/6 注入 SEA blob（postject）…');
  const postjectCli = path.join(serverDir, 'node_modules', 'postject', 'dist', 'cli.js');
  if (!fs.existsSync(postjectCli)) {
    fail('缺少 postject 依赖（server/node_modules/postject）。', '请先执行 npm --prefix server install 后重试。');
  }
  const injected = spawnSync(
    process.execPath,
    [postjectCli, exePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SEA_FUSE],
    { stdio: 'inherit' },
  );
  if (injected.status !== 0) {
    fail(`postject 注入失败（exit ${injected.status}）。`, '请把上方完整输出反馈给维护者。');
  }

  const sizeMb = (fs.statSync(exePath).size / 1000 / 1000).toFixed(1);
  console.log('');
  console.log(`[build-exe] 构建完成：${exePath}（${sizeMb} MB）`);
  console.log('[build-exe] 下一步：把 exe 放到可写目录（桌面、下载等）后双击运行；首次启动会在同目录解压 server/、code/ 并生成 data/。');
  console.log('[build-exe] 本机验证：npm run smoke:exe');
}

main().catch((error) => fail(`构建失败：${error instanceof Error ? error.stack : String(error)}`));
