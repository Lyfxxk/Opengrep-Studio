#!/bin/sh
# Opengrep Studio 容器入口：root 启动时先修正数据卷属主，再降权到 node 用户运行。
# 这样 `-v ./data:/data`（宿主机 root 建的目录）也能直接写入；以非 root 运行时原样 exec。
set -e

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data 2>/dev/null || true
  exec gosu node "$@"
fi

exec "$@"
