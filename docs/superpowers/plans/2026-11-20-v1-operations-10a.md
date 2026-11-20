# Sub-project 10a: Operations (backups, restore drill, storage protection) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily encrypted backups run from the server, a restore drill that proves them, protective read-only mode before the database disk fills, and an Operations page for Enterprise Administrators.

**Architecture:**
- **Ops commands.** New code lives in `app/src/ops/`, as plain Node commands (the `recover-admin` two-layer pattern) built into a new Docker target `ops`. The server's cron runs them in one-shot containers. Each command records its result in new tables in migration `0032_operations.sql`.
- **Reading and acting on the results.** The API reads those tables for status, banners and the Operations page. A cached operations state drives a refusal in `AuthGuard` and a pause in the worker. The sweep raises the episodes that a missing command cannot raise itself.

**Tech Stack:** NestJS 12, PostgreSQL 16 (`pg_dump`, `pg_restore`, `psql` version 16 client tools), pg-boss, Node `crypto` (AES-256-GCM), React web, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-20-v1-operations-10a-design.md`. Read it alongside this plan. Section numbers below (§) refer to it.

## Global Constraints

**Numbers and delivery**
- Migration `0032_operations.sql`; Decision Register D109–D116 (D117–D118 reserved); Configuration Catalogue C93–C99. Sub-project 9 owns 0031, D100–D108 and C85–C92.
- One PR, opened only after sub-project 9 is on main. Tasks 1–14 build from main; Task 15 is built after rebasing onto main with 9 merged.

**Rules carried over from earlier sub-projects**
- No real organisation names or domains anywhere. Test accounts are `*@example.org|com|net` or `*@kainow.test` only.
- Never print or open `.env` files or key files. Command output and stored failure text never contain key bytes, secrets, file content, connection strings or host paths. Failures are stored as `failure_code` plus the fixed text from §4.3.
- Never `git stash`.

**Tests and databases**
- Test database: `kainow_test_sp10` on the existing test server, `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:15432/kainow_test_sp10`. Check the port and password against `src/testing/db.ts` and the running `kainow-testdb` container; never use `kainow_test`, `kainow_test_sp8` or `kainow_test_sp9`.
- The full server suite takes about 2 hours. Run it in the background. Per task, run only that task's tests.

**Code conventions**
- Every listed order has a stable `ORDER BY` with a tie-break, and never sorts by uuid alone (`started_at DESC, id DESC`).
- Every new `writeAudit` action is added to `src/analytics/catalogue.ts`; `catalogue.db.test.ts` enforces it.
- Settings changes need a non-blank reason and are recorded with previous and next values. Copy `src/organisation/access-settings*.ts`.

**Fixed values**

| What | Value |
|---|---|
| Protective mode text | `Kainow is read-only for now to protect your data. Nothing you have saved is affected.` |
| Banner for everyone | `Kainow is read-only for now to protect your data. You can read everything; changes are paused.` |
| Restore not-sent label | `Not sent — restored from backup` |
| Restore not-run reason | `Not run — restored from backup` |

| Setting | Default | Bounds |
|---|---|---|
| Backup retention | 30 days | 7–365 |
| Storage warning | 80% | 50–95 |
| Storage critical | 90% | above warning, ≤ 99 |
| Safe floor | 5 GB | 1–1,000 GB |
| Diagnostic retention | 30 days | 7–365 |

| Time limit | Value |
|---|---|
| Recovery target | 24 hours |
| Restore target | 4 hours |
| A run counts as interrupted after | 6 hours |
| A missing storage check after | 30 minutes |
| Resume needs a reading younger than | 10 minutes |
| Operations state cache | 5 seconds |

## Review Focus

1. **The backup folder is a share that drops mid-run, or a disk that is offline.** Expect a recorded `folder_missing` or `no_space` failure, an `-incomplete` set left behind, the previous good set untouched, and no expiry run. Tested in Task 4 and Task 5.
2. **Two cron runs overlap** (a slow backup still running when the drill starts). Expect the second to refuse at once with "Another backup or drill is running" and record nothing. Tested in Task 4.
3. **The API refuses writes while a person is mid-form.** Expect the 503 text shown where the form shows errors, with the typed text kept. Expect also that GET handlers that write as a side effect (marking notices read, recording an export) neither crash nor half-write. Tested in Task 8 and Task 12.
4. **The clock edge.** A backup finished exactly 24 hours ago, a reading exactly 30 minutes old, usage exactly at the warning percentage. Expect the boundaries as specified: ≥ is the higher level, and > 24 h is target exceeded. Tested in Task 6 and Task 7.
5. **A restored installation's worker starting.** Expect nothing to be sent or repeated: no email, AI request, analysis or storage work from before the backup, and the analysis stall rule not rewriting the restored rows. Tested in Task 10.

---

## File structure

```
app/migrations/0032_operations.sql                 all 10a schema (Task 1)
app/src/ops/settings.ts, settings.service.ts       operations settings (Task 1)
app/src/ops/crypto.ts                              KNBK1 chunked encryption (Task 2)
app/src/ops/backup-key-cli.ts                      backup key file (Task 2)
app/src/ops/config.ts, pg-tools.ts, common.ts      ops config, pg client tools, lock/failure codes/notices (Task 3)
app/src/ops/backup.ts, backup-cli.ts               backup command (Task 4)
app/src/ops/expiry.ts                              retention and file-store collection (Task 5)
app/src/ops/status.ts, alerts.ts, sweep-ops.ts     pure status rules, episodes, sweep part (Task 6)
app/src/ops/storage-check.ts, storage-check-cli.ts readings, levels, entering protective mode (Task 7)
app/src/ops/state.ts, protective.ts                OperationsState cache, guard marker, worker pause (Task 8)
app/src/ops/drill.ts, restore-drill-cli.ts         restore drill (Task 9)
app/src/ops/restore.ts, restore-cli.ts             restore into an empty installation (Task 10)
app/src/ops/operations.controller.ts, operations.service.ts, ops.module.ts   API (Task 11)
app/src/analytics/operations.service.ts            analytics panel (Task 11)
app/web/src/operations.ts, views/Operations.tsx, views/analytics/OperationsPanel.tsx   web (Task 12)
app/Dockerfile, compose.yaml, .github/workflows/ci.yml   ops image, service, CI client tools (Task 3)
docs/…, INSTALL.md, app/README.md, docs/operations/verify-low-space.md   (Task 13)
app/src/ops/bench-cli.ts                           measured aims (Task 14)
app/src/ops/source-files.ts, restore-source-files-cli.ts   after sub-project 9 (Task 15)
```

---

### Task 1: Schema, operations settings and permissions

**Files:**
- Create: `app/migrations/0032_operations.sql`, `app/src/ops/settings.ts`, `app/src/ops/settings.service.ts`, `app/src/ops/settings.test.ts`, `app/src/ops/settings.db.test.ts`
- Modify: `app/src/auth/permissions.ts` (add `'operations.view'`, `'operations.manage'`), `app/src/analytics/catalogue.ts`

**Interfaces:**
- Produces:
  - `OPS_DEFAULTS`, `OPS_BOUNDS`, `type OpsSettings = { backupRetentionDays; storageWarningPct; storageCriticalPct; safeFloorGb; diagnosticRetentionDays }` (all `number`);
  - `validateOpsSettings(next: OpsSettings): string[]` (empty when valid);
  - `loadOpsSettings(db): Promise<OpsSettings>`;
  - `OpsSettingsService.get()` returning `{ settings, defaults, bounds, changes }`;
  - `OpsSettingsService.update(actorId, body)`;
  - audit action `ops.settings_changed`.
- Schema produced (§9, exact column names as in the spec): `operations_settings`, `operations_settings_changes`, `operations_state`, `operations_state_changes`, `backup_runs`, `restore_drills`, `storage_readings`, `storage_daily`, `ops_alerts`, the `email_outbox` status CHECK widened with `'not_sent_restored'`, and `operations_state.reason` CHECK `('low_space','restored_from_backup')`.

- [ ] **Step 1: Write failing tests.**
  - `settings.test.ts`:
    - defaults equal `{30, 80, 90, 5, 30}`;
    - `validateOpsSettings` rejects retention 6 and 366, warning 49 and 96, critical ≤ warning and critical 100, floor 0 and 1001, diagnostics 6 and 366, and non-integers;
    - it accepts the bounds themselves.
  - `settings.db.test.ts`:
    - after migrations, `get()` returns defaults and an empty history;
    - `update` with a blank reason → 400;
    - a valid update stores the values, adds one change row with `previous`/`next`, and writes `ops.settings_changed`;
    - a CHECK violation maps to 400;
    - `operations_state` has one row with `protective = false`;
    - `ops_alerts` refuses a second open episode for the same `kind` + `location`;
    - `email_outbox` accepts `status = 'not_sent_restored'`;
    - `operations_settings_changes` and `operations_state_changes` are append-only (UPDATE and DELETE raise).
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/settings*.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Write the migration**, as the §9 sketch made exact:
  - single-row tables seeded with `INSERT … DEFAULT VALUES`;
  - `kainow_append_only()` triggers on the `_changes` tables;
  - partial unique index `ops_alerts (kind, coalesce(location,'')) WHERE closed_at IS NULL`;
  - indexes `backup_runs (started_at DESC, id DESC)`, `restore_drills (started_at DESC, id DESC)`, `storage_readings (location, at DESC, id DESC)`.
- [ ] **Step 4: Implement** `settings.ts` and `settings.service.ts` by copying `access-settings.ts`/`access-settings.service.ts` (lock, validate, update, change row, audit, map 23514). Add both actions to `ACTIONS` and the `ops.settings_changed` catalogue entry.
- [ ] **Step 5: Run** the Step 2 command plus `node --test dist/analytics/catalogue.db.test.js`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(ops): operations schema, settings and permissions`.

