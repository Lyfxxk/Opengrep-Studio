# syntax=docker/dockerfile:1
# Opengrep Studio —— 本地优先的 opengrep 审计工作台
# 构建：docker build -t opengrep-studio .
# 运行：docker run --rm -p 8787:8787 -v ogstudio-data:/data opengrep-studio
#   （ bind mount 亦可：-v ./data:/data ，首次启动 entrypoint 会自动修正卷属主）

########## 构建阶段：前端产物 + 后端依赖 + 引擎二进制 ##########
FROM node:22-bookworm-slim AS build
WORKDIR /build

# 前端：先拷贝 manifest 利用层缓存，再构建产物
COPY code/package.json code/package-lock.json ./code/
RUN npm ci --prefix code
COPY code/ ./code/
RUN npm run build --prefix code

# 后端依赖（纯 JS 无原生模块，node_modules 可直接复制进运行时）
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server

# 引擎二进制：按构建平台从上游 Release 下载并 SHA256 校验（linux-x64 / linux-arm64）
COPY server/scripts/engines.json server/scripts/setup-engine.mjs ./server/scripts/
RUN node server/scripts/setup-engine.mjs

########## 运行阶段 ##########
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="Opengrep Studio" \
      org.opencontainers.image.description="本地优先的 opengrep 静态代码审计工作台" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/Lyfxxk/OpenGrep-Studio"

# git：容器内"Git 仓库直扫"需要；gosu：entrypoint 降权；ca-certificates：上游 HTTPS
RUN apt-get update \
    && apt-get install -y --no-install-recommends git gosu ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /build/code/dist ./code/dist
COPY --from=build /build/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY server/rules ./server/rules
COPY --from=build /build/opengrep-tool ./opengrep-tool

# 数据卷：SQLite + 源码快照 + 自定义规则包；预建目录并赋权，命名卷可继承属主
RUN mkdir -p /data/rules-custom && chown -R node:node /app /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    CUSTOM_RULES_DIR=/data/rules-custom
VOLUME /data
EXPOSE 8787

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# node:sqlite 需 Node >= 22.5（node:22 镜像满足）；引擎为上游 LGPL-2.1 二进制，未修改
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "--prefix", "/app/server", "run", "start"]
