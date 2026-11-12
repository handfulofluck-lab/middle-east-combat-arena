# syntax=docker/dockerfile:1
#
# MCA server image: static client + multiplayer relay + payments API, one
# process on one port (see docs/ONLINE.md).
#
#   docker build -t mca .
#   docker run --rm -p 8790:8790 -v mca-data:/data mca
#
# Build args:
#   NODE_IMAGE    base image (override with a registry mirror if Docker Hub
#                 rate-limits you, e.g. mirror.gcr.io/library/node:22-bookworm-slim)
#   RUNTIME_USER  user the container STARTS as. "node" (default): strictly
#                 non-root. "root": the entrypoint makes DATA_DIR writable for
#                 "node" and then drops privileges for good -- needed where a
#                 platform mounts volumes owned by root (Fly.io). Either way
#                 the server process itself never runs as root.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- 1. build the client (needs devDependencies: vite, fonts) ---------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && test -f dist/web/index.html

# ---- 2. production dependencies only ------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- 3. runtime ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG RUNTIME_USER=node
LABEL org.opencontainers.image.title="MCA — Middle East Combat Arena" \
      org.opencontainers.image.description="Static client, multiplayer relay and payments API in one process"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790 \
    WEB_ROOT=/app/dist/web \
    DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY --from=build /app/dist/web ./dist/web
# /data holds the license ledger. Mount a persistent volume there in production.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8790
USER ${RUNTIME_USER}
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8790) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/bin/sh", "/app/server/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
