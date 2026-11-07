# Kainow app (December 2026 MVP)

The MVP application: a NestJS API and a pg-boss worker on one PostgreSQL 16 database, in one repository (decision R01). It implements the scope in [`docs/MVP-DECISIONS.md`](../docs/MVP-DECISIONS.md), a working vertical slice and not the full V1.0 release. `technical-baseline/` stays as the earlier library spike and is not product code.

## Run locally

```
cd app
npm install
cp .env.example .env          # then fill in the values (see below)
npm run build
npm run migrate
npm run create-admin -- you@example.org "Your Name"   # the first Enterprise Administrator
npm run start:api             # GET /health
npm run start:worker
```

The API refuses to start unless these are set:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. The worker and `migrate` need only this. |
| `AUTH_SECRET` | Random value of at least 32 characters, used to hash sign-in codes. Keep it out of the database and the repo. |
| `SMTP_URL` and `SMTP_FROM` | Sends sign-in codes by email, for example `smtp://user:password@mail.example.org:587` and `Kainow <no-reply@example.org>`. |
| `LOG_SIGN_IN_CODES=true` | Local development only: prints codes in the server log instead of emailing them. Ignored when `SMTP_URL` is set. |
| `COOKIE_SECURE=false` | Optional. The session cookie is Secure by default; turn it off only if a browser refuses it on plain `http://localhost`. |

## Tests

```
KAINOW_TEST_DATABASE_URL=postgres://.../kainow_test npm test
```

The test database is throwaway: the suite drops and recreates its `public` schema. Without `KAINOW_TEST_DATABASE_URL` the database tests skip and report as skipped, not passed.

## Milestones

| # | Milestone | Status |
| --- | --- | --- |
| M1 | Foundation: API and worker entry points, config, SQL migrations with checksums, identity and append-only audit schema, health check, durable AI/email/document queues | Done, tested on PostgreSQL 16 |
| M2 | Passwordless sign-in and permissions: one-time codes (10 min, 5 attempts, 30 min lockout), 12-hour sessions, Enterprise Administrator, default-deny permission checks with allowed and denied tests for every action | Done, tested on PostgreSQL 16 |
| M3 | Notes intake: paste, TXT, Markdown, DOCX, selectable-text PDF; NFC normalisation; source versions and character offsets | Not started |
| M4 | AI extraction: pg-boss job, OpenAI adapter with pinned model ID, quote-to-offset location, token usage records, credential pattern check before sending, MYR 20 monthly cap with reserve-before-call | Needs open questions 2 and 3 |
| M5 | Review screen (React): source-linked proposals, approve and reject bound to the exact source version | Not started |
| M6 | Docker Compose package and local install, built and tested on the Product Owner's computer (Docker Hub is unreachable from the sandbox) | Not started |

## Answered by the Product Owner (7 November 2026)

Recorded in [`docs/MVP-DECISIONS.md`](../docs/MVP-DECISIONS.md): sign-in codes go out by a small email sender, the model is `gpt-6.1-sol`, prices are $2.00 input, $0.10 cached input and $10.00 output in USD at 4.1 MYR to the dollar, and originals are stored in PostgreSQL.

## Open questions for the Product Owner

1. Are the quoted prices per 1 million tokens? Only the Batch/Flex rates gave a unit.
2. The `gpt-6.1-sol` column of the price table was used, not the "GPT-6 Sol" column. Correct?
3. "Drop gpt-6.1-luna" was read as dropping `gpt-6-luna`. Correct?
4. Is the monthly cap reset boundary the calendar month in UTC+8?

## Sign-in design notes

These are design choices made under R05. They are not accepted product policy, so please say if any should change.

- **Same answer either way.** Asking for a code, or giving a wrong code, answers the same whether or not the address has an account, so the endpoints cannot be used to find out who has one.
- **Wrong codes are counted per account, not per code.** Otherwise asking for a new code would give fresh guesses. Five wrong codes lock the account for 30 minutes. The count clears on a successful sign-in.
- **Trade-off in that accepted policy:** anyone who knows the administrator's address can lock them out for 30 minutes with five wrong guesses. With one administrator and no second person to recover access, that matters. A short delay between codes would not fix it; a second administrator would help.
- **At most one code a minute per account** (`codeResendSeconds`, 60). This is a design detail, not an accepted default.
- **A newer code replaces the earlier unused one.**
- **The last active administrator cannot be disabled,** so access cannot be lost by accident. Users are disabled, never deleted.
- **Every route must declare how it is protected** (`@Public`, `@AnySignedInUser` or `@RequireAction`). A route that declares nothing is refused. The only public routes are `/health`, `/auth/request-code` and `/auth/verify`.
- **No CSRF token yet.** The session cookie is `SameSite=Lax` and the API accepts only JSON. Add a token before any form-style endpoint is exposed.
- Failed permission checks are not yet written to the audit trail. With a single role they cannot occur for a signed-in person, so this waits for more roles.

## Decisions already fixed in code

- Identifiers are UUIDv7; timestamps are stored in UTC.
- Users are disabled, never deleted. `audit_events` rejects update, delete and truncate in the database itself.
- Sign-in codes and session tokens are stored only as hashes.
- Applied migrations cannot be edited or removed silently.
