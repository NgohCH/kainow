# V1.0 sub-project 10a: operations — backups, restore drill, storage protection and the Operations panel — design

**Date:** 20 November 2026
**Status:** Approved by the Product Owner on 20 November 2026, including the D110, D113–D115 bounds and the measured aims.
**Builds on:** `main` at a33351c (sub-projects 1–8 merged). Branch `TheLord/vigilant-hawking-7ee526`. Sub-project 9 (external outputs and the managed source area) is being built in parallel on `TheLord/subproject-9-external-outputs-56227e` and is not merged.
**Reserved numbers:** migration `0032_operations.sql`; Decision Register D109–D118; Configuration Catalogue C93–C104. Sub-project 9 holds 0031, D100–D108 and C85–C92. Sub-project 10b (updater, release signing, load test, supported browsers) follows this one and takes the numbers after whatever 10a uses.
**Authority:**
- Intent Card "Accepted runtime direction" (daily encrypted backups, 30-day retention, 24-hour/4-hour targets "require actual verification") and its managed-sources paragraph (protective low-space behaviour).
- Product Summary §19 and §20.
- Consolidated Specification §19 A07, A09, A11 and §20 A13, A15–A19.
- Application Architecture and Operations Design §5, §7, §8.
- Managed Sources, Credentials, Storage and Recovery Rules §§2–7.
- Permission Matrix §8 ("Configure automatic backups/retention and initiate protected restore") and §9.
- Configuration Catalogue C66, C70–C74.
- Administrator Analytics rules (Operations row; §9 diagnostics and storage health).
- Remaining Design and Verification Register §6, §7 and R17 ("Operations panels stay with sub-project 10").
- The sub-project 9 design (`2026-11-20-v1-external-outputs-design.md` on its branch), §1 non-goals, §9 and §16: backup and restore of the source area are left to sub-project 10.

## 1. Purpose and the why

The accepted rules require daily encrypted backups, a proven restore, and protection from running out of disk. None of these exists. Today:

- A backup is a `pg_dump` command an operator types (INSTALL.md "Back up"), unencrypted, with no record in Kainow of whether it ran.
- INSTALL.md says that restoring "has not been rehearsed".
- Go-live checklist step 8 ("Configure daily encrypted backups and complete a test restore") is a box the Administrator ticks.
- Nothing watches disk space, so a full disk would stop PostgreSQL mid-write.

The real installation will run on a Linux VM or server in the cloud. Backups go to a place the organisation chooses, most likely a network share or a second disk. That disk may be offline at times.

10a makes backups real and visible, proves they restore, and protects the data when space runs out. 10b's updater builds on it: it needs "is there a fresh successful backup?" and a pre-update backup command.

### Goals

- A daily encrypted backup that contains everything Kainow needs to recover: the whole database, plus the files of the protected source area once sub-project 9 is merged. It is written to a folder the organisation chooses, apart from the running installation.
- Every backup run, successful or not, is recorded in Kainow. A missing or failed backup is never shown as healthy (A18).
- A restore drill, runnable at any time, that actually restores a backup into a scratch database and proves it complete. It also proves the protected key still opens sealed data, and measures the time against the 4-hour target. A passed drill closes go-live step 8.
- A documented restore into a new installation for a real disaster. The restored Kainow neither replays uncertain external effects nor carries on silently.
- Disk monitoring with 80% and 90% alerts, and a protective read-only mode before the database disk fills (A19). Leaving it needs an Administrator's confirmation.
- One Operations page for Administrators with backups, drills, storage, protective mode and health. It is also a panel in Administrator analytics.

### Non-goals (10a)

- The updater, release signing, maintenance mode for updates, the load test and the supported-browser matrix. These are 10b. 10a leaves the hooks 10b needs (§11).
- Backing up filed external outputs. The accepted rules say external project deliverables need their own backup arrangements (Architecture §5). The database backup keeps every output's references, so a restore re-links them.
- Point-in-time recovery (continuous log archiving). A daily logical backup meets the 24-hour data-loss target.
- High availability, replicas or automatic failover.
- Backing up to a cloud service from inside Kainow. The backup folder may itself be a mounted share; Kainow only writes to a folder.
- A "Back up now" or "Run drill" button in the browser. Both are server commands (§2).

### Anti-goals (failure even if it works)

- Kainow shows backups as healthy when the last one failed, never ran, or is older than 24 hours.
- A backup that cannot be decrypted, is missing tables or rows, or is missing source files, and is still reported as successful.
- The backup key or the protected key stored inside a backup, or in the database, a log or a screen.
- A restore drill that touches the live database.
- A restore that silently re-sends emails, repeats AI requests or re-files outputs that may already have happened after the backup was taken. Equally, a restore that quietly brings back access revoked after the backup, without telling anyone.
- Kainow deleting any retained record or evidence to free space. Only expired backup copies and expired diagnostics are ever removed.
- Protective mode that turns itself off, or leaves people unable to sign in and read.

## 2. Decisions taken with the Product Owner (20 November 2026)

| Topic | Decision |
|---|---|
| Hosting | The real installation runs on a Linux VM or server in the cloud, under Docker Compose. |
| Backup location | Configurable: a folder on the server, usually a mounted network share or a second disk that may be offline. |
| Split | Sub-project 10 is split: **10a** backups, restore drill, storage protection and the Operations panel; then **10b** updater (an updater container inside Compose, A02), release signing, load test and supported browsers. |
| Releases (for 10b) | The PO tags releases on GitHub and is the only publisher. Installations check on a regular interval and on demand. |
| Delivery | **One PR after sub-project 9 merges.** The work not tied to 9 may be built first on this branch, but 10a is opened as a single PR only once 9 is on main and the source-area tasks (§5.4, §7.1 source reading, `restore-source-files`) are built on 9's merged interfaces. |
| Who runs backups | **C: scheduled from the server.** The server's cron runs Kainow's own commands in one-shot containers (`docker compose run --rm ops …`). There is no always-running backup service, and the API and worker never hold the backup key or the backup folder. Each command records its result in Kainow, which raises the warnings. |

