# Go-live checklist and go-live database — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Go live on a new empty database prepared by `npm run golive-init`, with no notices for anything before go-live, and walk the Enterprise Administrator through an 11-step checklist that closes itself when real people work in a real project.

**Architecture:** Migration `0021_golive.sql` adds `notification_settings.notices_from` and three checklist tables (steps seeded by the migration). A pure-ish module `app/src/golive/checklist.ts` evaluates the automatic steps and the closing rule against the database; the API (`golive.controller.ts`) and the worker's sweep both call the same `refreshChecklist(db, now)`. The sweep drops planned triggers whose fire time is before `notices_from`. A CLI `golive-init` refuses non-empty databases, migrates, sets the cutoff and issues the setup invitation through the existing `SetupService`. The web adds a banner on My Projects and a `#/go-live` page.

**Tech Stack:** TypeScript, NestJS 12, PostgreSQL 16, React + Vite, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-v1-golive-checklist-design.md`

## Global Constraints

- Step keys and order exactly: `organisation, logos, second_admin, recovery, mailbox, test_email, calendar, backups, department, users, project` (positions 1–11). Auto: organisation, logos (or Confirm as skipped), second_admin, department, users, project. Confirm: recovery, mailbox, test_email (only after a test email reached `sent`), calendar, backups.
- Shown step text exactly as the spec §4 table; page heading `Go-live checklist`; banner `Go-live: <n> of 11 steps done`; closed text `Closed on <date>`; section `Not done at close`; settings line `Notices start from <Ddd D Mmm YYYY>, <HH:MM> (UTC+8)`; CLI final line `Open the link in the email to start the go-live checklist.`; CLI refusal `This database already holds users or projects. golive-init only prepares a new, empty database.`
- Closing rule: department + users + project done → `closed_at` set once; afterwards no tick/untick (409 `The go-live checklist is closed.`).
- "users" counts accounts with `status='active'` and `role <> 'enterprise_administrator'`; "project" = any project with status `active` now or a `project_transitions` row with `to_status='active'`; "department" = any department row; "second_admin" = 2+ Active Enterprise Administrators; "organisation" = organisation registered (`organisation.registered_at IS NOT NULL`); "logos" = any `organisation_logos` row.
- Only Active Enterprise Administrators see or change the checklist; everyone else 404.
- Notes ≤ 200 characters. Automatic ticks record `ticked_by = NULL` (shown "Kainow"); automatic steps are never unticked.
- `golive-init` never deletes anything. Injected clock everywhere in services; CLIs use real time.
- Test accounts only (`*@example.org`, `*@example.com`, `*@example.net`, `*@kainow.test`); no real organisation names. DB tests one file at a time with `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kainow_test`.

## Review Focus

1. **The sweep with `notices_from` null** (every database not made by golive-init, including all existing tests) must behave exactly as before (Task 2 test).
2. **An Administrator who is also a project Member** must not make step 10 true by themselves — only non-Administrator accounts count (Task 3).
3. **A test email that failed or is still queued** must not enable step 6 (Task 3).
4. **`golive-init` run twice** on the same database: the second run is refused because the first created a user (Task 4).
5. **A project that went Active then was Deferred before the check ran** still satisfies step 11 via `project_transitions` (Task 3).

---

### Task 1: Migration

**Files:** Create `app/migrations/0021_golive.sql`; modify `app/src/db/migrate.test.ts` (`REAL_FILES` gains it); test `app/src/db/golive-schema.test.ts`.

**Interfaces — produces:** `notification_settings.notices_from timestamptz NULL`; `golive_steps (key text PK, position smallint UNIQUE, ticked_by uuid NULL REFERENCES users, ticked_at timestamptz NULL, note text NULL CHECK (char_length(note) <= 200), skipped boolean NOT NULL DEFAULT false)` seeded with the 11 keys; `golive_checklist (id smallint PK CHECK (id = 1), closed_at timestamptz NULL)` seeded with one row; `golive_events (id uuid PK, step_key text NULL REFERENCES golive_steps, action text CHECK IN ('ticked','unticked','closed'), actor_id uuid NULL REFERENCES users, note text NULL, at timestamptz NOT NULL)` append-only via `kainow_append_only()`.

- [ ] **Step 1:** failing tests: 11 steps seeded in order with the exact keys; one checklist row with `closed_at` null; note longer than 200 rejected; `golive_events` UPDATE raises; `notices_from` column exists and is null.
- [ ] **Step 2:** run `cd app && npm run build && node --test dist/db/golive-schema.test.js` → FAIL.
- [ ] **Step 3:** write the migration.
- [ ] **Step 4:** run it and `dist/db/migrate.test.js` → PASS.
- [ ] **Step 5:** commit `Add go-live checklist tables and the notices start time`.

### Task 2: Notices start time in the sweep and settings

**Files:** modify `app/src/notifications/settings.ts` (OrgRow gains `noticesFrom: Date | null`; `loadEffective`/`loadEffectiveMany` expose it), `app/src/notifications/sweep.ts` (drop planned triggers with `fireAt < noticesFrom` before recording — they are neither fired nor recorded; also skip resumption/unavailable triggers whose time is before it), `app/src/notifications/settings.service.ts` (organisation view returns `noticesFrom`); web `app/web/src/views/NotificationSettings.tsx` (read-only line when set). Tests: `sweep.test.ts`, `settings.http.test.ts`.

- [ ] **Step 1:** failing tests: with `notices_from` = Tue 10 Nov 2026 09:30 UTC+8, a reminder due Mon 9 Nov 09:00 is neither fired nor in `notification_triggers`, and one due Wed 11 Nov 09:00 fires; with `notices_from` null the existing sweep tests are unchanged (Review Focus 1); organisation settings GET returns `noticesFrom` and PUT cannot change it (unknown field → 400 as other unknown fields).
- [ ] **Step 2:** run `dist/notifications/sweep.test.js` then `dist/notifications/settings.http.test.js` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run both, plus `dist/digests/digest.test.js` → PASS; `npm --prefix web test` and `npm run build:web` pass.
- [ ] **Step 5:** commit `Start notices from the go-live time`.

### Task 3: Checklist service, API and automatic ticks

**Files:** create `app/src/golive/checklist.ts`, `golive.service.ts`, `golive.controller.ts`, `golive.module.ts` (register in `app.module.ts`); modify `app/src/notifications/sweep.ts` (call `refreshChecklist` once per run, failures logged with a fixed message); test `app/src/golive/golive.http.test.ts`.

**Interfaces — produces:**
- `refreshChecklist(db, now: Date): Promise<void>` — in one transaction (`FOR UPDATE` on the checklist row): tick every automatic step whose condition (Global Constraints) holds and is not yet ticked (`ticked_by NULL`, event `ticked` with `actor_id NULL`); then close if department, users and project are ticked (set `closed_at`, event `closed`). No-op once closed.
- `GET /go-live` → `{ closedAt, steps: [{ key, position, text, explanation, link, mode: 'auto'|'confirm'|'auto_or_skip', done, tickedBy: { id, name } | 'kainow' | null, tickedAt, note, skipped, canTick }], notDoneAtClose: string[] }` (refreshes first).
- `POST /go-live/steps/:key/tick` `{ note? }`; `POST /go-live/steps/:key/untick`; `POST /go-live/steps/logos/skip` `{ note? }` — Active Enterprise Administrators only (404 otherwise); refused for auto steps (409 `Kainow ticks this step itself.`), for test_email before a `kind='test'` outbox row reached `sent` (409 `Send a test email first, then check it arrived.`), and after closing (409 per Global Constraints).
- `GET /go-live/summary` → `{ open: boolean, done: number, total: 11 }` for the banner (Administrators only; 404 others).

- [ ] **Step 1:** failing HTTP tests: non-admin 404 on every route; fresh setup → organisation auto-ticked after registration; second admin, department, logo upload auto-tick on GET; Review Focus 2, 3, 5; tick/untick/note/skip recorded in `golive_events`; auto step tick → 409; closing when the three are done with `notDoneAtClose` listing open confirm steps; tick after close → 409; sweep run also auto-ticks and closes.
- [ ] **Step 2:** run `dist/golive/golive.http.test.js` → FAIL.
- [ ] **Step 3:** implement (step texts/explanations/links as constants in `checklist.ts`; links: organisation `#/organisation`, logos `#/organisation`, second_admin `#/people`, recovery INSTALL.md section name, mailbox `#/notifications-settings`, test_email `#/deliveries`, calendar `#/notifications-settings`, backups INSTALL.md section name, department `#/departments`, users `#/`, project `#/`).
- [ ] **Step 4:** run it and `dist/notifications/sweep.test.js` → PASS.
- [ ] **Step 5:** commit `Add the go-live checklist with automatic ticks and closing`.

