# Installing Kainow on one computer (December 2026 MVP)

This starts Kainow with Docker Compose: a PostgreSQL database, the Kainow server (which also serves the review screen) and the background worker that talks to the AI. It is for one computer, reached at `http://localhost:3000`. There is no HTTPS and nothing is reachable from other computers.

**Status: first built and run on 8 November 2026** on Windows 11, with Docker Desktop 29.9.2 (WSL 2 engine) and Compose 5.6.1. These steps worked as written: the build, the migrations, creating the administrator, saving the spend settings, signing in at `http://localhost:3000` in a browser, uploading a Word document, the Windows backup, and every step of "Check that it works" below. One extraction of a synthetic note with the real `gpt-6.1-sol` returned 11 proposals, all quotes found, for MYR 0.06. If a step fails on your computer, I want to hear about it. The projects steps (6 and "Check that it works" 2–6) were walked through on the same install later that day, with four test accounts.

## Windows

The PowerShell lines in this guide were run in Windows PowerShell 5.1 on 8 November 2026 and work as written. The repository now forces Linux line endings (`.gitattributes`), so a Windows checkout does not break files inside the containers. If you cloned before that was added and see odd errors such as `\r` in a message, clone again. Use Docker Desktop with the WSL 2 engine (its default).

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

   A new code is made at most once a minute. If you ask again sooner, the screen looks the same but no new code is made, so use the latest code in the log.

6. **Set up the organisation and the first project** (as the administrator):
   - Under **Departments**, add at least one department. Every project belongs to one.
   - Under **Domains**, add your organisation's email domain (for example `example.com`). Only addresses at these domains can be invited, and a domain alone admits nobody.
   - Under **My Projects**, choose **New project**. It starts as a Draft.
   - On the project's **People** tab, invite a Project Manager and an Owner or Sponsor. The Project Manager then invites the Members. Each invitation is emailed (or, with `LOG_SIGN_IN_CODES=true`, written to `docker compose logs api`) as a link that expires after seven days.

   Invitation links use `APP_URL` from `.env`, which defaults to `http://localhost:3000`. If other people reach this computer by another address, set `APP_URL` to it and run `docker compose up -d`.

   After the first project, anyone with an account can create projects and becomes their Project Manager.

## Check that it works

1. Sign in as the administrator. The top bar should show "AI spend this month MYR 0.00 of MYR 20.00".
2. Add a department and your domain, create a project, and invite a Project Manager, an Owner and a Member (three addresses at your domain). Open each link from the log, sign in with the code for that address, and accept.
3. As the Project Manager: **Move to Planned**, then **Make Active**. Until everyone has accepted, Kainow says which role is still needed.
4. As the Project Manager, on the **Notes** tab, add notes: paste any meeting notes, or upload one of `tests/extraction/inputs/synthetic/*.md`.
5. Choose "Find decisions and actions". The run should go from waiting to ready in under a minute.
6. Sign in as the Owner, choose Review, **Authorise** one proposal (for an action: pick the accountable person and the due date) and reject another. The highlighted passage should change colour, and the authorised item appears on the project's **Work** tab. The spend figure should rise by a few sen. (The Project Manager and Members can read the proposals but cannot authorise them.)
7. If extraction says "No AI key is configured", the worker did not receive `OPENAI_API_KEY`: check `.env` and run `docker compose up -d` again.

8. Optional, as the Administrator: under **People**, disable the Member's account. The project now says "A member is On Hold — investigation needed" and the Project Manager gets an email (or a line in `docker compose logs api`). Enable the account again, then as the Project Manager or Owner record a finding on the People tab and choose **Restore**.

Notes added before projects existed (before 8 November 2026) stay in the database but are not shown.

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

On Mac or Linux:

```
docker compose exec -T db pg_dump -U kainow -Fc kainow > kainow-backup-$(date +%F).dump
```

In Windows PowerShell do **not** use `>` to save the dump: Windows PowerShell 5.1 rewrites the file as text and corrupts it. Let the database write the file and copy it out instead:

```
docker compose exec -T db sh -c "pg_dump -U kainow -Fc kainow -f /tmp/kainow.dump"
docker compose cp db:/tmp/kainow.dump "kainow-backup-$(Get-Date -Format yyyy-MM-dd).dump"
docker compose exec -T db rm /tmp/kainow.dump
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
