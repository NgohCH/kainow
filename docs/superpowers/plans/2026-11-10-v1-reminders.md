# Reminders, escalation, working-day calendar and email — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remind and escalate on authorised tasks and risk reviews using each project's working-day calendar, deliver in-app and by email (Microsoft 365 over XOAUTH2) through a durable outbox with the accepted retries, and send manual and scheduled action-item digests.

**Architecture:**
- Migration `0020_notifications.sql` adds settings, holidays, triggers, in-app notifications, the email outbox and attempts, digest runs and sweep runs.
- A pure `notifications/calendar.ts` + `notifications/planner.ts` compute, from a snapshot of a project's tasks, risks and settings, every trigger with its stable key and fire time. The same functions drive the sweep, the settings preview and the tests.
- The worker runs a pg-boss scheduled tick every minute on a new `sweep` queue. It performs a sweep when the configured interval (default 15 minutes) has passed since the last one. A sweep claims each due trigger with `INSERT … ON CONFLICT (key) DO NOTHING`, resolves recipients (with cover for people away or with email off), writes in-app rows, then emails each person per project according to their own choice: daily at 09:00 with urgent immediately (default), every notice immediately, daily only, or off.
- A second scheduled tick on the existing `email` queue dispatches due outbox rows: eligibility and relevance recheck, attempt, retry at 5/30/120 minutes after the first failure, uncertain handling.
- The API writes outbox rows (invitations, hold alerts, closure notices, digests, test email) and nudges the email queue. Sign-in codes and the setup invitation stay direct.

**Tech Stack:** TypeScript, NestJS 12, PostgreSQL 16, pg-boss 12, nodemailer 10 (built-in OAuth2/XOAUTH2 with a custom token provider), React + Vite, `node:test`. No new npm dependencies; the token request uses `fetch`.

**Spec:** `docs/superpowers/specs/2026-11-10-v1-reminders-design.md`

## Global Constraints

- Time zone fixed UTC+8. Deadline = 23:59:59 UTC+8 on `due_on`; send slot 09:00 UTC+8 on a working day; "next slot after T" = 09:00 on the first working day whose 09:00 ≥ T.
- Defaults: Working Days; weekdays Mon–Fri (ISO `[1,2,3,4,5]`); lead times `[7,1]`; escalation delay 3; sweep 15 minutes; three delegation switches `false`.
- Bounds: weekdays non-empty subset of 1–7; 1–3 lead times, each 1–30, all different; escalation 1–10; sweep 5–60.
- Email retries: initial attempt + retries at 5, 30 and 120 minutes after the first failure (max 4 attempts). `sending` for 10 minutes → `uncertain`; one automatic resend at the next retry slot, flagged `possible_duplicate`; a second uncertain stays for an Administrator.
- Trigger keys exactly as spec §4.6; outcomes `sent | skipped_obsolete | skipped_paused | no_recipient | cancelled_ineligible`; outbox statuses `queued | sending | retry_wait | sent | failed | cancelled | uncertain`.
- Exact copy:
  - `No independent escalation recipient`
  - `This is not a working day in this project's calendar. The deadline stays on this date.`
  - `Deadlines and review dates do not change.`
  - `Nothing to send: no open tasks`
  - `You no longer have access to this project`
  - `Possible duplicate: an earlier attempt may have been delivered`
  - `Each reminder must be 1–30 days before the due date.`, `At most 3 reminders, each on a different day.`, `The escalation delay must be 1–10 days.`, `The sweep interval must be 5–60 minutes.`, `Choose at least one working weekday.`
  - `The Administrator has not allowed projects to change this setting.`
  - Email subject for notice emails (one per person per project): `Kainow: <n> item(s) need your attention in <project name>` (`1 item needs`, `<n> items need`); digest subject `Action items: <project name>`; digest sections `Your open tasks`, `Other open tasks in this project`; header line `As at <Ddd D Mmm YYYY>, <HH:MM> (UTC+8)`.
  - Administrator fallback body: `A task in <project name> needs reassignment.` and nothing else about the task.
- Email preferences per (person, project): `daily_urgent_immediate` (default, no row), `immediate`, `daily`, `off`. Urgent kinds: `overdue`, `parent_deadline`, `past_due_set`, `assignee_unavailable`. Labels: `Daily, urgent immediately`, `Every notice immediately`, `Daily only`, `Off`.
- Away dates: inclusive `starts_on`–`ends_on` (UTC+8 dates); no notice email or digest on those dates; catch-up on the first send after; cover for escalations and alerts (spec §5).
- Secrets (`M365_CLIENT_SECRET`, `SMTP_URL` credentials) never appear in the database, logs, error bodies or API responses.
- Test accounts only: `*@example.org`, `*@kainow.test`. Invented names must be checked as fictitious; no real organisation names or acronyms.
- DB tests one file at a time: `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kainow_test`.

**Decisions taken in this plan (not in the spec):**
- A consolidated email whose items partly became obsolete or ineligible before an attempt is `cancelled` with reason `content changed`, and a new linked row (`replaces`) is composed with the remaining items; if none remain, nothing replaces it. This keeps "the composed body is never rewritten".
- Dispatching is a once-a-minute scheduled tick plus an immediate nudge from the API, not one pg-boss job per email; the outbox row is the source of truth, so retry times are honoured to within a minute.
- The sweep runs on a new `sweep` queue (the queue-names test changes to `['ai','document','email','sweep']`), and every sweep is recorded in `sweep_runs` (start, finish, duration, counts) for the measurement in Task 15.
- The inline letterhead logo is stored with the composed email (`attachments jsonb`, base64) so a later logo change does not alter an email already composed.