### 2.1 New Decision Register entries

| ID | Decision |
|---|---|
| D109 | **Backups** (20 November 2026). A backup is taken by Kainow's backup command, which the server runs on a schedule (daily by default) and before every update. It writes to one backup folder the organisation chooses, apart from the running installation. Each backup holds a complete logical copy of the database and, once the protected source area exists, every source file it references. Everything is encrypted with a backup key kept outside the database, its backups and the protected key; designated Administrators keep a recovery copy of it apart from the backups. Each run is recorded in Kainow with its start, finish, outcome, size and checksums, and only a run whose files were written, read back and checked counts as successful. |
| D110 | **Backup retention** (20 November 2026). Backups are kept for 30 days by default; the Enterprise Administrator may set 7 to 365 days, with a reason. The most recent successful backup and the most recent successful pre-update backup are always kept, whatever their age. Expiry removes only backup copies, never live data or history. Source files shared by several backups are removed only when no kept backup needs them. |
| D111 | **Backup status and failures** (20 November 2026). Kainow shows the last successful backup, the last attempt and whether the 24-hour recovery target is met. When a run fails, or when no successful backup is younger than 24 hours, every Enterprise Administrator receives an urgent notice by email and in Kainow, once per episode. A warning stays on every Administrator page until a fresh backup succeeds. Existing work continues. Updates are refused until a successful backup younger than 24 hours exists. A run still unfinished after 6 hours counts as failed (interrupted). |
| D112 | **Restore drill and restore** (20 November 2026). The restore drill restores a chosen backup (the latest by default) into a temporary separate database and never touches the live one. It checks the decryption, that every table's row count matches the count recorded at backup time, that every source file's checksum matches, and that the protected key opens one sealed value of each kind present; it then measures the time against the 4-hour target and removes the temporary database. The result is recorded in Kainow. A passed drill completes go-live step 8. Kainow asks for a new drill after the backup key or backup folder changes. A real restore goes into a new, empty installation only. It then starts in protective read-only, invalidates every session and sign-in code, and does not send queued emails or repeat queued AI, storage or other external work: queued emails show "Not sent — restored from backup" in the delivery history, and queued AI, analysis, extraction and storage work ends with the reason "Not run — restored from backup", AI reservations staying uncertain. Administrators are told the time of the backup restored from and that access changes made after it are lost and must be checked. An Administrator resumes normal use. |
| D113 | **Storage monitoring** (20 November 2026). Kainow measures, every five minutes by default, the used and free space of the disk holding the database and of the backup folder's disk, the database size, and the size and quota of the protected source area where the provider reports a quota ("Unavailable" otherwise, never zero). An Enterprise Administrator sets the warning level (default 80%, 50–95) and the critical level (default 90%, above the warning level, up to 99). Reaching a level sends one notice to every Enterprise Administrator, by email and in Kainow, per episode. A missing check (none for 30 minutes) is itself shown as a warning. |
| D114 | **Protective read-only mode** (20 November 2026). When free space on the database disk falls below the safe floor, Kainow enters protective read-only mode at once. The safe floor is a set amount (default 5 GB, 1–1,000 GB), verified on a test installation. In this mode people can still sign in and out and read everything they may read. Every other change is refused with "Kainow is read-only for now to protect your data. Nothing you have saved is affected." Background work (AI, analysis, reminders, digests, storage, imports) waits with its queue kept. Sign-in codes and urgent operations notices are still emailed, and backups still run. Retained data is never deleted to free space. The mode never ends by itself. An Enterprise Administrator chooses Resume, with a reason, and Kainow accepts it only when a check in the last 10 minutes shows free space at or above the floor and the health checks pass. A banner tells everyone while the mode is on. |
| D115 | **Routine diagnostics** (20 November 2026). Routine technical diagnostics kept by Kainow (storage readings, job-queue archives, backup command logs) are kept for 30 days by default; the Enterprise Administrator may set 7 to 365 days, with a reason. Business records, history, audit and security events, analytics events, backup and drill results and daily storage summaries are kept indefinitely and never expire with diagnostics. Container logs are rotated by size by Docker (three files of 10 MB per service) and documented as such. |
| D116 | **Operations settings and authority** (20 November 2026). Only an Enterprise Administrator changes operations settings (backup retention, storage alert levels, safe floor, diagnostic retention) or resumes from protective mode, each with a reason, recorded with previous and new values. Operations status is visible to Enterprise Administrators only. Running backups, drills and restores are server operations, done by whoever operates the server under the organisation's procedure; Kainow records each run but has no web control to start them. The numeric bounds in D110, D113, D114 and D115 were proposed by this design and approved by the Product Owner on 20 November 2026. |

D117 and D118 stay reserved for decisions found while building.

## 3. Concepts

- **Ops commands**: Node commands in the Kainow code base, run by the server's cron as one-shot containers of a new Compose service `ops`. The service has the Compose profile `ops`, so `docker compose up` never starts it. The commands are `backup`, `restore-drill`, `restore`, `storage-check` and `backup-key`.
- **Backup set**: one backup. It is a folder under the backup folder, holding the encrypted database dump, an encrypted manifest and a plain summary.
- **File store**: one shared folder of encrypted source files, each stored once under its SHA-256, referenced by the backup sets' manifests.
- **Backup key**: 32 random bytes in a file, mounted read-only into the `ops` container only. It is identified by a key id: the first 16 hex characters of its SHA-256, the same rule as the protected key.
- **Operations state**: one database row that says whether protective read-only mode is on, why, since when and by whom. The API, worker and ops commands all read it.

## 4. The `ops` container and the server schedule

### 4.1 Image and Compose service

