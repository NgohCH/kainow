# Sub-project 10b: Operations part 2 (updater, release signing, load test, browsers) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signed releases, a release check, Administrator-approved updates installed by a cron-started updater container with a pre-update backup and safe failure handling, plus a load test and a supported-browser matrix.

**Architecture:**
- **Server side in Kainow** (`app/src/updater/`): release checks run in the worker; approval, rescheduling, cancelling, emails and banners run in the API and the sweep, over new tables in `0034_updates.sql`. Maintenance reuses 10a's operations state with the reason `update`.
- **The updater** is a separate Docker target and Compose service started by cron (`updater-cli.js tick`). It drives `git` and `docker compose` through an injectable `Runner`, so every flow is tested with a fake runner; the real commands are exercised by the git/signature tests and one manual end-to-end run in WSL2.
- **Evidence tools**: `npm run load-test` (`app/src/loadtest/`) and `tests/browsers/` (Playwright), with their results in `docs/operations/`.

**Tech Stack:** NestJS, PostgreSQL 16, pg-boss, React web, `node:test`, `git` and `ssh-keygen -Y` (OpenSSH ≥ 8.2), Docker CLI and Compose plugin in the updater image, Playwright in `tests/browsers/` only.

**Spec:** `docs/superpowers/specs/2026-11-22-v1-operations-10b-design.md` (approved 22 November 2026). Read it alongside this plan; § numbers refer to it. 10a's spec `2026-11-20-v1-operations-10a-design.md` describes the code this builds on.

## Global Constraints