## Review Focus

1. **A task amended to a new due date while its old reminder email is still in `retry_wait`** must not deliver the old reminder (Task 7 relevance test).
2. **A person who is both PM and the assignee of an overdue Member-level subtask's parent** must not receive a parent-deadline escalation about their own task as the only recipient; Owners/Sponsors receive it (Task 6 routing test).
3. **A holiday added or removed after a trigger was recorded** never re-sends or re-schedules that trigger, only untriggered ones move (Task 8 sweep test).
4. **The worker down for three days across a weekend** produces one email per recipient per project, with only the 1-day reminder for a task whose 7-day and 1-day reminders both came due (Task 8 catch-up test).
5. **An account disabled between the sweep and the email attempt** gets `cancelled` with reason `recipient no longer eligible`, never sent (Task 7).
6. **A PM away while an Owner's task escalates** (recipients PM + other Sponsors): the Sponsors still get it and no cover adds the Owner who is the assignee (Task 6).

---

### Task 1: Migration

**Files:**
- Create: `app/migrations/0020_notifications.sql`
- Modify: `app/src/db/migrate.test.ts` (`REAL_FILES` gains `'0020_notifications.sql'`)
- Test: `app/src/db/notifications-schema.test.ts`

**Interfaces — produces** (tables, all `uuid` ids unless stated):
- `notification_settings` (`id smallint PK CHECK (id=1)`, `day_counting text CHECK IN ('working','calendar')`, `weekdays smallint[]`, `lead_days smallint[]`, `escalation_days smallint`, `sweep_minutes smallint`, `projects_may_change_calendar bool`, `projects_may_change_timings bool`, `projects_may_change_digest bool`, `updated_by`, `updated_at`), seeded with the defaults; CHECKs for every bound (array bounds via `cardinality` and `<@ ARRAY[1..7]` / `1..30`).
- `project_notification_settings` (`project_id PK`, nullable `day_counting`, `weekdays`, `lead_days`, `escalation_days`; `digest_enabled bool NOT NULL DEFAULT false`, `digest_frequency text CHECK IN ('daily','weekly')`, `digest_weekday smallint`, `digest_time time`).
- `holidays` (`id`, `project_id` NULL = organisation, `on_date date`, `name text`, `added_by`, `added_at`, `removed_by`, `removed_at`); unique current `(coalesce(project_id, nil uuid), on_date) WHERE removed_at IS NULL`.
- `notification_settings_changes` append-only (`scope text CHECK IN ('organisation','project')`, `project_id`, `field`, `old_value text`, `new_value text`, `reason text NOT NULL`, `actor_id`, `at`).
- `notification_triggers` append-only (`key text UNIQUE`, `kind`, `project_id`, `record_kind`, `record_id`, `fire_at`, `decided_at`, `outcome`, `recipients uuid[]`, `detail jsonb`).
- `notifications` (`user_id`, `trigger_id`, `project_id`, `kind`, `urgent bool`, `summary`, `link`, `created_at`, `read_at`, `outbox_id` NULL); index `(user_id, read_at, created_at DESC)` and `(user_id, project_id) WHERE outbox_id IS NULL`.
- `email_preferences` (`user_id`, `project_id`, PK both; `choice text CHECK IN ('daily_urgent_immediate','immediate','daily','off')`, `updated_at`).
- `away_periods` (`id`, `user_id`, `starts_on date`, `ends_on date CHECK (ends_on >= starts_on)`, `note`, `created_at`, `removed_at`).
- `email_outbox` (`to_user_id` NULL, `to_address`, `subject`, `text_body`, `html_body`, `attachments jsonb`, `kind`, `project_id`, `initiated_by_user`, `initiated_by text CHECK IN ('person','schedule','trigger','digest','system')`, `trigger_ids uuid[]`, `digest_run_id`, `relevance jsonb`, `status`, `attempts smallint`, `first_failure_at`, `next_attempt_at`, `last_reason`, `possible_duplicate bool`, `resend_of`, `replaces`, `created_at`, `sent_at`); index `(status, next_attempt_at)`.
- `email_attempts` append-only (`outbox_id`, `attempt_no`, `started_at`, `finished_at`, `outcome text CHECK IN ('sent','temporary','permanent','uncertain')`, `smtp_code`, `error_class`).
- `digest_runs` (`project_id`, `initiated_by_user` NULL, `scheduled bool`, `as_at`, `recipient_count`).
- `sweep_runs` (`started_at`, `finished_at`, `duration_ms`, `triggers_fired`, `emails_queued`).
- Indexes for the sweep: `tasks (project_id) WHERE status NOT IN ('completed','cancelled')`, `risks (project_id) WHERE status <> 'resolved' AND review_on IS NOT NULL`.

