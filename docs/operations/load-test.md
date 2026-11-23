# Load test

A repeatable load test for the V1.0 aim of **200 registered people, 10 using Kainow at once**, with a mixed workload (10b spec §13). It runs against a **test installation only**: the seed refuses any database that is not empty, and a run (and a worker started for a load test) refuses any database that is not the seeded test organisation.

Everything in it is dummy: the organisation is "Example Organisation" (example.org) and the people are `load-001@example.org` … `load-200@example.org`. No real AI provider is called and nothing is charged.

## What it does

1. **Seed** (`--seed`, about 30 s; if it stops part-way, drop and re-create the database, migrate it, and seed again: a half-seeded database is not empty, so the seed refuses it): on an empty migrated database, the organisation, 200 Active people (load-001 is the Enterprise Administrator), 5 departments, 40 Active projects (each with a Project Manager, an Owner, a Sponsor and 4–12 Members), 3,000 tasks, 400 decisions and 400 risks from approved proposals, 1,600 proposals waiting for review, 300 notes (450 versions), 120 discussion threads with 480 messages, and 30 days of history (transitions, task events, review times). Notes and discussion are written through the real HTTP routes of an in-process app, so every side table is as the app makes it. The rest is set-based SQL with deterministic ids.
   The first ten people are the virtual people of a run: each is the Project Manager of four projects, the Owner of four others (proposals are reviewed by the Owner or a Sponsor) and a Member of four more.
2. **Sessions**: each virtual person signs in through the real `POST /auth/request-code` and `POST /auth/verify`. The test installation runs with `LOG_SIGN_IN_CODES=true`; the load test reads each code from the API's log file (`--api-log`). The seed signs the same people in, so a request within a minute of it is silenced by the 60-second resend gap; the load test then waits the gap and asks once more. No session rows are seeded.
3. **Run** (`--users 10 --minutes 30 --think 5-20`): each virtual person loops a weighted journey, then thinks for a random 5–20 s:

   | Share | Journey | Requests |
   |---|---|---|
   | 35% | browse | `GET /projects`, `/projects/:id`, `/projects/:id/records` (Work tab), `/records/tasks/:id` |
   | 15% | read | `GET /projects/:id/discussion`, `/threads/:id`, `/projects/:id/notes`, `/notes/:id`, `/notes/:id/versions/:n` |
   | 15% | write | half: a discussion comment (`POST /threads/:id/messages`); half: the next status of one of the PM's tasks (`POST /records/tasks/:id/start\|complete\|block\|unblock\|reopen`) |
   | 10% | dashboards | `GET /dashboard/me`, `/projects/:id/dashboard` |
   | 8% | search | `GET /search?q=<word>` |
   | 7% | approve | `GET /projects/:id/proposals`, then authorise (65%) or reject (35%) a waiting one, as the Owner |
   | 5% | extract | `POST /projects/:id/notes` (a small note), `POST /notes/:id/versions/1/extractions` (queued to the fake AI) |
   | 5% | analytics | `GET /admin/analytics?panel=…`, as the Enterprise Administrator (load-001, one of the virtual people) |

   The journey sequence is repeatable (`--journey-seed`, default 1; person *i* uses seed + *i*). A 409 on changing a task or deciding a proposal is an **expected refusal** (it moved or was decided meanwhile) and is listed apart from errors. The other 190 people exist and receive the notifications, reminders and digests the worker produces.
4. **Drain and report**: after the run the load test waits (up to 6 minutes) until every extraction it asked for has finished and no email the run produced is still waiting, then writes `load-test-<date>.md` (and a `.json` with the figures): machine, parameters, per journey count, errors, expected refusals and p50/p95/p99; AI and email queue wait and run times; database connections (most seen), slowest statements from `pg_stat_statements` (or "not available"), database size before and after; and the worker's lag per pg-boss queue (job created to job started).

### The fake AI (route chosen)

