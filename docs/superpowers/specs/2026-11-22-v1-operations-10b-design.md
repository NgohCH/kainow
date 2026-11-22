# V1.0 sub-project 10b: operations part 2 — updater, release signing, load test and supported browsers — design

**Date:** 22 November 2026
**Status:** Approved by the Product Owner on 22 November 2026, including the calls listed at hand-over (updater runs as the folder owner, compatibility checks before stopping, D111 backup rule at approval, 30-minute backup retry, recovery on the previous version, configurable release API, load-test aims, go-live step `updates`, restart message).
**Builds on:** sub-project 10a, branch `TheLord/vigilant-hawking-7ee526` (PR #24, open). This branch (`TheLord/nice-goldberg-5d2b2b`) is cut from 10a's head 2b270e3 and is rebased onto `main` once #24 merges.
**Reserved numbers:** migration `0034_updates.sql`; Decision Register D119–D126 (D125–D126 kept for decisions found while building); Configuration Catalogue C105–C112 (C111–C112 kept likewise). 10a holds 0033, D109–D118 and C93–C104. Checked on `main` at 94b592f (highest: migration 0032, D108, C92).
**Authority:**
- Intent Card "Accepted runtime direction" ("release-specific Administrator-approved updates"; 200 registered / 10 concurrent users).
- Product Summary §19 (every release update needs explicit Enterprise Administrator approval; tested scale-up).
- Consolidated Specification A02, A03, A04, A07, A18, A19 and the responsive-web/browser paragraph ("current and previous major Edge, Chrome, Firefox and Safari releases at product release, with a documented matrix").
- Application Architecture and Operations Design §7 ("release integrity/authenticity checks, compatibility validation, maintenance/quiescence, backup verification, migration handling and post-update health checks require a concrete design before enabling updates. Database rollback cannot be assumed safe merely because an older application image exists"), §8 (capacity assessment) and §9.
- User Journeys and Acceptance Criteria (verify 200/10 with a documented mixed workload; verify release-specific EA approval, pre-update backup, migration compatibility, health outcomes and recovery).
- Remaining Design and Verification Register §6 ("updater integrity/privilege/migration/maintenance/recovery contract"), R19 (browser matrix) and the Presentation row.
- The 10a design `2026-11-20-v1-operations-10a-design.md`, §11 (hooks for 10b) and §16.

## 1. Purpose and the why

A02 promises a built-in update path where an Enterprise Administrator approves each release. Today an update is `git pull` and `docker compose up -d --build` typed by whoever runs the server: nothing checks who made the code, nothing takes a backup first, nothing stops people saving while the database migrates, and nothing says what to do when it goes wrong. The product has no releases yet (version `0.0.0`, no tags).

10b makes releases trustworthy and updates safe and visible, and produces the two pieces of evidence the acceptance criteria ask for before release: a measured load assessment for 200 registered / 10 concurrent users, and a supported-browser matrix.

### Goals

- **Releases** are git tags on the public GitHub repository, signed by the Product Owner's own SSH key, made by one release script. Nobody else can make a release an installation will accept, even someone who takes over the GitHub account.
- **Checking**: every installation looks for new releases daily, and an Enterprise Administrator can check at any time. A new release tells every Enterprise Administrator.
- **Approval**: an Enterprise Administrator approves one exact release, with a reason, to install at a chosen time (at least 15 minutes ahead). Approval covers that release only.
- **Warning**: every active person is emailed when the update is approved and again the day before, and sees a banner until it starts.
- **Installing**: an updater container verifies the signature, builds the new version while the old one keeps running, then at the approved time enters maintenance (read-only), takes a `pre_update` backup, migrates, restarts and checks health.
- **Failure**: before the migration, Kainow goes back to the old version by itself. After the migration, Kainow stays stopped behind a fixed "update failed" page, and the server operator runs one guided recovery command that restores the pre-update backup with the old version. Nothing is restored silently.
- **Load test**: a repeatable script that measures 200 registered / 10 concurrent users on a mixed workload and reports against stated aims.
- **Browsers**: an automated smoke run across Chrome, Edge, Firefox and the WebKit engine, a step-by-step manual Safari check the Product Owner performs, and a documented matrix with the actual versions.

### Non-goals (10b)

- Ready-built images or a container registry (option B), or a signed image bundle (option C). Updates build from the signed source tag on the server (§2).
- Automatic installation without approval, or blanket approval of later releases (A02).
- Downgrades, pre-release channels or installing an arbitrary commit.
- Automatic database rollback, or a "roll back" button in the browser.
- High availability or zero-downtime updates. An update has a short planned outage.
- Updating the host (Docker, the OS) or PostgreSQL's major version.
- A notice telling people their browser is unsupported.
- Hardware sizing guarantees from the load test (Architecture §8).

### Anti-goals (failure even if it works)

- Installing code whose signature does not verify against the installation's trusted key, or a commit other than the one approved.
- Installing anything nobody approved, or a release older than or equal to the running one.
- Anyone losing work they saved: no save is accepted between the pre-update backup and the end of the update.
- Restoring a backup without a person deciding to.
- An always-running container with control of Docker, or a web request that can make the updater do anything except install an approved, signed release.
- Showing an update as succeeded when the new version failed its checks, or leaving people with a blank error instead of a page that says what is happening.
- A key, secret, `.env` content or host path in a log, screen, email or audit event.

## 2. Decisions taken with the Product Owner (22 November 2026)

| Topic | Decision |
|---|---|
| Hosting | A cloud Linux VM or server (as 10a). |
| Release source | GitHub release tags on the product repository. The PO is the only publisher. Installations check on a regular interval, and an Administrator can check by hand. |
| How updates are applied | An updater container inside Compose (option A of A02). |
| Backup first | Every update takes a `pre_update` backup with 10a's backup command first. |
| What an installation downloads | **Option A: the signed source tag, built on the server.** The PO signs the tag with an SSH key that never leaves the PO's PC; the installation verifies it against the PO's public key fixed at install time, then builds the images as installs do today. Considered: (B) images built by GitHub Actions and pulled from GitHub's registry — faster and identical everywhere, but the signing trust moves to the GitHub account or a key held in GitHub, and the PO maintains a publishing pipeline; (C) a signed image bundle (~500 MB) uploaded by hand — key stays with the PO but every release is a large upload and ARM servers need a second build. A was chosen because it keeps today's install path, keeps the key with the PO, and every failure in it happens before anything changes. |
| Failure after the migration | Kainow stays stopped behind a fixed "update failed" page; the server operator runs a guided restore from the pre-update backup with the previous version. No silent automatic restore. Failure before the migration goes back to the old version automatically. |
| Warning people | Banner from approval until the update starts, plus **email to every active person** when the update is approved and again the day before. |
| Safari | The PO has an Apple device and performs the Safari check by hand from a step-by-step checklist; the builder prompts the PO when it is due. |
| First release and the history rewrite | The go-live history rewrite (old commits holding an organisation's domain, force-pushed) happens **before** the first real release, `v1.0.0`. A signed tag points at one exact commit, so a tag made before the rewrite would point at a commit that no longer exists. Until then 10b is tested only with throwaway keys and local tags; nothing is tagged or released on GitHub. The rewrite itself is a separate go-live step, not part of 10b. |
| Who is told when an update fails after the migration | **No email from the updater** (it holds no email settings, keeping the one container that controls Docker free of secrets). The page everyone sees says to contact their Administrator; the server operator is alerted through the server's log mail (cron `MAILTO`, as 10a recommends for backup failures). Once `recover` has run, the Enterprise Administrators get the in-app notice and the email. |

### 2.1 New Decision Register entries

| ID | Decision |
|---|---|
| D119 | **Releases and signing** (22 November 2026). A Kainow release is a tag `vMAJOR.MINOR.PATCH` on the product's GitHub repository, made by the release script and signed with the Product Owner's SSH release key, whose private part never leaves the Product Owner's computer. Each installation trusts the public keys in its own release-signers file, placed at installation and kept outside git. A release can change that file only when the release itself verifies against the current file. An installation installs only a tag whose signature verifies, whose internal tag name matches the tag, and whose version matches the tag. Untagged commits, pre-release tags and unsigned tags are never installed. |
| D120 | **Checking for releases** (22 November 2026). Kainow checks the product repository for newer release tags once a day, and when an Enterprise Administrator chooses Check now. A newer release sends one notice to every Enterprise Administrator, by email and in Kainow. Checking only reads the list of tags; nothing is downloaded or installed. |
| D121 | **Approving an update** (22 November 2026). An Enterprise Administrator approves one exact release (its tag and commit) with a reason and a start time at least 15 minutes ahead. One approval covers one release; later releases need their own. Only one update can be approved or in progress at a time; it can be cancelled, with a reason, until it starts. A release older than or equal to the running version cannot be approved. Approval is refused while protective read-only mode is on, and, as D111 already requires, while no successful backup younger than 24 hours exists; the update then also takes its own pre-update backup. Every active person is emailed when the update is approved (and when it is cancelled or moved) and again 24 hours before it starts if it was approved more than 24 hours ahead; a banner shows the time and expected length until it starts. |
| D122 | **Installing an update** (22 November 2026). The updater runs only when the server's schedule starts it; it is never left running. After approval it fetches and verifies the release and builds it while the current version keeps running. At the approved time it puts Kainow into maintenance (read-only, with its own banner), takes a pre-update backup, and installs only if that backup succeeds. It then migrates the database, starts the new version and checks its health. The update counts as succeeded only when every check passes; maintenance then ends. If anything fails before the migration starts, Kainow returns to the previous version and normal use by itself, and Enterprise Administrators are told. Every step is recorded in Kainow. |
| D123 | **A failed update after the migration** (22 November 2026). If the migration or anything after it fails, Kainow stays stopped and shows a fixed page saying it is unavailable after a failed update and asking people to contact their Administrator. The updater sends no email (it holds no email settings); the server operator is alerted through the server's log mail. Nothing is restored automatically. The server operator runs the recovery command, which keeps the failed database under another name, restores the update's pre-update backup with the previous version, and starts Kainow in protective read-only as for any restore (D112); an Administrator checks and resumes. Because maintenance blocked every save after the pre-update backup, nothing saved is lost. |
| D124 | **Supported browsers** (22 November 2026). Kainow supports the current and previous major releases of Edge, Chrome, Firefox and Safari at each product release, on desktop, tablet and phone. Each release records a browser matrix with the exact versions checked, how (automated or by hand) and the result; a version not checked is recorded as not checked, never as supported. |

D125 and D126 stay reserved for decisions found while building.

## 3. Concepts

- **Release**: a signed annotated tag `vX.Y.Z` on the product repository, pointing at a commit whose `app/package.json` version is `X.Y.Z`. Its tag message holds the release notes.
- **Release key**: the PO's SSH ed25519 key. The public part is in the repository's `release/release-signers` file (tracked) and, at installation, copied to the installation's **trusted signers file** `release-signers` in the Kainow folder (untracked, `.gitignore`d).
- **Update**: one approved release on its way to being installed, a row in `updates` (§9) with a state (§6.1).
- **Updater**: a new Compose service `updater` (profile `updater`) with its own image. It is the only part of Kainow that can control Docker. The server's cron starts it every 5 minutes as a one-shot container (`tick`); it exits when the tick is done.
- **Staging checkout**: a git worktree of the installation's repository at the new tag, under `.kainow-staging/<tag>` in the Kainow folder, used to build the new images before the window.
- **Maintenance**: 10a's operations state with the new reason `update`: the same guard, worker pause and banner, with update wording.
- **Notice page**: a tiny fixed page served by the updater image on Kainow's port while Kainow is stopped after a failed update.

## 4. Releases (D119)

### 4.1 The PO's one-time setup

Documented in `docs/operations/releasing.md`:

1. Create the key on the PO's PC: `ssh-keygen -t ed25519 -C "kainow-release" -f <path>`, with a passphrase. The builder never creates, reads or handles this key; the PO does this step and the builder prompts for it when the release script is ready.
2. Put the public key line into `release/release-signers` in the format `kainow-release namespaces="git" ssh-ed25519 AAAA…` and commit it.
3. Keep an offline copy of the private key (as the backup-key recovery copy in INSTALL.md).

Until the PO has done this, the repository's `release/release-signers` holds no key and the release script refuses. Tests use throwaway keys generated in a temporary folder. The first real release, `v1.0.0`, is made only after the go-live history rewrite (§2).

### 4.2 The release script

`npm run release -- <X.Y.Z>` from the repository root (a Node script in `scripts/release.mjs`, no new dependencies). It:

1. Refuses unless: on `main`, working tree clean, up to date with `origin/main`, `X.Y.Z` is greater than every existing release tag, the key in git's `user.signingkey` matches a line in `release/release-signers`, and `CHANGELOG.md` has a section for `X.Y.Z`.
2. Sets the version to `X.Y.Z` in `app/package.json`, `app/package-lock.json`, `app/web/package.json` and the image tags in `compose.yaml` (`kainow-app:X.Y.Z`, `kainow-ops:X.Y.Z`, `kainow-updater:X.Y.Z`), and commits "Release vX.Y.Z".
3. Creates the annotated tag signed with SSH (`git -c gpg.format=ssh tag -s vX.Y.Z -F <notes>`), the message being that version's `CHANGELOG.md` section.
4. Verifies the tag against `release/release-signers` exactly as an installation will (§5.3), and stops before pushing if it fails.
5. Asks for confirmation, then pushes the commit and the tag and creates the GitHub release with the same notes (`gh release create`).

`--dry-run` does everything except the push and the GitHub release, in a throwaway clone.

### 4.3 Rotating the release key

A release may change `release/release-signers` (add a new key, later remove the old one). When the updater installs a release, it copies the release's `release/release-signers` over the installation's trusted file only after that release verified against the trusted file as it was. INSTALL.md also describes replacing the file by hand if the key is lost (cross-checked against the key printed in INSTALL.md and on the GitHub release page).

## 5. The updater (D122)

### 5.1 Image and Compose service

- **Image**: Dockerfile target `updater`, from the `runtime` stage, adding `git`, `openssh-client` (for `ssh-keygen -Y verify`), and Docker's CLI and Compose plugin from Docker's apt repository with its signed key (same pattern as 10a's PostgreSQL repository). Image `kainow-updater:<version>`.
- **Service `updater`**: `profiles: [updater]`, `restart: "no"`, no ports, `read_only: true`, tmpfs `/tmp`.
- **Mounts**:
  - `/var/run/docker.sock` (the privilege this whole design keeps in one place);
  - the Kainow folder at **the same absolute path** as on the host (`${KAINOW_INSTALL_DIR}:${KAINOW_INSTALL_DIR}`), working directory set to it, so `docker compose` inside the container resolves the same relative paths, project name and `.env` as on the host;
  - the backup folder is **not** mounted: the updater runs the backup through the `ops` service (§5.5).
- **User**: the owner of the Kainow folder (`user: "${KAINOW_UID}:${KAINOW_GID}"`, set in `.env`; INSTALL.md gives the `id -u`/`id -g` lines), with the Docker socket's group added (`group_add: ["${DOCKER_GID}"]`, from `stat -c %g /var/run/docker.sock`). Running git as the folder's owner avoids git's "dubious ownership" refusal and never leaves root-owned files in the folder. `HOME` is a tmpfs so git and Docker can write their small config. *Design call*; Docker access is still root-equivalent, recorded as the trust boundary in §8.
- **Environment**: `DATABASE_URL` (to read and write its own rows), `KAINOW_INSTALL_DIR`. No email variables, no keys.

### 5.2 The schedule

INSTALL.md adds one crontab line (§4.2 of 10a lists the others):

```
# Updater: checks for an approved update every five minutes
*/5 * * * * cd /opt/kainow && docker compose --profile updater run --rm updater node dist/updater/updater-cli.js tick >> /var/log/kainow-ops.log 2>&1
```

Each tick takes a PostgreSQL advisory lock (its own key, separate from 10a's backup lock), records that it ran (`updater_ticks`, diagnostic, D115 retention), and does at most one thing: prepare an approved update, start a due one, or nothing. A tick that finds the lock held exits at once. A tick that is still running when the next cron start comes simply makes that one exit.

*Design call*: the updater does not check GitHub for releases; the worker does (§6.2). The updater only acts on a row an Enterprise Administrator approved.

### 5.3 Verifying a release

Given an approved update (tag `vX.Y.Z`, commit SHA recorded at approval):

1. `git fetch --no-tags origin refs/tags/vX.Y.Z:refs/kainow/candidate/vX.Y.Z` in the installation's repository (a private ref, so a moved tag never silently changes `refs/tags`).
2. The fetched object must be an annotated tag object (not a lightweight tag) whose internal `tag` header equals `vX.Y.Z`.
3. `git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=<Kainow folder>/release-signers verify-tag <object>` must succeed with the principal `kainow-release`.
4. The tag must point to the commit recorded at approval.
5. At that commit, `app/package.json` version must equal `X.Y.Z`, and `X.Y.Z` must be greater than the running version.

Any failure ends the update as `refused` with a fixed code (§5.8) and notifies the Enterprise Administrators. Nothing has changed on the server.

### 5.4 Preparing (before the window)

Started by the first tick after approval:

1. **Space**: the free space of the disk holding the Kainow folder must be at least 4 GB above the safe floor (10a's setting); otherwise `no_space_to_build`. *Builder checks* how much a build actually uses and records it; the 4 GB margin is adjusted to the measurement.
2. **Working tree**: the installation's checkout must be clean (`git status --porcelain` empty for tracked files) and at a release tag (detached `HEAD` at the running version's tag). Otherwise `local_changes` or `not_on_release`, naming the files changed (paths within the repository only). Local settings belong in `.env` and `compose.override.yaml` (§10).
3. **Verify** (§5.3).
4. **Staging checkout**: `git worktree add --detach .kainow-staging/vX.Y.Z <commit>`.
5. **Compatibility checks** (Architecture §7 "compatibility validation"), all against the staging checkout with the installation's own `.env` and `compose.override.yaml`, before anything stops:
   - `docker compose … config -q` must succeed. A release that needs a new required setting fails here (`settings_missing`, naming the variable from Compose's message, never its value).
   - The `db` service in the resolved staging configuration must equal the running one's (image, volumes, environment names). Otherwise `db_service_changed`: such a release is installed by hand.
   - The release's `release/requirements.json`, if present, is read: `{ "manual": true, "note": "…" }` refuses with `manual_install` and shows the note; `{ "minimumFrom": "X.Y.Z" }` refuses with `upgrade_path` when the running version is older (install the named release first).
6. **Build**: with the staging checkout as the project directory and the installation's project name and files: `docker compose --project-directory <staging> --project-name <installation's project name> --env-file <Kainow folder>/.env -f <staging>/compose.yaml [-f <Kainow folder>/compose.override.yaml] build`, so `build.context: ./app` resolves to the **new** code. This produces `kainow-app:X.Y.Z`, `kainow-ops:X.Y.Z` and `kainow-updater:X.Y.Z` beside the running images. The running containers are untouched. A test checks that the built image's `package.json` version is `X.Y.Z`.
7. State becomes `ready`. A build failure ends the update as `failed_before_install` (`build_failed`), removes the staging checkout and notifies; nothing has changed.

Preparation is limited to 60 minutes; beyond that it is `build_failed` (`build_timeout`).

### 5.5 Installing (at the window)

The first tick at or after the approved time, with the update `ready`. Each step is recorded in `update_steps` with its start, finish and outcome.

1. **Re-check**: still approved and not cancelled; protective mode (low space) not on; the staging tag object is the same object id as verified in §5.4 (`build_failed` otherwise is not possible — a mismatch is `refused`, `tag_changed`).
2. **Maintenance on**: set `operations_state` to `protective = true, reason = 'update'` with the update id. The API refuses changes with the update text (§7.1); the worker pauses (10a's rules: email still sends). Wait 10 seconds beyond the state cache's 5 seconds, so every process has seen it.
3. **Pre-update backup**: `docker compose --profile ops run --rm ops node dist/ops/backup-cli.js --kind pre_update` (the **running** version's `ops` image), reading the run id from its last output line. If the backup lock is held (a nightly backup or a drill is running; the backup command gets a distinct exit code for this, 3), it waits and retries every minute for up to 30 minutes, with maintenance on. If it fails, or the lock is still held after 30 minutes, the update ends `failed_before_install` (`backup_failed`), maintenance ends, and the Administrators are told; 10a's backup-failure notice also fires.
4. **Stop**: `docker compose stop api worker`. From here until §5.6 step 3, people see the browser's own "can't reach" or the web app's offline message (§7.2).
5. **Switch the code**: `git -c advice.detachedHead=false checkout --detach <commit>` in the Kainow folder; then copy `release/release-signers` to the trusted file (§4.3). If the checkout fails, go back (§5.6) with `checkout_failed`.
6. **Migrate**: `docker compose run --rm migrate` (now the new image). This is **the point of no return**: from the moment this command starts, any failure is `failed_after_migration`.
7. **Start**: `docker compose up -d api worker`.
8. **Health checks** (all within 10 minutes):
   - the `api` container's health check is healthy (`/health`, unchanged);
   - the `worker` container has been running for 60 seconds without restarting;
   - `docker compose run --rm api node dist/updater/post-check-cli.js` exits 0: the database's migration level equals the code's, and the code's version equals `X.Y.Z`.
9. **Maintenance off**: clear `operations_state` (only if its reason is still `update` for this update), record `succeeded`, write the audit event `ops.update_succeeded`, notify the Enterprise Administrators, and close the "update approved" banner.
10. **Tidy**: remove the staging checkout and the `refs/kainow/candidate/*` ref; remove Kainow images older than the previous version (the previous version's images are kept until the next successful update).

### 5.6 Going back before the migration

Used for any failure in §5.5 steps 4–5 (and step 3, where nothing was stopped yet):

1. `git checkout --detach <previous tag>` if the code was switched; restore the trusted signers file if it was copied.
2. `docker compose up -d api worker` with the previous images.
3. Wait for the same health checks (§5.5 step 8, with the previous version).
4. Clear maintenance, record `failed_before_install` with the code, audit `ops.update_failed`, notify the Enterprise Administrators.

If going back itself fails health checks, the update is recorded `failed_needs_attention` and handled as §5.7 without the database part (the operator's recovery command skips the restore when no migration ran).

### 5.7 After a failed migration or failed health checks (D123)

1. `docker compose stop api worker`.
2. **Back to the previous code at once**: `git checkout --detach <previous tag>` and restore the trusted signers file. The folder then holds the previous `compose.yaml`, so the notice page and `recover` run on the **previous** version's updater image (kept since §5.5 step 10), never on the release that just failed. The database stays as the failed migration left it until `recover`.
3. Start the notice page: `docker compose --profile updater up -d notice`, a service using the updater image that serves one fixed HTML page and `503` on Kainow's port (`127.0.0.1:${KAINOW_PORT}`), with the text: "Kainow is unavailable after a failed update. Nothing you saved before the update started has been lost. Please contact your Administrator." It is styled from inline CSS only, with no data from the database.
4. Record `failed_after_migration` with the code and the pre-update backup run id in the update row, best effort (the schema may be half-migrated; a failed write is only logged). No notices or emails are written here: this database is set aside by `recover`, so they would never be read or sent. Print the operator message to the cron log (which reaches the operator through cron's `MAILTO`, INSTALL.md): "The update to vX.Y.Z failed after the database migration started. Kainow is stopped and shows a notice page. Run: docker compose --profile updater run --rm updater node dist/updater/updater-cli.js recover. See INSTALL.md, 'After a failed update'."
5. Every later tick does nothing but repeat that log line once a day.

### 5.8 Failure codes

Fixed codes with fixed text, as 10a's (never raw command output, which can carry paths): `local_changes`, `not_on_release`, `no_space_to_build`, `settings_missing`, `db_service_changed`, `manual_install`, `upgrade_path`, `backup_busy`, `fetch_failed`, `not_annotated`, `tag_name_mismatch`, `signature_invalid`, `commit_mismatch`, `version_mismatch`, `not_newer`, `tag_changed`, `build_failed`, `build_timeout`, `protective_on`, `backup_failed`, `checkout_failed`, `migration_failed`, `start_failed`, `health_failed`, `rollback_failed`. The full command output goes to the cron log only, with the database URL masked.

### 5.9 The recovery command (`recover`)

Run by the server operator, never by a tick, after reading INSTALL.md "After a failed update". `updater-cli.js recover [--yes]` shows what it will do and asks for confirmation (`--yes` skips the prompt):

1. Refuses unless the latest update is `failed_after_migration` or `failed_needs_attention`.
2. Stops the notice page.
3. **Keeps the failed database**: renames database `kainow` to `kainow_failed_<YYYYMMDD>_<short update id>` and creates an empty `kainow` (through `docker compose exec db`). Nothing is dropped. INSTALL.md says how to remove it once the organisation is satisfied.
4. Confirms the folder is at the previous release tag (§5.7 step 2 put it there) and the trusted signers file is the previous one.
5. Runs 10a's restore with the update's pre-update set: `docker compose --profile ops run --rm ops node dist/ops/restore-cli.js --set <pre_update set> --reason "Recovering from failed update to vX.Y.Z"`. 10a's restore puts Kainow in protective read-only (`restored_from_backup`), ends sessions, and marks queued emails and jobs as not run (D112).
6. **Puts the update record right in the restored database**, before Kainow starts. The pre-update backup was taken while this update was `installing`, so the restored database holds that row as `installing` with its early steps. In one transaction `recover`:
   - sets the row to `recovered`, with the failure code, `finished_at`, and the restore's run id;
   - copies the later `update_steps` rows from the set-aside database (read through a second connection; skipped with a note if they cannot be read);
   - writes the audit event `ops.update_recovered`;
   - writes the urgent in-app notice `update_failed` to every Enterprise Administrator, with email outbox rows. These are written after the restore, so the restore does not mark them "not sent", and the worker sends them once it starts.
   The tick's re-entry rule (§7.1) never sees an `installing` row left behind.
7. `docker compose up -d` (previous version); waits for health.
8. Prints the 10a restore message plus: "Kainow is back on vA.B.C. Review and choose Resume on the Operations page."

When no migration ran (`failed_needs_attention` from §5.6), steps 3 and 5 are skipped.

*Note for INSTALL.md*: maintenance stopped every save after the pre-update backup, so the restore loses nothing people saved; the restore's side effects (signed out, queued emails marked not sent) are listed.

## 6. Checking, approving and warning (D120, D121)

### 6.1 Update states

`available` releases are not update rows; they are `release_checks` results. An update row moves through:

```
approved → preparing → ready → installing → succeeded
                │          │        ├─────→ failed_before_install
                │          │        ├─────→ failed_after_migration → recovered
                │          │        └─────→ failed_needs_attention → recovered
                ├──────────┴──→ refused / failed_before_install (build)
approved | preparing | ready ──→ cancelled   (by an Enterprise Administrator, with a reason)
```

Only one row may be in `approved`, `preparing`, `ready` or `installing` (partial unique index). A new approval is also refused while the latest update is `failed_after_migration` or `failed_needs_attention`.

### 6.2 Checking for releases

- **Source** (worker and api environment): `KAINOW_RELEASE_REPO` (`owner/name`, default the product repository) and `KAINOW_RELEASE_API` (default `https://api.github.com`). The second exists so the end-to-end test (§15) can point at a local stand-in serving the same tags response; INSTALL.md says to leave both unset.
- **Daily**: a worker schedule (once a day at a fixed minute, randomised per installation at first start, so installations do not all call at once) calls `GET <KAINOW_RELEASE_API>/repos/<KAINOW_RELEASE_REPO>/tags` (unauthenticated, `User-Agent: kainow-update-check`, no other identifying data, 10-second timeout), keeps names matching `^v\d+\.\d+\.\d+$` greater than the running version, and records the result (`release_checks`: at, outcome, newest tag and commit, or a fixed failure code). Paused in protective mode like other worker ticks? *Design call:* no — a read-only check that writes only its own diagnostic row runs in protective mode too, so Administrators can learn of a fix.
- **Check now**: `POST /admin/updates/check` (Enterprise Administrator) runs the same check immediately, at most once a minute per installation.
- **New release notice**: the first time a check finds a tag newer than any earlier check found, every Enterprise Administrator gets `release_available` by email and in Kainow ("Kainow vX.Y.Z is available. Review it on the Operations page."). One notice per tag.
- A failed check is shown ("Last check failed: GitHub could not be reached") and never notifies; three days of failed checks show a warning on the Operations page.

What the check knows is unverified (a tag name and commit). The Operations page says so: "Signature checked before installing." Release notes come from the signed tag message and are shown once the update is `ready` (verified); before then the page links to the GitHub release page.

### 6.3 Approving

On the Operations page, **Updates** section, for the newest available release: **Approve update**.

- Inputs: start time (date and time in UTC+8 like the rest of Kainow, at least 15 minutes from now, at most 30 days ahead; "As soon as possible" fills now + 15 minutes), expected length (minutes, default 30, 5–240) and a reason.
- Refused when: another update is open (§6.1); protective mode is on; the release is not newer than the running version; the latest update needs recovery; no successful backup younger than 24 hours exists (D111, using 10a's `freshBackup(now)`: "Updates are refused until a backup succeeds. See Backups above.").
- Shows the words "The update takes its own backup first and stops if that backup fails."
- Records the tag, commit, start time, length, reason and approver; audit `ops.update_approved`.
- **Cancel** (with a reason) until the update starts; **Change time** (with a reason, same bounds) until it starts. Audit `ops.update_cancelled`, `ops.update_rescheduled`.

### 6.4 Warning everyone

- **Emails** to every Active person (accounts able to sign in), through the existing email outbox, one row per person, with the organisation's branding:
  - on approval: "Kainow will be unavailable on <date> from <time> (UTC+8) for about <n> minutes while it is updated. Anything you save before then is kept.";
  - the day before: the same text, sent 24 hours before the start, only when the approval was made more than 24 hours ahead;
  - on a cancellation or a new time: the matching short text.
  The day-before email is sent by the worker's sweep (an `update_reminder_sent_at` column, so it goes once).
- **Banner** for every signed-in person, from approval until the update starts: "Kainow will be unavailable on <date> from <time> for about <n> minutes for an update." During maintenance the protective banner shows the update text (§7.1).
- These emails are operational notices: they ignore personal notification preferences, like sign-in codes, and are not part of digests. *Design call.*

## 7. Maintenance and what people see

### 7.1 Maintenance (reuses 10a)

- `operations_state.reason` gains `update`; `detail` holds the update id and version.
- API refusal while `reason = 'update'`: status 503, `{ code: 'update_in_progress', message: "Kainow is being updated. Nothing you have saved is affected; try again in a few minutes." }`.
- Banner: "Kainow is being updated. You can read; changes are paused until the update finishes."
- Sign-in page shows the same line.
- Resume from protective mode on the Operations page is **not** offered while the reason is `update` (only the updater ends it).
- If the updater dies mid-update (container killed, host restarted), the next tick finds an `installing` row whose lock is free: it re-checks where it got to from `update_steps` and either goes back (§5.6, before migration) or follows §5.7 (migration started). *Builder* makes each step re-entrant.

### 7.2 While Kainow restarts

The web app already loaded in a browser treats a network failure while the last known state was maintenance as "Kainow is restarting after an update…" and retries every 15 seconds, then reloads when `/health` answers. *Design call*, small change in the web app's API layer.

## 8. Trust boundary and privilege

| Part | Can control Docker | Reachable from the web | Holds keys |
|---|---|---|---|
| api, worker | No | api only | Auth secret; protected key optional (as now) |
| ops (10a) | No | No | Backup key, protected key |
| updater | **Yes** (Docker socket through its group; runs as the Kainow folder's owner) | No | None; trusted signers file is public keys only; no email settings |
| notice | No socket | Serves one fixed page | None |

What a compromised Enterprise Administrator account can do: approve an update to a release the PO signed, at a time at least 15 minutes ahead, with every active person emailed. It cannot choose the code, the commit or a downgrade. What a compromised GitHub account can do: publish a tag; installations refuse it unless it is signed by the release key. What a compromised server can do is out of scope (it already holds every secret).

INSTALL.md states plainly that the updater container has root-equivalent control of the server through the Docker socket, runs only when cron starts it, and can be disabled by removing its crontab line (updates are then done by hand: the same steps, documented).

## 9. Data model (migration `0034_updates.sql`)

Sketch; the builder fixes names, indexes and append-only triggers in the project's style.

```sql
ALTER TABLE operations_state DROP CONSTRAINT …, ADD CHECK (reason IN ('low_space','restored_from_backup','update'));

CREATE TABLE release_checks (id uuid PRIMARY KEY, at timestamptz NOT NULL, trigger text CHECK (trigger IN ('daily','manual')),
  actor_id uuid, outcome text CHECK (outcome IN ('found','none_newer','failed')), failure_code text,
  newest_tag text, newest_commit text);                    -- diagnostic (D115), except rows that first found a tag
CREATE TABLE releases_seen (tag text PRIMARY KEY, commit text NOT NULL, first_seen_at timestamptz NOT NULL,
  notified_at timestamptz);                                 -- one notice per tag

CREATE TABLE updates (id uuid PRIMARY KEY, from_version text NOT NULL, to_version text NOT NULL, tag text NOT NULL,
  commit text NOT NULL, tag_object text,                    -- set when verified
  state text NOT NULL CHECK (state IN ('approved','preparing','ready','installing','succeeded','refused',
    'failed_before_install','failed_after_migration','failed_needs_attention','recovered','cancelled')),
  starts_at timestamptz NOT NULL, expected_minutes int NOT NULL CHECK (expected_minutes BETWEEN 5 AND 240),
  approved_by uuid NOT NULL, approved_at timestamptz NOT NULL, reason text NOT NULL CHECK (btrim(reason) <> ''),
  cancelled_by uuid, cancelled_at timestamptz, cancel_reason text,
  reminder_sent_at timestamptz, release_notes text,         -- from the verified tag message
  pre_update_backup_run_id uuid REFERENCES backup_runs, recovery_backup_run_id uuid,
  failure_code text, finished_at timestamptz);
CREATE UNIQUE INDEX updates_one_open ON updates ((true)) WHERE state IN ('approved','preparing','ready','installing');
CREATE TABLE update_changes (...);                          -- append-only: approved, rescheduled, cancelled, state changes; actor or null for the updater
CREATE TABLE update_steps (id uuid PRIMARY KEY, update_id uuid NOT NULL REFERENCES updates, step text NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz, outcome text CHECK (outcome IN ('running','passed','failed','skipped')),
  failure_code text);
CREATE TABLE updater_ticks (id uuid PRIMARY KEY, at timestamptz NOT NULL, did text NOT NULL);   -- diagnostic (D115)
```

- Every listed order sorts stably: `ORDER BY approved_at DESC, id DESC`, `ORDER BY started_at, id`, `ORDER BY at DESC, id DESC`.
- Audit events: `ops.release_available`, `ops.update_approved`, `ops.update_rescheduled`, `ops.update_cancelled`, `ops.update_refused`, `ops.update_succeeded`, `ops.update_failed`, `ops.update_recovered`; added to the analytics event catalogue.
- Notification kinds: `release_available`, `update_succeeded`, `update_failed`, `update_refused`, and the people-wide email kinds `update_scheduled`, `update_reminder`, `update_cancelled`, `update_rescheduled`.
- 10a's diagnostic sweep expires `release_checks` and `updater_ticks` with D115's retention.
- The quarantine registry (which lists every text column) gets the new columns.

## 10. Installation changes

- **`compose.override.yaml`**: every local change moves there. `compose.yaml` stops telling people to uncomment lines; INSTALL.md gives a `compose.override.example.yaml` with the backup-key, protected-key and port lines. `compose.override.yaml` and `release-signers` and `.kainow-staging/` are in `.gitignore`.
- **Image tags** in `compose.yaml` carry the release version (set by the release script); until the first release they stay `0.0.0`.
- **`.env` additions**: `KAINOW_INSTALL_DIR`, `KAINOW_UID`, `KAINOW_GID`, `DOCKER_GID` (needed only by the updater; INSTALL.md gives the lines to fill them).
- **First real release**: `v1.0.0`, after the go-live history rewrite (§2).
- **Installing**: INSTALL.md "Install" becomes: clone, `git checkout vX.Y.Z` of the latest release, copy `release/release-signers` to `release-signers` after comparing the key with the one printed in INSTALL.md and on the GitHub release page, verify with the given `git verify-tag` line, then continue as now. Installations made before the first release keep working; the updater refuses them (`not_on_release`) until the operator checks out a release tag once (INSTALL.md gives the lines).
- **New INSTALL.md sections**: "Updates" (the cron line, what the updater can do, the approval flow, turning it off, updating by hand with the same steps); "After a failed update" (§5.9).
- **Everyday use**: the row "Update to a newer copy of the code" is replaced with "Approve updates on the Operations page".
- **Go-live checklist**: a new auto step `updates`: "Schedule the updater", done when an updater tick has been recorded in the last 24 hours and the installation is on a release tag. *Design call.*

## 11. Screens

**Operations page** gains an **Updates** section, after Backups:

- Running version, the installation's release key fingerprint (from the last tick's report), last release check (time, result) and **Check now**.
- **Available**: the newest release newer than the running one, with a link to its GitHub release page and **Approve update**.
- **Current update** (if any): version, state in words, start time, expected length, approver and reason, each step with its result once installing, release notes once verified, and **Change time** / **Cancel** until it starts.
- **History**: the last 20 updates with version, outcome, start and finish, and failure text.
- When an update needs recovery: a warning at the top of every Administrator page: "The update to vX.Y.Z failed. Kainow is on the notice page for everyone else; the server operator must run the recovery command (INSTALL.md, 'After a failed update')." (This shows only if Kainow is reachable at all, i.e. after recovery left it read-only — the notice page otherwise.)
- Status strip gains **Updates** (Up to date / Update available / Update scheduled / Update failed / Not checked for 3 days).

**Banners** (`App.tsx`, between header and `#main`): the update-scheduled banner for everyone; maintenance uses the protective banner slot with its own text.

**Analytics**: the `operations` panel adds update counts and outcomes for the period.

## 12. Permissions (Permission Matrix §8 additions)

| Action | Authority | Boundary |
|---|---|---|
| See release checks, available releases and update history | Enterprise Administrator (`operations.view`) | No host paths or command output. |
| Check for releases now | Enterprise Administrator (`operations.view`) | At most once a minute. |
| Approve, reschedule or cancel an update | Enterprise Administrator (`operations.manage`) | Reason; one signed, newer release; start at least 15 minutes ahead; refused in protective mode. |
| Prepare and install an approved update | The updater, started by the server's schedule | Only the approved tag and commit, verified against the installation's release key; pre-update backup first. |
| Recover from a failed update | Server operator (`recover` command) | Keeps the failed database; restores the update's own pre-update backup; Kainow restarts read-only. |
| Publish a release | Product Owner only (release key) | Signed tag on the product repository. |

## 13. Load test

### 13.1 What it is

`npm run load-test` in `app/` (`src/loadtest/`, Node, no new dependencies), run against a **test installation**, never a real one (it refuses a database whose organisation is not the seeded test organisation).

1. **Seed** (`--seed`): on an empty test database, an organisation "Example Organisation" (example.org), 200 Active people `load-001@example.org` … `load-200@example.org`, 5 departments, 40 projects (each with a PM, Owner, Sponsor and 4–12 members), about 3,000 tasks, 300 notes with versions, discussion threads, decisions, risks and 30 days of history. AI is configured with a stub model whose provider is a local fake server the script starts (no real provider is ever called; no cost). *Builder* finds the least-invasive way to point the AI adapter at the fake (the existing `testing/ai-connections.ts` fake factory is the pattern) and records it.
2. **Sessions**: the script signs each virtual person in through the real `request-code`/`verify` flow with `LOG_SIGN_IN_CODES=true` on the test installation (reading codes from the API log), or by a test-only session seed if the code rate limit makes that impractical; the builder records which.
3. **Run** (`--users 10 --minutes 30 --think 5-20s`): 10 virtual people at once, each looping a weighted journey with think time:

   | Share | Activity |
   |---|---|
   | 35% | Open My Projects, a project overview, its Work tab, a task |
   | 15% | Read discussion threads and notes |
   | 15% | Post a discussion comment; update a task's progress or status |
   | 10% | Personal and project dashboards |
   | 8% | Search |
   | 7% | Approve or reject a waiting proposal/change request |
   | 5% | Upload a small note and start an extraction (queued to the fake AI, 2 slots, 3–8 s each) |
   | 5% | Administrator analytics (one virtual person is an Enterprise Administrator) |

   The other 190 people exist (registered) and receive notifications, reminders and digests as the worker produces them.
4. **Report**: a Markdown file `load-test-<date>.md` with machine details (CPU, memory, disk, Docker version), the parameters, and per activity: count, errors, p50/p95/p99 response time; queue wait and run time for AI and email jobs; database: connections in use (max), slowest statements from `pg_stat_statements` if available (else "not available"), database size before/after; the worker's lag.

### 13.2 Aims

| Aim | Target |
|---|---|
| Page reads (GET) | p95 under 1 s |
| Saves (POST/PUT/PATCH/DELETE) | p95 under 2 s |
| Errors | none, other than the refusals the journey expects (e.g. approving an already-decided item) |
| AI queue | no request waits for a slot longer than the requests ahead of it need (2 slots honoured, none lost) |
| Email queue | every email produced during the run is sent (to the test mail sink) within 5 minutes |

Measured on the development PC through Docker Desktop for the build, and recorded as such: "measured on <machine>; not a hardware guarantee" (Architecture §8). INSTALL.md says how an organisation runs it on its own test installation. Misses are reported to the PO, who decides.

## 14. Supported browsers (D124)

### 14.1 Automated smoke run

`tests/browsers/` (its own `package.json`, like `tests/a11y/`), using Playwright, run against a test installation set up as the a11y README describes:

- **Browsers**: Chrome (installed channel), Edge (installed channel), Firefox (Playwright's build), WebKit (Playwright's build, labelled "WebKit engine, not Safari"). Previous major versions: Chrome and Edge from their installed previous channel where obtainable, Firefox via the ESR or the previous Playwright release pinned in a second config; anything not obtainable on this PC is recorded "not checked".
- **Sizes**: 1280×800 and 390×844 (phone), plus 820×1180 (tablet) in Chrome and WebKit.
- **Journey** (about 15 steps): sign in with a code; My Projects; open a project; Work tab; open a task and save a progress change; post a discussion comment; open a note; the review screen with a proposal; approve; dashboards; analytics as Administrator; the Operations page; sign out. Each step asserts visible content and no console errors, and takes a screenshot kept with the run's report.
- **Output**: `tests/browsers/results/<date>.md` with each browser's exact version, size, step results and failures.

### 14.2 Manual Safari check

`docs/operations/safari-check.md`, written for the PO, step by step, for Safari on macOS and on iPhone or iPad:

1. How to reach a test installation from the Apple device (the test installation on the PC bound to the local network for the check, with `COOKIE_SECURE=false`, or the cloud VM), and how to undo it afterwards.
2. How to read the Safari version (Safari › About Safari; Settings › General › About › iOS version).
3. The same journey as §14.1, each step with what to tap and what should appear, and a box for "as expected / what happened".
4. Where to write the result (a table to paste back, which the builder records in the matrix).

The builder prompts the PO when the check is due (after the web changes of this sub-project are built and the smoke run passes), with the link to the checklist and the address to open.

### 14.3 The matrix

`docs/operations/browser-matrix.md`: one row per browser × major version × device class, with the exact version, how checked (automated, by hand), date, result and any limitation. The Consolidated Specification's browser paragraph and the Remaining Register's Presentation row point to it. The build target of the web app (Vite's default) is recorded against the matrix; if a supported version is below that target, the builder lowers the target and records it.

## 15. Testing and measured aims

**Unit tests**: version comparison and tag-name rules; state transitions (§6.1) including the one-open rule; failure-code texts; approval bounds (15 minutes, 30 days, 5–240); reminder timing; the step re-entry decision (§7.1) for each step; banner and status-word helpers (web).

**Git and signature tests** (real `git` and `ssh-keygen` in a temporary folder with throwaway keys; skipped with a clear reason if absent, required in CI): a good signed tag verifies; unsigned, lightweight, wrong-key, renamed-tag (internal name differs), moved-tag (commit differs from approval) and version-mismatch tags are refused; key rotation through a release that verifies with the old key; a release changing the signers file but signed by the new key alone is refused.

**Updater flow tests** with a fake command runner (no real Docker): each step's success and failure leads to the right state, rollback before migration, the notice page after it, re-entry after a crash at every step, the advisory lock, and the log masking.

**Database tests** (own database, e.g. `kainow_test_sp10b`): approval/cancel/reschedule with reasons and audit; the partial unique index; release-check recording and one notice per tag; email rows to every Active person and none to others; the day-before reminder once; maintenance guard text and the hidden Resume; go-live step `updates`.

**HTTP tests**: the update endpoints and permissions; Check now's once-a-minute limit; the update-in-progress refusal.

**Release script tests** (`--dry-run` in a temporary repository with a throwaway key).

**A real end-to-end update** on the development PC, run **inside a WSL2 Linux distribution** using Docker Desktop's engine (a Windows `C:\` path cannot be mounted at the same path inside a Linux container); if no WSL2 distribution is available, on a Linux VM, or recorded as not run. Install a local test release `v0.0.1` signed with a throwaway key from a local bare repository standing in for GitHub (with a small local server answering `KAINOW_RELEASE_API`'s tags request), approve `v0.0.2` in the browser, let the cron tick (run by hand) prepare and install it, and confirm: pre-update backup recorded, maintenance seen in the browser, migration applied, new version reported. Then a `v0.0.3` with a deliberately failing migration: notice page shown, `recover` restores and Kainow comes back read-only on `v0.0.2`. This is a manual run recorded in the hand-over, not a CI test.

**Measured aims**:

| Aim | Target |
|---|---|
| Planned outage (maintenance on → new version healthy) on the bench database | under 5 minutes |
| Preparation (fetch, verify, build) on the development PC | recorded, no target |
| Load test | §13.2 |

## 16. Left to the builder

- Exact Docker apt repository pinning for the updater image; the socket mount for Docker Desktop on Windows (`//var/run/docker.sock`) for the development test.
- How the AI adapter reaches the load test's fake provider; how load-test sessions are created.
- How much disk a build uses (§5.4 margin).
- The previous-major browser versions actually obtainable on this PC.
- Table and index names; wording beyond the fixed texts given here.

Calls the builder makes are recorded in the plan and the final hand-over note.

## 17. Documents updated in this branch

- **Consolidated Specification**: D119–D124; the browser paragraph points to the matrix.
- **Configuration Catalogue**: C105 release source (product repository, daily check, Check now); C106 updater schedule (cron every 5 minutes); C107 update notice (minimum 15 minutes, maximum 30 days ahead, day-before email); C108 release signers file and key rotation; C109 expected update length (5–240 minutes, default 30); C110 supported-browser matrix.
- **Permission Matrix §8**: the rows of §12.
- **Remaining Design and Verification Register**: §6 updater contract "designed in sub-project 10b" with verification state; R19 browser matrix; the capacity row with the load-test result.
- **Architecture §7, §9**: pointer to this design for the updater.
- **INSTALL.md**: §10's changes.
- **`docs/operations/`**: `releasing.md`, `safari-check.md`, `browser-matrix.md`, `load-test.md` (how to run, last result).
- **`app/README.md`**: the updater commands and service, the load test.
- **`CHANGELOG.md`**: new, with an "Unreleased" section.
- **Analytics event catalogue**: the new `ops.*` events.

## 18. Outside 10b

- Ready-built images or a registry; multi-architecture builds.
- Zero-downtime updates, replicas, high availability.
- Host, Docker or PostgreSQL major-version upgrades.
- Unsupported-browser notices.
- Load testing beyond the 200/10 target (the script takes `--users` so an organisation can try more).