- [ ] **Step 1: Write failing tests** `notifications-schema.test.ts`: `defaults are seeded` (row 1 equals the Global Constraints defaults); `bounds are enforced` (updates with `lead_days = '{0}'`, `'{7,7}'`, `'{1,2,3,4}'`, `escalation_days = 11`, `sweep_minutes = 4`, `weekdays = '{}'` each raise `check_violation`); `trigger keys are unique` (second insert of the same key with `ON CONFLICT DO NOTHING` returns 0 rows); `history tables are append-only` (UPDATE on `notification_triggers`, `email_attempts`, `notification_settings_changes` raises).
- [ ] **Step 2: Run** `npm run build && node --test dist/db/notifications-schema.test.js`. Expected: FAIL.
- [ ] **Step 3: Write `0020_notifications.sql`**, using `kainow_append_only()` triggers as in earlier migrations.
- [ ] **Step 4: Run** the schema test and `node --test dist/db/migrate.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `Add notification, calendar and email outbox tables`.

### Task 2: Working-day calendar (pure)

**Files:**
- Create: `app/src/notifications/calendar.ts`
- Test: `app/src/notifications/calendar.test.ts`

**Interfaces — produces:**
- `export type DayCounting = 'working' | 'calendar'`
- `export interface Calendar { dayCounting: DayCounting; weekdays: number[]; holidays: ReadonlySet<string> }` (dates `YYYY-MM-DD`, weekdays ISO 1–7)
- `isWorkingDay(cal: Calendar, date: string): boolean`
- `stepBackWorking(cal: Calendar, date: string, n: number): string` (calendar mode: plain days)
- `addWorkingDays(cal: Calendar, date: string, n: number): string`
- `slotOn(date: string): Date` (09:00 UTC+8 on that date, i.e. 01:00Z)
- `nextSlot(cal: Calendar, t: Date): Date`
- `deadlineOf(date: string): Date` (23:59:59 UTC+8)
- `reminderAt(cal, dueOn, lead): Date`; `escalationAt(cal, dueOn, delay): Date` (= `nextSlot` after the end of `addWorkingDays(dueOn, delay)`); `riskDueAt(cal, reviewOn): Date` (`slotOn(reviewOn)`, or the previous working day's slot when non-working); `riskMissedAt(cal, reviewOn): Date` (`nextSlot(deadlineOf(reviewOn))`)

- [ ] **Step 1: Write failing table tests** with a Mon–Fri calendar and holiday `2026-11-20` (Fri):
  - `reminderAt('2026-11-16' Mon, 1)` = `2026-11-13T01:00:00Z` (Fri 09:00); `reminderAt('2026-11-21' Sat, 1)` = `2026-11-19T01:00:00Z` (Thu, Fri 20 is a holiday); `reminderAt('2026-11-23' Mon, 7)` = `2026-11-11T01:00:00Z`.
  - `escalationAt('2026-11-16' Mon, 3)` = `2026-11-23T01:00:00Z` (Tue–Thu pass; Fri 20 is a holiday); with no holiday = `2026-11-20T01:00:00Z`; `escalationAt('2026-11-13' Fri, 3)` = `2026-11-19T01:00:00Z` (Thu).
  - Calendar mode (holidays ignored): `escalationAt('2026-11-16', 3)` = `2026-11-20T01:00:00Z`; `reminderAt('2026-11-21' Sat, 1)` = `2026-11-20T01:00:00Z`.
  - `nextSlot(2026-11-14T03:00Z Sat)` = `2026-11-16T01:00:00Z`; `nextSlot(2026-11-16T01:00Z)` = the same instant.
  - `riskDueAt('2026-11-22' Sun)` = `2026-11-19T01:00:00Z` (Fri 20 is a holiday); `riskMissedAt('2026-11-17')` = `2026-11-18T01:00:00Z`.
- [ ] **Step 2: Run** `node --test dist/notifications/calendar.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** with date-string arithmetic on UTC dates (no local time zone use); loops bounded by 366 steps with an error if a calendar has no working day (impossible given the CHECK, but guard).
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `Add the working-day calendar functions`.

### Task 3: Trigger planner (pure)