### Task 2: Backup encryption format and backup key

**Files:**
- Create: `app/src/ops/crypto.ts`, `app/src/ops/crypto.test.ts`, `app/src/ops/backup-key-cli.ts`, `app/src/ops/backup-key-cli.test.ts`
- Modify: `app/package.json` (script `"backup-key": "node dist/ops/backup-key-cli.js"`)

**Interfaces:**
- Produces:
  - `loadBackupKey(path: string): { id: string; bytes: Buffer } | { error: 'key_missing' | 'key_invalid' }`. The id is the first 16 hex characters of the key's SHA-256, as in `quarantine/protected-key.ts`.
  - `encryptStream(key): Transform`, which emits `KNBK1` ‖ key id ‖ 12-byte salt, then 1 MiB chunks.
  - `decryptStream(key): Transform`, which errors with `BackupCryptoError` and `code: 'bad_magic' | 'wrong_key' | 'tampered' | 'truncated'`.
  - `sha256Stream(): Transform & { digest(): string }`, a pass-through hasher.
  - `runBackupKeyCli(args, io): number`, copying `runProtectedKeyCli`.

- [ ] **Step 1: Write failing tests.**
  - Round trip of 0 bytes, 1 byte, exactly 1 MiB and 3.5 MiB.
  - A different key → `wrong_key`.
  - A flipped bit in the header, in a chunk and in a tag → `tampered`.
  - The last chunk dropped → `truncated`.
  - Two chunks swapped → `tampered`.
  - A chunk spliced in from another file made with the same key → `tampered`.
  - The same plain input encrypted twice gives different ciphertext.
  - CLI: `--create <path>` writes 32 bytes with mode 0600 where supported, and prints only the path and the id; it refuses an existing file (exit 1); no arguments → exit 2.
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/crypto.test.js dist/ops/backup-key-cli.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Nonce:** chunk *i*'s nonce is HMAC-SHA-256(key, salt ‖ uint64be(i)), first 12 bytes.
  - **Additional data:** header ‖ uint64be(i) ‖ final-flag byte.
  - **Final chunk:** the last chunk has flag 1. An empty input still writes one final chunk.
  - **Chunk frame:** uint32be ciphertext length ‖ ciphertext ‖ 16-byte tag.
  - Put this construction in a comment at the top of `crypto.ts`.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): KNBK1 backup encryption and backup-key command`.

### Task 3: Ops container, client tools and command scaffolding

**Files:**
- Create: `app/src/ops/config.ts`, `app/src/ops/pg-tools.ts`, `app/src/ops/common.ts`, `app/src/ops/common.test.ts`, `app/src/ops/pg-tools.test.ts`, `app/src/ops/notify.ts`
- Modify: `app/Dockerfile` (new final-named target `ops`), `compose.yaml` (service `ops`, §4.1), `.github/workflows/ci.yml` (install `postgresql-client-16` from the PGDG apt repository before tests)

**Interfaces:**
- Produces:
  - **Config.** `loadOpsConfig(env): OpsConfig`, where `OpsConfig = { databaseUrl; backupDir; backupKeyFile; dbDataDir; protectedKeyFile: string | null; folderLabel: string }`. `folderLabel` is `KAINOW_BACKUP_DIR_LABEL`, or `/backups` if unset; Compose passes the host value of `KAINOW_BACKUP_DIR` as the label.
  - **Client tools.** `PgTools`, with `dump(args: string[]): ChildProcess`, `restore(args: string[]): ChildProcess`, `list(): ChildProcess` (`pg_restore --list` reading stdin) and `version(): Promise<number>` (major version). The binaries come from `KAINOW_PG_BIN` (a directory) or `PATH`. For local tests only, `KAINOW_TEST_PG_DOCKER=<container>` runs them via `docker exec -i <container>` and rewrites the connection to `127.0.0.1:5432` inside that container.
  - **Lock.** `withBackupLock<T>(pool, fn): Promise<T | 'busy'>`, a session advisory lock with constant key `hashtext('kainow.backup-folder')`.
  - **Failures.** `OPS_FAILURES: Record<FailureCode, string>`, holding the §4.3 codes and fixed texts. `FailureCode` is the union of those codes.
  - **Notices.** `notifyAdmins(db, { kind, summary, link, now, urgent: true }): Promise<void>`. It inserts one `notifications` row per id from `loadAdmins(db)`, with `email_off = false`, so `notifications/mailing.ts` emails them.
  - **Version.** `currentMigrationLevel(db): Promise<string>` (highest applied migration) and `codeMigrationLevel(): string` (highest file in `migrations/`).

- [ ] **Step 1: Write failing tests.**
  - `common.test.ts`:
    - every `FailureCode` has non-empty text;
    - no text contains `/` or `:` followed by digits (no paths or ports);
    - `loadOpsConfig` refuses a missing `KAINOW_BACKUP_DIR` with a message naming the variable, never its value.
  - `common.db.test.ts`: a second `withBackupLock` while the first is held returns `'busy'`.
  - `notify.db.test.ts`: `notifyAdmins` writes one row per Active administrator, `urgent = true`, `email_off = false`.
  - `pg-tools.test.ts`: `version()` returns 16. Skipped with the reason `"pg client tools not found"` when neither `KAINOW_PG_BIN`, `PATH` nor `KAINOW_TEST_PG_DOCKER` gives them; in CI (`process.env.CI`) skipping is a failure.
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/common*.test.js dist/ops/notify.db.test.js dist/ops/pg-tools.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules, then the Dockerfile target and the Compose service:
  - **Dockerfile target `ops`:** `FROM runtime AS ops`, then `USER root`, install `postgresql-client-16` via the PGDG apt source, then `USER node`. The existing default target stays the API image: place `ops` before the final stage, or keep the order and set `target: runtime` on `x-kainow`.
  - **Compose service `ops`:**
    - `profiles: [ops]`, `restart: "no"`, no `depends_on`, `build.target: ops`, `image: kainow-ops:0.0.0`;
    - volumes: `${KAINOW_BACKUP_DIR:?Set KAINOW_BACKUP_DIR in .env}:/backups`, `kainow-db:/pgdata:ro`, and commented key mounts following the protected-key comment style;
    - environment as in §4.1, plus `KAINOW_BACKUP_DIR_LABEL: ${KAINOW_BACKUP_DIR}`.
  - Run `docker compose --profile ops config` to validate.
  - **Check `statfs` on `/pgdata`** as uid 1000 (`docker compose --profile ops run --rm ops node -e "require('fs').statfsSync('/pgdata')"`), and record the result in the task report (§4.1 builder check).
- [ ] **Step 4: Run** the Step 2 command (locally with `KAINOW_TEST_PG_DOCKER=kainow-testdb`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): ops image, compose service and command scaffolding`.