### Task 4: `golive-init` command

**Files:** create `app/src/golive/golive-init-cli.ts` and `golive-init.ts` (testable `goliveInit(pool, config, sender, migrationsDir, now, person)`); modify `app/package.json` (`"golive-init": "node dist/golive/golive-init-cli.js"`), `INSTALL.md` (go-live section: new empty database, run golive-init, delete old dev databases and dump files by hand, then follow the checklist); test `app/src/golive/golive-init.test.ts`.

- [ ] **Step 1:** failing tests: a database with a user → throws the exact refusal and changes nothing (row counts unchanged); empty database → migrations applied, `notices_from = now`, one setup invitation issued to the person through a capturing sender; second run refused (Review Focus 4).
- [ ] **Step 2:** run `dist/golive/golive-init.test.js` → FAIL.
- [ ] **Step 3:** implement (emptiness checked before and after migrations; `SetupService.issue` reused).
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit `Add golive-init to prepare a new go-live database`.

### Task 5: Web — banner and checklist page

**Files:** create `app/web/src/golive.ts` (+ test: `bannerText(done, total)`, `stepState(step)` text), `app/web/src/views/GoLive.tsx`; modify `App.tsx` (route `#/go-live`, admin nav link "Go-live" while open), `views/Projects.tsx` (banner for Administrators while open).

- [ ] **Step 1:** failing tests for `bannerText` (`Go-live: 3 of 11 steps done`) and `stepState` (`Done by Kainow on 11 Nov 2026`, `Done by Ana Admin on …`, `Skipped by …`, `Not done`).
- [ ] **Step 2:** run `npm --prefix web test` → FAIL.
- [ ] **Step 3:** implement: ordered list, state in text, Mark done / Mark not done with optional note, Skip for logos, closing rule shown, closed view with `Not done at close`, polite live region, keyboard and phone width.
- [ ] **Step 4:** web tests and `npm run build:web` pass.
- [ ] **Step 5:** commit `Add the go-live checklist page and banner`.

### Task 6: Final check

- [ ] **Step 1:** full server suite (`npm test`), web tests and build; record totals.
- [ ] **Step 2:** organisation-name check over the branch's changed files.
- [ ] **Step 3:** commit any fixes `Final checks for the go-live checklist`.