The provider hosts are fixed in code (`ai/provider-clients.ts`; a project's key only ever goes to them), so an approved model's connection **cannot** be pointed at another base URL. The load test therefore uses the second route of the spec: a **load-test-only client factory**, registered by the worker only when `KAINOW_LOAD_TEST=1` and `KAINOW_LOAD_TEST_AI_URL` is a loopback `http` address (anything else stops the worker), and only on the seeded load-test organisation. Every attempt then goes, through the real OpenAI-compatible client, to a fake chat-completions server the load test starts on that address; it answers after 3–8 s with four proposals. Everything before the call is the real code: choosing the project's connection, opening its sealed key with the protected key, reserving spend, and taking one of the 2 AI places. The fake records every call, so the report shows how many were open at once.

The seed turns **automatic discussion analysis off**, so the extraction journey is the only AI work of a run (the fake answers only the extraction format).

### Email

The test installation sends email with the log provider (`LOG_SIGN_IN_CODES=true`, no `EMAIL_PROVIDER`): the worker writes each email to its log, which is the test mail sink. An email counts as sent when the outbox marks it sent.

## How to run it

On a PC or server with the Kainow source, Node and a PostgreSQL the installation can use. **Never point it at a real installation's database.**

1. Make an empty database and migrate it (`DATABASE_URL=… npm run migrate` in `app/`, after `npm run build`).
2. Make a throwaway protected key (32 random bytes) and a random `AUTH_SECRET` of at least 32 characters, in a scratch folder.
3. Seed: `DATABASE_URL=… KAINOW_PROTECTED_KEY_FILE=<key> npm run load-test -- --seed`
4. Start the API and the worker from `app/`, with the API's output in a file:

   ```
   DATABASE_URL=… AUTH_SECRET=… PORT=3310 LOG_SIGN_IN_CODES=true COOKIE_SECURE=false KAINOW_PROTECTED_KEY_FILE=<key> \
     KAINOW_RELEASE_API=http://127.0.0.1:9 node dist/main.js > api.log 2>&1
   DATABASE_URL=… LOG_SIGN_IN_CODES=true KAINOW_PROTECTED_KEY_FILE=<key> KAINOW_RELEASE_API=http://127.0.0.1:9 \
     KAINOW_LOAD_TEST=1 KAINOW_LOAD_TEST_AI_URL=http://127.0.0.1:3311/v1 node dist/worker/main.js > worker.log 2>&1
   ```

   (`KAINOW_RELEASE_API` on a dead loopback port keeps the daily release check off the network during the test.)
5. Run: `DATABASE_URL=… npm run load-test -- --users 10 --minutes 30 --think 5-20 --api-log api.log --machine "<name>" --disk "<disk>"`
   Options: `--base` (default `http://127.0.0.1:3310`), `--ai-port` (default 3311, must match `KAINOW_LOAD_TEST_AI_URL`), `--out`, `--journey-seed`. It exits 0 when every aim is met, 1 when one is missed or the run fails, 2 for a usage error.
6. Stop the API and the worker and drop the database.

To repeat a measurement, start again from an empty database: a run changes the data (approvals, task statuses, new notes).

## Aims (10b spec §13.2)

| Aim | Target |
|---|---|
| Page reads (GET) | p95 under 1 s |
| Saves (POST/PUT/PATCH/DELETE) | p95 under 2 s |
| Errors | none, other than the refusals the journey expects |
| AI queue | 2 places honoured (at most 2 calls open at the fake), none lost and none failed or blocked, and no request waits more than 5 s in all while a place is free (the allowance covers the job pick-up and the 1 s place poll) |
| Email queue | every email produced during the run is sent within 5 minutes |

Measured results are machine-specific: each is recorded as "measured on <machine>; not a hardware guarantee". Misses are reported to the Product Owner, who decides.

## Results

### First measured result: 22 November 2026 (UTC)

_measured on the development PC (Windows 11, Docker Desktop); not a hardware guarantee_

#### Machine

| | |
|---|---|
| Operating system | Windows_NT 10.0.26300 |
| CPU | 11th Gen Intel(R) Core(TM) i7-1185G7 @ 3.00GHz (8 logical cores) |
| Memory | 32 GB |
| Disk | SSD SAMSUNG MZVL21T0HCLR-00B07 954 GB |
| Docker | Docker 29.9.2 |
| Node | v24.22.1 |
| Database | PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2) |

#### Parameters