- **Image:** a new Dockerfile target `ops`, built from the existing `runtime` stage. It adds the PostgreSQL 16 client tools (`pg_dump`, `pg_restore`, `psql`) from the PostgreSQL project's apt repository, because Debian bookworm's own `postgresql-client` is version 15 and cannot dump a version 16 server. The `api` and `worker` images are unchanged. The image name is `kainow-ops:<version>`.
- **Compose service `ops`:**
  - `profiles: [ops]`;
  - `<<: *kainow` (read-only root, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp`);
  - `restart: "no"`, and no ports.
- **Environment:** `DATABASE_URL`, `KAINOW_BACKUP_DIR=/backups`, `KAINOW_BACKUP_KEY_FILE=/run/secrets/kainow-backup.key`, `KAINOW_DB_DATA_DIR=/pgdata`, `KAINOW_PROTECTED_KEY_FILE`. *Design call:* the protected key is required once the protected source area is in use, because the backup downloads source files through sub-project 9's connector, whose secret is sealed with the protected key; the drill also uses it. Without it such a backup fails with `protected_key_missing`. No email variables: `ops` never sends email itself, only writes outbox rows (§6.3).
- **Network and start order:** `ops` needs outbound access to the storage provider once the source area is in use. It has no `depends_on`, because a restore runs with only `db` started (§8.2).
- **Volumes:**
  - `${KAINOW_BACKUP_DIR:?Set KAINOW_BACKUP_DIR in .env}:/backups` (read-write);
  - `kainow-db:/pgdata:ro`, used only to measure the database disk;
  - the backup key file, read-only;
  - the protected key file, read-only.
- **Folder ownership:** the backup folder must be writable by the container user (uid 1000, `node`). INSTALL.md gives the `chown` line. *Builder check:* confirm `statfs` on `/pgdata` works for uid 1000 on a `postgres:16` volume, whose data directory is mode 0700 and owned by uid 999. If it does not, mount the volume's parent or measure through a `df` run in the `db` container, and record which.

### 4.2 Server schedule (documented in INSTALL.md)

A crontab for the Kainow folder, with the lines given exactly:

```
# Daily backup at 02:00 server time
0 2 * * *   cd /opt/kainow && docker compose --profile ops run --rm ops node dist/ops/backup-cli.js --kind daily >> /var/log/kainow-ops.log 2>&1
# Storage check every five minutes
*/5 * * * * cd /opt/kainow && docker compose --profile ops run --rm ops node dist/ops/storage-check-cli.js >> /var/log/kainow-ops.log 2>&1
# Monthly restore drill (recommended), 03:30 on the 1st
30 3 1 * *  cd /opt/kainow && docker compose --profile ops run --rm ops node dist/ops/restore-drill-cli.js >> /var/log/kainow-ops.log 2>&1
```

The INSTALL.md wording for these lines:

- The schedule is the server's. Kainow does not need to know the backup time: it judges freshness against the 24-hour target alone.
- `/opt/kainow` is a placeholder for the Kainow folder.
- For a Windows test computer, give the matching Task Scheduler action in one line, and note that real installations run on Linux.

### 4.3 Commands, common rules

- Each command is a thin `-cli.ts` file over a `run…(argv, deps)` function that returns its exit code, following the `recover-admin` pattern: own arguments, fixed message strings, pool closed in `finally`.
- Exit codes: 0 succeeded, 1 refused or failed, 2 usage.
- Output is plain lines. It never contains a key, a key's bytes, a secret, file content or a database password.
- Every run of `backup`, `restore-drill` and `restore` writes its own row (§9) and an audit event (`ops.backup_succeeded`, `ops.backup_failed`, `ops.backup_expired`, `ops.restore_drill_passed`, `ops.restore_drill_failed`, `ops.restored_from_backup`), with the run id and no secrets. `storage-check` writes readings, plus audit events only when the state changes (§7).
- `backup` and `restore-drill` take a PostgreSQL advisory lock (one constant key for "backup folder"), so two never write the backup folder at once. A second run refuses at once with "Another backup or drill is running" and records nothing.
- **Failure messages are fixed and specific.** They are stored as a code plus fixed text, never raw error output (which can carry paths or connection strings). The codes:

  | Code | When |
  |---|---|
  | `folder_missing` | The backup folder is missing or not mounted. |
  | `folder_not_writable` | The backup folder cannot be written. |
  | `key_missing` | The backup key file is missing. |
  | `key_invalid` | The backup key file is not exactly 32 bytes. |
  | `key_changed` | The key id differs from the last successful backup's (§5.6). |
  | `no_space` | The backup folder's disk ran out of space. |
  | `dump_failed` | `pg_dump` failed. |
  | `verify_failed` | Reading back the written files did not match. |
  | `source_files_failed` | Some source files could not be copied (§5.4). |
  | `protected_key_missing` | The source area is in use but no protected key is mounted. |
  | `database_unreachable` | The database could not be reached. |
  | `drill_no_space` | The drill's space check before restoring failed (§8.1). |
  | `drill_space_low` | Free space fell too low during the drill (§8.1). |
  | `drill_database_failed` | The drill's temporary database could not be created or written. |
  | `interrupted` | Set by Kainow, not the command (§6.1). |

## 5. Backups (D109, D110)

### 5.1 Layout of the backup folder

```
<backup folder>/kainow/
  sets/
    2026-11-21T0200Z-daily-<run id>/
      backup.json            plain: format version, run id, kind, started/finished, key id, Kainow version,
                             migration level, database bytes, file count, sha256 of each .enc file
      database.dump.enc      pg_dump custom format, encrypted
      manifest.json.enc      encrypted: table row counts, source file list (sha256, size, stored-file id)
  files/
    ab/abcd…ef.enc           one encrypted source file per SHA-256, shared by all sets
  drill/                     nothing is written here except temporary files the drill removes
```

- The set name sorts by time. A set that does not finish is left as `…-incomplete` and removed at the next expiry.
- `backup.json` holds nothing sensitive and lets an operator see what a set is without the key.

### 5.2 Encryption format

The format is Kainow's own, using Node `crypto` only, so there is no extra tool:

- **Header:** magic `KNBK1`, the key id, and a random 12-byte file salt. Each chunk's key is the backup key itself; each chunk's nonce is derived as HMAC-SHA-256(backup key, salt ‖ chunk index), truncated to 12 bytes. *Builder may choose an equivalent unique-nonce construction, and must document it.*
- **Body:** 1 MiB chunks, each sealed with AES-256-GCM. Its additional authenticated data is the header, the chunk index and a "final chunk" flag, so truncation, reordering and swapping chunks between files are all detected.
- **Streaming:** `pg_dump` output streams through the encryptor to disk, so no plain copy ever touches disk or `/tmp`.
- **Checksums:** both the plain stream's and the encrypted file's SHA-256 are recorded.
- **Tests:** round trip; a wrong key; a flipped bit in each part; a dropped final chunk; a reordered chunk; a chunk spliced in from another file. Each must fail with a distinct error.

### 5.3 Database part

The command:

1. Opens a `REPEATABLE READ` transaction and calls `pg_export_snapshot()`.
2. Counts the rows of every table in the `public` and `pgboss` schemas inside that transaction.
3. Runs `pg_dump --format=custom --snapshot=<id>` against the same snapshot, so the counts in the manifest are exactly the dump's counts.
4. Records the migration level (the highest applied migration), which the drill checks.

The dump covers the whole database, including the pg-boss schema, so queued jobs are in the backup. A restore deals with them (§8.2).

### 5.4 Source-area part (needs sub-project 9)

This part is built after sub-project 9 merges, as the last task of 10a.

- **Which files:** the command reads sub-project 9's `stored_files` rows for source files (originals and text) in state `stored`.
- **Copying:** for each SHA-256 not yet in the file store, it downloads the file through sub-project 9's connector, checks its SHA-256, encrypts it and writes `files/<2>/<sha>.enc`. It is written to a temporary name and renamed only after the check.
- **What the manifest lists:** every source file that the database refers to at that moment, whether newly copied or already in the store.
- **Outputs:** output files are not copied (non-goal).
- **When files can't be copied:** files that cannot be downloaded (Missing, Changed in storage, Access denied, unreachable) are listed in the manifest as not copied. The run then fails with `source_files_failed`, naming the count, because a backup without its sources is incomplete (Managed Sources rules §2).
  - *Exception:* files sub-project 9 has already flagged Missing or Changed in storage before the run do not fail it. They cannot be backed up from any source, and they are already reported. The run succeeds and shows "n source files already flagged in storage were not copied".
- **Before sub-project 9:** before 9 merges, or while no source area is approved, uploaded originals are still in the database (`source_versions.original_bytes`). They are therefore in the database part, and the manifest says "Source area: not in use".
- **Pace:** the copy is incremental; the first run copies everything. There is no cap; the drill measures how long a full restore takes.

### 5.5 Checks before a backup counts as successful

1. Every `.enc` file is read back from the folder and decrypted (`database.dump.enc` and `manifest.json.enc` in full; for newly written source files, each one). The SHA-256s must match what was written.
2. `pg_restore --list` runs on the decrypted dump stream, which proves the dump is a readable custom-format archive.
3. `backup.json` is written last. A set without it is incomplete.

Only then is the run recorded as successful.

### 5.6 Backup key

- **Creating it:** `npm run backup-key -- --create <path>` (and the `ops` container equivalent). This copies the `protected-key` command's rules: it refuses to overwrite, and prints only the path and the key id.
- **Where it lives:** in a file on the server, mounted into `ops` only, never into `api` or `worker`.
- **Key changes:** a backup run whose key id differs from the last successful backup's refuses with `key_changed`, unless `--new-key` is given. With it, the run proceeds; earlier sets stay readable only with the earlier key. Kainow records the change (audit `ops.backup_key_changed`, key ids only) and asks for a new drill (§8.1).
- **INSTALL.md wording:** keep a recovery copy of the backup key apart from the backups and apart from the protected key's copy, for example with the recovery custodian. A backup without its key is useless, and the key alone gives nothing.
- **Key ids on screen:** the Operations page shows the key id of the latest backup, and whether the protected key was present for the last drill. It never shows key material.

### 5.7 Expiry (D110)

After each successful backup, the same command expires backups:

1. **Sets:** it removes sets older than the retention period, except the most recent successful set and the most recent successful pre-update set. It also removes `-incomplete` sets older than one day.
2. **Files:** it then removes files in `files/` that no remaining set's manifest lists. A file is removed only after every remaining manifest has been decrypted and read; if any cannot be read, file removal is skipped for that run and noted.
3. **Recording:** each removed set's run row gets `expired_at`, and the action is recorded as `ops.backup_expired`, with counts only.

Expiry never runs after a failed backup, so a run of failures cannot remove the last good copy.

### 5.8 Kinds

| Kind | When |
|---|---|
| `daily` | From cron. |
| `manual` | An operator runs it by hand. |
| `pre_update` | Run by 10b's updater. The flag exists in 10a and is tested. |

## 6. Backup status, warnings and notices (D111)

### 6.1 Status

Computed on every read, from `backup_runs`:

| Status | Rule | Shown |
|---|---|---|
| Healthy | The last finished run succeeded, and it finished within the last 24 hours. | Green. |
| Last backup failed | The latest finished run failed, and a success exists within the last 24 hours. | Amber, with the failure text. |
| Target exceeded | No success within the last 24 hours. | Red, "24-hour recovery target exceeded", with the time of the last success. |
| No backup yet | No successful run ever. | Red. |

- **Interrupted runs:** a run still `running` after 6 hours is shown as failed with `interrupted`. The sweep sets it once, writing the outcome and the audit event.
- **Function for 10b:** `freshBackup(now): { ok: boolean; runId?; finishedAt? }` returns `ok` only when a successful run finished within 24 hours.

### 6.2 Where it shows

- **On the Operations page**, which shows:
  - the status;
  - the last success (time, kind, size, file count);
  - the last attempt;
  - the retention period;
  - the backup folder's label (`KAINOW_BACKUP_DIR` as given, never the full host path from inside the container);
  - the key id;
  - the last 30 runs, in a table.
- **A banner for Administrators.** Unless the status is Healthy, a banner appears on every page an Enterprise Administrator sees, under the top bar. It reads, for example, "Backups: 24-hour recovery target exceeded. Last successful backup 21 Nov 02:04." and links to the Operations page. Others never see it.
- **Before any backup exists:** the go-live checklist page shows the same status.

### 6.3 Notices

**Kinds:** `backup_failed` (each failed run, at most one per run), `backup_target_exceeded` (once per episode), `backup_recovered` (the first success after either). They go to every Active Enterprise Administrator, urgent, in Kainow and by email.

**Who notices what:**

- **The backup command itself** writes the `backup_failed` notice and its email outbox rows when it fails, before exiting. This works even if the worker is down; the email then waits in the outbox. *Design call:* `ops` never sends email directly, so it holds no email secrets. While the worker is down, the failure is visible in Kainow and in the cron log, and the email goes when the worker returns.
- **The sweep** detects "target exceeded", sends that notice once (one row per episode in `ops_alerts`, §9), and closes the episode on recovery.

**When the database is unreachable:** if the backup command cannot reach the database at all, it can record nothing. It writes the failure to its own output, which cron sends to `/var/log/kainow-ops.log`. Kainow then shows Target exceeded once 24 hours pass, which is the honest signal. INSTALL.md says to monitor that log or set cron's `MAILTO`.

## 7. Storage monitoring and protective mode (D113, D114)

### 7.1 Readings

Each `storage-check` run records one reading per location in `storage_readings`:

| Location | Measured |
|---|---|
| `database_disk` | `statfs` on `/pgdata`: total and free bytes. Also `pg_database_size`. |
| `backup_disk` | `statfs` on `/backups`: total and free bytes. Also the size of `kainow/`, measured incrementally from the sets' recorded sizes, not by walking the tree. |
| `source_area` | The total size of `stored`, used and quota as sub-project 9's storage page gets them, or "Unavailable". |

The `source_area` reading is added when sub-project 9 merges, in the same final task as §5.4.

Rules:

- A location that cannot be measured records `unavailable`, never zero.
- The percentage used is (total − free) / total.
- **Retention:** readings are diagnostics (D115) and expire after the diagnostic retention period. A daily summary (largest used, smallest free, per location, per UTC+8 day) goes in `storage_daily`, kept indefinitely, for growth charts.

### 7.2 Alert levels

For each location, the level is computed from the latest reading:

| Level | When |
|---|---|
| Normal | Below the warning level. |
| Warning | At or above the warning level. |
| Critical | At or above the critical level. |
| Unknown | No reading in the last 30 minutes. |

- **Notices:** the change into Warning, Critical or Unknown sends one urgent notice per location per episode to every Enterprise Administrator, in Kainow and by email. Kinds: `storage_warning`, `storage_critical`, `storage_check_missing`. The check that sees the change sends it, through `ops_alerts`. The sweep detects Unknown, because a missing check cannot report itself. Falling back to Normal closes the episode silently.
- **Shown:** on the Operations page and in the Administrator banner.

### 7.3 Protective read-only mode

**Entering it.** When the database disk's free space is below the safe floor, `storage-check` turns the mode on in the same transaction as its reading, if it is not already on:

- The safe floor is the setting alone. *Design call:* it is not tied to the backup size, because the backup folder is normally on another disk, and a backup folder that fills simply fails the backup (D111).
- It records `operations_state.protective = true`, `reason = 'low_space'`, `since`, the reading.
- It writes the audit event `ops.protective_entered` and sends the urgent notice `protective_mode_entered` to every Enterprise Administrator.

**API.** `AuthGuard` refuses every request whose method is not `GET`, `HEAD` or `OPTIONS` while the mode is on, unless the handler carries the new marker `@AllowedWhenProtective()`.

- **Allowed while on:** `auth/request-code`, `auth/verify`, `auth/logout`, `auth/logout-all`, and `admin/operations/resume`.
- **The refusal:** status 503, body `{ code: 'protective_read_only', message: <the D114 text> }`.
- **Public routes too:** the check runs before the `@Public` early return, so public routes are covered.
- **Reading the state:** the API reads it through a cache like `OrganisationState`, refreshed at most every 5 seconds.
- **GET handlers that write as a side effect:** for example, marking notices read or recording an export. They must either tolerate a refused write or be listed. *The builder audits every GET handler that writes, and lists the decisions in the plan.*

**Worker.** Every queue handler and scheduled tick checks the state first. While the mode is on it does nothing, and the job stays queued for later or the tick returns:

- **Paused:** AI, analysis, document, sweep (except the ops part of §6.3 and §7.2), quarantine cleaning and sub-project 9's storage queue.
- **Keeps running:** email sending, so that sign-in codes and urgent notices go out.

**Ops commands while on.**

- `backup` still runs.
- `restore-drill` refuses with "Protective mode is on; run the drill once space is restored", because the drill needs space for its temporary database.
- `storage-check` keeps measuring.

**Resume.** On the Operations page an Enterprise Administrator chooses **Resume normal use** and gives a reason. Kainow accepts only when all of these hold:

- the latest `database_disk` reading is younger than 10 minutes, and its free space is at or above the safe floor;
- the database answers;
- the migration level matches the code;
- no backup run is `running`.

Otherwise it refuses and names each failing check. Resuming clears the mode, records the audit event `ops.protective_resumed` with the reason, and notifies the other Enterprise Administrators.

**Everyone else.**

- While the mode is on, a banner on every page for every signed-in person reads "Kainow is read-only for now to protect your data. You can read everything; changes are paused." The same text appears on the sign-in page.
- Forms show the 503 message in their usual error place. No form loses its typed text, because the existing recoverable-draft handling covers a failed save.

**Retained data is never deleted.** Protective mode deletes nothing. Expiry of backups (§5.7) and of diagnostics (D115) runs on its usual schedule only.

### 7.4 Verifying the floor

The accepted rules require a tested threshold, not an invented one. The build includes `docs/operations/verify-low-space.md`, a scripted check on a Linux VM:

1. Put the Docker volume for the database on a small loop-mounted file system (for example 3 GB).
2. Fill it with a filler file while a script keeps writing through the API.
3. Show that protective mode starts before PostgreSQL reports "No space left on device", that no write is half-done, and that reading and signing in keep working.

The automated tests simulate disk readings through an injectable `statfs`. The measured result goes into the Configuration Catalogue entry (C96) as "Verified on …" or as a recorded gap for the PO.

## 8. Restore drill and restore (D112)

### 8.1 Restore drill (`restore-drill`)

`restore-drill [--set <name>|latest] [--keep]`

1. **Refusals.** It refuses when protective mode is on, when no successful set exists, or when the set's key id differs from the mounted backup key's ("This backup was made with key <id>; mount that key to drill it").
2. **Check the set.** It checks every `.enc` file's SHA-256 against `backup.json`, decrypts the manifest, and confirms the set's migration level is not newer than the code's.
2a. **Space (design call).** The temporary database lives on the database disk.
   - **Before restoring:** the drill refuses with `drill_no_space` unless the free space on the database disk is at least the live database's size (`pg_database_size`) × 1.2, plus the safe floor, plus 2 GB.
   - **While restoring:** it checks free space every 30 seconds. If it would fall below the safe floor plus 2 GB, it stops, drops its database and fails with `drill_space_low`.
   - This means the drill never triggers protective mode itself.
3. **Temporary database.** It creates `kainow_drill_<run id short>` on the same server (the `kainow` role creates databases under the provided Compose setup; *builder verifies*). If `pg_restore` cannot write there, the drill fails as `drill_database_failed`.
4. **Restore.** It streams the decrypted dump into `pg_restore --no-owner --exit-on-error`. The time is measured from here.
5. **Row counts.** It compares every table's row count with the manifest; any difference fails the drill and is listed by table name.
6. **Source files.** It decrypts each file the manifest lists from `files/` and checks its SHA-256. All are checked (completeness matters more than speed); `--sample <n>` exists for a quick check and records "sampled n of m", and a sampled drill does not count for go-live step 8.
7. **Protected key.** In the temporary database it finds one sealed value of each kind present: AI connection key (sub-project 6), quarantine original (sub-project 5), and storage connection secret (sub-project 9, once merged). It opens each with the mounted protected key, using each kind's existing open function and its additional data, and discards the plain value at once. The result per kind is Passed, Failed, or Not tested (none present, or no protected key mounted).
8. **Time.** It stops the clock and records the duration and whether it is under 4 hours.
9. **Clean up.** It drops the temporary database, unless `--keep` is given (for an operator's own inspection; it is listed on the Operations page until dropped by `restore-drill --drop <name>`).
10. **Record.** It records the result in the live database's `restore_drills`, with the checks as structured results, and writes the audit event `ops.restore_drill_passed` or `ops.restore_drill_failed`. A failure sends the urgent notice `restore_drill_failed` to the Enterprise Administrators.

**What counts as passed:**

- decryption, row counts and the full file check all passed;
- the protected key passed for every kind present. Not tested is allowed when no sealed value of that kind exists, but not when one exists and no protected key was mounted;
- the duration is under 4 hours. Over 4 hours, the drill is recorded as "Passed — over the 4-hour target" and counts as failed for go-live.

**Go-live step 8:** the `backups` step becomes `mode: 'auto'`, done when a passed full drill exists whose set was successful.

**Drill again:** the Operations page shows "Drill again: …" in three cases:

- the key id differs from the last passed drill's set;
- the backup folder label differs from that set's;
- the source area came into use after that drill. A drill passed before sub-project 9's source area existed did not cover source files.

In each case go-live step 8 is unticked until a new drill passes.

### 8.2 Restore into a new installation (`restore`)

**When it's for:** a real disaster, following INSTALL.md "Restore from a backup".

**Steps:**

1. **Start-up order.**
   1. The operator makes a new Compose project (as in "Going live") and sets the backup folder and both keys in `.env`.
   2. They start **only the database**: `docker compose up -d db`.
   3. They run `docker compose --profile ops run --rm ops node dist/ops/restore-cli.js --set <name|latest> --reason "…"`.
   4. Then they run `docker compose up -d --build`. `migrate` brings an older backup up to the code's migration level while protective mode is on, and the worker starts with nothing to replay.
2. **Refusals.** It refuses unless the target database is empty: no tables in `public` and no `pgboss` schema. It never overwrites a database.
3. **Before restoring.** It runs the same checks as the drill (steps 1–2).
4. **Restore.** It restores into the target with `pg_restore`, then checks the row counts.
5. **After restoring, in one transaction:**
   - Turns on protective mode with `reason = 'restored_from_backup'`, recording the set's time.
   - Deletes all sessions and unused sign-in codes, and expires recovery and setup links.
   - Marks every email outbox row not yet sent as `not_sent_restored`, so it is not sent and stays visible in the delivery history as "Not sent — restored from backup".
   - Ends every domain work row that was queued or running at backup time, using each table's existing failed or ended state with the fixed reason "Not run — restored from backup". This covers:
     - AI requests;
     - analysis and extraction runs;
     - AI assist answers and drafts;
     - quarantine cleaning;
     - sub-project 9's `storage_outbox`.
     
     Where a table has no reason column, the builder adds one or uses its failure-code column; the plan lists each table. Only the email outbox gains a new status, because the delivery history must say that an email was not sent. AI reservations of ended requests stay as uncertain reservations, never zero (D43). The analysis stall rule must not later rewrite these rows.
   - Cancels every pg-boss job that was queued or active at backup time, so nothing repeats. The worker re-creates its schedules when it starts.
   - Records the audit event `ops.restored_from_backup` with the set, the backup time and the reason.
   - Writes one urgent in-app notice to every Enterprise Administrator. The command also prints this text for the operator: "Kainow was restored from the backup taken at <time>. Everything after that time is lost, including access changes: check People, grants and Administrators before resuming. Queued emails and jobs were not sent."
6. **Source files.** These stay where they are in SharePoint. When the source area itself was lost, `restore-source-files` (added with §5.4) re-uploads every stored source file that is Missing at its recorded place from the backup's file store, checks it, and updates the reference through sub-project 9's relocation routine. Files it cannot find in the store are listed.
7. **Protected key.** The operator mounts the protected key from its recovery copy. Without it, sealed AI keys and the storage secret cannot be opened. The protected-key warning already shows this, and the restore output repeats it.
8. **Resuming.** An Administrator signs in (sign-in works in protective mode), reviews, and chooses Resume with a reason.

**Restoring sub-project 9's files:** restore into the same installation's own database is not offered. A failed live database is replaced by a new installation. This keeps "never overwrites" absolute.

## 9. Data model (migration `0032_operations.sql`)

Sketch only; the builder fixes exact names, indexes and append-only triggers in the project's style.

```sql
CREATE TABLE operations_settings (            -- single row, like access_settings
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  backup_retention_days int NOT NULL DEFAULT 30 CHECK (backup_retention_days BETWEEN 7 AND 365),
  storage_warning_pct  int NOT NULL DEFAULT 80 CHECK (storage_warning_pct BETWEEN 50 AND 95),
  storage_critical_pct int NOT NULL DEFAULT 90 CHECK (storage_critical_pct > storage_warning_pct AND storage_critical_pct <= 99),
  safe_floor_gb int NOT NULL DEFAULT 5 CHECK (safe_floor_gb BETWEEN 1 AND 1000),
  diagnostic_retention_days int NOT NULL DEFAULT 30 CHECK (diagnostic_retention_days BETWEEN 7 AND 365));
CREATE TABLE operations_settings_changes (id uuid PRIMARY KEY, actor_id uuid NOT NULL, at timestamptz NOT NULL,
  reason text NOT NULL CHECK (btrim(reason) <> ''), previous jsonb NOT NULL, next jsonb NOT NULL);   -- append-only

CREATE TABLE operations_state (               -- single row
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  protective boolean NOT NULL DEFAULT false,
  reason text CHECK (reason IN ('low_space','restored_from_backup')),   -- 10b adds 'update'
  since timestamptz, detail jsonb, changed_by uuid);
CREATE TABLE operations_state_changes (...);  -- append-only: entered/resumed, actor or null for Kainow, reason, detail

CREATE TABLE backup_runs (id uuid PRIMARY KEY, kind text CHECK (kind IN ('daily','manual','pre_update')),
  started_at timestamptz NOT NULL, finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('running','succeeded','failed')),
  failure_code text, failure_detail text,      -- fixed text only
  set_name text, folder_label text, key_id text, kainow_version text, migration_level text,
  database_bytes bigint, files_total int, files_new int, files_new_bytes bigint, files_not_copied int,
  source_area text CHECK (source_area IN ('included','not_in_use')),
  manifest_sha256 text, expired_at timestamptz);
