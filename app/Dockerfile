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
