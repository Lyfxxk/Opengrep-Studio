#!/usr/bin/env bash
# Opengrep Studio 一键启动（macOS / Linux），与 Windows 的 一键启动（Windows）.bat 等价：
# 校验 Node 版本 → 缺依赖时自动安装 → 拉起前后端；Ctrl+C 停止全部服务。
# 首次使用请先执行 `npm run setup:engine` 下载扫描引擎（约 50MB，按平台自动选择）。
set -euo pipefail
cd "$(dirname "$0")"

echo "================================================"
echo "  Opengrep Studio 一键启动"
echo "================================================"

echo "[1/5] 检查 Node.js 环境..."
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请安装 22.12 或更高版本：https://nodejs.org"
  exit 1
fi
NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
NODE_REST="${NODE_VER#*.}"
NODE_MINOR="${NODE_REST%%.*}"
echo "    当前版本 v$NODE_VER"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
  echo "[错误] Node.js 版本过低（v$NODE_VER），本项目要求 >= 22.12（后端内置 node:sqlite 需 22.5+，前端 Vite 8 需 22.12+）"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[错误] 未检测到 npm，请重新安装 Node.js：https://nodejs.org"
  exit 1
fi

echo "[2/5] 检查项目依赖..."
if [ ! -d node_modules ] || [ ! -d server/node_modules ] || [ ! -d code/node_modules ]; then
  echo "    依赖缺失，正在自动安装（首次可能需要几分钟）..."
  if ! npm run install:all; then
    echo "[错误] 依赖安装失败，请检查网络后重试，或手动执行 npm run install:all"
    exit 1
  fi
else
  echo "    依赖完整，跳过安装"
fi

echo "[3/5] 检查 opengrep 引擎..."
if [ ! -f opengrep-tool/opengrep ] && [ ! -f opengrep-tool/opengrep.exe ] && [ -z "${OPENGREP_BIN:-}" ]; then
  echo "    引擎缺失，正在从官方 Release 下载并校验（约 50MB，首次需要等待）..."
  if ! npm run setup:engine; then
    echo "[错误] 引擎下载失败。网络受限时可先 export OPENGREP_DOWNLOAD_BASE=镜像地址 再重试，"
    echo "        或手动下载：https://github.com/opengrep/opengrep/releases（版本以 server/scripts/engines.json 钉住的为准）"
    echo "        （重命名为 opengrep 放入 opengrep-tool/ 目录，或设置 OPENGREP_BIN 指向它；"
    echo "         macOS 浏览器下载的二进制需先执行 xattr -d com.apple.quarantine <引擎路径>）"
    exit 1
  fi
else
  echo "    引擎已就绪"
fi

echo "[4/5] 启动前后端服务..."
echo "    前端: http://localhost:1022    后端: http://127.0.0.1:8787"
echo "    提示：Ctrl+C 停止全部服务"
echo "[5/5] 前端就绪后将自动打开浏览器（后台探测进行中）"
(
  # 后台探测：前端 HTTP 就绪后用系统默认浏览器打开（最多等 60 秒）
  i=0
  while [ "$i" -lt 60 ]; do
    if node -e "fetch('http://127.0.0.1:1022/').then(() => process.exit(0), () => process.exit(1))" >/dev/null 2>&1; then
      if command -v open >/dev/null 2>&1; then
        open "http://127.0.0.1:1022/" || true
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "http://127.0.0.1:1022/" >/dev/null 2>&1 || true
      fi
      exit 0
    fi
    i=$((i + 1))
    sleep 1
  done
) &
exec npm run dev
