# syntax=docker/dockerfile:1

# 引擎单独成 stage：缓存键只有清单与安装脚本，业务代码改动不会让 50MB 引擎重新下载。
FROM node:22-bookworm-slim AS engine
WORKDIR /build
COPY server/scripts/engines.json server/scripts/setup-engine.mjs server/scripts/engine-install.mjs ./server/scripts/
RUN node server/scripts/setup-engine.mjs

FROM node:22-bookworm-slim AS build
WORKDIR /build

COPY code/package.json code/package-lock.json ./code/
RUN --mount=type=cache,target=/root/.npm npm ci --prefix code
COPY code/ ./code/
RUN npm run build --prefix code

COPY server/package.json server/package-lock.json ./server/
RUN --mount=type=cache,target=/root/.npm npm ci --prefix server

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="Opengrep Studio" \
      org.opencontainers.image.description="本地优先的 opengrep 静态代码审计工作台" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/Lyfxxk/Opengrep-Studio"

RUN apt-get update \
    && apt-get install -y --no-install-recommends git gosu ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node --from=build /build/code/dist ./code/dist
COPY --chown=node:node --from=build /build/server/node_modules ./server/node_modules
COPY --chown=node:node server/package.json ./server/package.json
COPY --chown=node:node server/src ./server/src
COPY --chown=node:node server/rules ./server/rules
COPY --chown=node:node server/scripts/engines.json server/scripts/engine-install.mjs ./server/scripts/
COPY --chown=node:node --from=engine /build/opengrep-tool ./opengrep-tool

# 只对数据目录递归 chown：/app 已由上面的 COPY --chown 归位，整目录再 chown 一遍是纯开销。
RUN mkdir -p /data/rules-custom && chown -R node:node /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    CUSTOM_RULES_DIR=/data/rules-custom
VOLUME /data
EXPOSE 8787

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "--prefix", "/app/server", "run", "start"]
