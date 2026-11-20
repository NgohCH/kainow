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
npm run setup-invite -- you@example.org "Your Name"   # one-time setup link for the first Enterprise Administrator
# or, for a demonstration on an empty database: npm run seed-demo
npm run start:api             # GET /health
npm run start:worker
```

The API refuses to start unless these are set:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. `migrate` needs only this. |
| `AUTH_SECRET` | Random value of at least 32 characters, used to hash sign-in codes. Keep it out of the database and the repo. |
| `SMTP_URL` and `SMTP_FROM` | Sends sign-in codes by email, for example `smtp://user:password@mail.example.org:587` and `Kainow <no-reply@example.org>`. |
| `LOG_SIGN_IN_CODES=true` | Local development only: prints codes in the server log instead of emailing them. Ignored when `SMTP_URL` is set. |
| `APP_URL` | Optional. The address people open Kainow at, used for links in emails (default `http://localhost:3000`). The API and the worker both read it. |
| `COOKIE_SECURE=false` | Optional. The session cookie is Secure by default; turn it off only if a browser refuses it on plain `http://localhost`. |

The worker needs `DATABASE_URL` and a way to deliver email: `EMAIL_PROVIDER` (`smtp`, `m365` or `log`) with `EMAIL_FROM`, plus `SMTP_URL` for `smtp`, or `M365_TENANT_ID`, `M365_CLIENT_ID` and `M365_CLIENT_SECRET` for `m365`. For development only, `LOG_SIGN_IN_CODES=true` prints emails in the log instead. Set `APP_URL` for the worker as well, so the links in notification emails are right. It reads no AI key: AI keys are per project, stored encrypted with the protected key, and opened only for one attempt. It runs the notification sweep and the email dispatch once a minute.

## Tests

```
KAINOW_TEST_DATABASE_URL=postgres://.../kainow_test npm test
```

The test database is throwaway: the suite drops and recreates its `public` schema. Without `KAINOW_TEST_DATABASE_URL` the database tests skip and report as skipped, not passed.

## Dashboards and analytics (V1.0 sub-project 7)

Design: [`docs/superpowers/specs/2026-11-18-v1-dashboards-design.md`](../docs/superpowers/specs/2026-11-18-v1-dashboards-design.md); decisions D88 (On-time completion), D89 (leadership summary scopes) and D90 (access-setting bounds).

| Screen | Route | Who |
| --- | --- | --- |
| Home (personal dashboard) | `#/` | Any signed-in account |
| Projects | `#/projects` | Any signed-in account (own projects; the Administrator sees all) |
| Project Figures (Overview tab) and Timeline | `#/projects/<id>` and `#/projects/<id>/timeline` | Anyone with `project.view` |
| Leadership summary | `#/leadership` | Holder of an Active leadership grant; summary fields only, no project access |
| Leadership access (grants) | `#/leadership-grants` | Enterprise Administrator |
| Access and records (access settings) | `#/access-settings` | Enterprise Administrator (`organisation.manage`) |
| Administrator analytics | `#/admin/analytics` | Enterprise Administrator (`analytics.view`) |
| Analytics definitions (event catalogue) | `#/admin/analytics/definitions` | Enterprise Administrator (`analytics.view`) |
| Customise panel (button in the page header) | opens over any page | Any signed-in user: theme (light or dark) and accent (teal, blue, plum or slate), which Home sections and Leadership card fields show; presentation only |

**Access settings** (Enterprise Administrator, with a reason; each change is kept in an append-only history):

| Setting | Default | Bounds |
| --- | --- | --- |
| Automatic archive delay after closing | 12 months | 1 to 60 |
| Audit/Oversight default grant length | 30 days | 1 to 90, and not above the maximum |
| Audit/Oversight maximum length per grant or extension | 90 days | 1 to 365 |
| Project invitation validity | 7 days | 1 to 30 |
| Analytics export allowed | On | On or Off |

A change applies to invitations sent and grants requested or extended afterwards. Changing the archive delay shows, before saving, which Closed projects would be archived or unarchived.

**Bench.** `npm run bench-dashboards` times the dashboard and analytics requests against aims (spec section 14). It needs its own database whose name ends in `_bench`, migrated first:

```
DATABASE_URL=postgres://.../kainow_bench npm run migrate
DATABASE_URL=postgres://.../kainow_bench npm run bench-dashboards
```