CREATE TABLE restore_drills (id uuid PRIMARY KEY, backup_run_id uuid REFERENCES backup_runs, set_name text,
  started_at timestamptz NOT NULL, finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('running','passed','passed_over_target','failed')),
  duration_seconds int, sampled boolean NOT NULL DEFAULT false, checks jsonb NOT NULL DEFAULT '[]',
  failure_code text, kept_database text, key_id text, folder_label text);
CREATE TABLE storage_readings (id uuid PRIMARY KEY, at timestamptz NOT NULL,
  location text CHECK (location IN ('database_disk','backup_disk','source_area')),
  total_bytes bigint, free_bytes bigint, used_bytes bigint, extra jsonb, unavailable boolean NOT NULL DEFAULT false);
CREATE TABLE storage_daily (day date, location text, max_used_bytes bigint, min_free_bytes bigint,
  total_bytes bigint, PRIMARY KEY (day, location));
CREATE TABLE ops_alerts (id uuid PRIMARY KEY, kind text NOT NULL, location text, opened_at timestamptz NOT NULL,
  closed_at timestamptz);                      -- one open episode per kind+location (partial unique index)
```

Other changes:

- Email outbox status gains `not_sent_restored`, and notification kinds are free text.
- Go-live: `UPDATE golive_steps` is not needed; the step mode lives in `checklist.ts`.
- Each listed order sorts stably: `ORDER BY started_at DESC, id DESC` and `ORDER BY at DESC, id DESC`, never by uuid alone.
- **Sub-project 9 overlap.** Its `0031` may also alter email outbox or notification constraints. Whichever merges second keeps both changes. This branch's migration is `0032`, so it runs after `0031` once both are on main. If this branch merges first, `0031` must still apply cleanly after `0032`. The builder checks the outbox status CHECK on both sides and writes the union.

## 10. Screens

**Operations page** (`#/admin/operations`, Enterprise Administrator, a new top-bar entry next to Analytics). Summary first:

