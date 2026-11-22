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

# --- the updater image: the same app plus git, ssh-keygen (release signatures) and Docker's CLI with its Compose plugin ---
# Docker's CLI and Compose plugin come from Docker's own apt repository, checked with its signed key; their versions are pinned.
# The downloaded key must be exactly one key with Docker's published fingerprint (9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88),
# or the build stops: this image holds the Docker socket.
# git and openssh-client are Debian bookworm's (security updates come with the distribution, as for the PostgreSQL client above).
# Compose runs it as the Kainow folder's owner (KAINOW_UID:KAINOW_GID) with the Docker socket's group (10b spec 5.1).
FROM runtime AS updater
USER root
RUN apt-get update  && apt-get install -y --no-install-recommends ca-certificates curl gnupg  && install -m 0755 -d /etc/apt/keyrings  && curl -fsSL -o /etc/apt/keyrings/docker.asc https://download.docker.com/linux/debian/gpg  && { export GNUPGHOME="$(mktemp -d)"; keys="$(gpg --batch --show-keys --with-colons /etc/apt/keyrings/docker.asc | grep -c '^pub:')"; fpr="$(gpg --batch --show-keys --with-colons /etc/apt/keyrings/docker.asc | awk -F: '$1 == "fpr" { print $10; exit }')"; rm -rf "$GNUPGHOME"; unset GNUPGHOME; if [ "$keys" != 1 ] || [ "$fpr" != 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]; then echo "Docker's apt key is not the expected key 9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88; the build stops." >&2; exit 1; fi; }  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list  && apt-get update  && apt-get install -y --no-install-recommends git openssh-client libnss-wrapper docker-ce-cli=5:29.10.0-1~debian.12~bookworm docker-compose-plugin=5.8.0-1~debian.12~bookworm  && apt-get purge -y --auto-remove curl gnupg  && rm -rf /var/lib/apt/lists/*
# ssh-keygen needs a passwd entry for the user it runs as; the entry point supplies one (see the script).
COPY --chmod=0755 docker/updater-entrypoint.sh /usr/local/bin/kainow-updater-entrypoint
ENTRYPOINT ["kainow-updater-entrypoint"]
USER node
