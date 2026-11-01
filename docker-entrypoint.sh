#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data 2>/dev/null || true
  exec gosu node "$@"
fi

exec "$@"