**Numbers and delivery**
- Migration `0034_updates.sql`; Decision Register D119–D124 (D125–D126 reserved); Configuration Catalogue C105–C110 (C111–C112 reserved).
- This branch sits on 10a (PR #24). Rebase onto `main` once #24 merges; then re-check that nothing on main took 0034, D119+ or C105+.
- Push or open a PR only when the PO says so.

**Rules carried over**
- No real organisation names or domains anywhere. Test accounts only `*@example.org|com|net` or `*@kainow.test`. The product repository's `owner/name` is allowed only as the default of `KAINOW_RELEASE_REPO`.
- Never print or open `.env` files or key files. The PO's release key is created by the PO; no task creates, reads or handles it. Tests use throwaway keys made in a temporary folder.
- Never `git stash`. Never push tags or create GitHub releases (nothing is released before the go-live history rewrite).
- Stored failure text is a fixed code plus fixed text (§5.8); raw command output goes only to the updater's stdout, with any `postgres://…` URL masked.

**Tests and databases**
- Test database `kainow_test_sp10b` on the `kainow-testdb` container: `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kainow_test_sp10b` (check the password against `src/testing/db.ts` and 10a's notes). Never `kainow_test`, `kainow_test_sp8`, `kainow_test_sp9`, `kainow_test_sp10*` other than this one.
- pg client tools are not installed on this PC: tool tests use `KAINOW_TEST_PG_DOCKER=kainow-testdb`.
- Git/signature tests need `git` and `ssh-keygen` (Git for Windows has both); skip with a clear reason when absent; CI (ubuntu) has them.
- Per task run only that task's tests. The full server suite (~2 h) runs in the background at the end.

**Code conventions**
- Every listed order has a stable `ORDER BY` with a tie-break, never uuid alone.
- Every new `writeAudit` action is added to `src/analytics/catalogue.ts`; every new text column to `src/quarantine/registry.ts`.
- Reasons go through `src/common/reason.ts` `readReason`.
- CLI files follow 10a's two-layer pattern: thin `-cli.ts` over `run…(argv, deps): Promise<number>`; exit 0 ok, 1 refused/failed, 2 usage.

**Fixed values**

| What | Value |
|---|---|
| Release tag pattern | `^v(\d+)\.(\d+)\.(\d+)$` (no pre-releases) |
| Signing principal / namespace | `kainow-release` / `git` |
| Maintenance refusal | 503 `{ code: 'update_in_progress', message: 'Kainow is being updated. Nothing you have saved is affected; try again in a few minutes.' }` |
| Maintenance banner and sign-in line | `Kainow is being updated. You can read; changes are paused until the update finishes.` |
| Scheduled banner | `Kainow will be unavailable on <date> from <time> for about <n> minutes for an update.` |
| Approval email | `Kainow will be unavailable on <date> from <time> (UTC+8) for about <n> minutes while it is updated. Anything you save before then is kept.` |
| Notice page | `Kainow is unavailable after a failed update. Nothing you saved before the update started has been lost. Please contact your Administrator.` |
| Approval refused without fresh backup | `Updates are refused until a backup succeeds. See Backups above.` |
| Approval hint | `The update takes its own backup first and stops if that backup fails.` |
| Release check note | `Signature checked before installing.` |
| Restart message (web) | `Kainow is restarting after an update…` |

| Limit | Value |
|---|---|
| Start time | ≥ 15 min ahead, ≤ 30 days ahead |
| Expected length | 5–240 min, default 30 |
| Day-before email | 24 h before start, only if approved > 24 h ahead |
| Check now | at most once a minute per installation |
| Release check timeout | 10 s; `User-Agent: kainow-update-check` |
| Failed checks warning | after 3 days without a successful check |
| Preparation limit | 60 min |
| Backup-lock retry | every minute, up to 30 min |
| Wait after maintenance on | 15 s (5 s cache + 10 s) |
| Health checks | within 10 min; worker up 60 s without restart |
| Space to build | free ≥ safe floor + 4 GB (adjust to the measured build, Task 8) |
| Updater cron | every 5 minutes |

## Review Focus

1. **A moved or re-pushed tag** between approval, preparation and installation must never install a different commit — the approval's commit and the verified tag object id are compared at each stage (Tasks 3, 8, 9).
2. **The updater dying at any step** (host reboot mid-update) must leave a state the next tick can finish or undo; never a half-switched installation with maintenance off (Task 9, a re-entry test per step).
3. **A save attempted during maintenance** must be refused with the update text, never accepted after the pre-update backup started; and Resume must not end update maintenance (Task 1).
4. **People who are not Active** (disabled, invited, on hold) must not receive the update emails, and the day-before email must go exactly once even when the time is changed (Task 6).
5. **Restoring after a failed migration** must not leave an `installing` row, a `running` pre-update backup row, or an `update` maintenance state in the restored database (Task 10).

---

## File structure

```
app/migrations/0034_updates.sql
app/src/updater/
  version.ts            tag parsing, comparison                         (Task 2)
  states.ts             state machine, failure codes and texts          (Task 2)
  git.ts                fetch, verify-tag, rotation, checkout helpers   (Task 3)
  runner.ts             Runner interface, real runner, URL masking      (Task 7)
  release-check.ts      daily/manual check, releases_seen, notice       (Task 5)
  updates.service.ts    approve, reschedule, cancel, status reads       (Task 6)
  updates.controller.ts /admin/updates/*, /updates/banner               (Task 6)
  people-mail.ts        emails to every Active person, reminder         (Task 6)
  tick.ts               tick: lock, record, dispatch                    (Task 7)
  prepare.ts            §5.4                                            (Task 8)
  install.ts            §5.5–5.7, re-entry                              (Task 9)
  post-check-cli.ts     migration level + version check                 (Task 9)
  recover.ts            §5.9                                            (Task 10)
  updater-cli.ts        tick | recover [--yes]                          (Task 7)
  notice-server.ts      the fixed notice page                           (Task 7)
app/src/loadtest/       seed, sessions, journeys, report, cli           (Task 12)
scripts/release.mjs, release/release-signers, CHANGELOG.md              (Task 4)
tests/browsers/                                                         (Task 13)
docs/operations/releasing.md, safari-check.md, browser-matrix.md, load-test.md
compose.yaml, compose.override.example.yaml, app/Dockerfile, .gitignore (Task 7)
```

---

### Task 1: Schema, maintenance reason and audit actions

**Files:**
- Create: `app/migrations/0034_updates.sql`
- Modify: `app/src/db/migrate.test.ts` (REAL_FILES gains `0034_updates.sql`), `app/src/ops/state.ts` (reason type), `app/src/ops/protective.ts` (per-reason texts), `app/src/ops/resume.ts` (refuse when reason is `update`), `app/src/ops/operations.controller.ts` (banner/public-state carry the update text), `app/src/analytics/catalogue.ts`, `app/src/quarantine/registry.ts`
- Test: `app/src/ops/protective.http.test.ts`, `app/src/ops/resume.db.test.ts`, `app/src/updater/schema.db.test.ts`

**Interfaces:**
- Produces: tables of spec §9 (`release_checks`, `releases_seen`, `updates`, `update_changes`, `update_steps`, `updater_ticks`; `updates_one_open` partial unique index; `updates.reminder_sent_at`); `ProtectiveState.reason: 'low_space' | 'restored_from_backup' | 'update' | null`; `UPDATE_CODE = 'update_in_progress'`, `UPDATE_MESSAGE`, `UPDATE_BANNER` exported from `protective.ts`; `protectiveRefusal(reason)` returning the update body when `reason === 'update'`. `updater_ticks` has columns `id, at, did, running_tag text, key_fingerprint text` (for the Operations page and go-live step). Audit actions: `ops.release_available`, `ops.update_approved`, `ops.update_rescheduled`, `ops.update_cancelled`, `ops.update_refused`, `ops.update_succeeded`, `ops.update_failed`, `ops.update_recovered`.

- [ ] **Step 1: Write failing tests**
  - `schema.db.test.ts`: `two open updates are refused by updates_one_open`; `a cancelled and a new approved update can coexist`; `update_changes and update_steps are append-only` (UPDATE/DELETE raise, following 10a's triggers — `update_steps` allows only setting `finished_at`, `outcome`, `failure_code` on a `running` row); `operations_state accepts reason update`.
  - `protective.http.test.ts`: `a POST during update maintenance is 503 update_in_progress with the update message`; `GET still works during update maintenance`; `banner endpoint returns the update banner text when the reason is update`.
  - `resume.db.test.ts`: `resume is refused while the reason is update` (409, message names the update).
- [ ] **Step 2: Run them; expect failures** — `npx tsc -p tsconfig.json && node --test dist/updater/schema.db.test.js dist/ops/protective.http.test.js dist/ops/resume.db.test.js`
- [ ] **Step 3: Write the migration and the reason handling.** Keep the existing `operations_state` CHECK name pattern; drop and re-add it with `update`. Registry: every new text column with its class (`release_notes` is "release text from a signed tag", `failure_code`/`cancel_reason`/`reason` as the existing patterns).
- [ ] **Step 4: Run the tests and `catalogue.db.test`, `registry` tests, `migrate.test`; expect PASS**
- [ ] **Step 5: Commit** `feat(updates): schema and update maintenance reason`

### Task 2: Versions, states and failure codes (pure)

**Files:** Create `app/src/updater/version.ts`, `app/src/updater/states.ts`; Test `version.test.ts`, `states.test.ts`

**Interfaces:**
- Produces:
  - `parseTag(tag: string): Version | null` (`Version = { major: number; minor: number; patch: number }`), `compareVersions(a, b): -1|0|1`, `versionString(v): string` (`'1.2.3'`), `isNewer(candidate: string, running: string): boolean` (`running` may be `'0.0.0'` or `'unknown'` → `unknown` is never older: returns false).
  - `type UpdateState` = the 11 states of §9; `OPEN_STATES`; `canTransition(from: UpdateState, to: UpdateState): boolean` per §6.1; `type FailureCode` = every code in §5.8 (including `settings_missing`, `db_service_changed`, `manual_install`, `upgrade_path`, `backup_busy`); `FAILURE_TEXT: Record<FailureCode, string>` (fixed sentences, no paths); `stateWords(s: UpdateState): string` for the page.
  - `approvalWindowProblem(startsAt: Date, now: Date, minutes: number): string | null` (15 min / 30 days / 5–240 bounds, fixed messages).
  - `reminderDue(update: { approvedAt: Date; startsAt: Date; reminderSentAt: Date | null }, now: Date): boolean`.

- [ ] **Step 1: Failing tests**: `parseTag accepts v1.2.3 and rejects 1.2.3, v1.2, v1.2.3-rc.1, v01.2.3`; `isNewer('v1.0.10','1.0.9') is true`; `isNewer(x,'unknown') is false`; `canTransition` table test covering every arrow in §6.1 and rejecting `succeeded→installing`, `recovered→anything`; `every FailureCode has text without a slash or colon-slash-slash`; `approvalWindowProblem` at 14:59 / 15:00 min ahead, 30 days + 1 min, minutes 4/5/240/241; `reminderDue` false when approved 23 h ahead, true at exactly 24 h before start when approved 48 h ahead, false once sent.
- [ ] **Step 2: Run; expect FAIL** — `node --test dist/updater/version.test.js dist/updater/states.test.js`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect PASS**
- [ ] **Step 5: Commit** `feat(updates): versions, states and failure codes`

### Task 3: Git fetch, signature verification and key rotation

**Files:** Create `app/src/updater/git.ts`; Test `app/src/updater/git.test.ts`, helper `app/src/testing/git-releases.ts` (makes a temp bare "origin", a working clone, a throwaway ed25519 key, signed/unsigned/lightweight tags)

**Interfaces:**
- Consumes: `parseTag` (Task 2); `Runner` is not used here — git is run with `execFile` directly through a small `git(dir, args, env?)` helper exported for Task 7's real runner to reuse.
- Produces:
  - `fetchCandidate(repoDir: string, tag: string): Promise<{ ok: true; tagObject: string } | { ok: false; code: 'fetch_failed' }>` — fetches `refs/tags/<tag>` into `refs/kainow/candidate/<tag>`.
  - `verifyCandidate(repoDir: string, tag: string, tagObject: string, signersFile: string, expect: { commit: string; runningVersion: string }): Promise<{ ok: true; commit: string; notes: string } | { ok: false; code: 'not_annotated'|'tag_name_mismatch'|'signature_invalid'|'commit_mismatch'|'version_mismatch'|'not_newer' }>` — checks §5.3 steps 2–5 (version read with `git show <commit>:app/package.json`); `notes` is the tag message without the signature block.
  - `signersAt(repoDir: string, commit: string): Promise<string | null>` — content of `release/release-signers` at that commit.
  - `workingTreeState(repoDir: string): Promise<{ clean: boolean; changed: string[]; headTag: string | null }>` (tracked files only; `headTag` = an exact release tag at HEAD).
  - `GIT_ENV` — environment forcing `gpg.format=ssh`, `gpg.ssh.allowedSignersFile`, no global config (`GIT_CONFIG_GLOBAL=/dev/null` / `NUL`), `GIT_TERMINAL_PROMPT=0`.

- [ ] **Step 1: Failing tests** (skip with reason when `git`/`ssh-keygen` are missing): `a signed annotated tag verifies and returns its commit and notes`; `an unsigned annotated tag is signature_invalid`; `a lightweight tag is not_annotated`; `a tag signed by another key is signature_invalid`; `a tag object whose internal name differs (v1.0.2 pushed as v1.0.3) is tag_name_mismatch`; `a tag re-pointed to another commit after approval is commit_mismatch`; `package.json 1.0.1 under tag v1.0.2 is version_mismatch`; `a tag not newer than the running version is not_newer`; `rotation: release signed by the old key carrying a new signers file verifies, and signersAt returns the new file`; `a release signed only by the new key, against the old signers file, is signature_invalid`; `workingTreeState reports an edited compose.yaml and ignores untracked .env`.
- [ ] **Step 2: Run; expect FAIL** — `node --test dist/updater/git.test.js`
- [ ] **Step 3: Implement** with `execFile` (never a shell), a 2-minute timeout per git call, and `-c gpg.format=ssh -c gpg.ssh.allowedSignersFile=<file> verify-tag --raw` checking the principal `kainow-release` in the output.
- [ ] **Step 4: Run; expect PASS**
- [ ] **Step 5: Commit** `feat(updates): verify signed release tags`

### Task 4: Release script, signers file and changelog

**Files:** Create `scripts/release.mjs`, `scripts/release.test.mjs`, `release/release-signers` (a comment line only: `# Kainow release keys: one line per key, principal kainow-release, namespaces="git". The Product Owner adds the key (docs/operations/releasing.md).`), `CHANGELOG.md` (an `## Unreleased` section), `docs/operations/releasing.md`; Modify root `package.json` if present, else document `node scripts/release.mjs` (no new dependencies).

**Interfaces:** Consumes the same verification rule as Task 3 (the script shells out to `git verify-tag` with the same `-c` options; it does not import TypeScript).

- [ ] **Step 1: Failing tests** in `release.test.mjs` (`node --test`, throwaway key and temp repos): `refuses when not on main`; `refuses with a dirty tree`; `refuses when the version is not greater than the last tag`; `refuses when user.signingkey is not in release/release-signers`; `refuses without a CHANGELOG section for the version`; `--dry-run sets the version in app/package.json, app/package-lock.json, app/web/package.json and the three compose image tags, commits "Release vX.Y.Z", makes a signed tag whose message is the changelog section, verifies it, and pushes nothing`.
- [ ] **Step 2: Run; expect FAIL** — `node --test scripts/release.test.mjs`
- [ ] **Step 3: Implement** per §4.2. Without `--dry-run`, it asks `Push vX.Y.Z to origin and create the GitHub release? (yes/no)` and then runs `git push origin main vX.Y.Z` and `gh release create vX.Y.Z --notes-file <section>`. `--dry-run` works in a throwaway clone. Write `releasing.md` (§4.1 one-time setup, §4.3 rotation, "first real release is v1.0.0, after the go-live history rewrite").
- [ ] **Step 4: Run; expect PASS**
- [ ] **Step 5: Commit** `feat(release): signed release script, signers file and changelog`

### Task 5: Release checks in the worker

**Files:** Create `app/src/updater/release-check.ts`, `release-check.db.test.ts`; Modify `app/src/worker/schedules.ts` (+ `queues.ts` new queue `release_check`), `app/src/config.ts` (`KAINOW_RELEASE_REPO`, `KAINOW_RELEASE_API` on api and worker), `compose.yaml` (pass both through, defaults empty → code default)

**Interfaces:**
- Consumes: `parseTag`, `isNewer` (Task 2); `notifyAdmins` (`src/ops/notify.ts`); `writeAudit`.
- Produces: `checkReleases(deps: { pool: Pool; fetch: typeof fetch; repo: string; api: string; runningVersion: string; now: Date }, trigger: 'daily'|'manual', actorId?: string): Promise<{ outcome: 'found'|'none_newer'|'failed'; newest?: { tag: string; commit: string }; failureCode?: 'unreachable'|'bad_response'|'rate_limited' }>`; `latestCheck(pool): Promise<…>`; `newestAvailable(pool, runningVersion): Promise<{ tag; commit; firstSeenAt } | null>`; `runningVersion(): string` (moved from `ops/backup.ts` `kainowVersion` into `src/common/version.ts` and reused by both).

- [ ] **Step 1: Failing tests** with a fake `fetch`: `records found with the newest valid tag and ignores v1.0.0-rc.1 and nonsense`; `none_newer when every tag is ≤ running`; `notifies every Active Enterprise Administrator once per tag (second check finds the same tag: no new notice)`; `a newer tag later gives a second notice`; `a 403 with rate-limit headers records rate_limited, notifies nobody`; `a timeout records unreachable`; `the request carries User-Agent kainow-update-check and no other identifying header`; `runs while protective mode is on`; `three days without a successful check makes latestCheck report stale`.
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3b: Diagnostics expiry.** Extend 10a's diagnostic expiry (D115) to `release_checks` (except rows that first found a tag) and `updater_ticks` (except the newest row), with a db test `old release checks and ticks expire with the diagnostic retention; the newest tick and first-found rows stay`.
- [ ] **Step 3: Implement.** GitHub's tags list is paged (`per_page=100`); read the first page only and sort by `compareVersions`. Daily schedule: a cron minute chosen once (`hashtext(installation id) % 60`, hour 03 UTC+8) stored nowhere new — derive from the organisation row id. The handler skips nothing in protective mode (spec §6.2 design call). Audit `ops.release_available` when a tag is first seen.
- [ ] **Step 4: Run; expect PASS**
- [ ] **Step 5: Commit** `feat(updates): daily release check and release notice`

### Task 6: Approving, rescheduling, cancelling, emails and banners

**Files:** Create `app/src/updater/updates.service.ts`, `updates.controller.ts`, `people-mail.ts`, `updates.db.test.ts`, `updates.http.test.ts`; Modify `app/src/ops/ops.module.ts` (register), the sweep's ops part (`app/src/ops/sweep-ops.ts`: call `sendDueReminders`), `app/src/ops/operations.controller.ts` (`operations/banner` gains the scheduled-update banner for everyone)

**Interfaces:**
- Consumes: Task 2 helpers; `freshBackup(now)` (10a `status.ts`); `OperationsState`; `newestAvailable` (Task 5); `writeOutbox`; `notifyAdmins`.
- Produces endpoints (all `operations.manage` except GETs `operations.view`; reasons via `readReason`):
  - `GET admin/updates` → `{ running: string; keyFingerprint: string|null; lastCheck; available: {tag; commit; releaseUrl}|null; current: UpdateView|null; history: UpdateView[] /* last 20, ORDER BY approved_at DESC, id DESC */; needsRecovery: boolean }`
  - `POST admin/updates/check` → runs `checkReleases(…,'manual')`; 429 within a minute of the last manual check.
  - `POST admin/updates` `{ tag, startsAt, expectedMinutes, reason }` → 201 `UpdateView`; refusals 409 with fixed text: another open update, protective on, not newer, needs recovery, no fresh backup (`Updates are refused until a backup succeeds. See Backups above.`), tag not the newest available, window problem (400).
  - `POST admin/updates/:id/reschedule` `{ startsAt, expectedMinutes, reason }`; `POST admin/updates/:id/cancel` `{ reason }` — only in `approved|preparing|ready`; reschedule clears `reminder_sent_at` only if the new start is > 24 h away.
  - `GET updates/banner` (any signed-in person) → `{ scheduled: { startsAt; expectedMinutes } | null }`.
  - `people-mail.ts`: `mailEveryone(client, kind: 'update_scheduled'|'update_rescheduled'|'update_cancelled'|'update_reminder', u: UpdateView, now)` — one outbox row per `users.status = 'active'`, ignoring personal notification preferences, with organisation branding as other system emails; `sendDueReminders(pool, now)` — uses `reminderDue`, sets `reminder_sent_at` in the same transaction.

- [ ] **Step 1: Failing tests**:
  - db: `approve records tag, commit, start, length, reason, approver, update_changes row and audit ops.update_approved`; `approve emails every Active person and nobody disabled, invited or on hold` (Review Focus 4); `approve is refused without a successful backup younger than 24 h`; `…while protective mode is on`; `…when another update is open`; `…when the latest update is failed_after_migration`; `…for a tag that is not newer`; `cancel emails everyone and is refused once installing`; `reschedule emails everyone; the day-before email still goes once` (approve 3 days ahead → reminder sent at T-24h → reschedule to 4 days ahead → second reminder at the new T-24h, never two for the same start); `sendDueReminders sends nothing for an approval made 23 h ahead`.
  - http: permissions (Member 403, Administrator without manage 403 on POSTs); `check now twice within a minute is 429`; `updates/banner shows the scheduled update to a Member`.
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement.** All writes for one action in one transaction (row, change, audit, outbox rows). Dates in emails and banners formatted UTC+8 with the existing date helpers.
- [ ] **Step 4: Run; expect PASS**
- [ ] **Step 5: Commit** `feat(updates): approve, reschedule and cancel with notice to everyone`

### Task 7: Updater image, Compose services, runner and the tick

**Files:**
- Create: `app/src/updater/runner.ts`, `tick.ts`, `updater-cli.ts`, `notice-server.ts`, `tick.db.test.ts`, `runner.test.ts`, `notice-server.test.ts`, `compose.override.example.yaml`
- Modify: `app/Dockerfile` (target `updater` after `ops`; Docker's apt repo with its signed key, `docker-ce-cli`, `docker-compose-plugin`, `git`, `openssh-client`; versions pinned like 10a's pg client), `compose.yaml` (services `updater` and `notice`, profile `updater`, per §5.1 and §5.7: `user: "${KAINOW_UID:?…}:${KAINOW_GID:?…}"`, `group_add`, socket and same-path folder mounts, `HOME` tmpfs, `KAINOW_INSTALL_DIR`; `notice` publishes `127.0.0.1:${KAINOW_PORT:-3000}:3000`; image tags stay `0.0.0`), `.gitignore` (`compose.override.yaml`, `release-signers` at the root, `.kainow-staging/`), `app/src/ops/backup.ts` (lock busy → exit code 3), `app/src/golive/checklist.ts` (+ step `updates`), `app/package.json` scripts (`updater`)
- Test: also `app/src/golive/*.db.test.ts` for the new step

**Interfaces:**
- Produces:
  - `interface Runner { run(cmd: 'git'|'docker', args: string[], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string,string> }): Promise<{ code: number; stdout: string; stderr: string }> }`; `RealRunner`; `FakeRunner` (in `src/testing/fake-runner.ts`: scripted responses matched by argument prefix, records calls); `maskSecrets(text: string): string` (masks `postgres://user:pass@` and any `password=`).
  - `runTick(deps: TickDeps): Promise<{ did: 'nothing'|'prepared'|'installed'|'failed'|'busy'|'remind_recovery' }>` with `TickDeps = { pool; runner: Runner; installDir: string; now: () => Date; log: (line: string) => void; prepare: (u) => Promise<void>; install: (u) => Promise<void> }` — advisory lock `hashtext('kainow.updater')`, records `updater_ticks` (`did`, `running_tag` from `workingTreeState`, `key_fingerprint` from `ssh-keygen -lf release-signers`), dispatches: `approved` → `prepare`; `ready` and `starts_at <= now` → `install`; `installing` with a free lock → `install` (re-entry, Task 9); `failed_after_migration|failed_needs_attention` → the daily log line.
  - `updater-cli.ts tick | recover [--yes]` (recover wired in Task 10).
  - `startNoticeServer(port: number): http.Server` — serves the fixed page (inline CSS, `lang="en"`, a `<main>` and `<h1>`) with status 503 for every path.
  - Go-live step `{ key: 'updates', mode: 'auto', link: 'INSTALL.md, the section on Updates', text: 'Schedule the updater', explanation: 'Kainow ticks this once the updater has run in the last 24 hours on a release.' }` — done when an `updater_ticks` row younger than 24 h has a non-null `running_tag`.
- [ ] **Step 1: Failing tests**: `maskSecrets hides the password in a postgres URL`; `a second tick while the lock is held returns busy and records nothing`; `a tick records running_tag and key_fingerprint`; `dispatch table` (one case per state, with fake prepare/install); `the notice page is 503 with the fixed text for / and /anything`; `go-live step updates ticks with a recent tick on a release and unticks after 24 h`; `backup-cli returns 3 when the backup lock is held` (extend 10a's test).
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement.** Build the image once locally to prove the Dockerfile: `docker build --target updater -t kainow-updater:test app` and `docker run --rm kainow-updater:test sh -c "git --version && ssh-keygen -V 2>&1 | head -1; docker --version && docker compose version"`. Record the versions in the commit message body.
- [ ] **Step 4: Run tests; expect PASS. `docker compose config -q` with a scratch `.env.ci`-style env (no real `.env`) passes.**
- [ ] **Step 5: Commit** `feat(updates): updater image, compose services and the tick`

### Task 8: Preparing an update

**Files:** Create `app/src/updater/prepare.ts`, `prepare.test.ts` (fake runner), `prepare.db.test.ts`

**Interfaces:**
- Consumes: Task 3 (`fetchCandidate`, `verifyCandidate`, `workingTreeState`), `Runner`, 10a `statfs` helper and safe floor setting.
- Produces: `prepareUpdate(deps: PrepareDeps, update: UpdateRow): Promise<'ready'|'refused'|'failed_before_install'>` where `PrepareDeps = { pool; runner; installDir; projectName: string; now; log; statfs }`. Sets `tag_object`, `release_notes`, state `preparing` then `ready`; records each step in `update_steps` (`space`, `working_tree`, `verify`, `staging`, `compatibility`, `build`); on failure sets `failure_code`, removes the staging worktree, notifies Enterprise Administrators (`update_refused` / `update_failed`), audit `ops.update_refused` / `ops.update_failed`.
  - The project name: `COMPOSE_PROJECT_NAME` from the environment, else the folder's base name lower-cased (Compose's rule).
  - Build command exactly: `docker compose --project-directory <staging> --project-name <name> --env-file <installDir>/.env -f <staging>/compose.yaml [-f <installDir>/compose.override.yaml] build`; compatibility uses the same flags with `config -q` and `config --format json` (compare `services.db` image, volumes and environment keys with the running config).
  - `release/requirements.json`: `manual: true` → `manual_install` (notes shown); `minimumFrom` greater than running → `upgrade_path`.
- [ ] **Step 1: Failing tests** (fake runner): `refuses local_changes naming the changed tracked files`; `refuses not_on_release when HEAD is not at a release tag`; `no_space_to_build below floor + 4 GB`; `each verify failure becomes refused with its code and the staging worktree is never created`; `settings_missing when config -q fails, naming the variable but no value`; `db_service_changed when the db image differs`; `manual_install and upgrade_path from requirements.json`; `build_failed removes the staging worktree`; `build_timeout after 60 minutes`; `the build command uses the staging folder as project directory and the installation's .env` (assert exact args); `success sets ready, tag_object and release_notes`; `a cancelled update found mid-preparation stops and removes staging`. db test: `steps and states are recorded in order (ORDER BY started_at, id)`.
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement.** Measure one real build of the current tree (`docker compose build`, `docker system df` before/after) and set the space margin to max(4 GB, measured × 1.5); record the figure in the commit body.
- [ ] **Step 4: Run; expect PASS**
- [ ] **Step 5: Commit** `feat(updates): prepare and verify a release before its window`

### Task 9: Installing, going back and the failed-migration path

**Files:** Create `app/src/updater/install.ts`, `post-check-cli.ts`, `install.test.ts` (fake runner), `install.db.test.ts`; Modify `app/web/src/api.ts` (restart message, §7.2) and its test

**Interfaces:**
- Consumes: Tasks 2, 3, 7, 8; `OperationsState`; 10a backup CLI exit codes (0, 1, 3).
- Produces: `installUpdate(deps: InstallDeps, update: UpdateRow): Promise<UpdateState>`; steps named `recheck`, `maintenance_on`, `backup`, `stop`, `switch_code`, `migrate`, `start`, `health`, `maintenance_off`, `tidy`, and on failure `go_back` or `notice_page`. `post-check-cli.ts` exits 0 only when `currentMigrationLevel(db) === codeMigrationLevel()` and `runningVersion()` equals its `--expect X.Y.Z`.
  - Re-entry: `resumePoint(steps: StepRow[]): { kind: 'continue_from'; step } | { kind: 'go_back' } | { kind: 'failed_after_migration' }` — any started `migrate` step means `failed_after_migration` unless `health` passed (then continue to `maintenance_off`); otherwise `go_back`.
  - Health: poll `docker compose ps --format json` for `api` health `healthy` and `worker` running ≥ 60 s with unchanged restart count; then `docker compose run --rm api node dist/updater/post-check-cli.js --expect X.Y.Z`; limit 10 minutes.
  - Failed after migration: stop api/worker, `git checkout --detach <previous tag>`, restore the previous signers file (kept as `release-signers.previous` when step `switch_code` copied the new one), `docker compose --profile updater up -d notice`, best-effort state write, log the operator line of §5.7 step 4.
- [ ] **Step 1: Failing tests** (fake runner + test db): `the happy path runs the steps in order and ends succeeded with maintenance off and audit ops.update_succeeded`; `maintenance is on before the backup command starts` (Review Focus 3); `backup exit 3 retries each minute and gives up after 30 minutes as backup_busy, maintenance off`; `backup failure: failed_before_install, nothing stopped`; `checkout failure goes back to the previous tag and images`; `migration failure: notice page started, previous tag checked out, failed_after_migration with the pre-update run id, no outbox rows written`; `health failure after migrate is failed_after_migration`; `going back that itself fails health is failed_needs_attention`; `a tag object that changed since preparation is refused tag_changed before maintenance`; **re-entry, one test per step**: a crash after each step (Review Focus 2) resumes to the right outcome and never leaves maintenance off with the code half-switched; `tidy keeps the previous version's images and removes older ones`; `the old images are never removed before succeeded`. Web: `a network failure while the last banner was update maintenance shows the restart message and retries every 15 s`.
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect PASS**
- [ ] **Step 5: Commit** `feat(updates): install with pre-update backup, rollback before migration, notice page after`

### Task 10: Recovering from a failed update

**Files:** Create `app/src/updater/recover.ts`, `recover.test.ts` (fake runner), `recover.db.test.ts` (two test databases: `kainow_test_sp10b` and `kainow_test_sp10b_failed`)

**Interfaces:**
- Consumes: Task 9's states and steps; 10a `restore-cli` (run through the runner); `notifyAdmins`; `writeAudit`.
- Produces: `runRecover(argv: string[], deps: RecoverDeps): Promise<number>` per §5.9; `fixRestoredRecord(restored: Pool, failed: Pool | null, updateId: string, restoreRunId: string, failureCode: FailureCode, now: Date): Promise<void>` — in one transaction on the restored database: update row → `recovered`, copy later `update_steps` from the failed database (skip with a logged note if unreadable), audit `ops.update_recovered`, `notifyAdmins` `update_failed` with email outbox rows.
  - Database rename through the runner: `docker compose exec -T db psql -U kainow -d postgres -c 'ALTER DATABASE kainow RENAME TO kainow_failed_<YYYYMMDD>_<id8>'` then `createdb`; both after `docker compose stop` of api/worker and terminating other connections.
- [ ] **Step 1: Failing tests**: `refuses unless the latest update needs recovery`; `asks for confirmation without --yes and does nothing on "no"`; `the command sequence: stop notice, rename, create, confirm previous tag, restore --set <pre_update set>, fix the record, up -d, health` (assert exact runner calls); `failed_needs_attention skips the rename and restore`; db: `after fixRestoredRecord the restored database has no installing row, the update is recovered, its steps include the failed ones, an update_failed notice and outbox rows exist for each Active Enterprise Administrator and are not marked not_sent_restored` (Review Focus 5); `the restored pre_update backup row is succeeded (10a's after-restore) and operations_state reason is restored_from_backup, not update`.
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement**; wire `recover` into `updater-cli.ts`.
- [ ] **Step 4: Run; expect PASS**
- [ ] **Step 5: Commit** `feat(updates): guided recovery from a failed update`

### Task 11: Web — Updates section, banners, status strip and analytics

**Files:** Modify `app/web/src/views/Operations.tsx`, `app/web/src/operations.ts` (+ test), `app/web/src/views/OpsBanner.tsx`, `app/web/src/App.tsx`, `app/web/src/views/analytics/OperationsPanel.tsx`, the sign-in page's protective line; server `app/src/ops/operations.service.ts` (status strip `updates` item; analytics counts of updates by outcome in the period)

**Interfaces:** Consumes Task 6's endpoints and `UpdateView`. Produces pure helpers in `operations.ts`: `updateStatusWord(view): 'Up to date'|'Update available'|'Update scheduled'|'Update failed'|'Not checked for 3 days'`, `scheduledBanner(s, now): string`, `approvalFormProblem(input, now): string | null` (mirrors Task 2's bounds for instant feedback; the server stays the judge).

- [ ] **Step 1: Failing web tests**: each status word; banner text with UTC+8 date and time; form bounds at 15 min and 30 days; maintenance shows the update banner, not the protective one, and no Resume button.
- [ ] **Step 2: Run; expect FAIL** — `npm --prefix web test`
- [ ] **Step 3: Implement** the section per §11 (running version, key fingerprint, last check and Check now, available release with link and Approve form, current update with steps, notes once ready, Change time/Cancel, history of 20, needs-recovery warning on Administrator pages). Same layout patterns as the 10a sections; colour never the only signal; works at 375 px.
- [ ] **Step 4: Run web tests and `npm --prefix web run build`; server http tests for the status strip; expect PASS**
- [ ] **Step 5: Browser check** on a throwaway database (as 10a Task 12): approve an update as an Administrator, see the banner as a Member, see maintenance text after setting the state by SQL, no horizontal scroll at 375 px.
- [ ] **Step 6: Commit** `feat(web): updates on the Operations page, update banners`

### Task 12: Load test

**Files:** Create `app/src/loadtest/{seed.ts,sessions.ts,journeys.ts,fake-ai.ts,report.ts,load-test-cli.ts}`, `journeys.test.ts`, `report.test.ts`, `seed.db.test.ts`; `docs/operations/load-test.md`; `app/package.json` script `load-test`

**Interfaces:** Produces `seedLoad(pool, opts: { people: 200; projects: 40 }): Promise<SeedSummary>` (refuses a non-empty database; organisation "Example Organisation", domain example.org, people `load-001@example.org`…); `runLoad(opts: { base: string; users: number; minutes: number; thinkMs: [number, number] }): Promise<RunResult>`; `writeReport(result, machine): string` (Markdown, §13.1 step 4); journey weights exactly the §13.1 table.

- [ ] **Step 1: Failing tests**: `seed refuses a database that has an organisation not created by the seed`; `seed makes 200 Active people at example.org and 40 projects each with PM, Owner and Sponsor`; `journey picker follows the weights within 2 percentage points over 100,000 draws (fixed seed)`; `report computes p50/p95/p99 and lists expected refusals separately from errors`; `aims table marks met and missed correctly`.
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement.** Point AI at the fake provider by the least-invasive route (an approved model whose connection's base URL is the local fake, if adapters allow it; otherwise a load-test-only adapter registered only when `KAINOW_LOAD_TEST=1` on a test installation) and record which in `load-test.md`. Sessions through `request-code`/`verify` with `LOG_SIGN_IN_CODES=true`, or a seeded session table row if rate limits block it; record which.
- [ ] **Step 4: Run tests; expect PASS. Then the real run**: a throwaway database and the API + worker built from this branch on the dev PC (Docker Desktop), `npm run load-test -- --seed`, then `-- --users 10 --minutes 30`. Write the report into `docs/operations/load-test.md` with "measured on <machine>; not a hardware guarantee". Report any missed aim to the PO.
- [ ] **Step 5: Commit** `feat(loadtest): 200/10 mixed-workload load test and first result`

### Task 13: Browser smoke run, Safari checklist and matrix

**Files:** Create `tests/browsers/{package.json,smoke.mjs,README.md,results/.gitkeep}`, `docs/operations/safari-check.md`, `docs/operations/browser-matrix.md`

**Interfaces:** `smoke.mjs` takes `KAINOW_URL`, `KAINOW_EMAIL`, `KAINOW_API_LOG`, `BROWSERS` (comma list: `chrome,msedge,firefox,webkit` plus previous-version entries where available) and writes `results/<date>.md`. Journey: §14.1's steps, each asserting a visible heading or text and no console errors, with a screenshot.

- [ ] **Step 1: Write the smoke script and README** (setup as `tests/a11y/README.md`, own throwaway database, Playwright pinned, browsers installed with `npx playwright install firefox webkit`).
- [ ] **Step 2: Run it** across every browser obtainable on this PC at 1280×800, 390×844 and (Chrome, WebKit) 820×1180. Fix product defects it finds in their own commits with tests.
- [ ] **Step 3: Write `safari-check.md`** (§14.2: reaching the test installation from the Apple device and undoing it, reading the version, each journey step with what to tap and what should appear, the result table) and `browser-matrix.md` (every browser × current/previous × device class; unchecked rows say "not checked"; Vite's build target recorded against the matrix).
- [ ] **Step 4: Prompt the PO** with the checklist link, the address to open and the expected time; record their results in the matrix when they reply. (Do not block the remaining tasks on it.)
- [ ] **Step 5: Commit** `test(browsers): smoke run, Safari checklist and browser matrix`

### Task 14: Documents and INSTALL.md

**Files:** Modify `INSTALL.md` (§10: install from a verified tag, `compose.override.yaml`, `.env` additions, "Updates" with the cron line and the updater's power stated plainly and how to turn it off/update by hand, "After a failed update", Everyday use row), `docs/Kainow-V1.0-Consolidated-Product-Specification-and-Decision-Register.md` (D119–D124; browser paragraph → matrix), `docs/Kainow-V1.0-Configuration-Catalogue.md` (C105–C110 per spec §17), `docs/Kainow-V1.0-Permission-Matrix.md` §8 (§12 rows), `docs/Kainow-V1.0-Remaining-Design-and-Verification-Register.md` (§6 updater contract designed in 10b with verification state; R19; capacity row with the load result), `docs/Kainow-V1.0-Application-Architecture-and-Operations-Design.md` §7/§9 pointer, `app/README.md`, `CHANGELOG.md` Unreleased entries

- [ ] **Step 1: Write the changes**; copy decision texts verbatim from spec §2.1.
- [ ] **Step 2: Check** every crontab and command line in INSTALL.md against `compose.yaml` and the CLI names; `docker compose config -q` passes with `compose.override.example.yaml` copied to a scratch folder.
- [ ] **Step 3: Commit** `docs: sub-project 10b decisions, catalogue, matrix, INSTALL updates`

### Task 15: End-to-end update in WSL2 and the outage measurement

**Files:** Create `docs/operations/verify-update.md` (the procedure and the recorded result)

- [ ] **Step 1: Check for a WSL2 distribution** (`wsl -l -v`). If none, record "not run: no WSL2 distribution or Linux VM" in `verify-update.md` and the hand-over, and stop this task.
- [ ] **Step 2: Inside WSL2**: a local bare repository standing in for GitHub, a throwaway release key, a tiny local server answering `KAINOW_RELEASE_API`'s tags request; release `v0.0.1` (this branch), install it per the new INSTALL.md, add a backup folder and key (throwaway), run one backup.
- [ ] **Step 3: Release `v0.0.2`** (a trivial change plus a harmless migration); Check now in the browser, approve "as soon as possible", run the tick by hand until it is `ready`, then at the time until `succeeded`. Confirm: pre-update backup recorded, maintenance seen in the browser, migration applied, version `0.0.2` shown. Measure maintenance on → healthy (aim under 5 minutes).
- [ ] **Step 4: Release `v0.0.3`** with a migration that fails. Confirm the notice page, the cron-log operator line, then `recover --yes`: Kainow back on `v0.0.2`, read-only, update shown as recovered, failed database kept under its new name.
- [ ] **Step 5: Record** the results (versions of Docker, Compose, git, the timings, anything that differed from the spec) and commit `docs: end-to-end update verification`.

## After all tasks

1. Final whole-branch review by a fresh Opus reviewer against the spec; one fix wave; re-review of the fix wave.
2. Full server suite in the background (`KAINOW_TEST_DATABASE_URL=…/kainow_test_sp10b`, `KAINOW_TEST_PG_DOCKER=kainow-testdb`), web tests and build; both green.
3. Hand-over note in the shared notes folder: calls made (Tasks 5, 8, 12, 13, 15), measured figures, what was not verified (real GitHub, a Linux VM if Step 15.1 found none, Safari until the PO's check), and the reminder that `v1.0.0` follows the go-live history rewrite.
4. Rebase onto `main` once #24 merges; then the PO chooses how to integrate.
