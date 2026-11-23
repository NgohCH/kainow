# Installing Kainow on one computer (December 2026 MVP)

This starts Kainow with Docker Compose: a PostgreSQL database, the Kainow server (which also serves the review screen) and the background worker that talks to the AI. It is for one computer, reached at `http://localhost:3000`. There is no HTTPS and nothing is reachable from other computers.

**Status: first built and run on 8 November 2026** on Windows 11, with Docker Desktop 29.9.2 (WSL 2 engine) and Compose 5.6.1. These steps worked as written: the build, the migrations, creating the administrator, saving the spend settings, signing in at `http://localhost:3000` in a browser, uploading a Word document, the Windows backup, and every step of "Check that it works" below. One extraction of a synthetic note with the real `gpt-6.1-sol` returned 11 proposals, all quotes found, for MYR 0.06. If a step fails on your computer, I want to hear about it. The projects steps (6 and "Check that it works" 2–6) were walked through on the same install later that day, with four test accounts.

## Windows

The PowerShell lines in this guide were run in Windows PowerShell 5.1 on 8 November 2026 and work as written. The repository now forces Linux line endings (`.gitattributes`), so a Windows checkout does not break files inside the containers. If you cloned before that was added and see odd errors such as `\r` in a message, clone again. Use Docker Desktop with the WSL 2 engine (its default).

## What you need

- Docker Desktop (or Docker Engine with the Compose plugin), version 24 or later.
- About 2 GB of free disk space for the first build.
- An OpenAI or Anthropic API key for each project that will use AI, if you want AI to run. Keys are entered per project in Kainow itself, never in `.env` (see "Set up AI" below). Without one everything else works and AI requests end with a clear message, sending and costing nothing.
- A way to send email, if you want sign-in codes emailed. To try Kainow alone, codes can be printed in the server log instead.

## Install

### Get the code at a signed release

A real installation runs a **release**: a tag `vX.Y.Z` signed with the Product Owner's release key (decision D119; how releases are made: `docs/operations/releasing.md`). The updater (see "Updates") installs only signed releases, and refuses a folder that is not at one (`not_on_release`).

**No release has been published yet.** The first release, `v1.0.0`, comes after the go-live history rewrite; until then there is no tag to check out and no key to compare, and installations run from a plain clone as before. Once releases exist, on the server:

