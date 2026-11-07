# Installing Kainow on one computer (December 2026 MVP)

This starts Kainow with Docker Compose: a PostgreSQL database, the Kainow server (which also serves the review screen) and the background worker that talks to the AI. It is for one computer, reached at `http://localhost:3000`. There is no HTTPS and nothing is reachable from other computers.

**Status: this package has not been built or run with Docker yet, and the Product Owner has deferred that first test to later.** The sandbox it was written in has no Docker daemon and cannot reach Docker Hub. What was checked instead: the compose file validates (`docker compose config`), and the exact contents of the final image (production dependencies, compiled code, migrations, the built screen) were assembled in a clean folder and run against PostgreSQL 16: migrate, create the administrator, sign in, open the screen, run the worker. If a step below fails on your computer, the first build is the most likely place, and I want to hear about it.

## What you need

- Docker Desktop (or Docker Engine with the Compose plugin), version 24 or later.
- About 2 GB of free disk space for the first build.
- An OpenAI key for `gpt-6.1-sol`, if you want extraction to run. Without one everything else works and extraction fails with a clear message, sending and costing nothing.
- A way to send email, if you want sign-in codes emailed. To try Kainow alone, codes can be printed in the server log instead.

## Install

1. **Make your settings file.** In this folder (the one with `compose.yaml`):

   ```
   cp .env.example .env
   ```

   Open `.env` and fill in:
   - `POSTGRES_PASSWORD`: letters and digits only. For example: `openssl rand -hex 24`
   - `AUTH_SECRET`: at least 32 characters. For example: `openssl rand -base64 48`
   - Sign-in codes: either `SMTP_URL` and `SMTP_FROM`, or leave `LOG_SIGN_IN_CODES=true` to read codes from the log (own computer only).
   - `OPENAI_API_KEY`: your key. It stays in `.env`, which is never committed, and only the worker receives it.

2. **Build and start.**

   ```
   docker compose up -d --build
   ```

   The first build downloads images and packages and takes a few minutes. The database migrates itself at every start.

3. **Create the first Enterprise Administrator.**

   ```
   docker compose run --rm api node dist/users/create-admin-cli.js you@example.org "Your Name"
   ```

4. **Save the approved AI spend settings** (model `gpt-6.1-sol`, USD 2.00 / 0.10 / 10.00 per million tokens, 1 USD = MYR 4.10, MYR 20 a month, no daily cap). Until you do this every AI request is refused:

   ```
   docker compose run --rm api node dist/spend/apply-mvp-settings-cli.js
   ```

5. **Open `http://localhost:3000`** and sign in with the email you used. If you left `LOG_SIGN_IN_CODES=true`, read the code with:

   ```
   docker compose logs api --tail 20
   ```

## Check that it works

1. Sign in. The top bar should show "AI spend this month MYR 0.00 of MYR 20.00".
2. Add notes: paste any meeting notes, or upload one of `tests/extraction/inputs/synthetic/*.md`.
3. Choose "Find decisions and actions". The run should go from waiting to ready in under a minute.
4. Choose Review, approve one proposal and reject another. The highlighted passage should change colour. The spend figure should rise by a few sen.
5. If extraction says "No AI key is configured", the worker did not receive `OPENAI_API_KEY`: check `.env` and run `docker compose up -d` again.

## Everyday use

| To | Run |
| --- | --- |
| See what is running | `docker compose ps` |
| Read the logs | `docker compose logs -f api worker` |
| Stop (keeps your data) | `docker compose stop` |
| Start again | `docker compose up -d` |
| Update to a newer copy of the code | `git pull` then `docker compose up -d --build` |
| Change a setting in `.env` | edit it, then `docker compose up -d` |

## Back up

```
docker compose exec -T db pg_dump -U kainow -Fc kainow > kainow-backup-$(date +%F).dump
```

This holds everything: notes, original files, proposals, decisions, the audit trail and AI spend records. Keep it somewhere other than this computer. **Restoring from a backup has not been rehearsed** (the full restore drill is deferred to January), so treat the backup as unproven until you have restored one into a spare copy.

## Remove everything

`docker compose down` removes the containers and keeps your data. `docker compose down -v` also **deletes the database volume, and with it all your notes, decisions and the audit trail. It cannot be undone.**

## What this does and does not protect

- Only this computer can reach Kainow (the port is bound to 127.0.0.1). Do not publish it to a network without putting HTTPS in front.
- The database has no published port and is reachable only by the other containers.
- The server and worker run as a non-root user, on a read-only filesystem, with no extra Linux capabilities.
- There is one Enterprise Administrator and no recovery person yet. If that person is locked out, access can be restored only from the command line (step 3 for a new administrator). Before real use, add a second administrator and agree who holds recovery.
- Updates are manual (`git pull`, rebuild). An in-app updater is deferred to January.