**Files:**
- Create: `app/src/notifications/planner.ts`
- Test: `app/src/notifications/planner.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `export type TriggerKind = 'reminder' | 'overdue' | 'past_due_set' | 'parent_deadline' | 'risk_review_due' | 'risk_review_missed'`
  - `export interface TaskSnap { id: string; parentId: string | null; title: string; assigneeId: string; dueOn: string; status: TaskStatus /* existing union in records/tasks.ts */; deadlineReviewRequired: boolean; dueSetAt: Date; reopenCount: number }`
  - `export interface RiskSnap { id: string; description: string; status: RiskStatus; responsibleId: string | null; reviewOn: string | null }`
  - `export interface Timings { leadDays: number[]; escalationDays: number }`
  - `export interface PlannedTrigger { key: string; kind: TriggerKind; recordKind: 'task' | 'risk'; recordId: string; fireAt: Date; detail: Record<string, unknown> }`
  - `planProject(input: { cal: Calendar; timings: Timings; tasks: TaskSnap[]; risks: RiskSnap[] }): PlannedTrigger[]` — every trigger for open, not-under-review tasks and unresolved risks, regardless of now.
  - `dueNow(planned: PlannedTrigger[], now: Date): PlannedTrigger[]` — `fireAt <= now`, minus reminders that are obsolete (deadline passed, or a later reminder of the same task also due), returning the obsolete ones separately: `{ fire: PlannedTrigger[]; obsolete: PlannedTrigger[] }`.

Rules (spec §4): reminder skipped when `reminderAt < dueSetAt`; `past_due_set` when `dueSetAt > deadlineOf(dueOn)`, fired at `nextSlot(dueSetAt)`; overdue `fireAt = max(escalationAt, nextSlot(dueSetAt))`; parent-deadline for every open child of a parent (any depth) at `nextSlot(deadlineOf(parent.dueOn))`, key uses parent id and parent `dueOn`; keys exactly as spec §4.6.

- [ ] **Step 1: Write failing tests**: `two reminders, one escalation for a fresh task`; `no reminder whose time passed before the due date was set`; `past due set gives past_due_set and, when 3+ days overdue, overdue at the same slot`; `amended due date changes every key`; `reopen count changes the episode`; `completed, cancelled and deadline-review tasks plan nothing`; `blocked tasks still plan`; `parent deadline planned for an open grandchild, not for a completed one`; `risk due and missed keyed by review date; resolved risk plans nothing`; `dueNow keeps only the latest reminder when 7-day and 1-day are both due, and drops reminders after the deadline as obsolete`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `Plan reminder, escalation and risk-review triggers`.

### Task 4: Settings, holidays, preview

**Files:**
- Create: `app/src/notifications/settings.ts` (effective-settings loader usable without Nest), `settings.service.ts`, `settings.controller.ts`, `notifications.module.ts`
- Modify: `app/src/app.module.ts` (import `NotificationsModule`)
- Test: `app/src/notifications/settings.http.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  - `loadEffective(db, projectId: string | null): Promise<{ cal: Calendar; timings: Timings; sweepMinutes: number; sources: Record<'dayCounting'|'weekdays'|'leadDays'|'escalationDays', 'organisation'|'project'>; delegation: { calendar: boolean; timings: boolean; digest: boolean }; digest: DigestSchedule | null }>` with `DigestSchedule = { frequency: 'daily'|'weekly'; weekday: number|null; time: string }`.
  - `loadTaskSnaps(db, projectId)`, `loadRiskSnaps(db, projectId)` (`dueSetAt` = max `task_events.at` where kind `authorised`, `deadline_reviewed`, or `amended` with `detail ? 'due'`; `reopenCount` = count of `reopened`).
  - HTTP:
    - `GET /notification-settings` and `PUT /notification-settings` (Administrator; body `{ changes: {...}, reason }`).
    - `GET|POST|DELETE /notification-settings/holidays[/:id]` (Administrator; delete records `removed_*`, reason required).
    - `GET /projects/:id/notification-settings` (anyone who can view the project) returns effective values, sources, delegation and `canEdit` per group.
    - `PUT /projects/:id/notification-settings` (PM/Owner/Sponsor; 403 `The Administrator has not allowed projects to change this setting.` when the group switch is off); `null` for a field clears the override.
    - `GET|POST|DELETE /projects/:id/holidays[/:id]` (calendar group).
    - `POST /notification-settings/preview` and `POST /projects/:id/notification-settings/preview` with the proposed changes: `{ moved: [{ recordKind, recordId, title, kind, from, to }], added: [...], removed: [...] }` for triggers with `fireAt` in the next 30 days and no recorded trigger, across affected projects (organisation preview: projects whose value is inherited).
  - Every change writes `notification_settings_changes` rows (one per field) and an `audit_events` row as other settings do.

- [ ] **Step 1: Write failing HTTP tests**: Administrator reads defaults and changes lead days with a reason (history row written); member gets 403 on organisation settings; each bound message from Global Constraints; project PM edit refused while the switch is off with the exact message, allowed when on, and the response labels the field `project`; `null` restores `organisation`; turning the switch off keeps the project value and makes `canEdit` false; holiday add/remove recorded, not deleted; preview of moving lead days from `[7,1]` to `[5,1]` on a seeded Active project lists the 7-day reminder as moved with `from`/`to`, and a trigger already in `notification_triggers` is not listed.
- [ ] **Step 2: Run** `node --test dist/notifications/settings.http.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**, following `changes/policy.service.ts` for reason, history and audit.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `Add notification settings, holidays and change preview`.

### Task 5: Email providers, composition and the outbox writer

**Files:**
- Create: `app/src/email/transport.ts`, `app/src/email/m365-token.ts`, `app/src/email/outbox.ts`, `app/src/email/letterhead.ts`, `app/src/email/relevance.ts` (the `Relevance` type only, as listed in Task 7; Task 7 adds `stillRelevant`)
- Modify: `app/src/config.ts` (`EmailConfig`), `app/src/auth/code-senders.ts` (send through the chosen transport), `INSTALL.md` (Microsoft 365 setup section), `app/src/config.test.ts`
- Test: `app/src/email/transport.test.ts`, `app/src/email/outbox.test.ts`

**Interfaces — produces:**
- `export type EmailConfig = { provider: 'm365'; tenantId: string; clientId: string; clientSecret: string; from: string } | { provider: 'smtp'; url: string; from: string } | { provider: 'log' }` in `AppConfig.email` and `WorkerConfig.email`. `EMAIL_PROVIDER` unset keeps today's behaviour (`SMTP_URL` → smtp, else log with `LOG_SIGN_IN_CODES=true`); `m365` requires `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET`, `EMAIL_FROM`, otherwise `loadConfig` throws naming the missing variable (never its value). `AppConfig.codeDelivery` is replaced by `email`.
- `export class M365TokenSource { constructor(cfg, fetchFn = fetch, clock: Clock); token(): Promise<string> }` — POST `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, `grant_type=client_credentials`, `scope=https://outlook.office365.com/.default`; cached until 5 minutes before `expires_in`.
- `export interface MailTransport { send(m: { from: string; to: string; subject: string; text: string; html: string; attachments: StoredAttachment[] }): Promise<{ messageId: string | null }> }` and `createTransport(cfg: EmailConfig, clock): MailTransport` (m365: nodemailer `host smtp.office365.com, port 587, requireTLS: true, auth: { type: 'OAuth2', user: from, accessToken }` with the token from `M365TokenSource`).
- `export class SendError extends Error { kind: 'temporary' | 'permanent'; smtpCode: number | null; reason: string }` and `classify(err: unknown): SendError` (4xx/connection/timeout/token 5xx → temporary; 5xx SMTP, 535 auth, token 400/401 → permanent with the readable reasons, e.g. `The mail service rejected the sender's credentials`).
- `loadLetterhead(db): Promise<Letterhead>` (move the logic `OrganisationService` uses into this plain function; the service calls it).
- `export async function writeOutbox(db, row: OutboxInput): Promise<string>` composing with the letterhead at write time; `OutboxInput = { toUserId: string|null; toAddress: string; subject: string; body: string; kind: string; projectId: string|null; initiatedBy: …; initiatedByUser?: string; triggerIds?: string[]; digestRunId?: string; relevance?: Relevance; replaces?: string; resendOf?: string }`.
- `export interface EmailNudge { nudge(): Promise<void> }` (`EMAIL_NUDGE` token; real one sends a pg-boss job to `email`; tests use a no-op).