`node dist/dashboards/bench-cli.js --seed-only` seeds a `_bench` or `_smoke` database and stops, for a browser smoke test. All seeded names are dummy and the e-mail addresses are at `@example.org`.

## Shared resources and optional budget (V1.0 sub-project 8)

Design: [`docs/superpowers/specs/2026-11-20-v1-resources-budget-design.md`](../docs/superpowers/specs/2026-11-20-v1-resources-budget-design.md); decisions D91 (resource lines and the overlap warning), D92 (recorded spending and approved adjustments), D93 (budget warnings) and D94 (finance settings and delegation).

| Screen | Route | Who |
| --- | --- | --- |
| Resources tab (lines, people, overlap warning, finance section) | `#/projects/<id>/resources` | Participants and Audit/Oversight holders read lines; the finance section needs finance read access; PM, Deputy, Owner and Sponsor maintain lines |
| Resources report | `#/projects/<id>/resources/report` | Same as the tab; the finance section only for finance readers |
| Project Settings > Finance | `#/projects/<id>/settings` | PM, Owner and Sponsor edit where delegated (read-only to Deputies); the Administrator always |
| System Settings > Resources and finance | `#/resources-admin` | Enterprise Administrator (delegation switch, default and enabled currencies, default warning thresholds, catalogue maintainers) |
| Resource catalogue (items and categories) | `#/resources-admin` (Administrator); `#/resource-catalogue` (named catalogue maintainers, menu item "Resource catalogue") | Enterprise Administrator and named catalogue maintainers |

Spending, budgets and adjustments need Financial Tracking Enabled on the project. Budgets, corrections and refunds go through the project's existing approval process; totals change only once approved, and spending in another currency stays out of totals until a conversion is approved. Warning thresholds are whole percentages 1 to 200, the first below the second (defaults 80 and 100); they are advisory.

**Bench.** `npm run bench-resources` times the Resources tab, finance, the Resources and finance analytics panel and the leadership summary against the aims in spec section 13. It uses its own database whose name ends in `_bench` or `_bench_sp8`, migrated first:

```
DATABASE_URL=postgres://.../kainow_bench_sp8 npm run migrate
DATABASE_URL=postgres://.../kainow_bench_sp8 npm run bench-resources
```

Result of the run on 20 November 2026 (p95, all four aims met): Resources tab with 100 lines 96.0 ms (aim 200; 36.4 ms after the final fix wave); finance with 1,000 entries 27.9 ms (aim 200); Resources and finance panel 79.5 ms (aim 500); leadership summary at organisation scope 489.4 ms (aim 500, little room; most of its time is sub-project 7's task measures; the two re-runs after the final fix wave read 561.7 and 540.6 ms, missed, with no change to its code path). The full table and the two fixes made after the first run are in the spec. All seeded names are dummy and the e-mail addresses are at `@example.org`.

## External outputs and storage (V1.0 sub-project 9)

Design: [`docs/superpowers/specs/2026-11-20-v1-external-outputs-design.md`](../docs/superpowers/specs/2026-11-20-v1-external-outputs-design.md); decisions D100–D108. The output register, generated Markdown/DOCX/PDF/CSV files, project CSV exports, filing in SharePoint or OneDrive with folder sharing kept in step with each output's readers, and the managed source area (every source version's original and text kept in SharePoint).

| Screen | Route | Who |
| --- | --- | --- |
| Project › Outputs (register, submit, register, file, approve, audience) | `#/projects/<id>/outputs` | Output readers; actions by role (Permission Matrix §5) |
| Project settings › Outputs (destination, formats, export roles) | from the project's settings | PM, Owner or Sponsor while delegated; otherwise the Enterprise Administrator |
| Storage (connection, destinations, storage Administrators, checks, manifest) | `#/storage` | Enterprise Administrator (`storage.manage`) |
| Report types | `#/report-types` | Enterprise Administrator |
| Access and records: "Project exports allowed" (Off by default) | `#/access-settings` | Enterprise Administrator |

**Storage settings** (System Settings › Storage, Enterprise Administrator, each change with a reason and kept in an append-only history):