### Task 4: The backup command

**Files:**
- Create: `app/src/ops/backup.ts`, `app/src/ops/backup-cli.ts`, `app/src/ops/backup.db.test.ts`, `app/src/ops/manifest.ts`
- Modify: `app/package.json` (`"backup": "node dist/ops/backup-cli.js"`), `app/src/analytics/catalogue.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `runBackup(argv, deps: { pool; config: OpsConfig; tools: PgTools; now(): Date; out; err; sourceFiles?: SourceFileCopier }): Promise<number>`;
  - flags `--kind daily|manual|pre_update` (default `manual`) and `--new-key`;
  - its last output line is `run <id> succeeded|failed <code>`;
  - `type Manifest = { formatVersion: 1; runId; tables: { schema; table; rows: number }[]; sourceFiles: { sha256; size; storedFileId; copied: boolean; reason?: string }[]; sourceArea: 'included' | 'not_in_use' }`;
  - `readSet(dir, key): Promise<{ summary: BackupSummary; manifest: Manifest }>`, where `BackupSummary` is the `backup.json` shape of §5.1;
  - `interface SourceFileCopier { copyAll(pool, key, filesDir): Promise<Manifest['sourceFiles']> }`. Task 15 provides it; until then `deps.sourceFiles` is undefined and the manifest says `'not_in_use'`;
  - audit actions `ops.backup_succeeded`, `ops.backup_failed`, `ops.backup_key_changed`.

- [ ] **Step 1: Write failing database tests** in `backup.db.test.ts`. They run against `kainow_test_sp10` with seeded rows and a temp backup folder; pg tools are required, with the same skip rule as Task 3.
  - **Successful run:**
    - writes `sets/<UTC yyyy-mm-ddTHHmmZ>-<kind>-<id>/` containing `backup.json`, `database.dump.enc` and `manifest.json.enc`;
    - the manifest row counts equal `SELECT count(*)` for each table in `public` and `pgboss`;
    - the `backup_runs` row has `succeeded`, sizes, `key_id`, `migration_level` and `source_area = 'not_in_use'`;
    - `ops.backup_succeeded` is written;
    - exit 0.
  - **Missing backup folder:** `folder_missing`, a failed row, one `backup_failed` notice per administrator, exit 1.
  - **Missing or wrong-length key:** `key_missing` / `key_invalid`.
  - **Changed key:** a key id differing from the last successful run → `key_changed`. With `--new-key` the run succeeds and `ops.backup_key_changed` is written.
  - **Lock held** (via `withBackupLock` in the test): output `Another backup or drill is running`, exit 1, no row written.
  - **Dump fails** (a fake `PgTools` whose dump exits 1): `dump_failed`. The set folder is renamed `…-incomplete` and has no `backup.json`.
  - **Read-back mismatch** (a fake writer that corrupts the file after the write): `verify_failed`.
  - **Pre-update kind:** `--kind pre_update` records kind `pre_update`.
  - **Failure text:** no stored `failure_detail` contains the temp folder path.
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/backup.db.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `runBackup`.** In order:
  1. Lock.
  2. Insert a `running` row.
  3. Check the folder (exists, writable via a probe file) and the key.
  4. Open a `REPEATABLE READ` transaction on a dedicated client, `SELECT pg_export_snapshot()`, and count rows per table in that transaction.
  5. Run `pg_dump --format=custom --snapshot=<id> --no-owner`. Pipe stdout through `sha256Stream`, then `encryptStream`, then `sha256Stream`, into `database.dump.enc.tmp`; rename it on success.
  6. Write the encrypted manifest.
  7. Verify: decrypt both files fully, compare hashes, and pipe the decrypted dump into `tools.list()`. Exit 0 is required.
  8. Write `backup.json` last.
  9. Update the row and write the audit event.
  - **Failure path:** in a `finally`, rename the set to `-incomplete`, set the row to failed with the code, write the audit event, call `notifyAdmins(kind 'backup_failed')`, and print the code text.
  - **Disk full:** map `ENOSPC` to `no_space`.
  - **Expiry hook:** expiry (Task 5) is called only after success.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): encrypted database backup command`.