1. Clone the product repository and check out the latest release (its name is on the repository's GitHub releases page):

   ```
   git clone https://github.com/<owner>/<repository>.git /opt/kainow
   cd /opt/kainow
   git -c advice.detachedHead=false checkout --detach vX.Y.Z
   ```

2. Compare the key in `release/release-signers` with the release key published here and on the release's GitHub page. **Release key: not yet published** (it is created before `v1.0.0`; this line will then show the key and its `SHA256:` fingerprint). If they differ, stop: do not install. Then make the installation's own trusted copy, which is kept outside git and which the updater checks every release against:

   ```
   cp release/release-signers release-signers
   ```

3. Verify the tag against it. The output must say `Good "git" signature for kainow-release`:

   ```
   git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=release-signers verify-tag vX.Y.Z
   ```

Then continue with step 1 below. **An installation made before the first release** keeps working. To let the updater take it over, put it on a release tag once, from the Kainow folder: `git fetch --tags origin` and `git -c advice.detachedHead=false checkout --detach vX.Y.Z` (as in step 1, so that `release/release-signers` is the release's own file), then steps 2 and 3 above, then `docker compose up -d --build`. Move any change you made to `compose.yaml` into `compose.override.yaml` first (see "Local changes" below), because the checkout needs a clean folder.

1. **Make your settings file.** In this folder (the one with `compose.yaml`):

   ```
   cp .env.example .env
   ```

   (In Windows PowerShell, `cp` works too. `Copy-Item .env.example .env` is the same thing.)

   Open `.env` (in PowerShell, `notepad .env`) and fill in:
   - `POSTGRES_PASSWORD`: letters and digits only. On Mac or Linux: `openssl rand -hex 24`. In Windows PowerShell, which usually has no `openssl`:

     ```
     $b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
     ```
   - `AUTH_SECRET`: at least 32 characters. On Mac or Linux: `openssl rand -base64 48`. In Windows PowerShell:

     ```
     $b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
     ```
   - Email (sign-in codes and reminders): either the four Microsoft 365 variables (see "Microsoft 365 email" below), or `SMTP_URL` and `SMTP_FROM`, or, for a trial on your own computer only, uncomment both `NODE_ENV=development` and `LOG_SIGN_IN_CODES=true` to read codes from the log. Kainow refuses to start with `LOG_SIGN_IN_CODES` when `NODE_ENV=production` (the default), whatever `APP_URL` says, and in any mode when `APP_URL` is not this computer (`localhost` or `127.0.0.1`): anyone who can read the log could otherwise sign in as anyone. Before real use, set up email and remove both lines.
   - No AI key goes in `.env`. The worker does not read `OPENAI_API_KEY` or any provider key from its environment. AI keys are entered later, per project, in Kainow itself (see "Set up AI" below), and are stored encrypted with the protected key.
   - On a server that will take updates, the four updater lines `KAINOW_INSTALL_DIR`, `KAINOW_UID`, `KAINOW_GID` and `DOCKER_GID` (see "Updates"). Nothing else needs them. Leave `KAINOW_RELEASE_REPO` and `KAINOW_RELEASE_API` unset.

2. **Build and start.**

   ```
   docker compose up -d --build
   ```

   The first build downloads images and packages and takes a few minutes. The database migrates itself at every start.

3. **Invite the first Enterprise Administrator.** This emails a one-time setup link (with `LOG_SIGN_IN_CODES=true` it is written to `docker compose logs api`). It works only while the installation has no Administrator, and closes for good once that person signs in. Running it again before then replaces the earlier link.

   ```
   docker compose run --rm api node dist/users/setup-invite-cli.js you@example.org "Your Name"
   ```

   For a demonstration only, `docker compose run --rm api node dist/users/seed-demo-cli.js` instead sets up a made-up "Example Organisation" (example.com) with the Administrator admin@example.com, on an empty database.

4. **Save the starting AI spend settings** (1 USD = MYR 4.10, MYR 20 a month, no daily cap, projects not yet allowed to set limits or manage connections, 3 attempts, 120 seconds, 2 requests at once). This saves no model and no key, so AI still does not run: finish "Set up AI" below (approve a model in **AI** › **Models**, then add a connection and limits in each project). If settings are already saved, the command changes nothing, so running it again is safe; change them later in **AI** › **Limits and policy**, with a reason. Until settings are saved every AI request is refused:

   ```
   docker compose run --rm api node dist/spend/apply-mvp-settings-cli.js
   ```

5. **Open the setup link** (or `http://localhost:3000`) and sign in with the email you used. If you set `LOG_SIGN_IN_CODES=true`, read the code with:

   ```
   docker compose logs api --tail 20
   ```

   A new code is made at most once a minute. If you ask again sooner, the screen looks the same but no new code is made, so use the latest code in the log.

6. **Set up your organisation.** Until this is done Kainow is closed to everything else and shows its own name and logo. On the **Set up your organisation** screen:
   - Give the organisation's name.
   - Add at least one email domain (for example `example.com`). Only addresses at these domains can be invited, and a domain alone admits nobody.
   - Add at least one department. Every project belongs to one.
   - Optionally add a wide logo and a square logo (PNG or JPEG, up to 512 KB each).
   - Choose **Finish setup**. The organisation's name and logos then appear in the page header, on the sign-in page and in emails. They can be changed later on the **Organisation** screen.

7. **Create the first project:**
   - Under **My Projects**, choose **New project**. It starts as a Draft.
   - On the project's **People** tab, invite a Project Manager and an Owner or Sponsor. The Project Manager then invites the Members. Each invitation is emailed (or, with `LOG_SIGN_IN_CODES=true`, written to `docker compose logs api`) as a link that expires after seven days.

   Invitation links use `APP_URL` from `.env`, which defaults to `http://localhost:3000`. If other people reach this computer by another address, set `APP_URL` to it and run `docker compose up -d`.

   After the first project, anyone with an account can create projects and becomes their Project Manager.

### Local changes: `compose.override.yaml`

**Never edit `compose.yaml`.** An update replaces it, and the updater refuses a folder whose tracked files were changed (`local_changes`). Put every local change in `compose.override.yaml` in the same folder instead: Docker Compose reads it on its own, it is not tracked by git (`.gitignore`), and the updater checks every new release against it before anything stops. `compose.override.example.yaml` holds the usual changes (the protected key on `api`, `worker` and `ops`, and the backup key on `ops`):

```
cp compose.override.example.yaml compose.override.yaml
```

Keep only the parts you need: a mount whose key file does not exist yet makes Docker create an empty folder in its place, so remove the backup-key line until the key exists ("Backups", step 2) and the protected-key lines until that key exists ("Protected key"). For another port, set `KAINOW_PORT` in `.env` rather than changing `ports` (the notice page after a failed update follows it too). Check the result with `docker compose config -q`, which prints nothing when the files are valid. (Do not run `docker compose config` without `-q` where others can see the screen or a log: it prints the settings from `.env`, passwords included.)

## Check that it works

1. Sign in as the administrator. Until AI is set up (see "Set up AI" below) the top bar says that AI spending is not set up; after the organisation limits are saved it shows your remaining allowance.
2. Add a department and your domain, create a project, and invite a Project Manager, an Owner and a Member (three addresses at your domain). Open each link from the log, sign in with the code for that address, and accept.
3. As the Project Manager: **Move to Planned**, then **Make Active**. Until everyone has accepted, Kainow says which role is still needed.
4. As the Project Manager, on the **Notes** tab, add notes: paste any meeting notes, or upload one of `tests/extraction/inputs/synthetic/*.md`.
5. Choose "Find decisions and actions". The run should go from waiting to ready in under a minute.
6. Sign in as the Owner, choose Review, **Authorise** one proposal (for an action: pick the accountable person and the due date) and reject another. The highlighted passage should change colour, and the authorised item appears on the project's **Work** tab. The spend figure should rise by a few sen. (The Project Manager and Members can read the proposals but cannot authorise them.)
7. If a request ends "AI is not set up for this project" or says there is no eligible connection, finish "Set up AI" below: an approved model, the organisation limits, and in the project a connection with its key and limits. If a connection says "Waiting for the protected key", create and mount the protected key (see "Protected key") and restart `api` and `worker`.

8. Optional, as the Administrator: under **People**, disable the Member's account. The project now says "A member is On Hold — investigation needed" and the Project Manager gets an email (or a line in `docker compose logs api`). Enable the account again, then as the Project Manager or Owner record a finding on the People tab and choose **Restore**.

9. Optional, as the Administrator: under **Approvals** (in the top bar) you can raise the number of Owners or Sponsors who must approve a change from 1 to 2 or 3, and choose whether projects may set their own number. Nothing new needs installing for changes, closing or the deadline review; the update applies its two new migrations (0017, 0018) when you run `docker compose up -d --build`.

Notes added before projects existed (before 8 November 2026) stay in the database but are not shown.

Cross-project search adds migration 0019, which creates the `pg_trgm` extension. That needs the CREATE privilege on the database; under the provided Compose setup the database user already has it. The migration also builds its search indexes while it runs, which can take a while on a large existing database, so expect `docker compose up -d --build` to wait for it.

## Everyday use

| To | Run |
| --- | --- |
| See what is running | `docker compose ps` |
| Read the logs | `docker compose logs -f api worker` |
| Stop (keeps your data) | `docker compose stop` |
| Start again | `docker compose up -d` |
| Approve updates on the Operations page | an Enterprise Administrator, in Kainow (see "Updates"); the updater installs them |
| Change a setting in `.env` | edit it, then `docker compose up -d` |
| Change the Compose setup | edit `compose.override.yaml` (never `compose.yaml`), then `docker compose up -d` |

**How many people at once?** A repeatable load test for 200 registered people with 10 at once, and its latest result, is in `docs/operations/load-test.md`. Run it only on a test installation, never on the live one: it refuses any database that is not its own seeded test organisation.

## Backups

Kainow takes its own backups: a complete copy of the database, encrypted with a backup key, written to a folder you choose that is apart from the running installation. Each run is recorded in Kainow, and a missing or failed backup is never shown as healthy. The server's scheduler (cron) starts the backups; Kainow has no button for them. The commands run in one-shot containers of the `ops` service in `compose.yaml`, which `docker compose up` never starts.

**Real installations run on a Linux server.** The steps below are written for Linux with the Compose plugin. A Windows test computer is covered at the end of this section. **Status: written on 21 November 2026 against the code and its automated tests. These steps have not yet been run end to end on a Linux server, and the low-space protection has not yet been verified on one (see "Disk space and protective read-only mode").**

### 1. Choose the backup folder

Pick a folder that is not on the database's disk: a mounted network share or a second disk. It may be offline at times; a backup then fails visibly (below) and Kainow warns. If the folder is on the database's disk after all, a backup stops with `no_space` before it takes the database disk below the safe floor plus 2 GB, so it never pushes Kainow into protective read-only mode. **Use one backup folder per installation**: never point a test installation and the live one at the same folder, because each would expire the other's backup copies. Set it in `.env`, then give the Kainow container user (uid 1000) ownership of it:

```
KAINOW_BACKUP_DIR=/srv/kainow-backups
```

```
sudo mkdir -p /srv/kainow-backups && sudo chown 1000:1000 /srv/kainow-backups
```

If `KAINOW_BACKUP_DIR` is not set, or the folder does not exist, only the `ops` commands fail (Docker reports that the bind source path does not exist). Every other `docker compose` command works as before, and Kainow never creates the folder for you. The Operations page shows the folder as written in `.env`, never the path inside the container.

### 2. Create the backup key and keep its recovery copy

The backup key is a 32-byte file kept outside the database, the backups and the protected key. From the `app` folder (after `npm run build`), create it next to `compose.yaml`:

```
mkdir -p ../secrets
npm run backup-key -- --create ../secrets/kainow-backup.key
```

It refuses to overwrite an existing file and prints only the path and a short key id, never the key. If you created it as a user other than uid 1000, make it readable by the container: `sudo chown 1000 ../secrets/kainow-backup.key`.

Then mount it into `ops` through `compose.override.yaml` (see "Local changes: `compose.override.yaml`"; never edit `compose.yaml`): keep the backup-key line under `ops` in `volumes`, `./secrets/kainow-backup.key:/run/secrets/kainow-backup.key:ro`, as `compose.override.example.yaml` has it. The key is mounted into `ops` only, never into `api` or `worker`. If the protected key is in use (the protected source area, AI keys or quarantined originals), keep **both** protected-key lines under `ops` as well: in `environment`, `KAINOW_PROTECTED_KEY_FILE: /run/secrets/kainow-protected.key`, and in `volumes`, `./secrets/kainow-protected.key:/run/secrets/kainow-protected.key:ro`. With only the mount, `ops` does not know where the key is: the drill reports sealed values as Not tested and `restore` thinks the key is missing.

**Once the protected source area is in use, the protected key is required in `ops`.** The source area is in use as soon as one is approved on **System Settings › Storage** (or files are stored in one). Every backup then also copies the source files: it downloads them through the storage connection, whose client secret is sealed with the protected key, so without the key in `ops` a backup fails with `protected_key_missing`. For the same reason `ops` then needs outbound HTTPS access to Microsoft Graph and its sign-in service, as `worker` has: the provided Compose network allows it; if the server's firewall limits outbound traffic, allow it for `ops` too.

**Keep a recovery copy of the backup key apart from the backups and apart from the protected key's copy**: with the recovery custodian, for example, on a locked USB drive or in a password manager's secure files. A backup without its key is useless, and the key alone gives nothing. Never email the key or put it in the repository. Losing the key means every backup made with it can never be read.

### 3. Make the first backup by hand

With Kainow running (`docker compose up -d`):

```
docker compose --profile ops run --rm ops node dist/ops/backup-cli.js --kind manual
```

The first run builds the `ops` image, which takes a few minutes. It prints `run <id> succeeded`, or `run <id> failed <code>` with a fixed explanation. Exit code 0 means succeeded, 1 refused or failed, 2 wrong usage, 3 another backup, restore drill or restore holds the backup lock, so nothing was done (run it again once that one has finished; the updater's pre-update backup waits and retries on this code by itself, every minute for up to 30 minutes). Output never contains a key, a secret, file content or a database password.

### 4. Schedule it

Put these three lines in the server's crontab (`crontab -e`), exactly as given. `/opt/kainow` is a placeholder: use the folder that holds `compose.yaml`. Times are the server's time. Kainow does not need to know the backup time; it judges freshness against the 24-hour target alone.

```
# Daily backup at 02:00 server time
0 2 * * *   cd /opt/kainow && docker compose --profile ops run --rm ops node dist/ops/backup-cli.js --kind daily >> /var/log/kainow-ops.log 2>&1
# Storage check every five minutes
*/5 * * * * cd /opt/kainow && docker compose --profile ops run --rm ops node dist/ops/storage-check-cli.js >> /var/log/kainow-ops.log 2>&1
# Monthly restore drill (recommended), 03:30 on the 1st
30 3 1 * *  cd /opt/kainow && docker compose --profile ops run --rm ops node dist/ops/restore-drill-cli.js >> /var/log/kainow-ops.log 2>&1
```

Each line sends everything to `/var/log/kainow-ops.log`, so cron itself mails nothing: **watch that log**, and rely on Kainow's own notices, which email every Enterprise Administrator when a run fails or no backup is younger than 24 hours. If you also want cron to mail someone, put `MAILTO=you@example.org` above the lines and drop `2>&1` from each (so only error output is mailed; the server needs a working mail command, and Docker may print progress lines to the error output). The log is a routine diagnostic: rotate it, for example with a `logrotate` entry `/var/log/kainow-ops.log { daily rotate 30 compress missingok notifempty }`.

The three commands, with their other options:

| Command | Runs | Options |
| --- | --- | --- |
| `backup-cli.js` | A backup, then expiry of old backup copies | `--kind daily\|manual\|pre_update` (`manual` when omitted); `--new-key` (see "Changing the backup key") |
| `storage-check-cli.js` | One storage reading for the database disk, the backup disk and (once in use) the source area | none |
| `restore-drill-cli.js` | A restore drill (below) | `--set <name>\|latest`, `--keep`, `--sample <n>`, `--drop <kainow_drill_name>` |

Failures say which of these happened, never a raw error: `folder_missing` (the folder is not mounted), `folder_not_writable` (check the `chown` above), `key_missing`, `key_invalid` (the key file is not exactly 32 bytes), `key_changed`, `no_space` (the backup folder's disk is full, or the folder is on the database disk and free space there fell to the safe floor plus 2 GB), `dump_failed` (also when the database copy is still running after 6 hours: it is stopped then), `verify_failed` (the files written did not read back correctly), `source_files_failed` (some source files could not be downloaded from the source area: changed since Kainow stored them, access refused, or the provider unreachable; the output and the Operations page name them by stored-file id). A source file that is simply gone from the library does not fail a backup: Kainow flags it Missing (the Administrators and storage Administrators get a notice) and the run succeeds, saying "n source files already flagged in storage were not copied". For `source_files_failed`: if the provider was unreachable or refused access, check the storage connection on **System Settings › Storage** and run the backup again; if a file was changed in the library, put the original back (from the library's version history, or with `restore-source-files` after it is flagged), or have a storage Administrator remove the changed file so it is flagged Missing. Until then each backup fails and the 24-hour warning shows, `protected_key_missing` (the source area is in use and no protected key is mounted in `ops`), `database_unreachable`, `interrupted` (set by Kainow when a run is still unfinished after 6 hours). A restore drill whose restore is still running after 6 hours is stopped and fails with `drill_database_failed`.

### 5. See the status in Kainow

Enterprise Administrators open **Operations** in the top bar (`#/admin/operations`). It shows the last successful backup, the last attempt, whether the 24-hour target is met (Healthy, Last backup failed, Target exceeded, or No backup yet), the retention, the folder and the key id of the latest backup, the last 30 runs ("Backup size (encrypted)" is the size of the encrypted dump), the restore drills and the storage readings. A warning shows on every Administrator page until a fresh backup succeeds, and when a run fails or no backup is younger than 24 hours every Enterprise Administrator gets one urgent notice, by email and in Kainow, per episode. A new installation stays quiet for its first 24 hours. Existing work continues; updates are refused until a successful backup younger than 24 hours exists.

Retention is set on that page by an Enterprise Administrator, with a reason: 30 days by default, 7 to 365. After each successful backup the same command removes backup copies older than that, except the newest successful backup and the newest pre-update backup, which are always kept. It never removes live data or history, and it never runs after a failed backup.

### 6. The restore drill: what it proves

A backup you have never restored is a guess. The drill restores a backup into a temporary database on the same server (never touching the live one), then checks that:

- every file decrypts and matches its recorded checksum;
- every table's row count matches the count recorded when the backup was taken;
- every protected source file's checksum matches (once the source area is in use);
- the protected key still opens one sealed value of each kind present (AI connection keys, quarantined originals and the storage connection's secret; a kind with none is "Not tested"; a kind present with no protected key mounted fails);
- the restore took under 4 hours.

It then removes the temporary database and records the result in Kainow. A full drill that passed completes go-live step 8, **Configure daily encrypted backups and complete a test restore**, which Kainow ticks for you. It asks for a new drill ("Drill again") when the backup key changes, when the backup folder changes, and when the source area comes into use after the last drill; the step is unticked until a new drill passes. A sampled drill (`--sample <n>`) is a quick check and does not count. Run one by hand before go-live:

```
docker compose --profile ops run --rm ops node dist/ops/restore-drill-cli.js
```

The drill needs free space on the database disk for its temporary database: about the live database's size × 1.2, plus the safe floor, plus 2 GB, and it stops and drops its database if space falls too low. It refuses to run while protective mode is on. `--keep` leaves the temporary database for inspection; drop it with `--drop <name>`. A drill that is refused before it starts records nothing in Kainow (the log has the reason).

**What the drill does not prove.** It does not start Kainow on the restored copy, test email or AI connections, or cover files filed outside Kainow (see below). Its monthly timing on a small database says little about a large one: watch the duration it records.

### 7. Changing the backup key

A backup run refuses with `key_changed` when the key differs from the last successful backup's. To change deliberately, run once with `--new-key`: earlier backups can then be read only with the earlier key, so keep both recovery copies until those backups have expired. Kainow records the change and asks for a new drill.

Source files are kept once per backup key in the backup folder (`kainow/files/<key id>/`), shared by every backup made with that key. After a key change the next backup copies every source file again into the new key's folder; the earlier key's folder is left as it is, so earlier backups still drill and restore their source files with the earlier key. Expect the backup folder to hold both copies until the last backup made with the earlier key has expired; Kainow then removes the earlier key's folder.

### Disk space and protective read-only mode

`storage-check` records free space for the database disk and the backup disk every five minutes, and, once the source area is in use, its size and the provider's quota as the Storage page shows them ("Unavailable" when the provider reports none). An Enterprise Administrator sets, with a reason, the warning level (default 80%, 50 to 95), the critical level (default 90%, above the warning level, up to 99) and the safe floor (default 5 GB free on the database disk, 1 to 1,000 GB). Reaching a level sends one urgent notice per episode, and no reading for 30 minutes shows as a warning.

When free space on the database disk falls below the safe floor, Kainow enters **protective read-only mode** at once: people can still sign in and read everything, every change is refused with "Kainow is read-only for now to protect your data. Nothing you have saved is affected.", background work waits with its queue kept, and backups still run. Nothing is ever deleted to free space. The mode never ends by itself: after you free space, an Enterprise Administrator chooses **Resume normal use** on the Operations page, with a reason, and Kainow accepts it only when a reading from the last 10 minutes shows free space at or above the floor and the health checks pass. **The safe floor has not yet been verified on a real disk**: the check is in `docs/operations/verify-low-space.md` and needs a Linux VM. Until it has been run, treat 5 GB as a proposal, and leave plenty of headroom on the database disk.

The safe floor must stay below the database disk's free space: a change to a floor at or above the free space in the latest reading (from the last 30 minutes) is refused, because it would make Kainow read-only at once.

**Read-only and Resume keeps failing because the floor is too high.** If the floor was set at or above the free space the disk can ever reach (for example before a reading existed), Resume never passes, and the setting cannot be changed in Kainow while the mode is on. Lower the floor on the server, in the installation's project folder. Replace `admin@example.org` with an Enterprise Administrator's sign-in address (recorded as the person who made the change) and `5` with the new floor in GB, below the free space shown on the Operations page:

```
docker compose exec -T db psql -U kainow -d kainow -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  admin uuid;
  prev jsonb;
BEGIN
  SELECT id INTO STRICT admin FROM users WHERE lower(email) = lower('admin@example.org') AND role = 'enterprise_administrator';
  SELECT jsonb_build_object('backupRetentionDays', backup_retention_days, 'storageWarningPct', storage_warning_pct,
                            'storageCriticalPct', storage_critical_pct, 'safeFloorGb', safe_floor_gb,
                            'diagnosticRetentionDays', diagnostic_retention_days)
    INTO STRICT prev FROM operations_settings;
  UPDATE operations_settings SET safe_floor_gb = 5;
  INSERT INTO operations_settings_changes (id, actor_id, at, reason, previous, next)
  VALUES (gen_random_uuid(), admin, now(), 'Safe floor lowered on the server: it was above the free space, so Kainow could not resume',
          prev, prev || jsonb_build_object('safeFloorGb', 5));
END $$;
SQL
```

It changes the floor and writes the change, with its reason, to the settings history in one step; if the address is not an Enterprise Administrator's, nothing changes. Wait for the next storage check (up to five minutes), then choose **Resume normal use**.

Routine diagnostics retention (default 30 days, 7 to 365, set on the same page) covers the storage readings. The job-queue archive is not governed by it: the job queue removes its own archive after a fixed 7 days. The backup log `/var/log/kainow-ops.log` is the server's own file, which Kainow never rotates: rotate it with `logrotate` (see "Schedule it"). Container logs are rotated by Docker: three files of 10 MB per service.

### What a backup does not cover

- Files filed outside Kainow (external project deliverables) need the organisation's own backup. The database keeps their references.
- Anything saved after the last backup (up to 24 hours at the default schedule).
- The protected key and the backup key: keep their recovery copies (above and "Protected key").
- The `.env` file: keep your own copy of your settings, apart from the backups.

### Windows test computer

Real installations run on Linux. On a Windows test computer, the matching Task Scheduler action for the daily backup is one line (change `C:\kainow` to your Kainow folder, and set `KAINOW_BACKUP_DIR` in `.env` to a folder path such as `C:/kainow-backups`):

```
schtasks /Create /SC DAILY /ST 02:00 /TN "Kainow backup" /TR "cmd /c cd /d C:\kainow && docker compose --profile ops run --rm ops node dist/ops/backup-cli.js --kind daily >> C:\kainow\kainow-ops.log 2>&1"
```

The other two use the same command with `storage-check-cli.js` and `/SC MINUTE /MO 5`, and with `restore-drill-cli.js` and `/SC MONTHLY /D 1 /ST 03:30`. The log redirection here is run by `cmd` and writes text only.

**Line endings and files.** In Windows PowerShell 5.1 do **not** use `>` or `>>` for any command that writes a file you need to keep intact: PowerShell rewrites the output as text and corrupts a binary file such as a dump. Let the container or the database write the file, and copy it out.

A plain, unencrypted dump of the database, for a one-off test copy only (it is not a Kainow backup: it is not recorded, not encrypted and not checked). On Mac or Linux:

```
docker compose exec -T db pg_dump -U kainow -Fc kainow > kainow-backup-$(date +%F).dump
```

In Windows PowerShell:

```
docker compose exec -T db sh -c "pg_dump -U kainow -Fc kainow -f /tmp/kainow.dump"
docker compose cp db:/tmp/kainow.dump "kainow-backup-$(Get-Date -Format yyyy-MM-dd).dump"
docker compose exec -T db rm /tmp/kainow.dump
```

A plain dump holds everything (notes, original files, proposals, decisions, the audit trail, AI spend records) in the clear: keep it somewhere safe, other than this computer.

## Restore from a backup

For a real disaster: the server or the database is lost and you need Kainow back from the backup folder. A restore goes into a **new, empty installation only**; it never overwrites a database, and a failed live database is replaced by a new installation. You need the backup folder, the backup key's recovery copy and (if AI keys, quarantined originals or the source area were in use) the protected key's recovery copy. Try the steps on a spare machine before you need them.

1. **Start the new installation's settings.** Make a new Compose project as in "Going live" (steps 1 and 2: stop the old installation, name a new project in `.env`). In `.env` set `KAINOW_BACKUP_DIR` to the backup folder. Put the recovery copies of the backup key (and the protected key) in `secrets/`, and mount them under `ops` in `compose.override.yaml` (copy `compose.override.example.yaml`, see "Local changes"): `./secrets/kainow-backup.key:/run/secrets/kainow-backup.key:ro`, and `./secrets/kainow-protected.key:/run/secrets/kainow-protected.key:ro`. For the protected key, also keep the `environment` line `KAINOW_PROTECTED_KEY_FILE: /run/secrets/kainow-protected.key` under `ops`; without it `restore` reports that no protected key is mounted.
2. **Start only the database:**

   ```
   docker compose up -d db
   ```

3. **Run the restore.** Use `latest`, or the name of one folder under `kainow/sets/`; the reason is recorded:

   ```
   docker compose --profile ops run --rm ops node dist/ops/restore-cli.js --set latest --reason "Server lost; restoring from backup"
   ```

   It refuses unless the database is empty. Before it restores, it checks the backup as the drill does (key, checksums, that the backup is not from a newer Kainow, enough free space), restores in one transaction, compares the row counts, and then puts Kainow into protective read-only mode with the backup's time recorded. It prints what happened, which you must read: **Kainow was restored from the backup taken at the time shown. Everything after that time is lost, including access changes: check People, grants and Administrators before resuming. Queued emails and jobs were not sent.**
4. **Start Kainow:**

   ```
   docker compose up -d --build
   ```

   `migrate` brings an older backup up to the current version while the mode is on, and the worker starts with nothing to replay.
5. **Install the crontab, then sign in and resume.** On a new server, first put the crontab lines from "Backups" (step 4, "Schedule it") in place: Resume needs a storage check from the last 10 minutes, and nothing runs one until the crontab does. Wait for the first check (up to five minutes). Everyone is signed out (sessions and unused sign-in codes are gone, and setup and recovery links are expired). An Enterprise Administrator signs in (sign-in works in protective mode), reviews People, grants and Administrators, and chooses **Resume normal use** on the Operations page, with a reason. Every Enterprise Administrator has an urgent notice about the restore.

**What the restore does not repeat.** Emails that were queued show "Not sent — restored from backup" in the delivery history. An email that was being sent when the backup was taken shows as uncertain, marked as a possible duplicate: the old installation very probably sent it, so resend it only if you know it was not. Notices still waiting for their email (a daily email, someone away) stay in Kainow but are not emailed, and the day's scheduled digest is not sent on the day of the restore: the old installation may have sent them after the backup. Queued AI, analysis, extraction and storage work ends with "Not run — restored from backup", and AI spend reserved for it stays counted as uncertain. An output that was being filed shows "Filing failed — Not run — restored from backup" (use Try again); source files that were waiting to be stored are stored by Kainow's daily storage task after you resume. Quarantine cleaning waits until you resume, then runs. Nothing else is sent or filed again on its own: decide what to repeat once you have resumed.

**Protected key.** Without the protected key's recovery copy, sealed AI keys and the storage secret cannot be opened: the restore prints a reminder, and Kainow shows the same warning. Mount it and restart `api` and `worker`.

**Source files.** Files in the managed source area stay where they are; the restore does not touch them. If that area was lost as well (the library deleted, or files removed from it), approve the source area to use on **System Settings › Storage** (the same one once it is back, or a new one), then, with Kainow started and the protected key mounted in `ops`, run:

```
docker compose --profile ops run --rm ops node dist/ops/restore-source-files-cli.js
```

It looks up every stored source file at its recorded place. Each one that is missing there is put back from the backup folder (`kainow/files/`) into the approved source area, in its project, source and version folder; its content is checked against the SHA-256 Kainow recorded, and its reference is updated (the old place is kept in the file's move history). Files the backup folder does not hold (stored after the last backup, or never copied) are listed by stored-file id: their working text is still in Kainow, but their original must come from elsewhere. Exit code 0 means every missing file was put back (or none was missing), 1 that some were not, or that the command was refused. You can run it again; it only acts on files still missing. It works while Kainow is read-only after the restore.

**If the restore is interrupted or fails** once it has started (power loss, a full disk, a message beginning "The restore ... " or "Row counts differ"), the target database may be half-restored and **must not be used**. Do not start Kainow on it. Drop it and recreate it empty, then run step 3 again:

```
docker compose exec -T db psql -U kainow -d postgres -c "DROP DATABASE kainow WITH (FORCE)" -c "CREATE DATABASE kainow OWNER kainow"
```

**Run this only in the new installation's own project folder** (check `docker compose ls` and `COMPOSE_PROJECT_NAME` in `.env` first): it deletes the whole database of that project, and a wrong folder would destroy a live installation. (If the project's database name or user differ in `compose.yaml`, use those.) This is the only supported repair: the restore itself refuses a database that already holds tables.

## Updates

An Enterprise Administrator approves each release in Kainow, and the **updater** installs it at the approved time (decisions D119–D123). Nothing is installed without an approval, an approval covers one release only, and only a release signed with the release key is installed. **Status: written on 23 November 2026 against the code and its automated tests. A real update has not yet been run end to end on a Linux server.**

**What the updater can do.** The updater is a one-shot container (the Compose service `updater`, profile `updater`) that the server's cron starts every five minutes; it does its work and exits, and `docker compose up` never starts it. **It holds the Docker socket, which is root-equivalent control of this server**: anything that controls Docker can take over the machine. That is why it is never left running, has no ports, holds no keys and no email settings, and acts only on an update an Enterprise Administrator approved, for the exact release and commit approved, after checking the release's signature against this installation's own `release-signers` file. It runs as the owner of the Kainow folder, which it sees at the same path as on the server. If you do not want any container to have that power, do not schedule it (see "Turning the updater off") and update by hand.

### 1. Fill in the updater's settings

The updater needs four lines in `.env`; nothing else uses them. In the Kainow folder (the one with `compose.yaml`), on the server, this prints them (it prints no secret):

```
echo "KAINOW_INSTALL_DIR=$(pwd -P)"
echo "KAINOW_UID=$(stat -c %u .)"
echo "KAINOW_GID=$(stat -c %g .)"
echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)"
```

- `KAINOW_INSTALL_DIR`: the folder's absolute path. The updater sees the folder at this same path, so the `docker compose` commands it runs resolve the same files, project name and `.env` as yours.
- `KAINOW_UID` and `KAINOW_GID`: the user and group that own the folder (if you own it, `id -u` and `id -g` give the same). The updater runs git and Docker as this user, so it never leaves files in the folder that you cannot change.
- `DOCKER_GID`: the group that owns the Docker socket, which lets the updater use Docker.

Add the four printed lines to `.env`. While any is unset, only `updater` runs fail; every other command works as before. Also check that the installation's trusted `release-signers` file is in the folder ("Install", "Get the code at a signed release") and that the folder is at a release tag: the updater refuses otherwise (`not_on_release`).

Try one tick by hand. The first run builds the `updater` image, which takes a few minutes; with nothing approved it does nothing and exits with code 0:

```
docker compose --profile updater run --rm updater node dist/updater/updater-cli.js tick
```

### 2. Schedule it

Add this line to the same crontab as the backup lines ("Backups", step 4), exactly as given. `/opt/kainow` is a placeholder: use the folder that holds `compose.yaml`, the same path as `KAINOW_INSTALL_DIR`.

```
# Updater: checks for an approved update every five minutes
*/5 * * * * cd /opt/kainow && docker compose --profile updater run --rm updater node dist/updater/updater-cli.js tick >> /var/log/kainow-ops.log 2>&1
```

Each tick does at most one thing (prepare an approved update, start a due one, or nothing) and records that it ran. A tick that finds another still running exits at once. Exit code 0 means done (including nothing to do), 1 a step failed or the database could not be reached, 2 wrong usage or a setting missing.

**Being told when an update fails.** After a failed update the updater sends no email (it holds no email settings). It writes a line ending `See INSTALL.md, 'After a failed update'.` to the log, and repeats it once a day until `recover` has run. With the line above, cron mails nothing: watch the log. To have that line mailed to you, put `MAILTO=you@example.org` above the crontab lines (the server needs a working mail command) and use this form of the line instead, which still writes everything to the log but prints, and so mails, only that line:

```
*/5 * * * * cd /opt/kainow && docker compose --profile updater run --rm updater node dist/updater/updater-cli.js tick 2>&1 | tee -a /var/log/kainow-ops.log | grep -F -e "After a failed update" -e "could not reach the database"
```

The second pattern also mails a tick that could not reach the database (`The updater could not reach the database.`): the database itself cannot record or tell anyone about that tick.

Once a tick on a release tag has been recorded in the last 24 hours, Kainow ticks go-live step 13, **Schedule the updater** (`updates`). It unticks it again when no tick has been recorded for 24 hours.

### 3. How an update goes

1. **A new release.** Kainow checks the product's GitHub repository for newer release tags once a day; an Enterprise Administrator can also choose **Check now** on the Operations page (at most once a minute). A newer release sends one notice to every Enterprise Administrator, by email and in Kainow. Checking downloads and installs nothing.
2. **Approval.** On the Operations page, **Updates**, an Enterprise Administrator chooses **Approve update** for that release, with a start time (at least 15 minutes and at most 30 days ahead, in UTC+8), the expected length (5 to 240 minutes, 30 by default) and a reason. It is refused while another update is open, while Kainow is read-only, for a release not newer than the running one, while a failed update still needs recovery, and while no successful backup is younger than 24 hours ("Updates are refused until a backup succeeds. See Backups above."). It can be cancelled or moved, with a reason, until it starts.
3. **Warning.** Every Active person is emailed when the update is approved (and when it is moved or cancelled), and again 24 hours before it starts if it was approved more than 24 hours ahead. Everyone sees a banner with the time and the expected length until it starts.
4. **Preparing**, at the first tick after approval, while Kainow keeps running: the folder must be clean and at the running release; the disk holding it must have at least 4 GB free above the safe floor; the release is fetched and its signature, tag name, commit and version checked; the new release is checked against your `.env` and `compose.override.yaml` (`docker compose config -q`), the database service must be unchanged, every `kainow-` image of the new release must carry its own version (so building it can never overwrite the running version's images), and the new images are built beside the running ones. Preparing may take up to 60 minutes. Any failure here ends the update with nothing changed; the Enterprise Administrators are told, and everyone who was warned is emailed that the update is cancelled.
5. **Installing**, at the first tick at or after the start time: Kainow goes read-only ("Kainow is being updated. You can read; changes are paused until the update finishes."), takes a `pre_update` backup (waiting, every minute for up to 30 minutes, if another backup holds the lock), stops `api` and `worker`, switches the folder to the new release, migrates the database, starts the new version and checks its health within 10 minutes. Only when every check passes does it end the read-only mode and record the update as succeeded. People are cut off from the moment `api` stops until the new version is healthy. The switch also records the release as a local tag (`vX.Y.Z`, the signed tag object that was verified), so the folder is on a release tag for the next update.

   If the updater could not start the update within an hour of its start time (the server was off, or the cron line is missing), the update is not installed: it ends as failed before installing with `window_missed`, nothing is changed, the Enterprise Administrators are told, and everyone who was warned is emailed that it is cancelled. Kainow's worker ends such an update by itself too (its regular sweep), so it does not wait for the updater. To install the release, approve it again for a new time.
6. **If it fails before the migration starts**, Kainow goes back to the previous version and normal use by itself, and the Enterprise Administrators are told why. **If the migration or anything after it fails**, Kainow stays stopped behind a notice page and waits for you: see "After a failed update".

Every step, and why an update stopped, is shown on the Operations page, as fixed text and never raw command output (that goes to the log only, with the database password masked). The two refusals you can fix on the server: `local_changes` (a tracked file in the folder was changed: move the change into `compose.override.yaml` or `.env` and undo it with `git checkout -- <file>`) and `not_on_release` (the folder is not at the running release's tag: see "Install", "An installation made before the first release").

### If the release key was lost or replaced

Normally the key changes through releases: a release signed with the old key adds the new one, and the updater copies the release's `release/release-signers` over the trusted file only after that release verified against it. If the Product Owner lost the key, or this installation fell behind a rotation, releases signed with the new key are refused (`signature_invalid`) until you replace the trusted `release-signers` file by hand. In the Kainow folder, with `vX.Y.Z` the first release signed with the new key:

1. Take the new file from that release, without checking it out:

   ```
   git fetch --tags origin
   git show vX.Y.Z:release/release-signers > release-signers.tmp
   ```

2. Show its keys' fingerprints and compare each with the key published in this guide ("Install", "Get the code at a signed release", as the guide reads in that release) **and** on that release's GitHub page. Both must match; if either differs, stop and delete `release-signers.tmp`:

   ```
   grep -v '^#' release-signers.tmp | awk '{print $3, $4}' | ssh-keygen -lf -
   ```

3. Keep a copy of the old file outside the folder, then replace it:

   ```
   cp release-signers ~/release-signers.old
   mv release-signers.tmp release-signers
   ```

4. Verify the release against the new file. The output must say `Good "git" signature for kainow-release`; if it does not, put the old file back (`cp ~/release-signers.old release-signers`):

   ```
   git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=release-signers verify-tag vX.Y.Z
   ```

The Operations page shows the new key's fingerprint after the next updater tick. An update already refused for the signature must be approved again.

### Turning the updater off

Remove its crontab line. Nothing else ever starts the updater, so it then has no access to anything. An approved update is then never installed: cancel it on the Operations page. Go-live step 13 unticks itself after 24 hours.

### Updating by hand

Without the updater, follow the same steps yourself, in the Kainow folder, at a time you have announced. Replace `vX.Y.Z` with the release, and keep the previous tag's name (`git describe --tags --exact-match`) in case you need to go back:

```
git fetch --tags origin
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=release-signers verify-tag vX.Y.Z
docker compose stop api worker
docker compose --profile ops run --rm ops node dist/ops/backup-cli.js --kind pre_update
git -c advice.detachedHead=false checkout --detach vX.Y.Z
cp release/release-signers release-signers
docker compose --profile ops --profile updater build
docker compose up -d
```

Stop if `verify-tag` does not say `Good "git" signature for kainow-release`, or if the backup does not print `succeeded`: start the previous version again with `docker compose up -d`. If the release has a file `release/requirements.json` (`git show vX.Y.Z:release/requirements.json`), follow its note first. Stopping `api` before the backup means nothing can be saved after it. `docker compose up -d` runs `migrate` before `api` starts; if `migrate` fails, **do not start the previous version on that database**: the database must go back to the backup you just took. In this order: `docker compose stop api worker`; check out the previous tag again (`git -c advice.detachedHead=false checkout --detach <previous tag>`, and put its `release/release-signers` back as `release-signers`), so the restore runs on the previous version's images; keep the failed database under another name and create an empty `kainow` (as `recover` does: `docker compose exec -T db psql -U kainow -d postgres -c "ALTER DATABASE kainow RENAME TO kainow_failed_YYYYMMDD_manual" -c "CREATE DATABASE kainow"`); then restore the set the pre-update backup printed into that empty database, as in "Restore from a backup" step 3, and start Kainow with `docker compose up -d`.

## After a failed update

When the database migration of an update, or anything after it, fails, Kainow stays stopped. Nothing is restored automatically (D123).

**What people see.** Kainow's address shows one fixed page (served by the `notice` service, status 503): "Kainow is unavailable after a failed update. Nothing you saved before the update started has been lost. Please contact your Administrator." The folder is already back at the previous release; the database is as the failed migration left it.

**What the server operator sees.** In `/var/log/kainow-ops.log` (and by mail, if you set that up in "Updates", step 2), repeated once a day:

```
The update to vX.Y.Z failed after the database migration started. Kainow is stopped and shows a notice page. Run: docker compose --profile updater run --rm updater node dist/updater/updater-cli.js recover. See INSTALL.md, 'After a failed update'.
```

(If instead the update failed before the migration but going back to the previous version did not pass its health checks, the line says so; recovery is the same command, without a restore.)

**Before you run it**, check that the database service is running (`docker compose ps db`), that the backup folder is reachable, and that the backup key (and the protected key, if used) are still mounted in `ops` by `compose.override.yaml`: the restore needs them. It also needs free space on the database disk for the restored copy beside the kept failed one.

**Run the recovery command** in the Kainow folder:

```
docker compose --profile updater run --rm updater node dist/updater/updater-cli.js recover
```

It shows what it will do and asks you to type `yes` (`recover --yes` skips the question). After a failed migration it:

1. stops the notice page and Kainow;
2. **keeps the failed database** under the name `kainow_failed_<YYYYMMDD>_<first 8 characters of the update id>` and creates an empty `kainow` database (nothing is dropped);
3. checks that the folder is at the previous release;
4. restores the update's own pre-update backup with the previous version (the same restore as in "Restore from a backup");
5. records the update as recovered and gives every Enterprise Administrator an urgent notice, by email and in Kainow;
6. starts Kainow on the previous version, waits for its health checks, and prints the restore's message and then `Kainow is back on vA.B.C. Review and choose Resume on the Operations page.`

**Nothing saved is lost**: from just before the pre-update backup started, Kainow refused every change, so the backup holds everything people saved. The restore has the side effects of any restore: Kainow starts read-only, everyone is signed out, and emails and jobs that were queued are not sent ("Not sent — restored from backup", "Not run — restored from backup"; see "What the restore does not repeat"). An Enterprise Administrator signs in, checks, and chooses **Resume normal use** on the Operations page, with a reason.

When no migration ran, `recover` skips the rename and the restore: it starts the previous version, waits for its health checks, ends the update's read-only mode and prints `Kainow is back on vA.B.C.`

**If `recover` stops with a message**, it changes nothing further, and the message says what to do; you can run it again, and it carries on from where it stopped (for example from the restore, once the failed database is already set aside). The common ones: "An updater tick is running; try again in a minute."; "The Kainow folder is not at vA.B.C. Check it out (…) and run recover again."; "The restore did not finish …": fix what the restore's messages name (the backup folder, a key, free space), and recreate the empty database first if it says so. **Never drop a `kainow_failed_…` database to make `recover` go on**: it is the failed database, kept for investigation.

**If Kainow is still unhealthy after `recover`** ("Kainow vA.B.C did not start or did not pass its health checks within 10 minutes; the notice page is shown again."):

- If no migration had run, the update is still waiting for recovery: find and fix the cause (below), then run `recover` again.
- After a restore, the update is already recorded as recovered, so `recover` answers that there is nothing to recover. Find the cause with `docker compose ps` and `docker compose logs --tail 200 api worker` (and the free space on the Operations page's last reading or `df -h`). Once it is fixed, stop the notice page and start Kainow; it starts read-only, and an Administrator resumes as above:

  ```
  docker compose --profile updater stop notice
  docker compose up -d
  ```

  If it still does not start, restore into a new installation as in "Restore from a backup", with `--set` naming the pre-update backup set that `recover` printed.

**Removing the kept failed database.** Once the organisation is satisfied that nothing in it is needed, drop it by hand, in the installation's own project folder. List it, then drop it by its exact name; this cannot be undone:

```
docker compose exec -T db psql -U kainow -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'kainow_failed_%'"
docker compose exec -T db dropdb -U kainow kainow_failed_YYYYMMDD_xxxxxxxx
```

## Set up AI

AI runs only through a model the Administrator has approved and a connection that belongs to one project. Nothing is sent until all of this is done. Each step is a screen in Kainow; every change asks for a short reason and is kept in the history.

**The protected key is required before any AI key can be saved.** An AI key is stored encrypted with the protected key (see "Protected key" below). Without the key file the form refuses to save a key and the connection shows "Waiting for the protected key".

First setup, in this order:

1. **Approve a model** (as the Administrator: **AI** in the top bar, **Approved models**). Give the model identifier exactly as the provider names it, its prices in USD per million tokens, the provider's data terms, the kinds of AI work it may do, and whether it may receive restricted sources. OpenAI and Anthropic models are supported. Kainow has no built-in model.
2. **Set the organisation limits and rate** (the same screen): the exchange rate, the monthly limit, and optionally a daily limit and a per-person monthly limit. A blank limit means no allowance, so nothing runs until a limit is set. Also here: attempts per request (1 to 5, default 3), timeout per attempt (30 to 300 seconds, default 120), AI requests at once (1 to 10, default 2), and whether projects may manage their own connections or set their own limits (both off by default).
3. **In each project, add a connection** (the project's **AI** tab, as the Administrator, or as the Project Manager, Owner or Sponsor when you allowed it): choose an approved model, name the connection, and paste that project's own API key into the form. The key is never shown again; to change it, enter a new one. Add a second connection to give the project a fallback. Connections are tried in order, and a refused key takes its connection out of use until you replace the key.
4. **In each project, set its limits** (same tab): a monthly limit, and optionally a daily and a per-person limit. A project with no limits set has no allowance. A project's limits cannot be above the ceiling the Administrator sets.

A request must fit every limit that applies (organisation and project, monthly, daily and per person), and the tightest one wins.

### Trying the AI from your own shell

`npm run probe-ai`, `probe-minutes` and `probe-assist` (in `app/`) send a few real requests to check a model. They read `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` from **your own shell's environment only**, never from the database or `.env`, and never print it. Choose the provider with `--provider openai|anthropic` (OpenAI by default); for Anthropic, name the model id. For example, in a Mac or Linux shell: `ANTHROPIC_API_KEY=... npm run probe-ai -- --provider anthropic <model id>`. A missing key stops the command with "<VARIABLE> is not set". Use a test project's key.

## Protected key

When someone reports a pasted password or key, Kainow removes it from every copy in Kainow and keeps the originals encrypted, apart from the database. The encryption key is a 32-byte file that you create once and keep outside the database and its backups.

1. Create it (on Mac or Linux, or inside the app folder): `npm run protected-key -- --create ./secrets/kainow-protected.key`. It refuses to overwrite an existing file and prints only the file path and a short key id, never the key.
2. Mount it read-only for `api`, `worker` and `ops` and set `KAINOW_PROTECTED_KEY_FILE` to its path inside the container, in `compose.override.yaml` (never in `compose.yaml`): `compose.override.example.yaml` has both lines for each of the three services (see "Local changes"). Then run `docker compose up -d` again.
3. **Keep a recovery copy apart from the database backups** (for example on a locked USB drive or in your password manager's secure files). A backup of the database alone cannot give the originals back, and the key alone gives nothing; losing the key means quarantined originals can never be restored. Never email the key or put it in the repository.

**In production with AI, require the key.** Add `KAINOW_REQUIRE_PROTECTED_KEY=true` to `.env`. Then `api` and `worker` refuse to start when the key file is not set, missing, unreadable or the wrong length, instead of starting without it. Before go-live, prove the recovery copy works: on a separate, fresh installation, restore the latest database backup, mount the recovery copy of the key, and check that a project's AI connection opens and a quarantined original can be restored.

**Go-live waits for the key.** `api` and `worker` each record, when they start, which protected key they hold (only its short id). The go-live checklist does not close until both hold the same key; until then it lists "Install the protected key on both api and worker" under **Also needed before the checklist closes**. After mounting the key, restart both (`docker compose restart api worker`).

Without the key (and without `KAINOW_REQUIRE_PROTECTED_KEY=true`), nothing breaks: a report still opens its case and hides the item at once, but cleaning waits. The case shows "Waiting for the protected key", and the Administrator organisation view shows the same warning until the file is mounted and the services restart; the worker then cleans the waiting cases in the order they were reported.

**Restart both `api` and `worker` once the key file appears.** Each reads the key only when it starts. Restarting only one leaves the other without it: the Administrator warning reflects the `api` process alone, so it can disappear while the `worker` still cannot clean waiting cases. `docker compose restart api worker` does both.

**Do not log SQL statements with their parameters on the database server.** The reported text travels to the database as bound parameters of the cleaning statements, so statement logging or slow-query logging that includes parameters would write it to the database server's log. Leave `log_statement` at `none` (or `ddl`), and set `log_parameter_max_length = 0` and `log_parameter_max_length_on_error = 0` on the database server.

**What "removed from future backups" means.** Cleaning replaces the stored values, but PostgreSQL keeps the old row versions on disk (dead tuples) and in its write-ahead log until vacuum and log recycling remove them. A logical backup (`pg_dump`, as in "Backups" above) taken after the report is clean. A physical backup (a copy of the database files or of the write-ahead log) taken soon after a report can still hold the old values. If you take physical backups, run `VACUUM` on the affected tables after a report (`docker compose exec -T db psql -U kainow -d kainow -c "VACUUM"` vacuums them all) before the next one.

## Remove everything

`docker compose down` removes the containers and keeps your data. `docker compose down -v` also **deletes the database volume, and with it all your notes, decisions and the audit trail. It cannot be undone.**

## Going live

Go live on a new, empty database so nothing from development or testing comes with you. Under the provided Compose setup the database address is fixed to the `db` service in `compose.yaml`, so the new database comes from a new Compose project with its own database volume.

1. **Stop the old installation**, in this folder, before changing `.env`:

   ```
   docker compose down
   ```

   Do not add `-v`. The old database volume is kept until you delete it by hand (`docker volume ls` lists it).
2. **Name a new Compose project.** Add this line to `.env`:

   ```
   COMPOSE_PROJECT_NAME=kainow-live
   ```

   Compose then uses a new, empty database volume, `kainow-live_kainow-db`.
3. **Build and start the new project:**

   ```
   docker compose up -d --build
   ```

4. **Prepare the database and invite the first Enterprise Administrator.** This applies the migrations, starts notices from now and emails a one-time setup link. It refuses any database that already holds users or projects, or tables of another application, and it never deletes anything:

   ```
   docker compose run --rm api node dist/golive/golive-init-cli.js you@example.org "Your Name"
   ```

   Outside Docker the same command is `npm run golive-init -- you@example.org "Your Name"`.

   If it says the database is ready but the setup email could not be sent, fix the email settings and send a new link with:

   ```
   docker compose run --rm api node dist/users/setup-invite-cli.js you@example.org "Your Name"
   ```

   (Outside Docker: `npm run setup-invite -- you@example.org "Your Name"`.) The setup link expires after 7 days; if it expires before it is used, send a new one the same way.
5. **Save the approved AI spend settings again**, on the new database, as in step 4 of "Install". Until you do, every AI request is refused:

   ```
   docker compose run --rm api node dist/spend/apply-mvp-settings-cli.js
   ```

6. From now on every `docker compose` command in this folder, the backup commands included, acts on the new `kainow-live` project, because `.env` names it. Removing the line from `.env` would point them back at the old installation.
7. Development and test databases and old backup dump files are not carried over. Delete them yourself, by hand, outside Kainow.
8. The first Administrator opens the emailed link and follows the **Go-live checklist**. The checklist closes only once every step except the optional ones (logos, storage) is done: launching the first project does not close it while the second Administrator, recovery, mailbox, test email, calendar or backup step is still open, nor until `api` and `worker` both hold the protected key (see "Protected key").

## Recovery custodian

**Two Administrators come first.** The everyday safeguard is a second Enterprise Administrator (step 3 of the Go-live checklist). If one Administrator loses access to their mailbox, the other disables that account on the **People** page. Always try a second Administrator first. Recovery is only for when **no Administrator can sign in**.

**Record the custodian in Kainow.** The recovery custodian is the person in your organisation who may run the recovery command on the server when every Administrator is locked out. An Administrator records their name and how to reach them on the **Organisation** page, under "Recovery custodian". Step 4 of the Go-live checklist can be marked done only once both are recorded.

**Test it before go-live with a dry run.** The custodian runs the checks without changing anything:

```
docker compose run --rm api node dist/golive/recover-admin-cli.js admin@example.org "Admin Name" --reason "Pre-go-live test" --dry-run
```

Outside Docker: `npm run recover-admin -- admin@example.org "Admin Name" --reason "Pre-go-live test" --dry-run`. While Administrators are active it lists them ("Dry run: these Administrators would be disabled first: ..."), then answers "Would be refused now: an Administrator is active. All other checks passed." and says what `--disable-active-administrators` would do. That is the expected result before go-live. A dry run sends nothing, changes nothing and writes nothing to the audit trail.

**Real recovery, when no Administrator can sign in.** The custodian names the person who will become an Administrator, on one of the organisation's email domains, and gives a reason. Run the dry run first and check the Administrators it lists. If Administrators are still Active in Kainow but none of them can sign in, add `--disable-active-administrators`:

```
docker compose run --rm api node dist/golive/recover-admin-cli.js admin@example.org "Admin Name" --reason "Why recovery is needed" --disable-active-administrators
```

Outside Docker: `npm run recover-admin -- admin@example.org "Admin Name" --reason "Why recovery is needed" --disable-active-administrators`. The name is required when the address has no account in Kainow yet; for an existing account it may be left out, and the account's name is kept.

The command refuses, and changes nothing, when the reason is missing, when Kainow is not set up yet (use `golive-init` or `setup-invite` instead), when an Administrator is still active and `--disable-active-administrators` is not given, when the email is not on an eligible domain, when the link would go to one of the Administrators being disabled, or when a new person has no name. Otherwise, in one step, it disables every still-Active Administrator, lists them, and emails a one-time recovery link that is valid for 7 days. If the email cannot be sent, the link is still recorded; fix the email settings and run the same command again, which replaces the earlier link. (`setup-invite` is only for before the organisation is set up; afterwards it refuses and points here.)

**What happens to the disabled Administrators.** Each is disabled the same way as on the People page: their sessions end, their unused sign-in codes stop working, their current project memberships are placed **On Hold**, and each affected project's Project Manager (or its Owner and Sponsors) is alerted by email. Each disabled Administrator is also emailed that their access was disabled, when, and the reason given; the email never carries the recovery link. Once the new Administrator is in, they can re-enable any of them on the **People** page; held memberships stay On Hold until the project resolves them.

**What recovery does and does not restore.** If the person already has an account, the same account is used, so their identity and history are kept. Nothing about the account changes until they sign in with the link, except that a disabled account is allowed to sign in. When they sign in, the account becomes an Active Enterprise Administrator. Their project roles, holds and Audit or Oversight access are **not** restored automatically, and recovery does not change them. If the link is replaced by a new run for another address, or has expired by the next run, the account it was for is put back as it was (an account the link created is disabled). If an Administrator is active again by the time the person signs in, the link can no longer be used.

**Every use is recorded.** Each recovery link is in the audit trail with its reason, its recipient, what their account was before and which Administrators were disabled; each disabled Administrator has their own entry; and so is the acceptance at sign-in. Every change to the custodian is recorded too.

## What this does and does not protect

- Only this computer can reach Kainow (the port is bound to 127.0.0.1). Do not publish it to a network without putting HTTPS in front. This Compose file is a single-computer setup, not a production design for staff on a network: that needs HTTPS at a reverse proxy, a firewall, monitoring, backups and a rehearsed restore.
- Sign-in requests are limited per client address (per /64 for IPv6, which one subscriber usually holds whole) and overall (by default, per minute: 10 code requests per address and 120 in all, 30 code checks per address and 300 in all); over the limit the answer is 429. Requests for unknown addresses are recorded in the audit trail at most 20 a minute, with a count of the rest. Behind a reverse proxy set `TRUST_PROXY` to the number of proxies (usually 1) so the limit sees the real client address, and add a matching limit at the proxy itself: the limits in Kainow are per `api` process and held in memory.
- The database has no published port and is reachable only by the other containers.
- The server and worker run as a non-root user, on a read-only filesystem, with no extra Linux capabilities.
- Before real use, appoint a second Enterprise Administrator and record the recovery custodian (see "Recovery custodian"). If every Administrator is locked out, the custodian restores access from the command line with `recover-admin`; this does not restore project roles.
- Backups are real and checked: a daily encrypted copy of the database goes to a folder apart from the installation, every run is recorded in Kainow, and a failed or missing backup is never shown as healthy (see "Backups"). The restore drill proves a backup restores: it decrypts, matches every table's row count, checks the files and the protected key, and times the restore against the 4-hour target. A restore into a new installation is described under "Restore from a backup". Both are only as good as the schedule you set up and the key recovery copies you keep.
- Kainow stops accepting changes before the database disk fills (protective read-only mode, see "Disk space and protective read-only mode"). That safe floor has not yet been verified on a real disk.
- Up to 24 hours of work can be lost in a disaster (the backup interval), and access changes made after the backup are not restored: after a restore, check People, grants and Administrators before resuming.
- Updates install only a release signed with the release key, only after an Enterprise Administrator approved that exact release, and only after a pre-update backup succeeded (see "Updates"). The updater that installs them has root-equivalent control of the server through the Docker socket; it runs only when cron starts it, and removing its crontab line turns it off. A failed update is never restored silently: the server operator runs `recover` ("After a failed update").

## Microsoft 365 email

Kainow can send all its email, sign-in codes and reminders, as one mailbox in your Microsoft 365 organisation, with no password stored: it signs in as an application. You need a Microsoft 365 administrator for steps 1 to 3. The examples use the placeholder mailbox `kainow@example.org`; use your own.

1. **Register an application.** In the Microsoft Entra admin centre choose **App registrations**, then **New registration**. Give it a name such as "Kainow email" and keep the default single-tenant choice. On its overview page note the **Directory (tenant) ID** and the **Application (client) ID**.
2. **Make a secret and give it permission.** Under **Certificates & secrets** make a **New client secret** and copy its **Value** at once (it is shown only once). Under **API permissions** choose **Add a permission**, **APIs my organization uses**, **Office 365 Exchange Online**, **Application permissions**, and add `SMTP.SendAsApp`. Then choose **Grant admin consent**.
3. **Let the application send as one mailbox.** In Exchange Online PowerShell (replace the placeholders with your application's client ID and its **Object ID** from **Enterprise applications**; this is a different ID from the one on the registration page):

   ```
   New-ServicePrincipal -AppId <client-id> -ServiceId <enterprise-application-object-id>
   Add-MailboxPermission -Identity kainow@example.org -User <enterprise-application-object-id> -AccessRights FullAccess
   ```

   Also make sure SMTP AUTH is allowed for that mailbox (`Set-CASMailbox -Identity kainow@example.org -SmtpClientAuthenticationDisabled $false`). Only this one mailbox can be used as the sender.

   **What `FullAccess` means.** Microsoft requires `FullAccess` on the mailbox for an application that sends through SMTP with its own credentials; there is no narrower "send only" right for this method. `FullAccess` lets the application open and read everything in that mailbox, not only send from it. Kainow only sends, but the grant itself is broader than that. We therefore recommend a **dedicated sender mailbox** used for nothing else (for example a shared mailbox named for Kainow), so the only mail the application could ever read is its own. Do not grant this on a person's mailbox or on a mailbox that receives other mail. The grant covers this one mailbox only; nothing else in your organisation is opened to the application.
4. **Put the four settings in `.env`** (never committed):

   ```
   EMAIL_PROVIDER=m365
   M365_TENANT_ID=<directory-tenant-id>
   M365_CLIENT_ID=<application-client-id>
   M365_CLIENT_SECRET=<secret-value>
   EMAIL_FROM=kainow@example.org
   ```

   Then `docker compose up -d`. If one is missing, Kainow refuses to start and names the missing variable (never its value). Remove `LOG_SIGN_IN_CODES` and `NODE_ENV=development` so codes are emailed, not logged, and Kainow runs in production mode.

**Auto-reply.** Set an automatic reply on the sender mailbox saying that it is not monitored, so people who answer a Kainow email know no one will read it.

If Microsoft rejects the sender's credentials, Kainow does not retry that email and shows the reason in the delivery history; check the secret has not expired and that steps 2 and 3 are done. The client secret is never written to the database, the logs or any screen.

**Sending rate.** Exchange Online accepts at most 30 messages a minute from one mailbox. Kainow sends at most 30 a minute through Microsoft 365 and keeps the rest queued for the next minute, so a large batch (for example the first morning after a long holiday) goes out over a few minutes. If Microsoft still answers that a sending limit or quota is reached, Kainow treats it as temporary and retries on its normal schedule.

## Storage in SharePoint or OneDrive

Kainow keeps every uploaded source file and its text in a protected **source area**, and files approved project outputs, in your own Microsoft 365 SharePoint (or OneDrive). It signs in as an application that can reach only the sites you grant it, one by one. You need a Microsoft 365 administrator for steps 1 to 4 and the protected key (see "Protected key") before step 5. Every name below is a placeholder; use your own.

1. **Register an application.** In the Microsoft Entra admin centre choose **App registrations**, then **New registration**, for example "Kainow storage", single tenant. Note the **Directory (tenant) ID** and the **Application (client) ID**. Under **Certificates & secrets** make a **New client secret** and copy its **Value** at once (it is shown only once). A separate registration from the email one keeps each one's permissions small.
2. **Give it Microsoft Graph application permissions.** Under **API permissions** choose **Add a permission**, **Microsoft Graph**, **Application permissions**, and add `Sites.Selected`. Add `User.ReadBasic.All` as well **only** if you will turn directory lookup on in Kainow (it lets Kainow check that a person is an account in your tenant before sharing a folder with them, and is needed for OneDrive destinations; it reads names and addresses only). Then choose **Grant admin consent**. `Sites.Selected` on its own reaches no site at all until step 3.
3. **Grant the application each site it will use.** For every site that holds a Kainow library, run one of these (the Storage page shows the same commands for each destination). Every Kainow site needs **Full control**: on output sites Kainow shares each output folder with the people who may read it, and on the source-area site it gives the storage Administrators you designate direct access by inviting them to the area's `projects` folder. **Write** is enough only if the probe (step 7) shows "write sufficed: ok" for your tenant:

   ```
   Grant-PnPAzureADAppSitePermission -AppId "<application-id>" -DisplayName "Kainow" -Site "https://<tenant>.sharepoint.com/sites/<site-name>" -Permissions FullControl
   ```

   or with Microsoft Graph (as an administrator):

   ```
   POST https://graph.microsoft.com/v1.0/sites/<site-id>/permissions
   { "roles": ["fullcontrol"], "grantedToIdentities": [ { "application": { "id": "<application-id>", "displayName": "Kainow" } } ] }
   ```

   Use the same for the source-area site. If Microsoft refuses `fullcontrol` when the permission is created, create it with `write` and then change it with `PATCH https://graph.microsoft.com/v1.0/sites/<site-id>/permissions/<permission-id>` and `{ "roles": ["fullcontrol"] }`. With only `write`, designating a storage Administrator fails as forbidden unless the probe has shown that `write` suffices. A OneDrive destination is the account's personal site, `https://<tenant>-my.sharepoint.com/personal/<account>`.
4. **Limit each Kainow library to the site owners.** SharePoint gives every file in a library the library's own permissions as well as the ones Kainow adds, so a library that site members can open would show every output to them. For each library Kainow uses: open the library, **Settings**, **Library settings**, **Permissions for this document library**, **Stop Inheriting Permissions**, then remove every group, person and sharing link except the site's **Owners** group. Kainow refuses to approve a library where anyone else can open it, names who, and warns on the Storage page if that changes later; it never removes those permissions itself. In the SharePoint admin centre set each of these sites' external sharing to **Only people in your organization**, so no guest can be invited.
5. **Connect Kainow.** Sign in as an Enterprise Administrator and open **System Settings › Storage**. Enter the tenant ID, the application ID and the client secret, with a reason; the secret is stored encrypted with the protected key and never shown again (without the protected key it cannot be saved). Choose **Check connection**: it should say "Connected". Turn directory lookup on only if you added `User.ReadBasic.All` in step 2.
6. **Add and approve the destinations.** Add the source-area library (exactly one) and one or more output libraries by the site address and the library name, check each one and approve it with a reason. Then designate the people who may open the source area directly (storage Administrators; never yourself), and choose each project's output destination in its settings (or let projects choose). The go-live checklist step "Connect storage and approve the source area" then ticks itself; until it does, source files stay in the database and are moved to the source area once it is approved.
7. **Check it against your tenant (recommended).** With the provided Compose setup (the `api` service already has the database address and the protected key):

   ```
   docker compose run --rm api node dist/storage/probe-storage-cli.js --destination "<label>" --test-account <person@your-domain> --granted fullcontrol
   ```

   Outside Docker: `DATABASE_URL=... KAINOW_PROTECTED_KEY_FILE=... npm run probe-storage -- --destination "<label>" --test-account <person@your-domain> --granted fullcontrol`.

   It works in its own folder, removes it permanently afterwards, prints one line per check and never prints the secret or a token. `--granted` says which site permission you gave in step 3. To find out whether `write` is enough in your tenant, grant `write` instead of Full control on one site, run the probe against a destination there with `--granted write`, and keep `write` only if it prints "write sufficed: ok". Send the output to whoever looks after Kainow. The output may name the people and groups who can open the library, so check it before you send it on.

To stop Kainow reaching a site, remove the site permission of step 3 (or delete the client secret in Entra). Files Kainow filed stay where they are; Kainow never deletes a filed output.