| Setting | Default | Notes |
| --- | --- | --- |
| Tenant ID, application (client) ID, client secret | none | The secret is sealed with the protected key and never shown again; without the protected key it cannot be saved and storage work waits. "Check connection" records its result. |
| Directory lookup | Off | On needs `User.ReadBasic.All` as well and is checked by looking up the Administrator's own address; it allows OneDrive destinations. Off: Kainow shares only with addresses on the approved email domains. |
| Destinations | none | A SharePoint library (or, with lookup on, a person's OneDrive), for the source area (exactly one approved) or outputs. Approval needs a passing check, including a library limited to site owners. |
| Scheduled checks | Off | A daily check (02:30 UTC+8) of up to 2,000 output files and 2,000 source files. |
| Approved formats; projects may change formats, choose their destination, set export roles | all formats; On, On, On | |
| Storage Administrators | none | Direct write on the source area, never self-designated. |

Microsoft app registration and site permissions: see "Storage in SharePoint or OneDrive" in [`INSTALL.md`](../INSTALL.md).

**Development without a Microsoft tenant.** Set `KAINOW_LOCAL_STORAGE_DIR` to a folder (both the API and the worker) and Kainow can use the `local` connector, which keeps files under that folder and records its "grants" in a JSON sidecar. It is refused when `NODE_ENV=production` and is not offered in the Storage page's form: add a local destination as the Enterprise Administrator with `POST /admin/storage/destinations` and `{ "kind": "local", "purpose": "outputs" or "source_area", "label": ..., "reason": ... }`, then check and approve it on the Storage page. Every Kainow account counts as having an account there. Tests use it end to end.

**Probe.** `npm run probe-storage` checks a real tenant (the Product Owner runs it once a tenant exists; it is not run in CI). It needs the database with a saved storage connection and a destination added on the Storage page, and the protected key:

```
DATABASE_URL=... KAINOW_PROTECTED_KEY_FILE=... npm run probe-storage -- --destination "<label>" --test-account <person@your-domain> --granted fullcontrol
```

It works in its own `kainow-probe-<time>` folder, removes it permanently at the end and prints one line per check: token, destination, folder, small upload, chunked upload, hashes (Microsoft's QuickXorHash against Kainow's, which confirms the self-derived test vectors), move, invite and revoke (read and write, to the test account), unknown account (how Microsoft refuses an unknown address), library permissions (how site owners, site collection administrators or a OneDrive owner appear), permanent delete, write sufficed (`--granted` says which site permission the app holds: `write` or `fullcontrol`; every Kainow site is granted Full control unless a run with `--granted write` prints "write sufficed: ok") and the permissions needed. It never prints the client secret or a token. Exit code 0 when nothing failed.

**Bench.** `npm run bench-outputs` times the register list, the tasks export, share-sync, the restricted-folder move and the daily source check against the aims (spec section 15), the storage jobs against the fake Graph server with 50 ms added to every request. It seeds the sub-project 7 data set plus outputs and stored files into its own database, whose name must end in `_bench` or `_bench_<suffix>`, migrated first:

```
DATABASE_URL=postgres://.../kainow_bench_sp9 npm run migrate
DATABASE_URL=postgres://.../kainow_bench_sp9 npm run bench-outputs
```

It can be run again on the same database (each run adds fresh destinations and one 50-reader project). All seeded names are dummy and the e-mail addresses are at `@example.org`.

**Go-live checklist step 12, "Connect storage and approve the source area".** It ticks itself once the last "Check connection" succeeded and a source area is approved, or the Administrator skips it with a note; until it is done, source files stay in the database and are stored when a source area is approved.

## Operations: backups, restore drill and storage protection (V1.0 sub-project 10a)

Design: [`docs/superpowers/specs/2026-11-20-v1-operations-10a-design.md`](../docs/superpowers/specs/2026-11-20-v1-operations-10a-design.md); decisions D109 (backups), D110 (retention), D111 (status and failures), D112 (restore drill and restore), D113 (storage monitoring), D114 (protective read-only mode), D115 (routine diagnostics) and D116 (operations settings and authority). Operator steps are in [`INSTALL.md`](../INSTALL.md), "Backups" and "Restore from a backup". Code is in `src/ops/`, migration `0032_operations.sql`.

**The commands** run by the server's cron (not by the API or worker) in one-shot containers of the Compose service `ops`. The service has the profile `ops`, so `docker compose up` never starts it; run a command with `docker compose --profile ops run --rm ops node dist/ops/<name>-cli.js`. Exit codes: 0 succeeded, 1 refused or failed, 2 usage. Output is fixed text and never holds a key, secret, file content, connection string or host path.

| `npm run` (inside `app/`) | File | Options | What it does |
| --- | --- | --- | --- |
| `backup` | `dist/ops/backup-cli.js` | `--kind daily\|manual\|pre_update` (`manual` when omitted), `--new-key` | Dumps the database from one snapshot, encrypts it, writes a set under the backup folder, reads it back, records the run, then expires old sets. |
| `storage-check` | `dist/ops/storage-check-cli.js` | none | Records the database disk and backup disk readings, raises alerts, enters protective mode below the safe floor. |
| `restore-drill` | `dist/ops/restore-drill-cli.js` | `--set <name>\|latest`, `--keep`, `--sample <n>`, `--drop <kainow_drill_name>` | Restores a set into a temporary database and checks it; never touches the live database. |
| `restore` | `dist/ops/restore-cli.js` | `--set <name>\|latest`, `--reason "<why>"` | Restores into a new, empty installation only, then turns on protective mode and ends queued work. Run with only `db` started. |
| `backup-key` | `dist/ops/backup-key-cli.js` | `--create <path>` | Writes a new 32-byte backup key file (never over an existing one) and prints only the path and key id. |

`backup` and `restore-drill` share one advisory lock on the backup folder: a second run refuses at once with "Another backup or drill is running" and records nothing.

**Environment of the `ops` service** (`src/ops/config.ts`; error messages name a variable, never its value):

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Required. The database to back up, drill against or restore into. |
| `KAINOW_BACKUP_DIR` | Required in the container; Compose sets it to `/backups`. On the host, the same name in `.env` is the folder bound to `/backups`. |
| `KAINOW_BACKUP_DIR_LABEL` | Optional. What the Operations page shows for the folder: Compose sets it to the host path from `.env`. Falls back to `/backups`. |
| `KAINOW_BACKUP_KEY_FILE` | The backup key file (default `/run/secrets/kainow-backup.key`). Mounted read-only into `ops` only. |
| `KAINOW_DB_DATA_DIR` | Where the database volume is mounted read-only, to measure its disk (default `/pgdata`). |
| `KAINOW_PROTECTED_KEY_FILE` | Optional. The protected key, for opening sealed values in the drill and for backing up the source area once it is in use. |
| `KAINOW_TEST_PG_DOCKER` | Tests only: the name of a running PostgreSQL 16 container (for example `kainow-testdb`) whose `pg_dump` and `pg_restore` the tests use when those tools are not installed on the machine. |

**Build notes.**

- The `ops` image is the `runtime` stage plus the PostgreSQL 16 client tools (Debian bookworm's own client is version 15 and cannot dump a version 16 server). `x-kainow` in `compose.yaml` keeps `target: runtime` for the services that use it, and `ops` names `target: ops`. The `ops` stage follows `runtime` and is the last stage in the Dockerfile, so a build without `--target` would produce the `ops` image: always build through Compose.
- The backup folder is a long-syntax bind mount with `create_host_path: false` and no `:?` check on `KAINOW_BACKUP_DIR`, so a missing folder fails only the `ops` runs and no existing `docker compose` command.
- `pg_dump` and `pg_restore` have no timeout yet. A hung tool keeps the lock; the sweep marks a backup run interrupted after 6 hours but cannot stop the tool.
- Settings (Operations page and `PUT /admin/operations/settings`, Enterprise Administrator with `operations.manage`, with a reason and a history of previous and new values): backup retention 30 days (7 to 365), storage warning 80% (50 to 95), critical 90% (above the warning level, up to 99), safe floor 5 GB (1 to 1,000), diagnostic retention 30 days (7 to 365). pg-boss keeps its own archive for a fixed 7 days (pg-boss 12.38.1), whatever the diagnostic setting says.

| Screen or route | Who |
| --- | --- |
| Operations page `#/admin/operations`: status strip, backups ("Backup size (encrypted)" is the encrypted dump's size), drills, storage, protective mode with **Resume normal use**, settings | Enterprise Administrator (`operations.view` to read, `operations.manage` to change or resume) |
| `GET admin/operations`, `GET`/`PUT admin/operations/settings`, `GET admin/operations/resume-checks`, `POST admin/operations/resume` | As above; `resume` is the only unsafe route allowed while protective mode is on, besides sign-in and sign-out |
| `GET operations/banner` | Any signed-in person (protective mode text for everyone; backup and storage warnings for Enterprise Administrators only) |
| `GET operations/public-state` | Public, for the sign-in page banner |
| Administrator analytics panel `operations` (`#/admin/analytics`) | Enterprise Administrator (`analytics.view`); growth follows the chosen period |

While protective mode is on, the API refuses every request that is not `GET`, `HEAD` or `OPTIONS` (except the allowed list above) with status 503 and `{ code: 'protective_read_only' }`, and the worker's queue handlers and ticks do nothing except sending email.

**Tests.** `npm run build`, then `node --test --test-concurrency=1 dist/ops/<file>.test.js` with `KAINOW_TEST_DATABASE_URL` set to a throwaway database (for example `postgres://postgres:test@127.0.0.1:15432/kainow_test_sp10`). Tool tests need `pg_dump` and `pg_restore` 16, either installed or through `KAINOW_TEST_PG_DOCKER`; without them they skip with a stated reason. Web tests: `npm --prefix web test`.

**Not covered yet.** The low-space check on a real Linux disk (`docs/operations/verify-low-space.md`: written, **not yet run**); a cron-driven week on a Linux VM; backing up protected source files, the `source_area` reading and `restore-source-files`, which arrive when sub-project 9 is joined (until then the drill reports `sealed_storage_secret` as Not tested); the updater and the pre-update hook's caller (sub-project 10b, which uses `backup --kind pre_update` and `freshBackup`).

## Milestones

| # | Milestone | Status |
| --- | --- | --- |
| M1 | Foundation: API and worker entry points, config, SQL migrations with checksums, identity and append-only audit schema, health check, durable AI/email/document queues | Done, tested on PostgreSQL 16 |
| M2 | Passwordless sign-in and permissions: one-time codes (10 min, 5 attempts, 30 min lockout), 12-hour sessions, Enterprise Administrator, default-deny permission checks with allowed and denied tests for every action | Done, tested on PostgreSQL 16 |
| M3 | Notes intake: paste, TXT, Markdown, DOCX, selectable-text PDF; NFC normalisation; source versions and character offsets | Done, tested on PostgreSQL 16 |
| M4a | AI spend cap: MYR 20 monthly cap, reserve before each call, settle from reported usage, uncertain charges stay counted, UTC+8 periods, administrator settings and view | Done, tested on PostgreSQL 16 |
| M4b | AI extraction: pg-boss job, OpenAI adapter with the pinned model ID, quote-to-offset location, token usage records, credential pattern check before sending. It calls the spend cap above before every request | Built and tested with a stand-in model. The extraction check script has run against the real `gpt-6.1-sol` on the Product Owner's computer (see the review record in `docs/`). **The app's own adapter has not**: the sandbox cannot reach the API |
| M5 | Review screen (React): source-linked proposals, approve and reject bound to the exact source version | Built and checked in a real browser; not yet tested by a person on the Product Owner's machine |
| M6 | Docker Compose package and local install, built and tested on the Product Owner's computer (Docker Hub is unreachable from the sandbox) | Written and checked as far as the sandbox allows (see `../INSTALL.md`). **Never built with Docker.** |

## Answered by the Product Owner (7 November 2026)

Recorded in [`docs/MVP-DECISIONS.md`](../docs/MVP-DECISIONS.md): sign-in codes go out by a small email sender, the model is `gpt-6.1-sol`, prices are $2.00 input, $0.10 cached input and $10.00 output in USD at 4.1 MYR to the dollar, and originals are stored in PostgreSQL.

The four follow-up points were confirmed the same day: prices are per 1 million tokens, the `gpt-6.1-sol` column is the one used, `gpt-6-luna` is dropped, and the monthly cap resets at the start of the calendar month in UTC+8.

## Open questions for the Product Owner

None at the moment.

## AI spend cap

Run `npm run apply-mvp-spend-settings` after `npm run migrate` to save the organisation values approved in [`docs/MVP-DECISIONS.md`](../docs/MVP-DECISIONS.md): 1 USD = 4.1 MYR, MYR 20 a month, no daily cap. Models and their prices are no longer in these settings: the Administrator approves each model (identifier, USD prices per million tokens, such as 2.00 / 0.10 / 10.00 for `gpt-6.1-sol`, and data terms) on the AI screen, and each project then adds a connection with its own key and sets its limits (V1.0 sub-project 6; see INSTALL.md, "Set up AI"). Until settings are saved, every AI request is blocked. The command saves only when no settings exist, so running it again never resets what an Administrator changed since. An administrator can view and change them with `GET /ai/spend` and `PUT /ai/spend-settings` (with a `reason`); each change is written to the audit trail with the previous and new values and the reason.

How a request is paid for (code in `src/spend/`, to be called by the extraction job in M4b):

1. **Estimate a ceiling.** A token is at least one byte, so the prompt's size in bytes bounds its tokens. The estimate adds a margin for message framing, prices every input token as uncached, and assumes the whole `max output tokens` is used. The request must carry that maximum: without it the cost cannot be bounded and the request must not be sent.
2. **Reserve.** Reservations take a database lock, so requests made at the same moment cannot each see the same headroom. The reservation is refused if it does not fit under every applicable limit (a reservation equal to what is left is allowed). A blank or zero limit allows nothing.
3. **Settle.** The reservation is replaced by the cost of the usage the provider reports, priced at the rates in force when it was reserved. Settling twice counts once. A real cost above the estimate is recorded in full and flagged, never trimmed.
4. **If the outcome is unknown** (timeout, lost connection, crash), mark it uncertain. The full estimate keeps counting until the real usage or evidence of no charge arrives. Only a request that was never sent can be released at once.

Every attempt, including a retry or a fallback, is its own entry and counts. Entries are never deleted. Amounts are whole micro-MYR (1 MYR = 1,000,000), with no floating point, and costs are rounded up.

**Reservations are deliberately larger than the likely cost.** A 50,000-byte note with up to 8,000 output tokens reserves MYR 0.74, but the example extraction of 10,000 input and 2,000 output tokens costs MYR 0.164. The extra is held only while the request runs. Near the end of the month a long note may be refused even though its real cost would have fit; that is the price of never overspending.

The extraction job (below) calls all of this. An optional monthly limit for each person (`userMonthly`) is checked in the same locked step; leaving it out means no personal limit, while a blank or zero value means no allowance. It is monthly only; there is no per-person daily cap.

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
4. Sends the request through the project's first eligible AI connection (a model the Administrator approved and that project's own key; see INSTALL.md, "Set up AI"), falling back to the next connection on an outage, and settles from the reported usage.
5. Saves the proposals. For each one it looks for the model's quote in the stored text and keeps the character offsets of the first match, plus how many places it matches.

**Quotes are never trusted.** A quote that is found nowhere is still kept and shown as unlocated (`quoteMatches: 0`, no offsets), so a reviewer sees the model made it up and can reject it; the run reports `unlocatedCount`. A quote that occurs more than once is flagged (`quoteMatches > 1`) because we cannot know which place the model meant. The reviewer says which place (`chosenOccurrence`), and `GET /extractions/:runId` lists the places (`occurrences`) for such quotes. Review screen (M5) must show both clearly.

**Retries and limits.** Each request is tried at most 3 times in all, 30 seconds apart and growing. Every attempt is reserved and recorded separately, so retries cost money and count against the cap. At most 2 AI requests run at once (A05), counted per worker process: run one worker.

**Rejected versus unknown (confirmed by the Product Owner, 7 November 2026).** An HTTP 4xx answer from OpenAI (a refused key, a bad request, "slow down") is treated as proof nothing was charged, and the reservation is given back, because the provider answered with an error before doing any work. A timeout, a lost connection, a 5xx answer or an answer without usage is an unknown outcome and the full estimate stays counted.

**An unusable answer is still paid for.** If the model answers with broken JSON, a malformed item, a refusal, or is cut off at the 8,000-token limit, the usage it reported is charged and the attempt counts as failed.

**The adapter is not yet verified against the real API.** The standalone check `tests/extraction/run.mjs` has run against `gpt-6.1-sol` on the Product Owner's computer (7 November 2026): the model answered, and all quotes were verbatim. The adapter makes the same call but adds `max_completion_tokens` so cost can be bounded, and it has not run against `gpt-6.1-sol`. Run `tests/extraction` on your computer with `OPENAI_API_KEY` set, and `npm run probe-ai` with `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY` with `--provider anthropic`) set in your own shell, before relying on it. The worker reads no key from its environment: without an approved model and a ready project connection, a run ends `ai_not_set_up` or `no_eligible_connection` and nothing is sent or charged.

## Review screen

Code in `web/` (React and Vite, bundled fonts, nothing loaded from the internet). `npm run build:web` builds it and the API serves it at `/`; for development `npm run dev` inside `web/` proxies `/api` to the API on port 3000. It has sign-in by emailed code, notes list and intake (paste or upload), a note page with its versions and extraction runs, and the review screen.

**On the review screen** the notes sit on the left with every proposed passage highlighted, and the proposals on the right. Selecting a proposal (click, or j and k) scrolls to and strongly marks its passage; clicking a passage selects its proposal. Approved passages turn teal, rejected ones fade. `a` approves and `r` rejects the proposal in focus.

**Rules the screen and the API both enforce:** a decision is bound to the exact version the reviewer was looking at (the screen sends it, the API refuses a mismatch). A quote that is not in the notes is shown with a warning and cannot be approved. A quote that appears more than once lists every place it occurs (with a few words of the notes around each), and Approve stays off until the reviewer chooses one; the chosen place is the one highlighted, and it is saved with the approval (`occurrence`, 0-based, in the approval's audit entry too). Only the first 100 places of a quote that repeats very often are listed. Approving again with another choice moves it. Rejecting forgets the choice. Every decision is audited, including a change of mind.

**Administrator screens.** *People* lists everyone, adds an administrator, disables one and enables a disabled one again (`POST /users/:id/enable`; their old sessions and codes stay revoked, so they sign in afresh, and the change is audited as `user.enabled`); it warns while fewer than two are active, and the last active administrator cannot be disabled (the API refuses). *AI* (`#/ai`) has three tabs: approved models (provider, prices, data terms, kinds of work, restricted approval, withdraw and approve again), limits and policy (exchange rate, monthly, daily and per-person limits, project ceiling, attempts, timeout, requests at once, and the two delegation switches), and usage (Confirmed, Uncertain and Reserved amounts by project, person and connection). A blank monthly limit is saved as no allowance and the form says so; "no daily cap" is an explicit choice. Every change is audited.

**Editing wording.** *Edit wording* on a proposal changes its text, owner and due (`POST /extractions/:runId/items/:itemId/edit`, same permission as reviewing). The model's own wording is never overwritten: each edit is a new row in `extraction_item_edits` (append-only in the database), the latest is in force, and the screen shows what the model said beside it (`edited`, `original`). The quoted passage and its place do not change. Saving sends a decided proposal back to review, so an approval always refers to the wording the reviewer saw. The audit entry (`proposal.edited`) names the fields changed and the earlier status, not the wording. Limits: text 2,000 characters, owner and due 200. A blank owner or due clears it, and an edit that changes nothing is refused with 409.

**Not in the MVP screens:** changing a proposal's kind or its quoted passage. The responsive layout stacks the notes above the proposals on a phone, which works but is not tuned. Safari and Firefox are deferred to January.

## Sign-in design notes

These are design choices made under R05. They are not accepted product policy, so please say if any should change.

- **Same answer either way.** Asking for a code, or giving a wrong code, answers the same whether or not the address has an account, so the endpoints cannot be used to find out who has one.
- **Wrong codes are counted per account, not per code.** Otherwise asking for a new code would give fresh guesses. Five wrong codes lock the account for 30 minutes. The count clears on a successful sign-in.
- **Trade-off in that accepted policy:** anyone who knows the administrator's address can lock them out for 30 minutes with five wrong guesses. With one administrator and no second person to recover access, that matters. A short delay between codes would not fix it; a second administrator would help.
- **At most one code a minute per account** (`codeResendSeconds`, 60). This is a design detail, not an accepted default.
- **A newer code replaces the earlier unused one.**
- **The last active administrator cannot be disabled,** so access cannot be lost by accident. Users are disabled, never deleted.
- **Every route must declare how it is protected** (`@Public`, `@AnySignedInUser` or `@RequireAction`). A route that declares nothing is refused. The only public routes are `/health`, `/auth/request-code` and `/auth/verify`.
- **Anti-forgery token.** Every request other than GET/HEAD/OPTIONS from a signed-in person must carry an `X-CSRF-Token` header. The token is an HMAC of the session id under the server secret, returned by `/auth/verify` and `/auth/me`; the web app sends it automatically. The session cookie is also `SameSite=Lax`. The two public sign-in POSTs (request code, verify) are not covered, because no session exists yet.
- Failed permission checks are not yet written to the audit trail. With a single role they cannot occur for a signed-in person, so this waits for more roles.

## Decisions already fixed in code

- Identifiers are UUIDv7; timestamps are stored in UTC.
- Users are disabled, never deleted. `audit_events` rejects update, delete and truncate in the database itself.
- Sign-in codes and session tokens are stored only as hashes.
- Applied migrations cannot be edited or removed silently.