### Task 5: Backup expiry

**Files:**
- Create: `app/src/ops/expiry.ts`, `app/src/ops/expiry.test.ts`, `app/src/ops/expiry.db.test.ts`
- Modify: `app/src/ops/backup.ts` (call `expireBackups` after success)

**Interfaces:**
- Produces:
  - `chooseExpired(sets: { name; runId; kind; finishedAt: Date; succeeded: boolean; incomplete: boolean }[], retentionDays: number, now: Date): string[]`, a pure function returning the set names to remove;
  - `expireBackups(pool, config, key, now): Promise<{ sets: number; files: number; filesSkipped: boolean }>`;
  - audit action `ops.backup_expired`, with counts in its detail.

- [ ] **Step 1: Write failing tests.**
  - `chooseExpired`:
    - keeps sets younger than the retention period;
    - removes older ones;
    - always keeps the newest succeeded set and the newest succeeded `pre_update` set, even when both are 400 days old;
    - removes `-incomplete` sets older than 1 day and keeps a 23-hour-old one;
    - a set exactly `retentionDays × 24h` old is kept, and one second older is removed.
  - DB test with three sets sharing files in `files/`:
    - after one set expires, files listed only by it are removed and shared files stay;
    - when one remaining manifest cannot be decrypted (corrupt it), no file is removed and `filesSkipped` is true;
    - expired rows get `expired_at`;
    - a failed backup run never calls expiry.
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/expiry*.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Sets:** read the set folders from disk, joined to `backup_runs` by run id. Folders without a row are treated as incomplete.
  - **Files:** collect the referenced SHA-256s from every remaining manifest before deleting anything under `files/`.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): backup retention and shared-file expiry`.

### Task 6: Backup status, episodes and the sweep's ops part

**Files:**
- Create: `app/src/ops/status.ts`, `app/src/ops/status.test.ts`, `app/src/ops/alerts.ts`, `app/src/ops/sweep-ops.ts`, `app/src/ops/sweep-ops.db.test.ts`
- Modify: `app/src/notifications/sweep.ts` (call `runOpsSweep(pool, now)` on every run, alongside `refreshChecklist`; it is exempt from protective pause)

**Interfaces:**
- Produces:
  - `backupStatus(runs: RunRow[], now: Date): { status: 'healthy' | 'last_failed' | 'target_exceeded' | 'none'; lastSuccess?: RunRow; lastAttempt?: RunRow }`;
  - `freshBackup(pool, now): Promise<{ ok: boolean; runId?: string; finishedAt?: Date }>`;
  - `openEpisode(db, kind, location | null, now): Promise<boolean>`, true only when it newly opened;
  - `closeEpisode(db, kind, location | null, now): Promise<boolean>`;
  - `runOpsSweep(pool, now): Promise<void>`:
    - marks `running` backup runs and drills older than 6 h as `failed` / `interrupted`, with an audit event;
    - opens or closes `backup_target_exceeded`, sending `notifyAdmins` on open;
    - sends `backup_recovered` when that episode closes because of a success;
    - opens `storage_check_missing` per location when the newest reading is older than 30 min;
    - expires `storage_readings` older than the diagnostic retention period;
    - pg-boss archive retention: if pg-boss exposes it as a runtime option, set it from the setting at worker start; otherwise document it as fixed in the hand-over note.

- [ ] **Step 1: Write failing tests.**
  - `status.test.ts`:
    - no runs → `none`;
    - success 23h59m ago → `healthy`;
    - success exactly 24h ago → `healthy`;
    - 24h + 1 s → `target_exceeded`;
    - latest failed with a success 2 h ago → `last_failed`;
    - a running row 6h + 1 s old counts as failed.
  - `sweep-ops.db.test.ts`:
    - two sweeps with the target exceeded → exactly one notice per administrator;
    - a success then closes the episode and sends `backup_recovered` once;
    - a storage reading 31 min old → one `storage_check_missing` per location;
    - readings older than the retention period are deleted, while `storage_daily` rows are untouched.
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/status.test.js dist/ops/sweep-ops.db.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** the Step 2 command plus `node --test dist/notifications/sweep.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): backup status, alert episodes and sweep checks`.

### Task 7: Storage check and entering protective mode

**Files:**
- Create: `app/src/ops/storage-check.ts`, `app/src/ops/storage-check-cli.ts`, `app/src/ops/levels.ts`, `app/src/ops/levels.test.ts`, `app/src/ops/storage-check.db.test.ts`
- Modify: `app/package.json` (`"storage-check"`), `app/src/analytics/catalogue.ts`

**Interfaces:**
- Produces:
  - `levelFor(usedPct: number | null, settings: OpsSettings): 'normal' | 'warning' | 'critical' | 'unknown'`;
  - `runStorageCheck(argv, deps: { pool; config; statfs(path): { total: number; free: number } | null; now; sourceArea?: () => Promise<{ used; quota: number | null } | null> }): Promise<number>`;
  - `enterProtective(db, reason: 'low_space' | 'restored_from_backup', detail, now)`;
  - audit actions `ops.protective_entered` and `ops.storage_level_changed`.

- [ ] **Step 1: Write failing tests.**
  - `levelFor` at 79.99 → normal, 80 → warning, 90 → critical, null → unknown.
  - DB tests:
    - **Readings:** each run writes a reading for `database_disk` and `backup_disk`, with `pg_database_size` in `extra`. A `statfs` returning null records `unavailable = true` with null bytes, never 0.
    - **Daily summary:** `storage_daily` upserts the max used and min free for the UTC+8 day.
    - **Warning:** a reading crossing 80% opens a `storage_warning` episode and notifies once; a second run notifies nothing more.
    - **Back to normal:** dropping below closes the episode silently.
    - **Below the floor:** free bytes of 5 GB − 1 on `database_disk` turns protective mode on, with reason `low_space`, a state-change row, `ops.protective_entered` and a `protective_mode_entered` notice. A second run changes nothing.
    - **Exactly at the floor:** free = 5 GB does not enter.
    - **Backup disk:** a low backup disk alone never enters protective mode.
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/levels.test.js dist/ops/storage-check.db.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The default `statfs` is `fs.statfsSync`, so total = `blocks*bsize` and free = `bavail*bsize`.
  - `sourceArea` is undefined until Task 15, and no `source_area` row is written.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): storage check, alert levels and protective entry`.