- [ ] **Step 1: Write failing tests**: config tests for each provider and the missing-variable message; token source requests once and reuses until 5 minutes before expiry (fake fetch + fake clock), refreshes after; `classify` table (421 → temporary, 450 → temporary, `ETIMEDOUT` → temporary, 550 → permanent, 535 → permanent with the credential reason); `writeOutbox` stores subject, text, html with the organisation name and a base64 logo attachment, status `queued`; nothing in any stored column contains the client secret.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the INSTALL.md section: app registration, `SMTP.SendAsApp` application permission with admin consent, `New-ServicePrincipal` and `Add-MailboxPermission` for the one sender mailbox, the four variables.
- [ ] **Step 4: Run.** Expected: PASS; the existing `code-senders.test.ts` still passes.
- [ ] **Step 5: Commit** `Add the Microsoft 365 and SMTP email transports and the outbox writer`.

### Task 6: Recipients and routing

**Files:**
- Create: `app/src/notifications/recipients.ts`
- Test: `app/src/notifications/recipients.test.ts` (pure), `app/src/notifications/eligibility.test.ts` (DB)

**Interfaces — produces:**
- `export interface Holder { userId: string; roles: ProjectRole[] }` (Active today, from `membershipState`, Active accounts only).
- `routeFor(kind: TriggerKind | 'resumption' | 'assignee_unavailable', ctx: { holders: Holder[]; assigneeId: string | null; responsibleId?: string | null; admins: string[] }): { to: string[]; noIndependent: boolean; minimal: boolean }` implementing spec §5, deduplicated, assignee removed for escalations.
- `applyCover(kind, route: { to: string[] }, ctx: { holders: Holder[]; assigneeId: string | null; unreachable: ReadonlySet<string> }): { to: string[]; covering: string[] }` — for `overdue`, `parent_deadline`, `assignee_unavailable` only: for each recipient in `unreachable` (away today or `off` for this project), add the next routing people per spec §5 (PM → all O/S; O/S → PM + other O/S) who are not unreachable, never the assignee, never Administrators.
- `loadUnreachable(db, projectId, today): Promise<Set<string>>` (away today, or preference `off`).
- `loadHolders(db, projectId, today): Promise<Holder[]>`; `isEligible(db, userId, projectId | null, today): Promise<boolean>` (Active account and an Active role today; `null` project means Active account with the Administrator role, for the minimal fallback).

- [ ] **Step 1: Write failing tests**: pure — Member→PM; Deputy→PM; PM→all O/S; Owner→other Sponsors + PM; Owner who is also the only Sponsor and the PM → `noIndependent` with empty `to`; parent-deadline to PM, or to O/S when the PM is the child's assignee; risk with no responsible → PM only; unavailable assignee → PM, else O/S, else admins with `minimal: true`; a person holding PM and Owner appears once; cover: PM away on a Member's escalation adds every O/S; PM away and every O/S away adds nobody; Owner's task with PM away adds the other Sponsors but never the Owner; reminders get no cover. DB — `isEligible` false for On Hold, expired, revoked, Scheduled, disabled account; true for Active.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `Route notices to independent recipients`.

### Task 7: Email dispatcher

**Files:**
- Create: `app/src/email/dispatcher.ts`; Modify: `app/src/email/relevance.ts` (add `stillRelevant`)
- Test: `app/src/email/dispatcher.test.ts`