- **Status strip:** Backups, Last drill, Database disk, Backup disk, Source area, Protective mode. Each has a word status and a time; colour is never the only signal.
- **Backups:** status, last success, last attempt, retention, folder label, key id, a "Drill again" note when applicable, and the table of the last 30 runs (time, kind, outcome, size, files, duration).
- **Restore drills:** last drill with each check and its result, duration against 4 hours, and earlier drills.
- **Storage:** for each location, used, free and total, percentage, level, the safe floor (database disk), last reading time, and a 30-day growth chart from `storage_daily`. The chart has a table equivalent (O15).
- **Protective mode:** state, reason, since, and **Resume normal use** (reason, then the checks listed with pass or fail, then Confirm).
- **Settings:** the five settings with their bounds, effective values and history (previous, new, by whom, reason), saved with a reason, as on the access settings page.
- **How backups run:** a short fixed explanation pointing at INSTALL.md "Backups". It explains that backups and drills run on the server.

**Administrator analytics:** a new panel `operations`, read-only, that reuses the Operations service for the status strip, run counts and growth over the chosen period. Its CSV export follows the existing analytics export rules. The analytics event catalogue lists the new `ops.*` audit events.

**Banners**, placed between the header and `#main` in `App.tsx`:

- Protective mode, for everyone.
- Backup or storage warnings, for Enterprise Administrators only.

