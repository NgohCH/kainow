# Verifying an update end to end (updater, release signing, outage time)

## Purpose

This check runs a real update, and a real failed update, on a Linux Docker host, against a stand-in for GitHub and a throwaway release key. It shows what the automated tests cannot: that the whole flow of the 10b design (spec section 5, "the updater") works with real git, real signatures, a real Docker socket and a real database. It proves:

1. Check now finds a newer signed release through `KAINOW_RELEASE_API` (the GitHub tags response shape the code expects).
2. An approved update is prepared while Kainow runs, then installed at the start time: read-only maintenance, a `pre_update` backup, migration, restart, health checks, and the update recorded as succeeded.
3. **The outage, from maintenance on to healthy, is under 5 minutes** (the aim; this is the figure to measure).
4. A failed migration leaves the notice page, the operator line in the cron log, and `recover --yes` puts Kainow back on the previous version, read-only, with the failed database kept under its new name.

Everything here is test data. Use `example.org` addresses. Never use a real installation, a real release key or the real repository.

## Status

**Not run (23 November 2026): no WSL2 distribution or Linux VM on the development PC.** `wsl -l -v` lists only `docker-desktop`, Docker Desktop's own internal distribution, which is not usable for this. Every figure in the results table below is therefore "not run".

To run it, the Product Owner must choose to install a distribution (this changes the PC, so it is the PO's decision):

```
wsl --install -d Ubuntu
```

Then install Docker Engine with the Compose plugin inside that Ubuntu (or turn on Docker Desktop's WSL integration for it), and install Node.js 20 or later, git and `openssh-client`. A separate Linux VM works equally well. Everything below runs inside the Linux shell, never in PowerShell.

## What you need

- Docker with the Compose plugin (version 24 or later), git, Node.js 20+, `ssh-keygen`, `curl`.
- Around 4 GB of free disk space for the three builds, and an hour or two (the updater builds images twice).
- The Kainow source on that host, on the branch under test. The examples assume it is at `$SRC`.

Choose one working folder for everything, and set these in every shell you use for this check:

```
export V=/tmp/kainow-verify              # everything lives here and is thrown away at the end
export SRC=/path/to/kainow               # the Kainow checkout under test
mkdir -p "$V"
```

## Part A: the stand-ins

### A1. A throwaway release key (never the Product Owner's)

```
ssh-keygen -t ed25519 -N "" -C "kainow-release" -f "$V/release-key"
```

No passphrase, so the release script can sign without a prompt. This key exists only here; delete it at the end.

### A2. A bare repository standing in for GitHub

```
git init --bare "$V/origin.git"
git clone -b "$(git -C "$SRC" rev-parse --abbrev-ref HEAD)" "$SRC" "$V/work"
cd "$V/work"
git checkout -B main
git remote set-url origin "$V/origin.git"
git config user.name "Verify Releaser"
git config user.email "releaser@example.org"
git config user.signingkey "$V/release-key"
```

`scripts/release.mjs` only releases from a branch called `main`, equal to `origin/main`, so the work clone makes its own `main` from the branch under test. List the throwaway key as the only trusted key (the format is the one in `docs/operations/releasing.md`), then publish `main`:

```
printf 'kainow-release namespaces="git" %s\n' "$(cut -d' ' -f1,2 "$V/release-key.pub")" >> release/release-signers
```

Put a `## 0.0.1` section into `CHANGELOG.md` (the script refuses a release without one), for example the line `## 0.0.1` followed by a blank line and `- Verification release.`, directly under the `## Unreleased` section. Then:

```
git add release/release-signers CHANGELOG.md
git commit -m "Verification: trust the throwaway key, changelog for 0.0.1"
git push origin main
```

### A3. A stand-in for `gh`

`release.mjs` ends by running `gh release create`. A stub that succeeds keeps the script's exit code clean; nothing is created anywhere:

```
mkdir -p "$V/bin"
printf '#!/bin/sh\nexit 0\n' > "$V/bin/gh"
chmod +x "$V/bin/gh"
```

Run every `release.mjs` command below with `PATH="$V/bin:$PATH"`.

### A4. A tiny local server answering the tags request

The release check (`app/src/updater/release-check.ts`) asks `GET <KAINOW_RELEASE_API>/repos/<KAINOW_RELEASE_REPO>/tags?per_page=100` with the header `User-Agent: kainow-update-check` and expects a 200 response with a JSON array of `{ "name": "<tag>", "commit": { "sha": "<40 hex>" } }`. Anything else is a failed check. The server below answers exactly that from the bare repository's tags (the commit is the commit the tag points at). Save it as `$V/tags-server.mjs`:

```
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const origin = process.env.ORIGIN;
const repo = process.env.REPO ?? 'example/kainow';
const port = Number(process.env.PORT ?? 8099);

function tags() {
  const names = execFileSync('git', ['--git-dir', origin, 'tag', '-l', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return names.map((name) => ({
    name,
    commit: { sha: execFileSync('git', ['--git-dir', origin, 'rev-list', '-n', '1', name], { encoding: 'utf8' }).trim() },
  }));
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  console.log(new Date().toISOString(), req.method, req.url, req.headers['user-agent']);
  if (req.method === 'GET' && url.pathname === `/repos/${repo}/tags`) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(tags()));
  } else {
    res.writeHead(404).end();
  }
}).listen(port, '0.0.0.0');
console.log(`Tags server on ${port} for ${repo}`);
```

Start it in its own terminal and leave it running. It binds to all interfaces so that the Kainow containers can reach it (see B2):

```
ORIGIN="$V/origin.git" REPO=example/kainow PORT=8099 node "$V/tags-server.mjs"
```

Check it (it is empty until the first release): `curl -s "http://127.0.0.1:8099/repos/example/kainow/tags?per_page=100"` prints `[]`.

## Part B: release v0.0.1 and install it

### B1. Release v0.0.1

```
cd "$V/work"
PATH="$V/bin:$PATH" node scripts/release.mjs 0.0.1 --dry-run
PATH="$V/bin:$PATH" node scripts/release.mjs 0.0.1
```

The dry run works in a throwaway clone and pushes nothing. The real run prints `Made and verified v0.0.1`, asks `Push v0.0.1 to origin and create the GitHub release? (yes/no)`; answer `yes`. Confirm: `git --git-dir "$V/origin.git" tag -l` lists `v0.0.1`, and the tags server now lists it.

### B2. Install it per INSTALL.md

Follow INSTALL.md, "Install" > "Get the code at a signed release", with the bare repository as the "GitHub" address:

```
export K=/opt/kainow-verify
sudo mkdir -p "$K" && sudo chown "$(id -u):$(id -g)" "$K"
git clone "$V/origin.git" "$K"
cd "$K"
git -c advice.detachedHead=false checkout --detach v0.0.1
cp release/release-signers release-signers
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=release-signers verify-tag v0.0.1
```

The last command must say `Good "git" signature for kainow-release`. (The key comparison step is skipped on purpose: there is no published key, only the throwaway one.)

Make the settings file (`cp .env.example .env`, then fill in as INSTALL.md "Install" step 1 says) with these lines in addition to `POSTGRES_PASSWORD` and `AUTH_SECRET`:

```
LOG_SIGN_IN_CODES=true
KAINOW_BACKUP_DIR=/srv/kainow-verify-backups
KAINOW_RELEASE_REPO=example/kainow
KAINOW_RELEASE_API=http://host.docker.internal:8099
```

The last two are the only difference from a normal installation (INSTALL.md says to leave them unset): they point the release check at the stand-in. Add the four updater lines, printed as INSTALL.md "Updates", step 1 gives them:

```
echo "KAINOW_INSTALL_DIR=$(pwd -P)"
echo "KAINOW_UID=$(stat -c %u .)"
echo "KAINOW_GID=$(stat -c %g .)"
echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)"
```

Local changes go in `compose.override.yaml`, never `compose.yaml` (the updater refuses a changed tracked file). Two are needed here: the containers must reach the stand-in server on the host, and the updater must see the bare repository at the same path (its `origin` is a local folder, not GitHub). The backup key line goes in once the key exists (B3):

```
services:
  api:
    extra_hosts: ["host.docker.internal:host-gateway"]
  worker:
    extra_hosts: ["host.docker.internal:host-gateway"]
  updater:
    volumes:
      - /tmp/kainow-verify/origin.git:/tmp/kainow-verify/origin.git:ro
  ops:
    volumes:
      - ./secrets/kainow-backup.key:/run/secrets/kainow-backup.key:ro
```

If you used another value for `$V`, change the path in the `updater` volume to match. Compose merges the lists, so the service's own mounts stay. Check it with `docker compose config -q` (prints nothing when valid; never run it without `-q` where others can see the screen).

Build and start, and invite the administrator, as INSTALL.md "Install" steps 2 to 6 say. With `LOG_SIGN_IN_CODES=true` the setup link and the sign-in code are in `docker compose logs api`. Use `admin@example.org`, finish **Set up your organisation** with the domain `example.org` and one department. Saving the starting spend settings (step 4) is not needed for this check.

### B3. A throwaway backup folder and key, and one backup

```
sudo mkdir -p /srv/kainow-verify-backups && sudo chown 1000:1000 /srv/kainow-verify-backups
mkdir -p secrets
(cd app && npm ci && npm run build && npm run backup-key -- --create ../secrets/kainow-backup.key)
docker compose up -d
docker compose --profile ops run --rm ops node dist/ops/backup-cli.js --kind manual
```

The last command must print `run <id> succeeded`. (Updates are refused until a backup younger than 24 hours has succeeded.)

### B4. The updater's first tick, by hand

```
docker compose --profile updater run --rm updater node dist/updater/updater-cli.js tick
```

The first run builds the `updater` image (a few minutes). With nothing approved it does nothing and exits 0 (`echo $?`).

### B5. Start the outage recorder

In another terminal, record the health of Kainow's address once a second for the whole of Parts C and D. It is the independent record of the outage:

```
while true; do printf '%s %s\n' "$(date -u +%FT%T)" "$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1:3000/health)"; sleep 1; done > "$V/health.log"
```

## Part C: release v0.0.2 (a harmless migration) and update to it

### C1. Release it

```
cd "$V/work"
printf -- '-- Verification only: a harmless migration.\nCREATE TABLE verify_update_marker (id integer PRIMARY KEY);\n' > app/migrations/0035_verify_update_marker.sql
```

Put a `## 0.0.2` section in `CHANGELOG.md` (as for 0.0.1), then:

```
git add app/migrations/0035_verify_update_marker.sql CHANGELOG.md
git commit -m "Verification: harmless migration"
git push origin main
PATH="$V/bin:$PATH" node scripts/release.mjs 0.0.2
```

Answer `yes`. Check the number: if `app/migrations` already has a `0035_` file, use the next free number.

### C2. Check now and approve

In the browser, sign in as `admin@example.org`, open the Operations page, and choose **Check now** in Updates. Confirm: v0.0.2 is shown as available, and the Enterprise Administrator has one notice (email in the log, and in Kainow). The tags server log shows the request with `kainow-update-check`. Then choose **Approve update**, set the start with **As soon as possible** (15 minutes ahead; the form will not take less), leave the length at 30, give a reason, and approve.

### C3. Prepare, then install

Run the tick by hand (this is what cron does every five minutes) until the update is `ready`:

```
cd "$K"
docker compose --profile updater run --rm updater node dist/updater/updater-cli.js tick 2>&1 | tee -a "$V/kainow-ops.log"
```

The first tick after approval prepares it: Kainow keeps running while the folder is checked, the tag fetched and verified, and the images built. Repeat until the Operations page shows the update as ready (the log shows each step with an ISO time). Then wait for the start time and run the same tick once more at or after it. **Write down the time this tick starts.** Open the Operations page in the browser before the start time and keep it open, to see maintenance.

### C4. What to confirm

- In the browser, before the tick: the banner with the start time and length.
- During the tick: the page says "Kainow is being updated. You can read; changes are paused until the update finishes." (read-only), then the address stops answering while `api` is stopped (`docker compose ps`).
- After it: the Operations page shows the update succeeded, with every step. Running version `0.0.2`. Also: `git -C "$K" describe --tags --exact-match` prints `v0.0.2`.
- The pre-update backup is recorded: the backups list on the Operations page has a `pre_update` run, succeeded, and the backup folder has its files.
- The migration applied: `docker compose exec -T db psql -U kainow -d kainow -Atc "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 2"` shows `0035_verify_update_marker.sql`.
- The trusted file was refreshed from the release: `cmp release-signers release/release-signers` prints nothing.
- Kainow is no longer read-only, and the update is not offered again.

### C5. Time the outage

Two readings; record both:

- **Maintenance on to healthy:** from the updater log, the time of the line for read-only maintenance starting (or the tick start you wrote down) to the line recording the update as succeeded. The Operations page shows the same steps.
- **Address not answering:** from `$V/health.log`, the first line that is not `200` to the first `200` after it. People are cut off from when `api` stops until the new version is healthy (INSTALL.md "Updates", step 3.5).

The aim is under 5 minutes from maintenance on to healthy. If the build had to happen during the install it is a defect: the build belongs to preparing, which runs while Kainow is up.

## Part D: release v0.0.3 (a failing migration) and recover

### D1. Release it and approve it

```
cd "$V/work"
printf -- '-- Verification only: this migration must fail.\nSELECT 1/0;\n' > app/migrations/0036_verify_update_fails.sql
```

Put a `## 0.0.3` section in `CHANGELOG.md`, then:

```
git add app/migrations/0036_verify_update_fails.sql CHANGELOG.md
git commit -m "Verification: failing migration"
git push origin main
PATH="$V/bin:$PATH" node scripts/release.mjs 0.0.3
```

Run a manual backup first if the last one is more than 24 hours old (B3's command). In the browser: **Check now**, then **Approve update** for v0.0.3 with **As soon as possible**. Run the tick by hand until `ready`, then at or after the start time, as in C3.

### D2. What to confirm after the failed tick

- The tick ends with exit code 1 and the log line (also the one an operator would see in `/var/log/kainow-ops.log` or in cron mail):

  ```
  The update to v0.0.3 failed after the database migration started. Kainow is stopped and shows a notice page. Run: docker compose --profile updater run --rm updater node dist/updater/updater-cli.js recover. See INSTALL.md, 'After a failed update'.
  ```

  Check the second form too, the one that is mailed: `docker compose --profile updater run --rm updater node dist/updater/updater-cli.js tick 2>&1 | tee -a "$V/kainow-ops.log" | grep -F "After a failed update"` prints that line.
- `curl -i http://127.0.0.1:3000/` answers status 503 with the fixed page "Kainow is unavailable after a failed update. Nothing you saved before the update started has been lost. Please contact your Administrator." (`docker compose --profile updater ps notice` shows the `notice` service).
- `git -C "$K" describe --tags --exact-match` prints `v0.0.2` (the folder is already back on the previous release).
- The database is as the failed migration left it: `docker compose exec -T db psql -U kainow -d kainow -Atc "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1"` still shows `0035_verify_update_marker.sql`.
- A tick run a second time, and again after 24 hours, repeats the line (once a day). Not required to wait for the 24 hours; the automated tests cover it.

### D3. Recover

Before running it, as INSTALL.md "After a failed update" says: `docker compose ps db` is running, the backup folder is reachable, the backup key is still mounted in `ops` by `compose.override.yaml`.

```
docker compose --profile updater run --rm updater node dist/updater/updater-cli.js recover --yes
```

Confirm: it prints the restore's message and then `Kainow is back on v0.0.2. Review and choose Resume on the Operations page.` Then:

- The notice page is gone, and Kainow answers on port 3000 on `v0.0.2`.
- Kainow is **read-only** (the restore starts it read-only; everyone is signed out). Sign in as `admin@example.org`: the Operations page shows the v0.0.3 update as **recovered**, and an urgent notice to the Enterprise Administrator.
- The failed database is kept: `docker compose exec -T db psql -U kainow -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'kainow_failed_%'"` lists one `kainow_failed_<YYYYMMDD>_<8 characters>`.
- The restored `kainow` database has no `0036_verify_update_fails.sql` in `schema_migrations`.
- Choose **Resume normal use** (with a reason): Kainow takes changes again.

If `recover` stops with a message, write it in the results and see INSTALL.md, "After a failed update". Never drop the `kainow_failed_` database to make it go on.

### D4. The release-key replacement (optional)

To check INSTALL.md "If the release key was lost or replaced": make a second throwaway key, list only it in `release/release-signers`, release a further version signed with it (the script refuses unless its key is listed), see the update refused as `signature_invalid`, then follow that section by hand (`git show vX.Y.Z:release/release-signers > release-signers.tmp`, compare the fingerprints, replace the file, `verify-tag`) and approve again. Note anything in that section that did not work as written.

## Clean up

Stop the recorder and the tags server, then:

```
cd "$K" && docker compose --profile ops --profile updater down -v
sudo rm -rf "$K" /srv/kainow-verify-backups "$V"
```

This deletes the throwaway key with the rest. Nothing was pushed anywhere outside `$V`.

## Results (fill in)

Every cell starts as "not run". Replace it with what you saw.

| Item | Result |
| --- | --- |
| Date run, host, who ran it | not run |
| Host (distribution and version, or WSL2 distribution) | not run |
| Docker version (`docker version`) | not run |
| Compose version (`docker compose version`) | not run |
| git version (`git --version`) | not run |
| Node.js version (`node --version`) | not run |
| v0.0.1 released, signature verified, installed | not run |
| First backup succeeded | not run |
| Check now found v0.0.2; one notice to the administrator | not run |
| Approved "as soon as possible"; ticks until `ready` (how many, how long preparing took) | not run |
| Pre-update backup recorded | not run |
| Maintenance (read-only) seen in the browser | not run |
| Migration 0035 applied; version 0.0.2 shown | not run |
| Outage: maintenance on to healthy (updater log) | not run |
| Outage: address not answering (`health.log`) | not run |
| Outage under 5 minutes (aim) | not run |
| v0.0.3: tick failed; notice page (status 503); operator line in the log | not run |
| `recover --yes`: back on v0.0.2, read-only, update recovered, failed database kept (its name) | not run |
| Resume normal use worked | not run |
| Key replacement section (optional) | not run |
| Differences from the spec (section 5) and from INSTALL.md | not run |
