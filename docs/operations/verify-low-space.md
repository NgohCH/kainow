# Verifying the safe floor (low-space check)

**Status: Not yet run.** Written on 21 November 2026 for sub-project 10a. The builder had no Linux VM, so nothing below has been executed, and no result in this file is real until someone fills in the results table. The Configuration Catalogue entry C96 says the same.

## Why this exists

The accepted rules (Managed Sources rules, A19; decision D114) require a *tested* safe threshold, not an invented one. Kainow enters protective read-only mode when free space on the database disk falls below the safe floor (default 5 GB). This check shows, on a real disk that really fills, that:

1. protective mode starts **before** PostgreSQL reports "No space left on device";
2. no write is half-done (every write either committed completely or was refused);
3. reading, signing in and signing out keep working while the mode is on;
4. Resume is refused while space is still low and accepted once space is freed.

The automated tests only simulate disk readings. This procedure is the real test. It uses a small loop-mounted file system for the database, so it cannot fill the VM's own disk.

## What you need

- A throwaway **Linux VM** (not a real installation) with root (`sudo`), Docker with the Compose plugin, `curl`, `fallocate` and `ext4` tools, and about 14 GB free on the VM's own disk for the loop file.
- The Kainow folder checked out on that VM. The examples use `/opt/kainow-lowspace`.
- An hour. Part of it is waiting for the five-minute storage check.

Everything here is test data. The test account is `admin@example.org`. Do not run this against an installation that holds real data.

## The measured quantities

