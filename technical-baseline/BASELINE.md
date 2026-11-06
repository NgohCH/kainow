# Kainow V1.0 — Technical baseline spike

**Status:** Spike, not product code. It checks that the pinned libraries install, compile, and work together against a real PostgreSQL 16 database. It doesn't implement any product requirement.

## Pinned versions (exact)

| Component | Version | Verified here |
| --- | --- | --- |
| Node.js | 22.23.4 (local) | Build and runs. pg-boss 12.38.1 requires `>=22.12.0`. Whether 22.x is the right pin for production is not decided. |
| PostgreSQL | 16.15 (Ubuntu 24.04 package) | Connected; pg-boss schema created and job processed. |
| TypeScript | 5.9.3 | Compiles with `strict`. |
| @nestjs/core, common, platform-express | 12.4.0 | App boots; `GET /health` returns `{"status":"ok"}`. |
| pg-boss | 12.38.1 | `send`, `work` and completion verified against PostgreSQL. |
| pg | 8.23.1 | Used by pg-boss. |
| react | 19.3.1 | Installed only. No frontend code yet, so not verified. |
| rxjs | 7.8.2 | Required by NestJS. |
| reflect-metadata | 0.2.2 | Required by NestJS. |

## Choices I made that need review

- **TypeScript 5.9.3, not 7.0.2.** The latest TypeScript (7.0.2) wasn't tested, because NestJS 12 compatibility wasn't checked. 5.9.3 is a version that compiles this code.
- **Node.js 22 chosen by default.** The `node@lts` lookup failed, so the current LTS line wasn't confirmed.
- **Versions are latest-at-time-of-spike** from the npm registry on 6 November 2026, not a support-matrix decision.

## Verification run

- `npm run build`: passes.
- `npm run smoke` against `postgres://…@localhost:5432/kainow_dev`: job id returned, payload `{"hello":"kainow"}` processed, `SMOKE OK`.
- `npm run start` then `GET /health`: returns `{"status":"ok"}`.

## Not yet covered by this spike

PostgreSQL row-level security, the durable job retry and reconciliation rules from A11, the data schema, the permission model, AI provider adapters, the frontend, backup and restore, and the self-hosted update mechanism. Each needs its own design under the Remaining Design register.

## Running locally

```
npm install
DATABASE_URL=postgres://<user>:<password>@localhost:5432/<db> npm run smoke
npm run start
```

Credentials are supplied through the environment and are not stored in this repository.