- 10 virtual people at once for 30 minutes, think time 5–20 s, journey seed 1.
- From 2026-11-22T17:17:13.887Z to 2026-11-22T17:47:26.289Z; 4,163 requests in 1,403 journeys.
- Journeys started: browse 487, read 195, write 188, dashboards 149, search 125, approve 104, extract 75, analytics 80.

#### Aims

| Aim | Target | Measured | Result |
|---|---|---|---|
| Page reads (GET) | p95 under 1 s | 88 ms | met |
| Saves (POST/PUT/PATCH/DELETE) | p95 under 2 s | 54 ms | met |
| Errors | none, other than expected refusals | 0 | met |
| AI queue | 2 places honoured, none lost, no wait while a place is free (allowance 5.0 s) | 75 requested, 75 succeeded, 0 failed, 0 lost; at most 2 at once; longest wait with a free place 0.6 s | met |
| Email queue | every email sent within 5 minutes | 28 produced, 28 sent, 0 not sent; slowest 0.9 s | met |

Every aim was met.

#### Response times by activity

| Activity | Requests | Errors | Expected refusals | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|
| browse | 1948 | 0 | 0 | 34 | 91 | 109 |
| read | 975 | 0 | 0 | 12 | 20 | 36 |
| write | 377 | 0 | 0 | 26 | 45 | 58 |
| dashboards | 298 | 0 | 0 | 46 | 81 | 106 |
| search | 125 | 0 | 0 | 85 | 106 | 137 |
| approve | 209 | 0 | 0 | 53 | 69 | 96 |
| extract | 151 | 0 | 0 | 35 | 60 | 91 |
| analytics | 80 | 0 | 0 | 45 | 66 | 115 |
| all | 4163 | 0 | 0 | 32 | 87 | 106 |

#### Errors

None.

#### Expected refusals

None.

#### AI and email jobs

| Queue | Jobs | Wait p50 | Wait p95 | Wait max | Run p50 | Run p95 |
|---|---|---|---|---|---|---|
| AI (extraction, fake provider) | 75 | 0.2 s | 0.5 s | 3.6 s | 5.9 s | 7.8 s |
| Email (created to sent) | 28 | 0.7 s | 0.9 s | 0.9 s | – | – |

#### Database

- Connections (most seen, sampled every 5 s): 22 open, 8 running a statement at once.
- Size before 34.2 MB, after 43.5 MB.
- Slowest statements: not available (pg_stat_statements is not loaded on this database server).

#### Worker lag (job created to job started)

| Queue | Jobs | p95 | Max |
|---|---|---|---|
| __pgboss__send-it | 155 | 1.3 s | 5.0 s |
| ai | 75 | 0.4 s | 0.5 s |
| analysis | 31 | 1.9 s | 2.0 s |
| email | 32 | 2.0 s | 2.0 s |
| quarantine.clean-waiting | 31 | 1.9 s | 2.0 s |
| storage | 72 | 1.0 s | 55.2 s |
| storage.outbox | 31 | 1.9 s | 1.9 s |
| sweep | 31 | 1.9 s | 2.0 s |

#### Conditions of this run

**Accepted by the Product Owner for now (23 November 2026, D126).** The run below had the API and worker on the host rather than in containers. It is to be repeated in full with every service in containers during sub-project 11 (Acceptance), on a virtual machine of the size Kainow will recommend. A cloud installation is a virtual machine running the Docker Compose installation (D126); managed container services are not supported in V1.0.

- The API and the worker ran as Node processes on the PC (built from this branch, `node dist/main.js` and `node dist/worker/main.js`); PostgreSQL 16 ran in Docker Desktop, in a container **shared with other development sessions**, which were running their own test suites (migrations and database creation) during the run. A throwaway database was seeded for the run and dropped afterwards.
- No expected refusal happened: each project has one virtual Owner (who decides its proposals) and one virtual Project Manager (who changes its tasks), so two people never raced for the same item. The refusal path is counted but was not exercised.
- `pg_stat_statements` is not loaded on that database server, so the slowest statements are not available.
- One `storage` job waited 55 s before it started (p95 1.0 s); it is background filing of the new notes' source text, not something a person waits for.
- The email figures are what the run's activity produced (28 notification emails); no daily digest or reminder fell inside the 30 minutes.