### Task 8: Protective mode in the API and worker, and Resume

**Files:**
- Create: `app/src/ops/state.ts`, `app/src/ops/protective.ts`, `app/src/ops/protective.http.test.ts`, `app/src/ops/resume.ts`
- Modify:
  - `app/src/auth/access.ts` (`AllowedWhenProtective`);
  - `app/src/auth/auth.guard.ts` (inject `OperationsState`; refuse unsafe methods before the `public` early return);
  - `app/src/auth/auth.controller.ts` (mark `request-code`, `verify`, `logout`, `logout-all`);
  - `app/src/worker/schedules.ts` and `app/src/worker/ai-worker.ts` (pause check);
  - the providers module that hosts `OrganisationState`.

**Interfaces:**
- Produces:
  - `OperationsState` (Nest injectable, plus a plain class usable by the worker) with `isProtective(): Promise<boolean>` and `current(): Promise<{ protective; reason; since }>`. It caches for 5 s; `invalidate()` clears the cache.
  - `ALLOWED_WHEN_PROTECTIVE_KEY` and `AllowedWhenProtective()`.
  - The refusal: `ServiceUnavailableException({ code: 'protective_read_only', message: <protective text> })`.
  - `resumeChecks(pool, now, settings): Promise<{ name: 'reading_fresh' | 'space_above_floor' | 'database' | 'migrations_current' | 'no_backup_running'; ok: boolean }[]>`.
  - `resume(pool, actorId, reason, now)`, which refuses (409) listing the failing checks. On success it clears the mode, writes a state-change row and `ops.protective_resumed`, and calls `notifyAdmins` for the other administrators.

