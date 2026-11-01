# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /build

COPY code/package.json code/package-lock.json ./code/
RUN npm ci --prefix code
COPY code/ ./code/
RUN npm run build --prefix code

COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server

COPY server/scripts/engines.json server/scripts/setup-engine.mjs server/scripts/engine-install.mjs server/scripts/engine-name.mjs ./server/scripts/
RUN node server/scripts/setup-engine.mjs

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="Opengrep Studio" \
      org.opencontainers.image.description="本地优先的 opengrep 静态代码审计工作台" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/Lyfxxk/Opengrep-Studio"

RUN apt-get update \
    && apt-get install -y --no-install-recommends git gosu ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /build/code/dist ./code/dist
COPY --from=build /build/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY server/rules ./server/rules
COPY server/scripts/engines.json server/scripts/engine-install.mjs ./server/scripts/
COPY --from=build /build/opengrep-tool ./opengrep-tool

RUN mkdir -p /data/rules-custom && chown -R node:node /app /data
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