**Interfaces:**
- Consumes: Task 5; Task 6's `isEligible`.
- Produces:
  - `export const RETRY_MINUTES = [5, 30, 120]`; `UNCERTAIN_AFTER_MINUTES = 10`.
  - `export type Relevance = { kind: 'task'; taskId: string; dueOn: string; reopenCount: number } | { kind: 'risk'; riskId: string; reviewOn: string } | { kind: 'project_active'; projectId: string } | { kind: 'none' }` plus `items` for consolidated emails: `relevance = { items: Array<{ triggerId: string; projectId: string; check: Relevance; line: string }> }`.
  - `stillRelevant(db, r: Relevance): Promise<boolean>`.
  - `export class EmailDispatcher { constructor(deps: { pool: Pool; transport: MailTransport; from: string; clock: Clock; log }); dispatchDue(): Promise<{ sent: number; failed: number; cancelled: number }> }` — marks stale `sending` rows `uncertain`; selects `queued`, and `retry_wait`/`uncertain` with `next_attempt_at <= now`, `FOR UPDATE SKIP LOCKED`; rechecks; attempts; records `email_attempts`; sets status, `first_failure_at`, `next_attempt_at = first_failure_at + RETRY_MINUTES[attempts-1]`.
  - `resend(db, outboxId, actorId): Promise<string>` (new row with `resend_of`, fresh attempts).

