# Kainow app (December 2026 MVP)

The MVP application: a NestJS API and a pg-boss worker on one PostgreSQL 16 database, in one repository (decision R01). It implements the scope in [`docs/MVP-DECISIONS.md`](../docs/MVP-DECISIONS.md), a working vertical slice and not the full V1.0 release. `technical-baseline/` stays as the earlier library spike and is not product code.

## Run locally

```
cd app
npm install
cp .env.example .env          # then fill in the values (see below)
npm run build
npm run build:web        # the review screen; the API serves it at /
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
| M3 | Notes intake: paste, TXT, Markdown, DOCX, selectable-text PDF; NFC normalisation; source versions and character offsets | Done, tested on PostgreSQL 16 |
| M4a | AI spend cap: MYR 20 monthly cap, reserve before each call, settle from reported usage, uncertain charges stay counted, UTC+8 periods, administrator settings and view | Done, tested on PostgreSQL 16 |
| M4b | AI extraction: pg-boss job, OpenAI adapter with the pinned model ID, quote-to-offset location, token usage records, credential pattern check before sending. It calls the spend cap above before every request | Built and tested with a stand-in model. **Not yet run against the real API** (the sandbox cannot reach it) |
| M5 | Review screen (React): source-linked proposals, approve and reject bound to the exact source version | Built and checked in a real browser; not yet tested by a person on the Product Owner's machine |
| M6 | Docker Compose package and local install, built and tested on the Product Owner's computer (Docker Hub is unreachable from the sandbox) | Written and checked as far as the sandbox allows (see `../INSTALL.md`). **Never built with Docker.** |

## Answered by the Product Owner (7 November 2026)

Recorded in [`docs/MVP-DECISIONS.md`](../docs/MVP-DECISIONS.md): sign-in codes go out by a small email sender, the model is `gpt-6.1-sol`, prices are $2.00 input, $0.10 cached input and $10.00 output in USD at 4.1 MYR to the dollar, and originals are stored in PostgreSQL.

The four follow-up points were confirmed the same day: prices are per 1 million tokens, the `gpt-6.1-sol` column is the one used, `gpt-6-luna` is dropped, and the monthly cap resets at the start of the calendar month in UTC+8.

## Open questions for the Product Owner

None at the moment.

## AI spend cap

Run `npm run apply-mvp-spend-settings` once after `npm run migrate` to save the values approved in [`docs/MVP-DECISIONS.md`](../docs/MVP-DECISIONS.md): `gpt-6.1-sol`, USD 2.00 / 0.10 / 10.00 per million tokens (input / cached input / output), 1 USD = 4.1 MYR, MYR 20 a month, no daily cap. Until settings are saved, every AI request is blocked. An administrator can view and change them with `GET /ai/spend` and `PUT /ai/spend-settings`; each change is written to the audit trail with the new values.

How a request is paid for (code in `src/spend/`, to be called by the extraction job in M4b):

1. **Estimate a ceiling.** A token is at least one byte, so the prompt's size in bytes bounds its tokens. The estimate adds a margin for message framing, prices every input token as uncached, and assumes the whole `max output tokens` is used. The request must carry that maximum: without it the cost cannot be bounded and the request must not be sent.
2. **Reserve.** Reservations take a database lock, so requests made at the same moment cannot each see the same headroom. The reservation is refused if it does not fit under every applicable limit (a reservation equal to what is left is allowed). A blank or zero limit allows nothing.
3. **Settle.** The reservation is replaced by the cost of the usage the provider reports, priced at the rates in force when it was reserved. Settling twice counts once. A real cost above the estimate is recorded in full and flagged, never trimmed.
4. **If the outcome is unknown** (timeout, lost connection, crash), mark it uncertain. The full estimate keeps counting until the real usage or evidence of no charge arrives. Only a request that was never sent can be released at once.

Every attempt, including a retry or a fallback, is its own entry and counts. Entries are never deleted. Amounts are whole micro-MYR (1 MYR = 1,000,000), with no floating point, and costs are rounded up.

**Reservations are deliberately larger than the likely cost.** A 50,000-byte note with up to 8,000 output tokens reserves MYR 0.74, but the example extraction of 10,000 input and 2,000 output tokens costs MYR 0.164. The extra is held only while the request runs. Near the end of the month a long note may be refused even though its real cost would have fit; that is the price of never overspending.

The extraction job (below) calls all of this. Not covered yet: the per-user limit.

## Notes intake

Code in `src/notes/`. Needs the `note.import` action to add notes and `note.view` to read them.

| Route | Does |
| --- | --- |
| `POST /notes` | Paste: `{ "title", "text" }`. Makes a source and its version 1. |
| `POST /notes/upload` | Multipart with `file` and an optional `title` (the file name is the default title). |
| `POST /notes/:id/versions` and `/versions/upload` | A new version by paste or by file. |
| `GET /notes`, `GET /notes/:id` | List, and one source with its versions (no text). |
| `GET /notes/:id/versions/:n` | One version with its text. |
| `GET /notes/:id/versions/:n/original` | The uploaded file exactly as received, always as a download. |

**Text contract (R02).** Stored text is Unicode NFC with LF line ends; a leading BOM is dropped. Quote positions are **UTF-16 code units** (the index into the JavaScript string), end exclusive, counted in the stored text and never in the original file. `locateQuote` in `src/notes/text.ts` returns every place a quote occurs, each with an occurrence number, so a repeated quote is not ambiguous. An emoji counts as two.

**Versions are immutable.** A change is a new version. Identical text is refused with 409. The database itself rejects update, delete and truncate of versions, and deleting a source. Originals (for uploads) are kept in PostgreSQL next to the text.

**Safety checks on files.** The extension must be .txt, .md, .docx or .pdf and the content must match it. Text must be valid UTF-8 with no NUL bytes. A Word file's ZIP directory is inspected before anything is unpacked (no ZIP64, no encryption, at most 2,000 parts, at most 100 MiB declared in total). PDFs with a password, more than 300 pages, or no selectable text (scans) are refused with a plain reason. Nothing is written to disk. The audit trail records the file name, sizes and hashes, never the text.

**Limits I chose** (technical defaults, not product policy, in `src/notes/text.ts` and `readers.ts`): upload 10 MiB, text 500,000 characters, JSON body 4 MB.

**Not covered yet.** Scanned PDFs need OCR (not in the MVP). Tables in Word documents come out as one cell per paragraph. Any note is visible to anyone with `note.view`; with one role that is every signed-in person.

## AI extraction

Code in `src/extraction/` and `src/worker/`. `POST /notes/:id/versions/:n/extractions` (needs `extraction.run`) records a queued run for that exact version and answers 202 at once. The worker picks it up, and `GET /extractions/:runId` (or the list at `GET /notes/:id/versions/:n/extractions`) shows its state and, when finished, its proposals. Only one run per version can be waiting or running, so a double click cannot pay twice.

**What the worker does with each run, in order:**

1. Checks the person who asked is still active and still allowed (A11).
2. Looks for credentials in the text (O01): private keys, AWS, `sk-`, GitHub, Slack and Google keys, JSON web tokens, bearer tokens, `password: ...` style assignments and passwords inside web addresses. If it finds any the run is **blocked and nothing is sent**; the message names the kind and count, never the secret. This is a basic safety net, not a guarantee.
3. Reserves the worst-case cost under the spend cap. If that is refused (blank or zero limit, no approved settings, or not enough left) the run is blocked and nothing is sent.
4. Sends the request to `gpt-6.1-sol` (the model saved in the spend settings) and settles from the reported usage.
5. Saves the proposals. For each one it looks for the model's quote in the stored text and keeps the character offsets of the first match, plus how many places it matches.

**Quotes are never trusted.** A quote that is found nowhere is still kept and shown as unlocated (`quoteMatches: 0`, no offsets), so a reviewer sees the model made it up and can reject it; the run reports `unlocatedCount`. A quote that occurs more than once is flagged (`quoteMatches > 1`) because we cannot know which place the model meant. Review screen (M5) must show both clearly.

**Retries and limits.** Each request is tried at most 3 times in all, 30 seconds apart and growing. Every attempt is reserved and recorded separately, so retries cost money and count against the cap. At most 2 AI requests run at once (A05), counted per worker process: run one worker.

**Rejected versus unknown (confirmed by the Product Owner, 7 November 2026).** An HTTP 4xx answer from OpenAI (a refused key, a bad request, "slow down") is treated as proof nothing was charged, and the reservation is given back, because the provider answered with an error before doing any work. A timeout, a lost connection, a 5xx answer or an answer without usage is an unknown outcome and the full estimate stays counted.

**An unusable answer is still paid for.** If the model answers with broken JSON, a malformed item, a refusal, or is cut off at the 8,000-token limit, the usage it reported is charged and the attempt counts as failed.

**Not yet verified against the real API.** The adapter follows the same call as `tests/extraction/run.mjs`, but with `max_completion_tokens` added so cost can be bounded. Neither has run against `gpt-6.1-sol` from here. Run `tests/extraction` on your computer with `OPENAI_API_KEY` set, then start the worker with the same key, before relying on it. The worker needs `OPENAI_API_KEY`; without it runs fail with `model_not_configured` and nothing is sent or charged.

## Review screen

Code in `web/` (React and Vite, bundled fonts, nothing loaded from the internet). `npm run build:web` builds it and the API serves it at `/`; for development `npm run dev` inside `web/` proxies `/api` to the API on port 3000. It has sign-in by emailed code, notes list and intake (paste or upload), a note page with its versions and extraction runs, and the review screen.

**On the review screen** the notes sit on the left with every proposed passage highlighted, and the proposals on the right. Selecting a proposal (click, or j and k) scrolls to and strongly marks its passage; clicking a passage selects its proposal. Approved passages turn teal, rejected ones fade. `a` approves and `r` rejects the proposal in focus.

**Rules the screen and the API both enforce:** a decision is bound to the exact version the reviewer was looking at (the screen sends it, the API refuses a mismatch). A quote that is not in the notes is shown with a warning and cannot be approved. A quote that appears more than once shows how many times, highlights the first, and needs a tick ("I checked this is the passage meant") before Approve is enabled. Every decision is audited, including a change of mind.

**Administrator screens.** *People* lists everyone, adds an administrator and disables one; it warns while fewer than two are active, and the last active administrator cannot be disabled (the API refuses). *AI spending* shows this month's and today's figures (used, held for requests in progress, counted while an outcome is unknown, left) and edits the model, prices, exchange rate and limits. A blank monthly limit is saved as no allowance and the form says so; "no daily cap" is an explicit choice. Every change is audited.

**Not in the MVP screens:** editing a proposal's wording, choosing which of several repeated passages was meant, and re-enabling a disabled person. The responsive layout stacks the notes above the proposals on a phone, which works but is not tuned. Safari and Firefox are deferred to January.

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
