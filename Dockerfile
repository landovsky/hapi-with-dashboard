# syntax=docker/dockerfile:1
#
# Container image for the hapi-hub fork (voice dashboard).
#
# Pure Bun stack — the hub uses bun:sqlite (no native modules to compile) and
# the entrypoint is hub/src/index.ts → startHub() (listens on
# HAPI_LISTEN_HOST:HAPI_LISTEN_PORT). `bun run build` builds the web PWA and
# embeds it into the hub, so the single process serves both the API and the UI.
#
# Built + pushed by .github/workflows/k3s-deploy.yml on a vX.Y.Z tag.

# ---- build: install deps, build web + embed + hub --------------------------
FROM oven/bun:1 AS build
WORKDIR /app

# Lockfile-first for layer caching on dependency-only changes.
COPY package.json bun.lock ./
COPY cli/package.json ./cli/
COPY hub/package.json ./hub/
COPY web/package.json ./web/
COPY shared/package.json ./shared/
COPY docs/package.json ./docs/
COPY website/package.json ./website/
RUN bun install --frozen-lockfile

# Full source, then build (web → embedded-web-assets → hub).
COPY . .
RUN bun run build

# ---- runtime: lean image, run the hub from source --------------------------
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# Match the existing k3s deployment: data on the PVC at /root/.hapi, bind all
# interfaces on 3006. HAPI_HOME pins the data dir regardless of $HOME.
ENV NODE_ENV=production \
    HAPI_LISTEN_HOST=0.0.0.0 \
    HAPI_LISTEN_PORT=3006 \
    HAPI_HOME=/root/.hapi
USER root

# Bring over the resolved workspace + the built/embedded assets. node_modules
# carries the bun workspace symlinks (@hapi/protocol → shared) the hub imports.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/shared ./shared
COPY --from=build /app/hub ./hub

EXPOSE 3006
CMD ["bun", "run", "hub/src/index.ts"]