- [ ] **Step 1: Write failing tests** (fake transport scripted per call, fake clock): `sends once and records sent_at`; `temporary failures retry at +5, +30, +120 from the first failure, then failed` (assert `next_attempt_at` values and that a dispatch before the time sends nothing); `permanent failure is failed at once with the reason`; `attempt count survives a new dispatcher instance`; `a row left sending for 10 minutes becomes uncertain, is resent once at the next slot with possible_duplicate true, and a second uncertain stays uncertain`; `task amended before the attempt cancels the reminder email`; `recipient disabled cancels with recipient no longer eligible`; `one of two items obsolete cancels with content changed and writes a replacement holding only the other item`; `resend creates a linked row with fresh attempts`.
- [ ] **Step 2: Run** `node --test dist/email/dispatcher.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `Dispatch outbox email with bounded retries and uncertain handling`.

### Task 8: The sweep

**Files:**
- Create: `app/src/notifications/sweep.ts`, `app/src/notifications/summaries.ts` (resumption summary, consolidated email text, in-app summary lines)
- Test: `app/src/notifications/sweep.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces: `export class Sweep { constructor(deps: { pool: Pool; clock: Clock; appUrl: string; nudge: EmailNudge; log }); runIfDue(): Promise<boolean>; run(): Promise<SweepCounts> }`. `runIfDue` checks `sweep_runs` against `sweep_minutes`. `run`:
  1. For every Active project: effective settings, snaps, `planProject`, `dueNow`.
  2. For each trigger due, in its own transaction: `INSERT … ON CONFLICT (key) DO NOTHING RETURNING id`; if a row came back, decide its outcome (`skipped_paused` when `fireAt` precedes the project's latest return to Active from Deferred/Closed; `no_recipient`; `cancelled_ineligible` when every recipient fails `isEligible`; else `sent`), write `notifications` rows. Obsolete reminders are recorded `skipped_obsolete`.
  3. Unavailable-assignee triggers from open tasks whose assignee is not a holder (cause = hold, membership or declined/expired/revoked invitation id).
  4. Resumption summaries for each `project_transitions` row to `active` from `deferred`/`closed` without a recorded `project:<id>:resumed:<transition id>` key.
  5. Mailing (`notifications/mailing.ts`, `mailDue(db, now): Promise<number>`). Notifications created while the person's choice for the project is `off` get `detail.email_off = true` and are never emailed. For each (person, project) with unemailed rows (`outbox_id IS NULL` and not `email_off`), skip while the person is away today; otherwise send when the choice allows: `immediate` → now; `daily_urgent_immediate` → urgent rows now, all rows at the project's 09:00 slot on a working day; `daily` → all rows at that slot. One `writeOutbox` per (person, project) with `relevance.items`, set `outbox_id` on the rows it carries, then `nudge()`.
  6. Insert the `sweep_runs` row.
- `GET /projects/:id/escalation-flags` (in `notifications.controller.ts`, project viewers) lists tasks whose current-episode overdue trigger is `no_recipient` and still overdue.

- [ ] **Step 1: Write failing tests** (seeded projects, fake clock moved across days): reminder at Fri 09:00 for a Monday deadline, in-app row and one email; escalation Friday 09:00 to the PM; second `run()` at the same time fires nothing; amendment to a new due date yields new reminders and keeps the old trigger rows; Deferred project fires nothing and, after resuming on Wednesday, a trigger whose time fell during the pause is `skipped_paused` and one resumption summary goes to the PM and each assignee listing "Deadline review required" tasks; Owner's task with no independent person → `no_recipient` and the flag endpoint lists it; catch-up (Review Focus 4); holiday added after a trigger was recorded does not re-send it (Review Focus 3); parent-deadline with the PM as child assignee (Review Focus 2); risk due and missed on the next morning, not after a new review date was set; unavailable assignee after a hold, once per hold; Administrator fallback email contains exactly `A task in <name> needs reassignment.`; Planned project fires nothing; `runIfDue` false before 15 minutes have passed; default choice: a 14:00 escalation is emailed at once, a reminder fired at 09:00 and a risk notice at 09:00 share one 09:00 email per project, and two projects give two emails; `immediate` emails a non-urgent notice at once; `daily` holds an escalation to the next 09:00; `off` sends nothing and nothing later; away Mon–Wed holds everything and Thursday's 09:00 email carries the catch-up.
- [ ] **Step 2: Run** `node --test dist/notifications/sweep.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `Sweep for due reminders, escalations and risk-review notices`.

### Task 9: Digests

**Files:**
- Create: `app/src/digests/digest.ts` (build per recipient), `digests.service.ts`, `digests.controller.ts`
- Modify: `app/src/notifications/sweep.ts` (scheduled digests, key `project:<id>:digest:<date>`)
- Test: `app/src/digests/digest.test.ts`, `app/src/digests/digests.http.test.ts`

**Interfaces — produces:**
- `buildDigest(db, projectId, recipientId, asAt: Date): Promise<{ subject: string; body: string; openCount: number }>` — sections and lines per spec §8.3.
- `scheduledDigestDue(cal, schedule: DigestSchedule, now: Date, lastSentDate: string | null): string | null` (the due date, daily on working days in Working Days mode; weekly on the weekday or the working day before).
- HTTP: `GET /projects/:id/digest/preview` (PM/O/S, Active) → `{ recipients: number; asAt; subject; body }` of the caller's own copy; `POST /projects/:id/digest` → `{ digestRunId, recipients }`; 409 `Nothing to send: no open tasks`; schedule edits through Task 4's project settings `digest` group.

- [ ] **Step 1: Write failing tests**: own tasks first with overdue first; others grouped by assignee; Completed/Cancelled absent; markers `Overdue` and `Deadline review required`; header `As at …`; no proposals, risks, decisions or questions in the body; recipients exclude Audit/Oversight grant holders, On Hold members and people away today (but not people whose notice choice is `off`); Member gets 403 on send; Deferred project 403; empty project 409; scheduled daily skips Saturday; weekly on a holiday goes the working day before; scheduled empty digest not sent; `digest_runs` row with recipient count and linked outbox rows.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `Add manual and scheduled action-item digests`.

### Task 10: Move existing emails to the outbox

**Files:**
- Modify: `app/src/auth/tokens.ts` (`CodeSender` keeps `send` and `sendSetupInvitation` only), `app/src/auth/code-senders.ts`, `app/src/projects/invitations.service.ts`, `app/src/users/users.service.ts`, `app/src/projects/projects.service.ts`, `app/src/testing/fakes.ts`, `app/src/testing/http.ts` (expose `outbox(to?: string)` reading `email_outbox`)
- Test: existing `invitations.http.test.ts`, `holds.http.test.ts`, `closure.http.test.ts`, `code-senders.test.ts`

**Interfaces — produces:** `TestApp.outbox(email?: string): Promise<OutboxRow[]>`; `TestApp.lastInvitationLink(email)` replacing `sender.lastInvitation`.

- [ ] **Step 1: Change the existing tests** to read invitations, hold alerts and closure notices from `outbox()` with the same subjects and bodies as today, written in the same transaction as the event (a failing event leaves no outbox row).
- [ ] **Step 2: Run** those test files one at a time. Expected: FAIL.
- [ ] **Step 3: Implement** with `writeOutbox` + `nudge()` after commit.
- [ ] **Step 4: Run** the whole server suite (`npm test`). Expected: PASS.
- [ ] **Step 5: Commit** `Send invitation, hold and closure emails through the outbox`.

### Task 11: Notifications, delivery history and Administrator email APIs

**Files:**
- Modify: `app/src/notifications/notifications.controller.ts`; Create: `app/src/email/email.controller.ts`
- Test: `app/src/notifications/notifications.http.test.ts`, `app/src/email/email.http.test.ts`

**Interfaces — produces:**
- `GET /notifications?before=<created_at>` (30 per page, newest first; entries for unreadable projects have `summary: null, link: null, noAccess: true`); `GET /notifications/unread-count` → `{ count }`; `POST /notifications/:id/read`; `POST /notifications/read-all`; `GET /email-preferences` → `{ projects: [{ projectId, name, choice }], away: [{ id, startsOn, endsOn, note }] }` for projects where the person holds a role; `PUT /email-preferences/:projectId` `{ choice }` (403 for a project where they hold no role); `POST /away-periods` `{ startsOn, endsOn, note? }` (400 `The end date cannot be before the start date.`); `DELETE /away-periods/:id` (own only, records `removed_at`).
- `GET /projects/:id/deliveries` (PM/O/S) and `GET /deliveries` (Administrator): rows with recipient name, kind, subject, `createdAt`, status, attempts, `lastReason`, `possibleDuplicate`.
- `POST /deliveries/:id/resend` (Administrator; only `failed`/`uncertain`); `POST /email/test` (Administrator; to own address); `GET /email/status` → `{ provider, from, lastOutcome }`.

- [ ] **Step 1: Write failing tests**: own notifications only; unread count; mark one and all read; preferences default to `daily_urgent_immediate`, set and read back, refused for a project without a role; away periods created, listed and removed, another person's id is 404; a notification for a project the person has left shows `noAccess`; Member 403 on project deliveries, PM 200; Administrator resend of a `failed` row creates a linked row; resend of a `sent` row is 409; test email queued to the Administrator's address; `/email/status` never contains the secret.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `Add notification, delivery history and email administration endpoints`.

### Task 12: Worker wiring

**Files:**
- Modify: `app/src/worker/queues.ts` (add `sweep`), `app/src/worker/queues.test.ts`, `app/src/worker/main.ts`; Create: `app/src/worker/schedules.ts`; Create: `app/src/email/nudge.ts` (pg-boss `EmailNudge` for the API, started lazily like `PgBossExtractionQueue`)
- Test: `app/src/worker/schedules.test.ts`

**Interfaces — produces:** `registerSchedules(boss: PgBoss, deps: { sweep: Sweep; dispatcher: EmailDispatcher }): Promise<void>` — `boss.schedule('sweep', '* * * * *')` and `boss.schedule('email', '* * * * *')` with `singletonKey`; `work('sweep', …)` calls `sweep.runIfDue()`; `work('email', …)` calls `dispatcher.dispatchDue()`. The worker starts pg-boss with `schedule: true`.

- [ ] **Step 1: Write failing tests**: queue names `['ai','document','email','sweep']`; after `registerSchedules` the two schedules exist (`boss.getSchedules()`); a job sent to `email` runs `dispatchDue` once (fake dispatcher).
- [ ] **Step 2: Run** `node --test dist/worker/schedules.test.js` then `dist/worker/queues.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**; `main.ts` builds `Sweep` and `EmailDispatcher` from `loadWorkerConfig()` (which gains `email` and `appUrl`).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `Run the sweep and email dispatch from the worker`.

### Task 13: Web — bell and Notifications page

**Files:**
- Create: `app/web/src/notifications.ts` (+ test), `app/web/src/views/Notifications.tsx`, `app/web/src/views/Bell.tsx`
- Modify: `app/web/src/App.tsx` (route `#/notifications`, bell in the header beside `HeaderSearch`)

**Interfaces — produces:** `bellLabel(count: number): string` (`Notifications`, `Notifications, 1 unread`, `Notifications, 99+ unread`); `badgeText(count): string | null`.

- [ ] **Step 1: Write failing tests** in `notifications.test.ts` for `bellLabel` and `badgeText` (0 → null, 120 → `99+`).
- [ ] **Step 2: Run** `npm --prefix web test`. Expected: FAIL.
- [ ] **Step 3: Implement**: count refresh on hash change and every 60 seconds while `document.visibilityState === 'visible'`; page with Mark read, Mark all read, Show more, the no-access text, loading/empty/error states; opening a link marks the entry read. An **Email preferences** section on the same page: a radio group per project with the four labels from Global Constraints, and an away-dates list with add (start, end, optional note) and remove.
- [ ] **Step 4: Run** web tests and `npm run build:web`. Expected: PASS.
- [ ] **Step 5: Commit** `Add the notification bell and page`.

### Task 14: Web — project and Administrator screens

**Files:**
- Create: `app/web/src/views/NotificationSettings.tsx` (project and organisation forms share it), `app/web/src/views/Deliveries.tsx`, `app/web/src/views/DigestSend.tsx`, `app/web/src/calendar.ts` (+ test)
- Modify: `app/web/src/App.tsx` (routes `#/projects/:id/settings`, admin `#/notifications-settings`, `#/deliveries`), `ProjectPage.tsx` (Settings tab, Send action-item email, Delivery history, the `No independent escalation recipient` flag), `AuthoriseForm.tsx`, `ChangeForms.tsx`, `DeadlineReview.tsx`, `Work.tsx` (effective mode beside deadlines; non-working-day warning)

**Interfaces — produces:** `isWorkingDayClient(settings, date): boolean` and `modeLabel(settings): string` (`Working Days, Mon–Fri` / `Calendar Days`).

- [ ] **Step 1: Write failing tests** for `modeLabel` and `isWorkingDayClient` (weekend, holiday, calendar mode).
- [ ] **Step 2: Run** web tests. Expected: FAIL.
- [ ] **Step 3: Implement**: effective-value labels `From the organisation` / `Set for this project`, read-only when `canEdit` is false, reason field, preview list with `Deadlines and review dates do not change.` before save; digest preview and confirm; delivery history table with Resend for the Administrator; provider status and Send test email; the warning copy under date fields.
- [ ] **Step 4: Run** web tests and `npm run build:web`; check the screens in the browser pane at desktop and 375 px width with keyboard only.
- [ ] **Step 5: Commit** `Add notification settings, digests and delivery history screens`.

### Task 15: Measure the sweep

**Files:**
- Create: `app/src/notifications/sweep-bench-cli.ts` (seeds into the test database: 200 users, 300 Active projects, 30,000 open tasks and subtasks with due dates spread over ±60 days, 3,000 risks with review dates, a year of holidays; runs `Sweep.run()` cold and five times warm; prints timings and `EXPLAIN (ANALYZE, BUFFERS)` of the snapshot queries)
- Modify: `docs/superpowers/specs/2026-11-10-v1-reminders-design.md` §12.3 (record the results, met or missed)

- [ ] **Step 1: Run** `npm run build && node dist/notifications/sweep-bench-cli.js` against `KAINOW_TEST_DATABASE_URL`. Expected: timings printed.
- [ ] **Step 2:** If the warm sweep is 2 seconds or more, add the index or batching the plans point to, rerun, and record both runs. Do not claim the aim met without a measured run under 2 seconds.
- [ ] **Step 3: Commit** `Record sweep timings on a realistic dataset`.

### Task 16: Final check

- [ ] **Step 1: Run** `npm test` (server, one file at a time as configured) and `npm --prefix web test` and `npm run build:web`. Expected: all pass; report the counts.
- [ ] **Step 2:** `git grep -n -i` over the branch's changed files for any organisation names or acronyms used in tests and seed data; replace any that are not clearly invented.
- [ ] **Step 3: Commit** any fixes `Final checks for reminders and email`.