- [ ] **Step 1: Write failing HTTP tests** (`startTestApp`, with protective mode set directly in the table):
  - **Writes refused:** a `POST` to a representative write route (create a project) → 503, `code: 'protective_read_only'`, the exact text.
  - **Reads allowed:** a `GET` still answers 200.
  - **Sign-in and sign-out:** `auth/request-code`, `auth/verify`, `auth/logout` and `auth/logout-all` still work.
  - **Public routes:** a public `POST` route other than auth is refused.
  - **Every route covered:** a test enumerates every route through Nest's discovery, and asserts that each non-GET route either has `AllowedWhenProtective` or is refused.
  - **GETs that write:** each GET handler found to write in the audit (Step 3) passes in protective mode without a 500.
  - **Resume:**
    - with no fresh reading → 409 naming `reading_fresh`;
    - with a fresh reading below the floor → 409 `space_above_floor`;
    - with a fresh reading at the floor and no running backup → 200, mode off, and the audit event written;
    - a non-administrator → 403.
  - **Worker:** with the mode on, a sweep tick does not call `runIfDue` but does call `runOpsSweep`; the analysis and quarantine handlers return without work; the email dispatcher still runs; AI jobs fetched are re-queued (`boss.fail` with retry, or never fetched via `offWork`; the implementer chooses and documents it) and not run.
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/protective.http.test.js dist/worker/*.test.js`. Expected: FAIL.
- [ ] **Step 3: Audit GET handlers that write.** `grep` the controllers for GET handlers that call INSERT, UPDATE or `writeAudit`. List each one in the task report with its decision: tolerate a refused write (catch the 503 and skip the write while protective), or mark it allowed when the write is essential.
- [ ] **Step 4: Implement.**
  - In the guard, put the protective check after reading `access` and before `if (access.kind === 'public')`. It applies only to non-safe methods and reads the marker from the handler and the class.
  - The resume endpoint (Task 11 owns the controller) calls `resume`; here, expose `resume` and test it through a temporary route in the test, or put the route in Task 11 and test `resume` directly with the database.
- [ ] **Step 5: Run** the Step 2 command. Expected: PASS. Then run the full HTTP subset `node --test dist/**/*.http.test.js` in the background. Expected: no new failures.
- [ ] **Step 6: Commit** `feat(ops): protective read-only mode in the API and worker`.

### Task 9: Restore drill and go-live step 8

**Files:**
- Create: `app/src/ops/drill.ts`, `app/src/ops/restore-drill-cli.ts`, `app/src/ops/sealed-checks.ts`, `app/src/ops/drill.db.test.ts`
- Modify: `app/src/golive/checklist.ts` (`backups` step `mode: 'auto'`; condition per §8.1, including the drill-again rule), `app/package.json`, `app/src/analytics/catalogue.ts`

**Interfaces:**
- Consumes: `readSet` (Task 4), `PgTools`, `withBackupLock`, `OperationsState`.
- Produces:
  - `runRestoreDrill(argv, deps: { pool; config; tools; statfs; now; out; err; protectedKey: ProtectedKey | null; checkSourceFiles?: (manifest, filesDir, key, sample?) => Promise<Check> }): Promise<number>`;
  - flags `--set <name>|latest`, `--keep`, `--drop <dbname>`, `--sample <n>`;
  - `type Check = { name: 'set_checksums' | 'decrypt' | 'migration_level' | 'space' | 'restore' | 'row_counts' | 'source_files' | 'sealed_ai_key' | 'sealed_quarantine' | 'sealed_storage_secret' | 'duration'; result: 'passed' | 'failed' | 'not_tested'; detail?: string }`;
  - `sealedChecks(drillPool, protectedKey): Promise<Check[]>`, which opens one sealed value per kind using the existing open functions (`src/ai/keys.ts` with its additional data; the quarantine original decrypt in `src/quarantine/`), discarding the plaintext;
  - `drillAgainReason(pool): Promise<null | 'key_changed' | 'folder_changed' | 'source_area_new'>`;
  - audit actions `ops.restore_drill_passed` and `ops.restore_drill_failed`.

- [ ] **Step 1: Write failing tests** (pg tools required; a temp backup folder holding a set made by `runBackup`):
  - **Full drill:** passes; the `restore_drills` row is `passed` with every check, `duration_seconds` is set, the temporary database `kainow_drill_*` is gone afterwards, and the live database is untouched (compare a row count before and after).
  - **`--keep`:** leaves the temporary database, recorded in `kept_database`; `--drop <name>` removes it and refuses names not starting `kainow_drill_`.
  - **Row counts:** a test hook that deletes a row in the drill database before the compare gives a `failed` row naming the table.
  - **Tampered set:** a flipped byte in `database.dump.enc` fails `set_checksums`.
  - **Wrong key:** the refusal text names the set's key id.
  - **Protective mode on:** refusal, exit 1, no row written.
  - **Space checks:**
    - the fake `statfs` free value below `pg_database_size × 1.2 + floor + 2 GB` → `drill_no_space`;
    - the free value dropping during the restore (on the second poll) → `drill_space_low`, and the temporary database is dropped.
  - **Sealed values:** with a sealed AI key seeded and no protected key → `sealed_ai_key` is `failed` and the drill counts as failed; with the key → passed; with no quarantine originals → `not_tested`.
  - **Sampled drill:** `--sample 1` records `sampled = true`.
  - **Go-live step 8:**
    - after a passed full drill, `refreshChecklist` ticks `backups`;
    - after a later backup with a new key id, `drillAgainReason` is `key_changed` and the step is unticked;
    - a sampled drill never ticks it.
  - **Over the target:** a drill whose duration is set over 4 h (an injected clock) is recorded as `passed_over_target` and does not tick the step.
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/drill.db.test.js dist/golive/*.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Flow:** §8.1 steps 1–10.
  - **Temporary database:** create it with `CREATE DATABASE kainow_drill_<first 8 of run id>` on the live connection, and restore with `pg_restore --no-owner --exit-on-error -d <drill url>`.
  - **Space polling:** poll space every 30 s while the restore runs (injectable interval for tests).
  - **Clean-up:** always drop the temporary database in `finally`, unless `--keep`.
  - **Unticking step 8:** if the checklist has no "untick by Kainow" path, add one in `refreshChecklist` for `backups` only, with a `golive_events` row `unticked` and actor null.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): restore drill, sealed-value checks and go-live step 8`.

### Task 10: Restore into an empty installation

**Files:**
- Create: `app/src/ops/restore.ts`, `app/src/ops/restore-cli.ts`, `app/src/ops/after-restore.ts`, `app/src/ops/restore.db.test.ts`
- Modify:
  - `app/package.json`;
  - `app/src/analysis/tick.ts` (the stall rule skips rows whose `failure_code = 'restored_from_backup'`);
  - `app/src/analytics/catalogue.ts`;
  - `app/web/src/` delivery status label, if Task 12 does not cover it (see Task 12).

**Interfaces:**
- Produces:
  - `runRestore(argv, deps): Promise<number>`, with flags `--set`, `--reason` (required, run through `refuseSecrets`);
  - `afterRestore(client, { setTime: Date; reason; now }): Promise<{ emails: number; jobs: number; work: Record<string, number> }>`;
  - audit action `ops.restored_from_backup`.