## 11. Hooks for 10b

- `freshBackup(now)` (§6.1).
- `backup-cli --kind pre_update`, which also returns the run id on its last output line.
- `operations_state.reason` accepts `'update'` once 10b's migration adds it. The guard, worker pause and banner are written so that 10b's maintenance mode reuses them, with its own text.
- The status computations are pure functions over rows, testable without a database.

## 12. Permissions (Permission Matrix additions)

| Action | Authority | Boundary |
|---|---|---|
| View operations status, backups, drills, storage and protective mode | Enterprise Administrator (`operations.view`) | No project content; backup folder label and key id only, never key material or host paths. |
| Change operations settings | Enterprise Administrator (`operations.manage`) | Reason; bounds of D110, D113–D115. |
| Resume from protective mode | Enterprise Administrator (`operations.manage`) | Reason; only when the D114 checks pass. |
| Run backups, restore drills, restores and storage checks | Server operator under the organisation's procedure (ops commands) | Recorded in Kainow; restore only into an empty installation; never reveals credential values or restricted sources (Matrix §8). |

The existing row "Configure automatic backups/retention and initiate protected restore" gains a note that retention is in Kainow, while the schedule and restore are server commands (D116).

## 13. Testing and measured aims

**Unit tests:**

- the encryption format (§5.2);
- status rules (§6.1) and alert levels (§7.2), including boundaries at exactly 24 hours, exactly the warning level, and readings that are 30 minutes old;
- the drill space check (§8.1);
- the expiry choice, including "always keep the latest successful and latest pre-update";
- argument parsing and refusals for each command.

