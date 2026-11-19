# V1.0 Sub-project 5 — History, Logical Deletion and Credential Quarantine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let PM/Owner/Sponsor delete and restore sources and authorised records (with delegation to the PM), give Audit/Oversight grants an Inspect Deleted Content scope, show deletions in project History, and quarantine secrets found in stored content: hold the item, encrypt originals apart from the database, clean every copy, alert PM/Deputies to other places, and let separately approved security reviewers open originals.

**Architecture:** Part 5a (Tasks 1–7) adds deletion columns, a `history` module for source/record deletion, restoring, delegation, the History list and Deleted-item inspection, and makes every read path filter Deleted items. Part 5b (Tasks 8–16) adds a protected-key file and AES-256-GCM helper, a registry of every stored text column with a schema completeness test, a cleaning engine that rewrites registered columns under a transaction-local trigger exception, and a `quarantine` module for reports, holding, possible copies, review, security-reviewer grants and release. The 4b removal hook `onMaterialRemoved` is extended, not duplicated.

**Tech Stack:** TypeScript, NestJS 12, PostgreSQL 16 (plain SQL migrations with checksums), pg-boss 12, React + Vite, `node:test`, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-11-16-v1-history-deletion-design.md` (read it in full first; § numbers below refer to it). Also read the 4a spec §3–§5 (message moderation, masking) and the 4b spec §5.5 and §7.3 (removal hook, summaries).

## Global Constraints

- One migration `app/migrations/0027_history_deletion.sql` (Task 1); never edit 0001–0026 (checksums). If PR #14 (4b) has merged by execution time, rebase onto `main` first.
- Nothing is physically deleted. The only UPDATE of an immutable or append-only row is the quarantine write (§7.4), allowed only when `current_setting('kainow.quarantine_write', true)` equals the id of a `quarantine_cases` row in state `held` or `cleaned` (or during release-unchanged / dismiss, the case being released). The string `kainow.quarantine_write` appears in `app/src` only in `app/src/quarantine/clean.ts`.
- Deletion and restoration reasons: 1–1,000 characters after trim; every reason, purpose and note box runs the credential check and refuses with the existing D75 wording.
- Refusal for deleting a record not in a final state names the state needed, e.g. `Cancel this task before deleting it.`; `Withdraw or supersede this decision before deleting it.`; `Resolve or withdraw this question before deleting it.`; `Resolve this risk, or accept it with no further review, before deleting it.`
- Labels exactly: `Deleted — <name>, <d Mon yyyy>: <reason>`; `Source deleted — review`; `a deleted record`; `Record deletion delegated to <PM> by <name>`; `Held — suspected credential, under review`; `[credential removed]`; `Credential removed — under review`; `Possible credential removed — awaiting check`; `Original file withheld — credential removed from text`; `Quote changed: credential removed — review`; `Waiting for the protected key`; `Known disclosures (copies outside Kainow cannot be recalled)`.
- History lines never contain an item's title or text for viewers without Inspect Deleted Content.
- The marked secret text, the key, and decrypted originals never appear in logs, errors, API responses (except Reveal), `audit_events`, any `*_events` row, notifications or emails.
- Restoring never starts AI, emails, reminders, deadline changes or invitations, and never brings back withdrawn AI outputs.
- Out-of-audience, Deleted (without the scope) or held items answer 404 on direct requests.
- Dates and times in UTC+8 (`todayUtc8`, `Asia/Kuala_Lumpur`).
- No real organisation names or acronyms; test accounts only `*@example.org|com|net` or `*@kainow.test`.
- Tests: `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kainow_test`; DB tests through `npm test` (`--test-concurrency=1`); check no other session is running tests before a full suite.
- Never print or open `.env` files, API keys or the protected key file's contents. Never use `git stash`.
- Commit after each task with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A secret straddling a passage boundary or quote offset:** after cleaning, no passage body, transcript span text or quote may hold any fragment of the marked text longer than 3 characters, and every offset must still slice the cleaned text correctly. Test: Task 10 `secret crossing a passage boundary leaves no fragment and offsets still slice`.
2. **A reason that contains the secret** (`"deleting — it had password Xy7!pass"`) typed into a delete, moderation or grant reason before the report: swept and cleaned like content. Test: Task 10 `secret in an earlier deletion reason is cleaned`.
3. **Restoring a parent task whose subtask was deleted separately earlier:** only subtasks deleted with it come back. Test: Task 3 `restoring a parent brings back only the subtasks deleted with it`.
4. **A task amended during quarantine review, then the case released unchanged:** the amendment is kept and the case lists it as changed. Test: Task 14 `release unchanged skips a value changed since cleaning`.
5. **Project Deferred or Closed when a secret is reported or a copy confirmed:** reporting, review, release and restoring still work (protective / Q04); deleting is refused. Test: Task 11 `report and release work while Closed` and Task 2 `deleting a source is refused while Deferred, restoring works`.

---

## File Structure

| File | Responsibility |
|---|---|
| `app/migrations/0027_history_deletion.sql` | All schema for 5a and 5b (spec §8) |
| `app/src/history/final-states.ts` | Pure: is a record deletable; refusal sentence |
| `app/src/history/deleted-sql.ts` | SQL fragments every read path uses to exclude Deleted and held rows |
| `app/src/history/sources-deletion.service.ts` | Delete/restore sources, audience preview |
| `app/src/history/records-deletion.service.ts` | Delete/restore records, subtask cascade |
| `app/src/history/delegation.ts` + `delegation.service.ts` | D83 delegation rows, open/end helpers |
| `app/src/history/history.service.ts` | Deletions-and-restorations list; Deleted items for grant holders |
| `app/src/history/history.controller.ts`, `history.module.ts` | Endpoints, Nest module |
| `app/src/common/reason.ts` | `readReason` with length and credential check |
| `app/src/quarantine/protected-key.ts`, `protected-key-cli.ts` | Key file loading, AES-256-GCM, key id, CLI |
| `app/src/quarantine/registry.ts` | Every stored text column, how to find a project's rows and an item's derived rows |
| `app/src/quarantine/clean-text.ts` | Pure replacement and offset mapping |
| `app/src/quarantine/clean.ts` | Cleaning engine: encrypt originals, write cleaned values, restore originals |
| `app/src/quarantine/cases.service.ts` | Report, hold, possible copies, review, release, notifications, disclosures |
| `app/src/quarantine/security.service.ts` | Security reviewers, grants, reveal, release unchanged |
| `app/src/quarantine/quarantine.controller.ts`, `quarantine.module.ts` | Endpoints, Nest module, worker job for waiting cases |
| `app/web/src/history.ts`, `app/web/src/quarantine.ts` | Web API calls and pure helpers |
| `app/web/src/views/DeleteRestore.tsx`, `HistoryList.tsx`, `DeletedItems.tsx`, `ReportSecret.tsx`, `HeldReview.tsx`, `SecurityReview.tsx` | Screens |

New matrix actions in `app/src/projects/matrix.ts`:

| Action | Roles | States |
|---|---|---|
| `source.delete` | pm, owner, sponsor | draft, planned, active |
| `source.restore` | pm, owner, sponsor | all |
| `record.delete` | owner, sponsor (pm via D83, checked in the service) | draft, planned, active |
| `record.restore` | owner, sponsor (pm via D83) | all |
| `record.delegate_deletion` | owner, sponsor | all |
| `secret.report` | participant (also in `GRANT_ACTIONS`) | all |
| `quarantine.release` | pm, owner, sponsor | all |
| `quarantine.copies` | pm, deputy_pm | all |

---

## Part 5a — deletion, restoring, History, Inspect Deleted Content

### Task 1: Migration 0027

**Files:**
- Create: `app/migrations/0027_history_deletion.sql`
- Test: `app/src/history/migration.test.ts`

**Interfaces:**
- Produces (exact names):
  - `sources`: `deleted_by uuid`, `deleted_at timestamptz`, `delete_reason text`, `held_case_id uuid`; CHECK deleted columns all null or all set. `source_events(id, source_id, project_id, kind CHECK IN ('deleted','restored'), actor_id, reason, at)` append-only.
  - `tasks`, `decisions`, `questions`, `risks`: `deleted_at`, `deleted_by`, `delete_reason`, `held_case_id`; `tasks.deleted_with uuid NULL REFERENCES tasks(id)`. `task_events.kind` and `record_events` kind CHECKs gain `'deleted'`, `'restored'`.
  - `held_case_id uuid` also on `discussion_messages`, `discussion_threads`, `extraction_items`, `human_proposals`, `ai_answers`, `report_drafts`, `summaries`, `ai_feedback`.
  - `record_deletion_delegations(id, project_id, pm_user_id, delegated_by, reason, at, revoked_by, revoked_at, revoke_reason)`; unique open row per project (as `closure_delegations_one_open`).
  - `access_grants.inspect_deleted boolean NOT NULL DEFAULT false`.
  - `users.security_reviewer boolean NOT NULL DEFAULT false`; `security_reviewer_events(id, user_id, kind CHECK IN ('designated','undesignated'), actor_id, reason, at)` append-only; CHECK `actor_id <> user_id`.
  - `quarantine_cases(id, project_id, item_kind, item_id, reporter_id NULL, reason NULL, marked_length int, detector_kinds text[], holder_user_id NULL, state CHECK IN ('held','cleaned','released','released_unchanged'), waiting_for_key bool, reported_at, cleaned_at, closed_at, closed_by, close_reason)`.
  - `quarantine_items(case_id, item_kind, item_id, role CHECK IN ('reported','copy'))`.
  - `quarantine_possible_copies(case_id, item_kind, item_id, found_at, masked bool, decision CHECK IN ('confirmed','dismissed') NULL, decided_by, decided_at)`.
  - `quarantine_originals(id, case_id, table_name, row_key jsonb, column_name, ciphertext bytea, nonce bytea, tag bytea, key_id text, cleaned_sha256 text, restored_at NULL)`; only `restored_at` may change.
  - `quarantine_events(id, case_id, project_id, actor_id NULL, action CHECK IN ('reported','held','cleaned','copies_found','copy_confirmed','copy_dismissed','marked_more','released','released_unchanged','grant_requested','grant_approved','grant_declined','grant_extended','grant_revoked','original_opened','notified'), item_kind, item_id, reason, detail jsonb, at)` append-only.
  - `quarantine_grants(id, requester_id, purpose, hours int, requested_at, decision, decided_by, decided_at, decision_reason, expires_at, revoked_by, revoked_at, revoke_reason)`; CHECK `decided_by <> requester_id`; `quarantine_grant_cases(grant_id, case_id)`.
  - `source_versions.quarantined_at timestamptz`; `source_versions_upload_has_original` relaxed to also accept `origin = 'upload' AND original_bytes IS NULL AND quarantined_at IS NOT NULL`.
  - `CREATE FUNCTION kainow_quarantine_writing() RETURNS boolean` (true when the setting names a case in `held`/`cleaned`, or a case being closed in this transaction); every immutable/append-only trigger function on a registered table (Task 9 list) returns NEW for `TG_OP = 'UPDATE' AND kainow_quarantine_writing()`. DELETE and TRUNCATE stay refused.
- [ ] **Step 1: Failing tests** in `migration.test.ts`: `source_versions refuse update without the quarantine setting`; `source_versions accept update with a held case set`; `a closed case does not open the exception`; `delete is refused even with the setting`; `security reviewer cannot be designated by themselves`; `quarantine grant cannot be decided by its requester`; `deleted columns are all or nothing`; `upload with withheld original needs quarantined_at`.
- [ ] **Step 2:** `npm test` from `app` — new tests FAIL.
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** `npm test` — PASS, all earlier tests still pass.
- [ ] **Step 5:** Commit `feat(history): migration 0027 for deletion, delegation and quarantine`.

### Task 2: Source deletion, restoring and D79 import check

**Files:**
- Create: `app/src/history/sources-deletion.service.ts`, `app/src/history/deleted-sql.ts`, `app/src/history/history.controller.ts`, `app/src/history/history.module.ts`, `app/src/common/reason.ts`
- Modify: `app/src/projects/matrix.ts` (all new actions above), `app/src/notes/notes.service.ts` (`createSource`/`addVersion` call `refuseSecrets` always, on extracted text for uploads), `app/src/discussion/masking.ts` (flag `Source deleted — review` for proposals whose evidence source is Deleted), `app/src/search/search.service.ts`, `app/src/assist/material.ts`, `app/src/extraction/runner.ts`, `app/src/analysis/analysis-runner.ts`, `app/src/analysis/minutes-runner.ts`, `app/src/assist/assist-runner.ts`, `app/src/app.module.ts`
- Test: `app/src/history/sources-deletion.http.test.ts`, `app/src/notes/notes.http.test.ts` (add)

**Interfaces:**
- Produces:
  - `function readReason(input: unknown, label = 'a reason'): string` in `common/reason.ts` — trims, 1–1,000 characters, `refuseSecrets`; throws `BadRequestException('Give <label> (up to 1,000 characters).')`.
  - `const liveSourceSql = (alias: string) => string` — `<alias>.status <> 'deleted' AND <alias>.held_case_id IS NULL`; `liveRecordSql(alias)` — `<alias>.deleted_at IS NULL AND <alias>.held_case_id IS NULL`; `liveMessageSql(alias)` — `<alias>.state = 'visible' AND <alias>.held_case_id IS NULL`. Every later filter uses these.
  - `SourcesDeletionService.delete(user, sourceId, { reason }): Promise<{ id: string; status: 'deleted' }>`; `.restorePreview(user, sourceId): Promise<{ names: string[] }>`; `.restore(user, sourceId, { reason }): Promise<{ id: string; status: 'active' }>`.
  - Endpoints: `POST /sources/:id/delete`, `GET /sources/:id/restore-preview`, `POST /sources/:id/restore`.
- [ ] **Step 1: Failing tests:** `PM deletes notes with a reason; Member refused`; `deleting a discussion transcript source is refused`; `deleting a source is refused while Deferred, restoring works`; `deleted notes vanish from the notes list, global search and Ask material`; `a shared answer built on deleted notes goes to review; a private one is withdrawn`; `deleting an approved summary source withdraws the summary`; `proposal from deleted notes shows Source deleted — review and restoring clears it`; `extraction queued before deletion ends blocked with no spend entry` (and one each for analysis, minutes, assist runners); `restore preview lists the current audience by name`; `restore starts no extraction and brings back no withdrawn answer`; `manager import with an sk- key is refused with the kind only`; `approving a summary version containing an sk- key is refused`.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement (call `onMaterialRemoved(db, { sourceIds: [id] }, 'deleted', at)` in the delete transaction; `source_events` row; `writeAudit` action `source.deleted`/`source.restored`, no text). **Step 4:** run — PASS.
- [ ] **Step 5:** Commit `feat(history): delete and restore sources; secrets refused at import`.

### Task 3: Record deletion and restoring

**Files:**
- Create: `app/src/history/final-states.ts`, `app/src/history/records-deletion.service.ts`
- Modify: `app/src/history/history.controller.ts`, `app/src/assist/removal.ts` (`RemovedMaterial` gains `records?: Array<{ kind: 'task' | 'decision' | 'question' | 'risk'; id: string }>`; `RemovalReason` gains `'record_deleted'` and `'quarantined'`; `touchedRequests` matches `ai_request_material (record_kind, record_id)`), `app/src/records/records.service.ts`, `app/src/records/tasks.ts` (progress excludes Deleted), `app/src/digests/digest.ts`, `app/src/notifications/*` (reminder and escalation queries skip Deleted), `app/src/search/search.service.ts`, `app/src/assist/material.ts`, `app/src/changes/flags.service.ts` (lists skip flags on Deleted records), link renderers (`a deleted record`)
- Test: `app/src/history/final-states.test.ts`, `app/src/history/records-deletion.http.test.ts`

**Interfaces:**
- Produces:
  - `type RecordKind = 'task' | 'decision' | 'question' | 'risk'`
  - `function deletionRefusal(kind: RecordKind, row: { status: string; noFurtherReview?: boolean }): string | null` — null when deletable (§3 final states), else the exact refusal from Global Constraints.
  - `RecordsDeletionService.delete(user, kind, id, { reason })`, `.restorePreview(user, kind, id)`, `.restore(user, kind, id, { reason })`; `canActOnRecords(ctx, userId): 'owner_sponsor' | 'delegated_pm' | null` (uses Task 4's `openRecordDelegation`; until Task 4 lands, owner/sponsor only).
  - Endpoints: `POST /records/:kind/:id/delete`, `GET /records/:kind/:id/restore-preview`, `POST /records/:kind/:id/restore`.
- [ ] **Step 1: Failing pure tests:** `cancelled and completed tasks are deletable, in-progress is not`; `accepted risk needs no further review`; `refusal names the state needed`.
- [ ] **Step 2: Failing HTTP tests:** `Owner deletes a cancelled task; PM refused without delegation`; `deleting a task deletes its final subtasks and records deleted_with`; `deleting a parent with an open subtask is refused`; `restoring a parent brings back only the subtasks deleted with it`; `a subtask cannot be restored while its parent is deleted`; `deleted task leaves lists, progress, search, digest and Ask material`; `a decision replacing a deleted one shows a deleted record`; `a shared answer whose material held the record snapshot goes to review`; `restored task keeps its status and history, no reminder is created`.
- [ ] **Step 3:** FAIL. **Step 4:** implement. **Step 5:** PASS.
- [ ] **Step 6:** Commit `feat(history): delete and restore authorised records`.

### Task 4: Delegated record deletion (D83)

**Files:**
- Create: `app/src/history/delegation.ts`, `app/src/history/delegation.service.ts`
- Modify: `app/src/history/history.controller.ts`, `app/src/projects/memberships.service.ts` (PM change ends it beside `endDelegation`), `app/src/history/records-deletion.service.ts` (notice to Owners/Sponsors when acting as delegated PM), `app/src/projects/projects.service.ts` (project view carries `recordDeletionDelegation`)
- Test: `app/src/history/delegation.http.test.ts`

**Interfaces:**
- Produces: `openRecordDelegation(db, projectId): Promise<{ id: string; pmUserId: string; pm: string; by: string; reason: string; at: Date } | null>`; `endRecordDelegation(c, projectId, actorId, at, why): Promise<boolean>`; endpoints `POST /projects/:id/record-deletion-delegation` `{ reason }`, `POST /projects/:id/record-deletion-delegation/revoke` `{ reason }`.
- [ ] **Step 1: Failing tests:** `Sponsor delegates; PM then deletes a cancelled task`; `Owners and Sponsors get an in-app notice titled "<PM> deleted a task in <project>"`; `a Deputy cannot receive or use it`; `a second open delegation is refused`; `changing the PM ends it`; `any Owner or Sponsor revokes it with a reason`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(history): delegated record deletion and restoring (D83)`.

### Task 5: History list and Inspect Deleted Content

**Files:**
- Create: `app/src/history/history.service.ts`
- Modify: `app/src/history/history.controller.ts`, `app/src/projects/grants.service.ts` and `grants.controller.ts` (`inspectDeleted` on request; immutable after), `app/src/projects/access.service.ts` (grant context exposes `inspectDeleted`), `app/src/discussion/threads.service.ts` (Deleted message text shown to holders, labelled)
- Test: `app/src/history/history.http.test.ts`

**Interfaces:**
- Produces:
  - `HistoryService.deletions(user, projectId): Promise<HistoryLine[]>` with `interface HistoryLine { at: string; kind: 'message' | 'note' | 'minutes' | 'summary' | RecordKind | 'credential_report'; action: 'deleted' | 'restored' | 'reported'; actor: string | null; reason: string | null; title?: string; href?: string }` — `title`/`href` only for an Active `inspect_deleted` grant holder; `credential_report` lines have `actor` only for PM/Owner/Sponsor and no reason.
  - `HistoryService.deletedItems(user, projectId)` and `.deletedItem(user, kind, id)` (holders only; 404 otherwise; each opening writes `audit_events` `deleted.inspected` with kind and id).
  - Endpoints: `GET /projects/:id/history/deletions`, `GET /projects/:id/deleted-items`, `GET /projects/:id/deleted-items/:kind/:id`.
- [ ] **Step 1: Failing tests:** `a Member sees "A task was deleted by <name>" with no title`; `a holder with Inspect Deleted Content sees the title and opens the item, logged`; `an Audit grant without the scope gets 404 for a deleted item`; `the scope cannot be added to an approved grant`; `a holder still cannot read a Restricted deleted source outside its audience`; `deleted items never appear in the holder's Ask material or search`; `creator, PM and Administrator get 404 for deleted content`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(history): deletions list and Inspect Deleted Content`.

### Task 6: Web screens for 5a

**Files:**
- Create: `app/web/src/history.ts`, `app/web/src/history.test.ts`, `app/web/src/views/DeleteRestore.tsx`, `app/web/src/views/HistoryList.tsx`, `app/web/src/views/DeletedItems.tsx`
- Modify: `app/web/src/views/ProjectPage.tsx` (History → Deletions and restorations; delegation panel), `Work.tsx`, `NoteDetail.tsx`, record views (Delete/Restore menu items where allowed), `ProjectAccessPanels.tsx` (grant tick-box "Include Inspect Deleted Content")
- Test: `app/web/src/history.test.ts`

**Interfaces:**
- Consumes: Task 2–5 endpoints.
- Produces: `historyLineText(line: HistoryLine): string` — e.g. `3 Dec 2026 — A task was deleted by Aisyah Rahman — "Duplicate"`; `deletedLabel(by: string, at: string, reason: string): string`.
- [ ] **Step 1: Failing tests:** `history line has no title without the scope`; `deleted label format`; `restore dialog shows the names before confirming`.
- [ ] **Step 2:** FAIL. **Step 3:** implement (WCAG 2.2 AA; dialogs keyboard operable; reason required). **Step 4:** `npm test` and `npm run build` in `app/web` — PASS.
- [ ] **Step 5:** Commit `feat(web): delete, restore, history and deleted items`.

### Task 7: 5a leak tests

**Files:**
- Create: `app/src/history/leaks.http.test.ts`

- [ ] **Step 1:** One test per surface for a Deleted message, a Deleted source and a Deleted record, as an ordinary Member: project lists and counts, global search, Ask material and a new AI request (fake model input captured), digest content and queued email bodies, notifications, History lines, direct link (404), grant holder without scope (404).
- [ ] **Step 2:** Run. Any failure is a defect in the owning task's code: fix there, re-run until PASS.
- [ ] **Step 3:** Commit `test(history): leak tests for Deleted content`.

## Part 5b — credential quarantine

### Task 8: Protected key and encryption

**Files:**
- Create: `app/src/quarantine/protected-key.ts`, `app/src/quarantine/protected-key-cli.ts`, `app/src/quarantine/protected-key.test.ts`
- Modify: `app/src/config.ts` (`protectedKeyFile: string | null` from `KAINOW_PROTECTED_KEY_FILE`), `app/package.json` (script `protected-key`), `compose.yaml` (read-only mount, commented example), `INSTALL.md` (create the key; keep a recovery copy apart from backups), `app/src/health/*` and the Administrator organisation view (warning `Waiting for the protected key` when cases wait)

**Interfaces:**
- Produces:
  - `interface ProtectedKey { id: string; encrypt(plain: Buffer): { ciphertext: Buffer; nonce: Buffer; tag: Buffer }; decrypt(v: { ciphertext: Buffer; nonce: Buffer; tag: Buffer }): Buffer }`
  - `function loadProtectedKey(path: string | null): ProtectedKey | null` — 32 bytes exactly, else null and a log line naming the problem (never the bytes); `id` = first 16 hex of SHA-256 of the key.
  - CLI `npm run protected-key -- --create <path>` refuses to overwrite.
- [ ] **Step 1: Failing tests:** `round trip`; `a fresh nonce each call`; `tampered tag fails`; `wrong length file gives null`; `key id is stable and 16 hex`; `CLI refuses to overwrite`.
- [ ] **Step 2:** FAIL. **Step 3:** implement with `node:crypto` `aes-256-gcm`. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(quarantine): protected key file and encryption`.

### Task 9: Text registry and completeness test

**Files:**
- Create: `app/src/quarantine/registry.ts`, `app/src/quarantine/registry.db.test.ts`

**Interfaces:**
- Produces:
  - `interface TextColumn { table: string; column: string; json: boolean; rowKey: string[]; projectSql: string; itemSql?: Partial<Record<ItemKind, string>> }` — `projectSql` selects the table's rows for `$1` = project id; `itemSql[kind]` selects the rows belonging to or derived from an item (`$1` = item id).
  - `type ItemKind = 'message' | 'source' | 'task' | 'decision' | 'question' | 'risk' | 'proposal' | 'human_proposal' | 'answer' | 'report_draft' | 'summary' | 'minutes_draft' | 'feedback' | 'thread'`
  - `const TEXT_COLUMNS: readonly TextColumn[]` (spec §7.4 list plus event reasons/details and the new 0027 text columns) and `const NO_USER_TEXT: Readonly<Record<string, string>>` (`table.column` → one-line reason).
- [ ] **Step 1: Failing test** `every text, varchar and jsonb column is registered or declared` — reads `information_schema.columns` for the public schema and fails listing any column in neither list; `every registered projectSql runs`; `every itemSql runs`.
- [ ] **Step 2:** FAIL. **Step 3:** write the registry; add every Task 1 trigger function the registry needs to the exception (back in the migration only if Task 1 missed one — then it is a Task 1 fix before commit, since 0027 is not yet merged). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(quarantine): registry of stored text with a completeness test`.

### Task 10: Cleaning engine

**Files:**
- Create: `app/src/quarantine/clean-text.ts`, `app/src/quarantine/clean.ts`, `app/src/quarantine/clean-text.test.ts`, `app/src/quarantine/clean.db.test.ts`

**Interfaces:**
- Produces:
  - `const MARKER = '[credential removed]'`
  - `function cleanText(text: string, marks: string[], htmlEscaped?: boolean): { text: string; edits: Array<{ from: number; to: number; newFrom: number; newTo: number }> }` — exact, case-sensitive; overlapping or adjacent matches merged; `htmlEscaped` also matches the HTML-escaped form.
  - `function mapOffset(edits: Edit[], offset: number, side: 'start' | 'end'): number` — offsets inside a replaced span widen to cover the whole marker.
  - `function cleanJson(value: unknown, marks: string[]): unknown` — every string leaf.
  - `async function cleanItem(c: PoolClient, key: ProtectedKey, caseId: string, kind: ItemKind, itemId: string, marks: string[]): Promise<{ rows: number }>` — sets `kainow.quarantine_write` locally, encrypts each changed original into `quarantine_originals` with `cleaned_sha256`, writes cleaned values, recomputes passage bodies/offsets, transcript spans and quote offsets of cleaned versions, withholds `original_bytes` (encrypted, set NULL, `quarantined_at`), flags overlapped quotes.
  - `async function findPlaces(c: PoolClient, projectId: string, marks: string[], except: { kind: ItemKind; id: string }): Promise<Array<{ kind: ItemKind; id: string }>>`
  - `async function restoreOriginals(c: PoolClient, key: ProtectedKey, caseId: string, scope?: { kind: ItemKind; id: string }): Promise<{ restored: number; changed: Array<{ table: string; rowKey: unknown }> }>` — skips rows whose current value's SHA-256 ≠ `cleaned_sha256`; sets `restored_at`.
- [ ] **Step 1: Failing pure tests:** `replaces every occurrence`; `merges overlapping marks`; `html-escaped form matched in html mode`; `offset inside a secret widens to the marker`; `offsets after the secret shift by the length difference`; `json leaves cleaned, keys untouched`.
- [ ] **Step 2: Failing DB tests:** `cleaning a notes version removes the secret from text, passages, search view and quotes`; `secret crossing a passage boundary leaves no fragment and offsets still slice`; `an uploaded file's original bytes are withheld and encrypted`; `secret in an earlier deletion reason is cleaned`; `originals decrypt back to the exact values`; `findPlaces finds a message and a task title holding the text, not the item itself`; `restoreOriginals skips a value changed since cleaning`; `without the setting the same UPDATE is refused`.
- [ ] **Step 3:** FAIL. **Step 4:** implement. **Step 5:** PASS.
- [ ] **Step 6:** Commit `feat(quarantine): cleaning engine with encrypted originals`.

### Task 11: Reporting, holding and possible copies

**Files:**
- Create: `app/src/quarantine/cases.service.ts`, `app/src/quarantine/quarantine.controller.ts`, `app/src/quarantine/quarantine.module.ts`, `app/src/quarantine/cases.http.test.ts`
- Modify: every read path through `deleted-sql.ts` helpers (now also `held_case_id`); `app/src/assist/summaries.service.ts` (held → summary `hidden`); `app/src/notifications/mailing.ts` (cancel queued/retry_wait emails containing the marks, via `findPlaces` on `email_outbox`); `app/src/worker/*` (job `quarantine.clean-waiting` when the key appears); `app/src/app.module.ts`

**Interfaces:**
- Consumes: `cleanItem`, `findPlaces`, `loadProtectedKey`, `onMaterialRemoved(..., 'quarantined', at)`.
- Produces:
  - `CasesService.report(user: AuthUser | 'kainow', input: { projectId: string; kind: ItemKind; id: string; marked: string[]; reason: string | null; holderUserId?: string }): Promise<{ caseId: string }>` — marked text ≥ 4 characters and present in the item's current text; one transaction: case, `held_case_id`, removal hook, clean item (or `waiting_for_key`), find places, mask places (clean, not held; held if no key), `quarantine_possible_copies`, events, notifications (§7.7).
  - `CasesService.decideCopies(user, caseId, decisions: Array<{ kind: ItemKind; id: string; decision: 'confirmed' | 'dismissed' }>)`
  - `CasesService.disclosures(caseId): Promise<{ aiRequests: Array<{ at: string; provider: string; model: string }>; emails: Array<{ at: string; recipients: number }>; audienceSize: number }>`
  - Endpoints: `POST /projects/:id/secret-reports`, `GET /quarantine/cases/:id/copies`, `POST /quarantine/cases/:id/copies`.
- [ ] **Step 1: Failing tests:** `a Member reports a secret in notes; the notes are held and gone from views, search and Ask`; `marked text not in the item is refused`; `a private answer built on it disappears, a shared one goes to review`; `an approved summary of it is hidden`; `the same text in a message is masked at once, visible and labelled, and PM and Deputies are alerted without the text`; `PM confirms one copy and dismisses another, whose original returns`; `a queued digest email containing it is cancelled`; `Administrators, the author and the named holder get the urgent notice without the text`; `without the key the item and the places are held, and a job cleans them when the key appears`; `report and release work while Closed`; `an Audit grant holder may report`; `no event, notification or email row contains the marked text`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(quarantine): report, hold, mask copies and alert`.

### Task 12: Kainow's own reports from runners

**Files:**
- Modify: `app/src/extraction/runner.ts`, `app/src/analysis/analysis-runner.ts`, `app/src/analysis/minutes-runner.ts`, `app/src/assist/assist-runner.ts` (on a `findCredentials` hit in stored input: `report('kainow', …)` on the owning item, then block as today)
- Test: add to each runner's test file

**Interfaces:**
- Consumes: `CasesService.report` with `'kainow'`; owning item per §7.1 (passage → source or message; snapshot → record).
- [ ] **Step 1: Failing tests:** `extraction finding a stored key opens a case on the notes and blocks without charge` (and one per runner); `a snapshot hit opens the case on the record`; `a second run on the same item does not open a second case`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(quarantine): runners report stored secrets themselves`.

### Task 13: Review, mark more, release; reasons checked

**Files:**
- Modify: `app/src/quarantine/cases.service.ts`, `quarantine.controller.ts`; every service that takes a free-text reason or note (moderation, holds, grants, closure, changes, feedback, summaries review, history) switches to `readReason`
- Test: `app/src/quarantine/review.http.test.ts`

**Interfaces:**
- Produces: `CasesService.heldForReview(user, projectId)`, `.cleanedView(user, caseId)` (cleaned text with marker positions, never originals), `.markMore(user, caseId, marked: string[])`, `.release(user, caseId, { reason })`; endpoints `GET /projects/:id/held`, `GET /quarantine/cases/:id`, `POST /quarantine/cases/:id/mark-more`, `POST /quarantine/cases/:id/release`.
- [ ] **Step 1: Failing tests:** `PM in the audience sees the cleaned text only`; `a PM outside a Restricted source's audience gets 404`; `mark more cleans further text and encrypts it into the same case`; `release returns the item and confirmed copies to their audience; withdrawn answers stay withdrawn; hidden summary stays hidden`; `a cleaned task stays visible labelled Credential removed — under review and reminders continue`; `the reporter and PM are told when released`; `a moderation reason containing an sk- key is refused`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(quarantine): review and release; reasons checked for secrets`.

### Task 14: Security reviewers, grants, reveal, release unchanged

**Files:**
- Create: `app/src/quarantine/security.service.ts`, `app/src/quarantine/security.http.test.ts`
- Modify: `app/src/quarantine/quarantine.controller.ts`, `app/src/organisation/*` (Security reviewers section)

**Interfaces:**
- Produces: `SecurityService.designate(admin, userId, { reason })`, `.undesignate(...)`, `.requestGrant(reviewer, { caseIds, purpose, hours = 24 })`, `.decideGrant(admin, grantId, { decision, reason })`, `.extendGrant` (fresh approval, another Administrator), `.revokeGrant`, `.cases(reviewer)`, `.reveal(reviewer, caseId, itemKind, itemId, { confirm: true })` → original text with marks, response header `Cache-Control: no-store`, `.releaseUnchanged(reviewer, caseId, { reason })`, `.adminCases(admin)` (every case: project, item kind, reporter, state, disclosures — never content). Endpoints under `/security/...`.
- [ ] **Step 1: Failing tests:** `an Administrator cannot designate themselves`; `a non-reviewer cannot request`; `the requester cannot approve their own grant`; `with one Administrator who is the requester the request waits`; `reveal without confirm is refused; with it the original is returned and logged`; `reveal after expiry is refused`; `ordinary Audit with Inspect Deleted Content cannot reveal`; `release unchanged restores originals and passages and notifies Administrators`; `release unchanged skips a value changed since cleaning`; `no export, email or AI path accepts a quarantined original`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(quarantine): security reviewers, grants, reveal and release unchanged`.

### Task 15: Web screens for 5b

**Files:**
- Create: `app/web/src/quarantine.ts`, `app/web/src/quarantine.test.ts`, `app/web/src/views/ReportSecret.tsx`, `HeldReview.tsx`, `SecurityReview.tsx`
- Modify: item menus (Report a suspected secret), `ProjectPage.tsx` (Held for review; Possible copies), `Organisation.tsx` (Security reviewers, Quarantine cases, grant requests, key warning), `styles.css` (marker style with text equivalent)

**Interfaces:**
- Produces: `markerSegments(text: string): Array<{ text: string; removed: boolean }>` for rendering `[credential removed]` distinctly.
- [ ] **Step 1: Failing tests:** `marker segments split the cleaned text`; `report form requires a selection or pasted text and a reason`; `possible copies list never shows the marked text`.
- [ ] **Step 2:** FAIL. **Step 3:** implement (WCAG 2.2 AA; marker not by colour alone; Reveal confirmation dialog). **Step 4:** `npm test` and `npm run build` in `app/web` — PASS.
- [ ] **Step 5:** Commit `feat(web): report, review and security screens`.

### Task 16: Leak tests, measured aims and documents

**Files:**
- Create: `app/src/quarantine/leaks.http.test.ts`, `app/src/quarantine/bench-cli.ts` (script `bench-history`)
- Modify: `docs/Kainow-V1.0-Permission-Matrix.md`, `docs/Kainow-V1.0-Configuration-Catalogue.md` (C62, C69), `README.md`, spec §10 (measured results)

- [ ] **Step 1:** Leak tests for a held item and after cleaning, per surface as Task 7, plus: `a search of every registered column of the project finds the marked text nowhere after report`; `decrypting the case's originals gives it back`.
- [ ] **Step 2:** Run; fix defects in their owning task's code; re-run until PASS.
- [ ] **Step 3:** Bench on `kainow_bench` (4b seed; refuse database names not ending `_test`/`_bench`): 50 reports of a secret in one large source with three copies in messages — report-to-cleaned p95 < 2 s; confirming three copies p95 < 2 s; passage search p95 with the new filters within 10% of 66 ms. Record numbers in spec §10 as found; a miss goes to the PO.
- [ ] **Step 4:** Update the documents listed (Permission Matrix rows for delete/restore with D83, delegation, report, release, copies, security reviewers; Catalogue C62/C69 key file and waiting behaviour; README feature list).
- [ ] **Step 5:** Full suites: `npm test` in `app` and in `app/web`, `npm run build` in `app/web` — all PASS.
- [ ] **Step 6:** Commit `test(quarantine): leak tests, measured aims and documents`.

After Task 16: final whole-branch review on the most capable model, against the spec and the Review Focus list above, then one fix wave.