- [ ] **Step 1: Write failing tests.**
  - **Target not empty:** a target database with any table in `public`, or a `pgboss` schema, is refused with nothing changed.
  - **Successful restore** into a freshly created empty database: row counts match.
  - **`afterRestore`, seeded beforehand** with sessions, unused sign-in codes, a recovery link, queued and `retry_wait` emails, a running `ai_requests` row, a queued `analysis_runs` row, a queued `extraction_runs` row and queued pg-boss jobs:
    - no sessions or unused codes remain, and the link is expired;
    - the emails have status `not_sent_restored`;
    - the AI, analysis and extraction rows are `failed` with `failure_code = 'restored_from_backup'`;
    - their AI spend reservations are `uncertain`, not released;
    - the pg-boss jobs are `cancelled`;
    - protective mode is on with reason `restored_from_backup` and `detail.setTime`;
    - each administrator has an urgent notice;
    - `ops.restored_from_backup` is written.
  - **Stall rule:** a subsequent analysis tick does not rewrite those rows.
  - **Output:** the command prints the §8.2 operator text with the set time.
  - **Table list:** the task report lists every domain work table checked, including AI assist tables, quarantine cleaning and digest runs, and the state used for each.
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/restore.db.test.js dist/analysis/tick*.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** per §8.2. `afterRestore` runs in one transaction on the restored database. Ending `storage_outbox` rows is added in Task 15.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): restore into an empty installation without replaying work`.

### Task 11: Operations API and analytics panel

**Files:**
- Create: `app/src/ops/operations.service.ts`, `app/src/ops/operations.controller.ts`, `app/src/ops/ops.module.ts`, `app/src/ops/operations.http.test.ts`, `app/src/analytics/operations.service.ts`
- Modify:
  - `app/src/app.module.ts`;
  - `app/src/analytics/analytics.controller.ts` (`PANELS` adds `'operations'`);
  - `app/src/analytics/csv.ts` (`PanelData`, `EXPORT_PANELS`);
  - `app/src/analytics/views.service.ts` (`VIEW_PANELS`).

**Interfaces:**
- Produces:
  - **Overview.** `GET admin/operations` (`operations.view`) returns `OperationsView = { backups: { status; lastSuccess; lastAttempt; retentionDays; folderLabel; keyId; drillAgain: string | null; runs: RunRow[] /* 30, started_at DESC, id DESC */ }; drills: { last; earlier: DrillRow[] /* 10 */ }; storage: { location; totalBytes; freeBytes; usedPct; level; at; unavailable }[] + { safeFloorGb }; growth: storage_daily rows for 30 days; protective: { on; reason; since; setTime? }; health: { database: 'up'; migrationsCurrent: boolean; lastSweepAt; queues: { name; queued; active; failed24h }[] } }`.
  - **Settings.** `GET` and `PUT admin/operations/settings` (`operations.manage`, the settings service).
  - **Resume.** `POST admin/operations/resume` (`operations.manage`, `@AllowedWhenProtective`).
  - **Banners.** `GET operations/banner` (any signed-in person) returns `{ protective: boolean; admin?: { backups: status; storage: level-worst; text: string } }`, where `admin` is present for Enterprise Administrators only.
  - **Sign-in page.** `GET operations/public-state` (`@Public`, `@BeforeSetup`) returns `{ protective: boolean }`, for the sign-in page text.
  - **Analytics.** The `operations` panel data reuses `OperationsService.view()` without the run tables, plus counts of backups, failures and drills in the chosen period from `backup_runs` and `restore_drills`.

- [ ] **Step 1: Write failing HTTP tests.**
  - **Overview:** shape and ordering, with ties on `started_at` ordered by id.
  - **Permissions:** a Member gets 403 on `admin/operations` and on settings.
  - **Banner, protective mode:** shows `protective: true` to a Member but no `admin` key; an administrator gets `admin.text` when backups are `target_exceeded`.
  - **Public state:** answers before sign-in.
  - **Analytics:** `admin/analytics?panel=operations` answers for an administrator, and the CSV export includes it.
  - **No paths or key material:** the response never contains the backup folder's container path or any key material (assert no `/backups` and no 64-hex strings beyond key ids).
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/operations.http.test.js dist/analytics/*.http.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Health `queues` reads the pg-boss tables read-only, as `analytics/system.service.ts` does.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): operations API, banners and analytics panel`.

### Task 12: Web — Operations page, banners and panel

**Files:**
- Create: `app/web/src/operations.ts`, `app/web/src/operations.test.ts`, `app/web/src/views/Operations.tsx`, `app/web/src/views/analytics/OperationsPanel.tsx`
- Modify:
  - `app/web/src/App.tsx` (route `#/admin/operations`, top-bar link for administrators, banner between `</header>` and `<div id="main">` in both layouts, sign-in page protective line);
  - `app/web/src/analytics.ts` (`VIEW_PANELS`, `PANEL_LABELS`);
  - `app/web/src/views/Analytics.tsx`;
  - `app/web/src/views/Deliveries.tsx` (`not_sent_restored` → "Not sent — restored from backup");
  - `app/web/src/api.ts`, so that a 503 with `code: 'protective_read_only'` gives `ApiError` the server's message.

**Interfaces:**
- Consumes: Task 11's responses.
- Produces pure helpers in `operations.ts`:
  - `backupStatusWords(status)`: `'Healthy' | 'Last backup failed' | '24-hour recovery target exceeded' | 'No backup yet'`;
  - `levelWords(level)`;
  - `formatBytes(n | null)`, where null → `'Unavailable'`;
  - `bannerLines(banner, isAdmin): string[]`;
  - `growthTable(rows)`: `{ day; used; free }[]`, the table equivalent of the chart;
  - `resumeCheckWords(name)`.

- [ ] **Step 1: Write failing web tests** (`operations.test.ts`):
  - every status and level has words;
  - `formatBytes(null)` is `Unavailable` and `formatBytes(0)` is `0 B`;
  - `bannerLines` gives the exact protective sentence for everyone and adds the backup line only for an administrator;
  - `growthTable` sorts by day ascending.
- [ ] **Step 2: Run** `npm --prefix web test`. Expected: FAIL.
- [ ] **Step 3: Implement the screens** per §10:
  - summary strip first;
  - colour never the only signal;
  - chart with a visible table toggle;
  - the Resume form shows each check as passed or failed before Confirm, and needs a reason;
  - the settings form shows bounds, effective values and history, and needs a reason;
  - forms keep their text after a 503.
- [ ] **Step 4: Run** `npm --prefix web test && npm --prefix web run build`. Expected: PASS. Then a browser smoke against the dev server:
  1. Set protective mode in the database.
  2. Check the banner on a Member's page and the sign-in page, and that a save shows the refusal text.
  3. Resume as an administrator.
  4. Check the page at 375 px with no horizontal scroll.
- [ ] **Step 5: Commit** `feat(web): operations page, banners and analytics panel`.

### Task 13: Documents, INSTALL.md and the low-space verification