| Name | Used in the examples | Meaning |
| --- | --- | --- |
| File system size | 12 GB | Big enough that the default 5 GB safe floor fits (protective mode starts at about 7 GB used). |
| Safe floor | 5 GB (the default) | The value being verified. Do not change it for the real run. |
| Check interval | 5 minutes | The same as the INSTALL.md crontab. The floor must cover what can be written between two checks. |
| Fill rate | 50 MB every 5 seconds (10 MB/s, about 3 GB per check interval) | Stands in for the heaviest write load you expect on the database disk between two checks. Raise it to match your own worst case (a large import plus backups' temporary files, for example). |

The floor is adequate when, after a check sees free space at or above the floor, the most that can be written before the next check still leaves space. At the example rate that is 3 GB per interval, below the 5 GB floor.

## Procedure

### 1. Make the small file system

```
export LS_IMG=/var/tmp/kainow-lowspace.img
export LS_DIR=/mnt/kainow-lowspace
sudo truncate -s 12G "$LS_IMG"
sudo mkfs.ext4 -q -m 0 "$LS_IMG"
sudo mkdir -p "$LS_DIR"
sudo mount -o loop "$LS_IMG" "$LS_DIR"
sudo mkdir -p "$LS_DIR/pgdata" "$LS_DIR/filler"
df -B1 "$LS_DIR"
```

`-m 0` reserves no blocks for root, so "free" means what it says. Record the size shown.

### 2. Put the database volume on it

In the Kainow folder, create `compose.lowspace.yaml`. It makes the named volume `kainow-db` a bind onto the small file system, for both `db` and `ops` (which measures it):

```
cat > compose.lowspace.yaml <<'EOF'
volumes:
  kainow-db:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /mnt/kainow-lowspace/pgdata
EOF
```

Add to `.env` (use fresh values for the secrets, as in INSTALL.md "Install", step 1):

```
COMPOSE_PROJECT_NAME=kainow-lowspace
LOG_SIGN_IN_CODES=true
COOKIE_SECURE=false
KAINOW_BACKUP_DIR=/srv/kainow-lowspace-backups
```

`COOKIE_SECURE=false` lets `curl` keep the session over plain `http://localhost`. The backup folder is not on the small file system (the `ops` service needs the variable set to run at all):

```
sudo mkdir -p /srv/kainow-lowspace-backups && sudo chown 1000:1000 /srv/kainow-lowspace-backups
export COMPOSE_FILE=compose.yaml:compose.lowspace.yaml
```

Keep that `export` in every shell you use below.

### 3. Start Kainow and set up the test organisation

```
docker compose up -d --build
docker compose exec db df -B1 /var/lib/postgresql/data
```

The second line must show the 12 GB file system, not the VM's disk. If it does not, stop: the volume is not on the loop mount.

Invite the test administrator and finish setup as in INSTALL.md "Install", steps 3 to 6, with `admin@example.org`, the domain `example.org` and one department:

```
docker compose run --rm api node dist/users/setup-invite-cli.js admin@example.org "Test Admin"
```

Sign in at `http://localhost:3000`, and open **Operations** (`#/admin/operations`). Confirm the safe floor reads 5 GB and that protective mode is off. Record the PostgreSQL version (`docker compose exec db postgres --version`) and the Docker version.

### 4. Sign in from the command line

The write script needs a session and its anti-forgery token. A code is logged because `LOG_SIGN_IN_CODES=true`:

```
export BASE=http://localhost:3000
curl -s -c /tmp/ls-jar -X POST "$BASE/auth/request-code" -H 'content-type: application/json' -d '{"email":"admin@example.org"}'
CODE=$(docker compose logs api --tail 30 | grep 'admin@example.org' | tail -1 | grep -o ': [0-9]\{6\} ' | tr -d ': ')
curl -s -c /tmp/ls-jar -b /tmp/ls-jar -X POST "$BASE/auth/verify" -H 'content-type: application/json' \
  -d "{\"email\":\"admin@example.org\",\"code\":\"$CODE\"}" | sed -n 's/.*"csrfToken":"\([0-9a-f]*\)".*/\1/p' > /tmp/ls-csrf
test -s /tmp/ls-csrf && echo "signed in"
```

A session lasts 12 hours, which is enough.

### 5. The write script

Save as `lowspace-writer.sh`. Each pass makes one real write through the API: an Operations settings change with a reason (one transaction: the setting, its history row and its audit event), alternating retention between 30 and 31 days so every pass changes something. The reason is padded to about 700 characters so each write is not trivially small.

```
#!/usr/bin/env bash
# Usage: lowspace-writer.sh   (needs BASE, LS_DIR and the files from step 4)
CSRF=$(cat /tmp/ls-csrf)
PAD=$(printf 'padding %.0s' {1..90})
n=0
while true; do
  n=$((n+1)); v=$((30 + n % 2))
  code=$(curl -s -o /tmp/ls-body -w '%{http_code}' -b /tmp/ls-jar -X PUT "$BASE/admin/operations/settings" \
    -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
    -d "{\"backupRetentionDays\": $v, \"reason\": \"low space probe $n $PAD\"}")
  echo "$(date -u +%FT%TZ) $n $code $(df -B1 --output=avail "$LS_DIR" | tail -1 | tr -d ' ')" >> /tmp/ls-writer.log
  sleep 0.2
done
```

Expected codes: `200` while the mode is off, `503` once it is on. Anything else, especially `500`, is a failure to record.

### 6. The storage check, at the production interval

Run the check exactly as the INSTALL.md crontab does, every five minutes, in a loop:

```
nohup bash -c 'while true; do docker compose --profile ops run --rm ops node dist/ops/storage-check-cli.js >> /tmp/ls-check.log 2>&1; sleep 300; done' >/dev/null 2>&1 &
```

Wait for the first reading and see the **Database disk** line on the Operations page show about 12 GB total and Normal.

### 7. Fill the disk

Start the writer and watch it:

```
export LS_DIR=/mnt/kainow-lowspace
nohup bash lowspace-writer.sh >/dev/null 2>&1 &
```

First fill quickly to just above the floor plus a margin (leave about 8 GB free), then wait for the next check to record that reading:

```
FREE=$(df -B1 --output=avail "$LS_DIR" | tail -1 | tr -d ' ')
sudo fallocate -l $((FREE - 8*1024*1024*1024)) "$LS_DIR/filler/big"
df -B1 "$LS_DIR"
```

Then fill slowly, at the example rate, until protective mode shows on the Operations page or on the sign-in page (`curl -s $BASE/operations/public-state` answers `{"protective":true}`), and keep going for one more minute after that to try to push the disk further:

```
i=0
while true; do
  i=$((i+1))
  sudo fallocate -l 50M "$LS_DIR/filler/chunk-$i" || { echo "disk full at chunk $i"; break; }
  if [ "$(curl -s $BASE/operations/public-state)" = '{"protective":true}' ]; then
    echo "protective mode seen at chunk $i; continuing 60 s"; sleep 60; break
  fi
  sleep 5
done
df -B1 "$LS_DIR"
```

**"disk full at chunk N" before protective mode is a failed check** (the floor did not protect), as is any `No space left on device` in the database log. Record the free space at that moment and stop.

### 8. Look at what happened

While the mode is on (before Resume):

```
# a read still works:
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/ls-jar "$BASE/auth/me"          # expect 200
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/ls-jar "$BASE/admin/operations" # expect 200
# a write is refused with the fixed text:
curl -s -b /tmp/ls-jar -X POST "$BASE/departments" -H 'content-type: application/json' \
  -H "x-csrf-token: $(cat /tmp/ls-csrf)" -d '{"name":"Low space refused"}'        # expect 503, code protective_read_only
# signing in still works (this is a new session; the code is in the log):
curl -s -X POST "$BASE/auth/request-code" -H 'content-type: application/json' -d '{"email":"admin@example.org"}'
```

Then check that nothing is half-done and the database never ran out:

```
# 1. The writer's status codes:
awk '{print $3}' /tmp/ls-writer.log | sort | uniq -c        # only 200 and 503
# 2. First 503 and the free space then:
grep -m1 ' 503 ' /tmp/ls-writer.log
# 3. The lowest free space ever seen by the writer:
awk '{print $4}' /tmp/ls-writer.log | sort -n | head -1
# 4. PostgreSQL never reported running out of space:
docker compose logs db | grep -ci 'no space left on device\|could not extend\|PANIC'    # expect 0
# 5. Every committed write is complete: history rows, audit events and the writer's 200s agree:
docker compose exec -T db psql -U kainow -d kainow -At -c \
  "SELECT (SELECT count(*) FROM operations_settings_changes WHERE reason LIKE 'low space probe%'),
          (SELECT count(*) FROM audit_events WHERE action = 'ops.settings_changed')"
grep -c ' 200 ' /tmp/ls-writer.log
# 6. The state, the entering event and the readings:
docker compose exec -T db psql -U kainow -d kainow -At -c \
  "SELECT protective, reason, since FROM operations_state"
docker compose exec -T db psql -U kainow -d kainow -At -c \
  "SELECT action, occurred_at FROM audit_events WHERE action = 'ops.protective_entered' ORDER BY occurred_at DESC, id DESC LIMIT 1"
docker compose exec -T db psql -U kainow -d kainow -At -c \
  "SELECT at, free_bytes FROM storage_readings WHERE location = 'database_disk' ORDER BY at DESC, id DESC LIMIT 5"
```

In check 5, on this fresh test installation, the history-row count and the audit count should both equal the number of `200` lines in the writer's log (nothing else in this installation changes Operations settings). A history row without its audit event, or the reverse, is a half-done write.

Also open the Operations page and the Administrator banner as the test administrator: they should show the protective banner text "Kainow is read-only for now to protect your data. You can read everything; changes are paused." and the low-space warning.

### 9. Resume

1. With the filler still in place, choose **Resume normal use** on the Operations page, give a reason, and see it refused with the failing check named (free space below the floor, or no reading younger than 10 minutes).
2. Free the space and make a fresh reading:

   ```
   sudo rm -f "$LS_DIR"/filler/*
   docker compose --profile ops run --rm ops node dist/ops/storage-check-cli.js
   ```

3. Choose **Resume normal use** again. It must be accepted, the banner must go, and the writer's log must return to `200`.

### 10. Clean up

```
pkill -f lowspace-writer.sh; pkill -f 'storage-check-cli.js'
docker compose ls                       # confirm the only project listed here is kainow-lowspace
docker compose down -v
sudo umount /mnt/kainow-lowspace
sudo rm -f /var/tmp/kainow-lowspace.img compose.lowspace.yaml /tmp/ls-jar /tmp/ls-csrf /tmp/ls-body
sudo rm -rf /srv/kainow-lowspace-backups
```

Remove the four test lines from `.env`, or delete the whole test checkout.

## What a pass looks like

- Protective mode is on, with reason `low_space`, **while free space is still above zero** and PostgreSQL's log has no out-of-space lines.
- The writer's log shows only `200` and then `503`; no `500` and no `000`.
- No half-done write: history rows, audit events and the writer's `200` count agree.
- Reading, the Operations page and signing in worked throughout.
- Resume was refused while space was low and accepted after it was freed.
- The margin is recorded: the free space when the mode started, and the lowest free space seen. A pass with less than about one check interval's worth of fill (3 GB at the example rate) left under the floor means the floor is too tight for that write rate: raise the floor or shorten the check interval, and run the check again.

## Results

Fill this table when the procedure is run. **Until then every row stays "Not yet run".**

| Item | Expected | Observed | Result |
| --- | --- | --- | --- |
| Date, tester, VM (OS, kernel), Docker, PostgreSQL version | Recorded | Not yet run | Not yet run |
| File system size, safe floor, check interval, fill rate | 12 GB, 5 GB, 5 min, 10 MB/s (or your values) | Not yet run | Not yet run |
| Database volume really on the loop file system (step 3) | 12 GB shown | Not yet run | Not yet run |
| Free space when protective mode started | Above 0 and near the floor | Not yet run | Not yet run |
| Lowest free space seen by the writer | Above 0 | Not yet run | Not yet run |
| Writer status codes | Only 200, then 503 | Not yet run | Not yet run |
| Out-of-space lines in the PostgreSQL log | 0 | Not yet run | Not yet run |
| Half-done writes (history, audit, writer 200s agree) | 0 | Not yet run | Not yet run |
| Reads and sign-in while the mode is on | Work | Not yet run | Not yet run |
| Write refused with the fixed text | 503, `protective_read_only` | Not yet run | Not yet run |
| Resume refused while space is low, names the check | Refused | Not yet run | Not yet run |
| Resume accepted after space is freed; writes work again | Accepted | Not yet run | Not yet run |

## After the run

Record the outcome in Configuration Catalogue C96 as "Verified on <date>" with the file system size, fill rate and check interval used, or as the failed row and what was changed. Also update the "Verification state" in the Remaining Design and Verification Register, §7, and the one sentence in INSTALL.md "Disk space and protective read-only mode" that says the floor is unverified. Do not mark it verified from a run on a different disk size or fill rate than the one you will use in production without saying so.
