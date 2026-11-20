# One image runs the API, the worker and the one-off commands (migrate, create the first administrator).
# Build context is the app/ folder. Versions are pinned: change them deliberately, not by accident.

# --- the review screen ---
FROM node:22.23.4-bookworm-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- the API and worker, compiled ---
FROM node:22.23.4-bookworm-slim AS api
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Tests and their helpers are not shipped.
RUN npx tsc -p tsconfig.json && find dist -name '*.test.js' -delete && rm -rf dist/testing

# --- what actually runs: production dependencies only, no compiler, no tests, not root ---
FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=api /build/dist ./dist
COPY migrations ./migrations
COPY assets ./assets
COPY --from=web /build/web/dist ./web/dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

# --- the operations image: the same app plus the PostgreSQL 16 client tools (pg_dump, pg_restore, psql) ---
# Debian bookworm's own postgresql-client is version 15 and cannot dump a version 16 server, so it comes from the PostgreSQL project.
# This stage must stay last only if you build without --target; compose.yaml names the target for every service.
FROM runtime AS ops
USER root
RUN apt-get update  && apt-get install -y --no-install-recommends ca-certificates curl gnupg  && install -d /usr/share/postgresql-common/pgdg  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list  && apt-get update  && apt-get install -y --no-install-recommends postgresql-client-16  && apt-get purge -y --auto-remove curl gnupg  && rm -rf /var/lib/apt/lists/*
USER node