**Files:**
- Modify:
  - `docs/Kainow-V1.0-Consolidated-Product-Specification-and-Decision-Register.md` (D109–D116 rows, verbatim from §2.1);
  - `docs/Kainow-V1.0-Configuration-Catalogue.md` (C93–C99 per §15; C66, C70, C73 and C74 point to them);
  - `docs/Kainow-V1.0-Permission-Matrix.md` (§12 rows and the note on the existing row);
  - `docs/Kainow-V1.0-Remaining-Design-and-Verification-Register.md` (§6, §7, R17);
  - `INSTALL.md`;
  - `app/README.md`.
- Create: `docs/operations/verify-low-space.md`

- [ ] **Step 1: Rewrite INSTALL.md "Back up" as "Backups".**
  - **Contents:** `KAINOW_BACKUP_DIR` and the `chown 1000:1000` line; creating the backup key and keeping its recovery copy apart (with the custodian, apart from the protected key's copy); the three cron lines of §4.2 exactly; `MAILTO` or watching the log; status in Kainow; what the drill proves; the Windows Task Scheduler line.
  - **New "Restore from a backup" section:** the §8.2 order, exactly.
  - **"What this does and does not protect":** replace "restore has not been rehearsed" and the updater line ("Updates are manual until sub-project 10b").
  - **Line endings:** keep the PowerShell `>` warning, applied to any command that writes files.
- [ ] **Step 2: Write `verify-low-space.md`.**
  - **The procedure:** §7.4 exactly. The loop-mounted file system commands, the filler, the write script (a loop of authenticated POSTs with `curl`, using the documented test account `admin@example.org`), the expected observations and a results table.
  - **Running it:** if a Linux VM is available to the builder, run it and fill in the results. Otherwise record "Not yet run" in C96 and in the hand-over note for the PO.
- [ ] **Step 3: Check the documents.**
  - `grep` the new text for organisation names or domains other than `example.*` and `kainow.test`. Expected: none.
  - Check every cron line against the CLI file names in `app/package.json`.
- [ ] **Step 4: Commit** `docs: operations decisions, catalogue, matrix, INSTALL backups and restore`.

### Task 14: Measured aims

**Files:**
- Create: `app/src/ops/bench-cli.ts`
- Modify: `app/package.json` (`"bench-ops"`), `docs/superpowers/specs/2026-11-20-v1-operations-10a-design.md` (§13 results line)

- [ ] **Step 1: Implement `bench-ops`.**
  - **Seeding:** reuse the bench seeding of `src/dashboards/bench-cli.ts` (30k tasks) into `kainow_bench_sp10`.
  - **Timings:** time `runBackup`, `runRestoreDrill` and `runStorageCheck`.
  - **Guard overhead:** time 1,000 GET requests with `OperationsState` cached against a guard without the check, and report the p95 difference.
  - **Output:** each figure against its aim (backup < 10 min, drill < 30 min, check < 5 s, guard < 1 ms p95), with pass or miss.
- [ ] **Step 2: Run** `npm run build && KAINOW_TEST_PG_DOCKER=kainow-testdb npm run bench-ops` in the background. Expected: four lines with figures.
- [ ] **Step 3: Record** the figures in §13 and in the hand-over note, with any misses stated plainly.
- [ ] **Step 4: Commit** `docs: sub-project 10a bench figures`.

### Task 15: Source area (after sub-project 9 merges)

**Precondition:** sub-project 9 is on main. Rebase this branch onto main, resolving row conflicts in the register, matrix, catalogue and `app/README.md` by keeping both sides. Run the migrations from empty to check that 0031 and 0032 apply in order.

**Files:**
- Create: `app/src/ops/source-files.ts`, `app/src/ops/restore-source-files-cli.ts`, `app/src/ops/source-files.db.test.ts`
- Modify:
  - `app/src/ops/backup-cli.ts` (provide `SourceFileCopier` when a source area is approved);
  - `app/src/ops/drill.ts` (`checkSourceFiles`, `sealed_storage_secret`);
  - `app/src/ops/storage-check-cli.ts` (`sourceArea` reading);
  - `app/src/ops/after-restore.ts` (end `storage_outbox` rows);
  - `drillAgainReason` (`source_area_new`);
  - `INSTALL.md` (protected key required in `ops`; network access).

**Interfaces:**
- Consumes: sub-project 9's `stored_files`, its connector (`download`, `getItem`), the relocation routine and its quota call, all as merged. Read 9's §5.1, §5.2, §9 and its code before starting.
- Produces:
  - `SourceFileCopier.copyAll`;
  - `checkSourceFiles`;
  - `runRestoreSourceFiles(argv, deps)`, which re-uploads Missing stored source files from `files/` through the relocation routine and lists those it cannot find.

- [ ] **Step 1: Write failing tests** against 9's fake Graph server:
  - **First backup:** copies every `stored` source file once into `files/<2>/<sha>.enc`. The second backup copies none and lists all.
  - **Download failures:** a file that fails to download → run `failed` with `source_files_failed` and the count. A file already flagged Missing or Changed before the run → success, with "n source files already flagged in storage were not copied".
  - **No protected key:** with the source area in use → `protected_key_missing`.
  - **Drill:** decrypts and checks every listed file. A corrupted store file fails `source_files`. `sealed_storage_secret` passes with the key.
  - **Drill again:** a drill passed before the source area came into use → `drillAgainReason = 'source_area_new'`.
  - **Storage check:** writes a `source_area` reading, with the quota or `unavailable`.
  - **After restore:** `afterRestore` ends queued `storage_outbox` rows with the not-run reason.
  - **Re-upload:** `restore-source-files` re-uploads a file deleted from the fake drive and its reference updates. A file absent from the store is listed.
- [ ] **Step 2: Run** `npm run build && node --test dist/ops/source-files.db.test.js dist/ops/drill.db.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** using 9's interfaces as merged.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS. Then run the full server suite in the background (about 2 hours) and the web suite. Expected: all green.
- [ ] **Step 5: Commit** `feat(ops): back up and restore the protected source area`.

---

## After all tasks

- **Reviews:** a final whole-branch review on Opus, then one fix wave.
- **Hand-over note** (`sub-project-10a-build-handover.md`) in the shared notes folder, covering:
  - figures;
  - builder calls;
  - the GET side-effect audit;
  - the `statfs` result;
  - the low-space verification state;
  - open points for the PO.
- **Before the PR:** green server and web suites. Push and open the PR only when the PO says so.