**Database tests** (`KAINOW_TEST_DATABASE_URL`, own database name, e.g. `kainow_test_sp10`):

- settings with reason, bounds and history;
- the run rows and notices;
- `ops_alerts` episodes (one notice per episode);
- the sweep's interrupted-run and target-exceeded detection;
- the protective-mode guard: every unsafe route refused, the allowed list works, and public routes are covered;
- worker handlers skipping while the mode is on;
- Resume checks;
- go-live step 8 auto;
- the restore post-steps on a seeded database (sessions gone, outbox marked, jobs cancelled, mode on).

**Tool tests** (need `pg_dump` and `pg_restore` 16 on the test machine; skipped with a clear reason when absent, required in CI). CI installs `postgresql-client-16`.

- A full backup then drill against a seeded database with a temporary backup folder.
- A tampered set fails.
- A wrong key refuses.
- Row-count mismatch detection, by deleting a row in the drill database before the compare, through a test hook.
- Expiry with shared files.
- The restore into an empty database, and its refusal of a non-empty one.

**HTTP tests:** the Operations endpoints, banners data and permissions.

**Web tests:** pure helpers for status words, banner text, chart table equivalents.

**Measured aims:**

| Aim | Target |
|---|---|
| Daily backup of the bench database (the 30k-task bench used in earlier sub-projects) | Under 10 minutes. |
| Drill of that backup | Under 30 minutes, well inside the 4-hour target. |
| `storage-check` run | Under 5 seconds. |
| Guard overhead per request | Under 1 ms at p95 (cached state). |

