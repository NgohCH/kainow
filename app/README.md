# Kainow app (December 2026 MVP)

The MVP application: a NestJS API and a pg-boss worker on one PostgreSQL 16 database, in one repository (decision R01). It implements the scope in [`docs/MVP-DECISIONS.md`](../docs/MVP-DECISIONS.md), a working vertical slice and not the full V1.0 release. `technical-baseline/` stays as the earlier library spike and is not product code.

## Run locally

```
cd app
npm install
cp .env.example .env          # then set DATABASE_URL
npm run build
DATABASE_URL=postgres://... npm run migrate
DATABASE_URL=postgres://... npm run start:api      # GET /health
DATABASE_URL=postgres://... npm run start:worker
```

## Tests

```
KAINOW_TEST_DATABASE_URL=postgres://.../kainow_test npm test
```

The test database is throwaway: the suite drops and recreates its `public` schema. Without `KAINOW_TEST_DATABASE_URL` the database tests skip and report as skipped, not passed.

## Milestones

| # | Milestone | Status |
| --- | --- | --- |
| M1 | Foundation: API and worker entry points, config, SQL migrations with checksums, identity and append-only audit schema, health check, durable AI/email/document queues | Done, tested on PostgreSQL 16 |
| M2 | Passwordless sign-in and permissions: one-time codes (10 min, 5 attempts, 30 min lockout), 12-hour sessions, Enterprise Administrator, default-deny permission checks with allowed and denied tests for every action | Needs open question 1 |
| M3 | Notes intake: paste, TXT, Markdown, DOCX, selectable-text PDF; NFC normalisation; source versions and character offsets | Not started |
| M4 | AI extraction: pg-boss job, OpenAI adapter with pinned model ID, quote-to-offset location, token usage records, credential pattern check before sending, MYR 20 monthly cap with reserve-before-call | Needs open questions 2 and 3 |
| M5 | Review screen (React): source-linked proposals, approve and reject bound to the exact source version | Not started |
| M6 | Docker Compose package and local install, built and tested on the Product Owner's computer (Docker Hub is unreachable from the sandbox) | Not started |

## Open questions for the Product Owner

1. **How are sign-in codes delivered in the MVP?** Email is deferred to January, but passwordless sign-in needs a way to deliver the code. Options: a minimal SMTP sender used only for sign-in codes, or writing the code to the server log for the single administrator.
2. **Prices for the spend cap.** The cap is MYR 20 a month, but token prices for `gpt-6-luna` are billed in another currency. R10 needs approved per-token prices and a USD-to-MYR rate that the Administrator can change.
3. **Model IDs.** `gpt-6-luna` and `gpt-6.1-sol` are still unverified against the provider's list (`modelVerified` is `false` in `tests/extraction/config.json`).
4. **Where originals are stored in the MVP.** SharePoint/OneDrive storage (A13) is deferred. Proposed default: keep the original file and extracted text in PostgreSQL, and move to the managed area later.

## Decisions already fixed in code

- Identifiers are UUIDv7; timestamps are stored in UTC.
- Users are disabled, never deleted. `audit_events` rejects update, delete and truncate in the database itself.
- Sign-in codes and session tokens are stored only as hashes.
- Applied migrations cannot be edited or removed silently.