Measure, report and disclose misses; the PO decides.

**Results** (21 November 2026, `npm run bench-ops`, 30,000-task bench database): backup 0.02 min (about 1 s), aim under 10 minutes, met; drill 3.30 min, aim under 30 minutes, met; `storage-check` 0.02 s, aim under 5 s, met; guard overhead 0.009 ms at p95 with cached state, aim under 1 ms, met (measured in process on the real guard, 1,000 calls with and without the check, larger of the POST and GET differences). No aim was missed. The PostgreSQL tools ran through docker on a Windows development PC, so the backup and drill figures include docker exec overhead and are not production figures. The bench database is small (a few tens of MB: 30,000 tasks in 100 projects, little text), so the backup figure shows the command's own overhead, not the time for a production-size database. The drill ran with a simulated free-space reading (the drill's space check and its 30 s poll did not read a real disk) and with no protected key, so its three sealed-value checks were not tested.

**Manual verification:** the low-space check of §7.4; one full cron-driven week on a Linux VM is recommended before go-live, but is not part of this build.

## 14. Left to the builder

- The exact nonce construction (§5.2), table and index names, and file names.
- How to read sub-project 9's quota (once merged).
- The `statfs` mount detail (§4.1).
- The GET-with-side-effects audit (§7.3).
- Whether `storage_readings` keeps one row per location or one per run.
- Wording of the Operations page beyond the fixed texts given here.

Calls the builder makes are recorded in the plan and the final hand-over note.

## 15. Documents updated in this branch

- **Consolidated Specification §14:** D109–D116.
- **Configuration Catalogue:** C93 backup folder and key; C94 backup retention; C95 storage alert levels; C96 safe floor (with the verification result); C97 diagnostic retention; C98 storage check interval (server schedule, 5 minutes recommended); C99 restore drill schedule (monthly recommended, required before go-live and after key or folder changes). Rows C66, C70, C73 and C74 point to them.
- **Permission Matrix §8:** the rows of §12.
- **Remaining Design and Verification Register:** §6 and §7 get backup method, restore procedure and safe threshold as "designed in sub-project 10a" with the verification state; R17 records the Operations panel.
- **INSTALL.md:**
  - "Back up" is rewritten as "Backups" (folder, key, cron, status, drill);
  - a new "Restore from a backup" section;
  - "What this does and does not protect" is updated;
  - the "restore has not been rehearsed" line is replaced by what the drill proves.
- **`app/README.md`:** the ops commands and the `ops` service. Expect row conflicts with sub-project 9; keep both.
- **Analytics event catalogue:** the `ops.*` events.

## 16. Outside 10a

- **In 10b:** updater, release signing and checking, maintenance mode for updates, the pre-update backup call, load test, supported browsers.
- Backup of filed external outputs (organisation's own arrangement).
- Point-in-time recovery, replicas, high availability.
- A web button to start a backup or drill.
