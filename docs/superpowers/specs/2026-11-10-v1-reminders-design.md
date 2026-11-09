# V1.0 sub-project 3: reminders, escalation, working-day calendar and email — design

**Date:** 10 November 2026
**Status:** Approved in conversation by the Product Owner on 10 November 2026, section by section; this document records that design.
**Builds on:** cross-project search (PR #10, branch `v1/search`). Branch `v1/reminders`.
**Authority:** Intent Card principles 4, 5 and 8 (audience rules apply to emails; UTC+8); Product Summary §8–9 and Q02; Consolidated Specification §9, §13, D23–D25, D46, D47, D64, D65, O04 (email retry), O12, Q01, Q02, Q06, A11; Reminders, Notifications and Escalation Rules (all sections); Action-Item Emails, External Outputs and Department Attribution §4; Configuration Catalogue C27–C37 and C48; Permission Matrix §1, §5 and §6; Application Architecture and Operations Design A05, A11 and §6; Remaining Design and Verification Register R13 and R14.

## 1. Purpose

Authorised work in Kainow carries due dates and review dates, but nothing yet reminds anyone about them. This sub-project adds:

- a working-day calendar for each project (Working Days by default, Calendar Days selectable);
- task reminders, overdue escalation, parent-deadline escalation, risk-review notices, an unavailable-assignee alert and a resumption summary;
- in-app notifications (a bell and a Notifications page) and email;
- a durable email outbox with the accepted retry schedule, delivery history and a Microsoft 365 connection;
- manual and scheduled action-item digests;
- the organisation and project settings for all of the above, with delegation and change history.

Notifications never change a task, risk, deadline, membership or approval, never count as acknowledgement and never disclose more than the recipient can read.

## 2. Decisions taken with the Product Owner

| Question | Decision |
|---|---|
| Scope | Everything in one sub-project: calendar, reminders, escalation, risk notices, pause/resume, in-app, email outbox, digests and the Microsoft 365 connection. |
| Microsoft 365 sending | SMTP with OAuth (XOAUTH2) to `smtp.office365.com`, using nodemailer and an OAuth client-credentials token for one approved sender mailbox. Plain SMTP stays as a second provider; the log sender stays for development. |
| In-app channel | A bell in the page header with an unread count, opening a Notifications page. |
| Editable settings | Calendar (mode, weekdays, holidays) and timings (reminder lead times, escalation delay), bounded (§9), at organisation level and, where the Administrator allows, per project. |
| Digest content | Your own open tasks first, then the rest of the project's open tasks grouped by assignee. |
| Owner/Sponsor escalation | Every other Owner and Sponsor and the PM, all different people from the assignee, together. |
| Scheduling approach | A worker sweep over current data, each trigger keyed so it fires once. Sweep interval configurable, default 15 minutes. |
| Firing rules | As in §4, including "due Monday escalates Friday 09:00" and parent-deadline escalation at the next working-day 09:00. |
| Uncertain email outcome | Resent automatically once, marked as a possible duplicate (§7.4). |
| Delegation switches | All three off by default. |
| Sweep time aim | Under 2 seconds per sweep on the seeded dataset of §12. |

## 3. Time and the working-day calendar

- All calculations and displays use UTC+8 (fixed; no other time zone in V1.0).
- A task's deadline is 23:59:59 UTC+8 on `tasks.due_on`. Tasks stay date-only; no specific-time deadlines are added.
- A risk's review date is `risks.review_on`; it is due at the end of that date (D65).
- **Working day.** In Working Days mode a date is a working day when its weekday is one of the project's effective working weekdays and it is neither an organisation holiday nor a project holiday. In Calendar Days mode every date is a working day.
- **Send slot.** A notice "at 09:00 on day X" is sent by the first sweep at or after 09:00 UTC+8 on X. "The next slot" after a moment T is 09:00 on the first working day whose 09:00 is at or after T.
- Calendar rules never move a deadline or a review date. When a non-working date is chosen as a due date (authorise form, amendment, deadline review) or a review date, the form shows a warning: "This is not a working day in this project's calendar. The deadline stays on this date." Saving is not blocked.
- The effective mode ("Working Days, Mon–Fri" or "Calendar Days") is shown beside the deadline in task detail and beside the reminder settings (O12).
- Elapsed-time rules are untouched: invitation validity, membership and grant expiry, sign-in codes, sessions and email retry intervals ignore the calendar (Q02).

The calendar functions live in one pure module, `app/src/notifications/calendar.ts`, with no database access, so that the sweep, the settings preview and the tests share them.

## 4. When each notice fires

### 4.1 Task reminders

For each effective lead time L (default 7 and 1):

- Working Days mode: start at `due_on` and step back to the previous working day L times. The reminder is at 09:00 on the resulting date. Due Monday, L = 1 → Friday 09:00. Due Saturday (non-working), L = 1 → Friday 09:00.
- Calendar Days mode: 09:00 on `due_on − L` days.
- A reminder whose time was already past when the current due date took effect is never sent (C27). The current due date took effect at the latest of: the task's authorisation, an authorised amendment that changed its due date, or an approved deadline-review date (from `task_events`).
- Recipient: the assignee.

### 4.2 Overdue escalation

- With escalation delay D (default 3), the escalation is due once D full working days have passed after the deadline, and it is sent at the next slot. Due Monday → Tuesday, Wednesday and Thursday pass → **Friday 09:00**. Due Friday → Monday, Tuesday and Wednesday pass → Thursday 09:00. In Calendar Days mode, due Monday → Friday 09:00.
- Once per overdue episode (§4.6).
- Recipients: §5.

### 4.3 Due date set in the past (O12)

- When the current due date took effect after its deadline had already passed, one notice goes to the assignee and the PM at the next slot after that moment.
- If the task was already D or more working days overdue at that moment, the overdue escalation is sent at the same slot, without a further D-day wait.

### 4.4 Parent-deadline escalation

- When a parent task's deadline passes while a child (either level) is neither Completed nor Cancelled, a parent-deadline escalation is sent at the next slot after the parent's deadline.
- It is a separate trigger from the child's own reminders and escalation, with its own history (C29). One trigger per child per parent episode.
- Recipient: §5.

### 4.5 Risk-review notices

For each risk that is not Resolved and has a `review_on`:

- **Review due:** 09:00 on `review_on`; if `review_on` is not a working day, 09:00 on the working day before it (Q02, C32).
- **Review missed:** at the next slot after the end of `review_on`, if `review_on` still has the same value (nobody set a new review date) and the risk is still not Resolved. Sent once per review date.
- The risk's status never changes because of a notice (D65).
- Recipients: §5.

### 4.6 Episodes and keys

Every trigger has a stable key that names exactly one occurrence, and `notification_triggers.key` is unique, so a trigger can be recorded only once.

| Trigger | Key |
|---|---|
| Reminder | `task:<id>:reminder:<L>:<due_on>:<reopen count>` |
| Overdue escalation | `task:<id>:overdue:<due_on>:<reopen count>` |
| Due date set in the past | `task:<id>:past_due_set:<due_on>:<reopen count>` |
| Parent-deadline escalation | `task:<child id>:parent_deadline:<parent id>:<parent due_on>` |
| Risk review due / missed | `risk:<id>:review_due:<review_on>` / `risk:<id>:review_missed:<review_on>` |
| Unavailable assignee | `task:<id>:assignee_unavailable:<cause>:<cause id>` |
| Resumption summary | `project:<id>:resumed:<transition id>` |

An episode is (task, current `due_on`, number of reopenings). A new authorised due date or a reopening starts a new episode with its own schedule; earlier triggers and their history remain (D64). Reopening an already overdue task gives one escalation for the new episode, at the next slot, not a repeat of the old one.

### 4.7 What stops notices

No task notice fires for a task that is Completed or Cancelled, a task marked "Deadline review required", or a project that is not Active. Planned projects get no reminders, because their tasks cannot start yet. A Blocked task keeps its reminders and escalation (the deadline is not extended).

A trigger whose time fell while the project was Deferred or Closed is recorded as `skipped_paused` and never sent later (D23); the resumption summary (§5) covers what matters.

### 4.8 Catch-up after downtime

If the worker was down, the next sweep finds every trigger that came due. For each task only the latest reminder that is still relevant is sent; earlier reminders for that task are recorded `skipped_obsolete`. A reminder is no longer relevant once its task's deadline has passed. Everything that fires in one sweep is consolidated per recipient (§6), so a recipient gets one email, not a flood (Q02).

## 5. Recipients

| Trigger | Recipients |
|---|---|
| Reminder | The assignee. |
| Overdue escalation, assignee is a Member or Deputy PM | The PM. |
| Overdue escalation, assignee is the PM | Every Owner and Sponsor. |
| Overdue escalation, assignee is an Owner or Sponsor | Every other Owner and Sponsor and the PM. |
| Parent-deadline escalation | The PM; if the PM is the child's assignee, every Owner and Sponsor. |
| Due date set in the past | The assignee and the PM. |
| Risk review due / missed | The Risk Responsible Person and the PM; the PM alone when no one is responsible. |
| Unavailable assignee | The PM; if there is no Active PM, every Active Owner and Sponsor; if none of them is Active, every Active Enterprise Administrator, with minimal information only (project name and "a task needs reassignment", no task content). |
| Resumption summary | The PM and each assignee with outstanding work. |

Rules that apply to every row:

- A recipient is a person whose account is Active and who holds an Active role in the project today (for the Administrator fallback: an Active account with the Administrator role). This is checked when the trigger fires and again before every email attempt.
- When a person holds several of the roles the routing names, they are one recipient.
- **Escalation is never sent to the assignee alone.** Recipients equal to the assignee are removed. When nobody is left, no message is sent, the trigger is recorded `no_recipient`, and the project page shows **"No independent escalation recipient"** with the task, for as long as that episode is overdue. No recipient is invented and the Administrator is never used for escalation (§9 of the Consolidated Specification).
- **Unavailable assignee** fires when an open task's assignee no longer holds an Active role in the project (On Hold, expired, revoked) or the invitation the task is waiting on was declined, expired or revoked. The cause and its id (hold, membership or invitation) form the key, so each new cause alerts once.
- **Resumption summary** fires once when a Deferred or Closed project returns to Active (not on a first activation from Draft or Planned). Each recipient's summary lists, filtered to what that person can read: tasks still marked "Deadline review required", tasks overdue on their current date, and risks whose review date has passed. Missed reminders are not replayed (D24).

## 6. In-app notifications and consolidation

- Every recipient of a fired trigger gets one row in `notifications`: project, kind, a plain-language summary ("Reminder: 'Draft the tender' is due on Mon 17 Nov"), the record's link and `read_at`.
- **Bell.** Every signed-in page has a bell in the main header with the unread count (hidden when zero, capped as "99+"). It refreshes on navigation and every 60 seconds while the page is visible. Its accessible name includes the count ("Notifications, 3 unread").
- **Notifications page (`#/notifications`).** Newest first, 30 at a time with "Show more". Each entry shows the project, the summary, when it fired (UTC+8) and a link; "Mark read" per entry and "Mark all read". Opening the link marks the entry read.
- **Access at display time.** Each entry is shown with its summary only while the person can still read the project; otherwise it shows "You no longer have access to this project" and no detail.
- **Email.** All triggers that fire for one recipient in one sweep go into one email, grouped by project, one line per item with its link ("Kainow: 3 items need your attention"). Each trigger keeps its own history row, so separate triggers for the same task stay distinguishable (O12).
- **Content of every notice.** Project name, record kind, title, due or review date, and a link. A link grants no access. Notes, discussion, rationale, mitigation and evidence are never included. The Administrator fallback contains only the project name.

## 7. Email delivery

### 7.1 Providers

Chosen by deployment configuration (environment), never by a project:

| `EMAIL_PROVIDER` | Behaviour |
|---|---|
| `m365` | SMTP to `smtp.office365.com:587` with STARTTLS and XOAUTH2. The access token comes from the Microsoft identity platform's client-credentials flow (`M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET`, scope `https://outlook.office365.com/.default`) and is reused until shortly before it expires. `EMAIL_FROM` is the approved sender mailbox. |
| `smtp` | Today's `SMTP_URL` + `SMTP_FROM` (the existing variables keep working). |
| `log` | Development only; still needs `LOG_SIGN_IN_CODES=true`, as today. |

- Secrets stay in deployment configuration (A15's portable deployment-secret handling). They are never stored in the database, shown, logged or included in error details.
- The connection receives only what it needs (Q06): `INSTALL.md` documents registering the app, granting the Office 365 Exchange Online `SMTP.SendAsApp` permission, registering its service principal in Exchange and granting it send rights on the one sender mailbox only. No organisation-wide mailbox access is assumed.
- The Administrator's settings page shows the active provider, the sender address and the last delivery outcome, and has **Send test email** (to the Administrator's own address, through the outbox).
- Sign-in codes and other emails use the same provider.

### 7.2 Outbox

Every email except sign-in codes and the one-time setup invitation is written to `email_outbox` in the same transaction as the event that causes it, then sent by the worker:

- notification emails (§6), digests (§8) and the test email;
- the existing invitation, hold-alert and delegated-closure emails, which move from synchronous sending to the outbox and so gain retries and recorded delivery.

Sign-in codes and the setup invitation stay direct: someone is waiting, and resending the code is the retry.

Each row records the recipient (user and address), subject, the body as composed (text and HTML with the organisation's letterhead), kind, project, what started it (a person, a schedule, a trigger or a digest run) and its status. The composed body is never rewritten; later changes to a task do not alter an email already composed.

Statuses: `queued`, `sending`, `retry_wait`, `sent`, `failed`, `cancelled`, `uncertain`.

### 7.3 Attempts and retries (O04, C37)

- Before every attempt the worker checks again that the recipient is eligible (§5) and the email is still relevant (the task still open, the same due date and episode, the project still Active for project notices; a digest's project still Active). If not, the row becomes `cancelled` with the reason; it is not sent.
- A temporary failure (SMTP 4xx, connection failure, timeout, token service unavailable) moves the row to `retry_wait`. Retries are at 5 minutes, 30 minutes and 2 hours after the **first** failure: an initial attempt plus at most three retries. After the last one fails the row is `failed`.
- A permanent failure (SMTP 5xx, rejected address, rejected credential) makes the row `failed` at once, with a reason an Administrator can read ("The mail service rejected the sender's credentials").
- Every attempt is a row in `email_attempts` (append-only): attempt number, start, outcome, SMTP code and error class. Restarts never reset the count (A11).
- `sent` means the mail service accepted the message. It never means read or acknowledged.

### 7.4 Uncertain outcomes

When an attempt started but its outcome was never recorded (the worker stopped mid-send), the row becomes `uncertain` once that attempt has been `sending` for 10 minutes. An uncertain row is resent automatically **once**, at its next retry slot, and the attempt counts within the four. The history marks it "Possible duplicate: an earlier attempt may have been delivered". If that resend is also uncertain, the row stays `uncertain` and is not resent again automatically; an Administrator may choose **Resend**.

### 7.5 Delivery history

- Project delivery history (PM, Owner and Sponsor of the project): every outbox row for the project, newest first, with recipient name, kind, subject, created time, status, attempts and the last reason.
- Organisation delivery history (Administrators): every outbox row, including rows with no project. **Resend** for `failed` and `uncertain` rows creates a new linked row with a fresh attempt count, after the same eligibility and relevance checks.
- Failed delivery is never described as successful, and a delivery outcome never changes task or project state.

## 8. Action-item digests (D46, Action-Item Emails §4)

### 8.1 Manual digest

- PM, Owner or Sponsor of an Active project. **Send action-item email** on the project opens a preview of the sender's own copy, the number of recipients and the as-at time. Confirming builds one email per recipient at that moment.
- When the project has no open tasks the button is disabled with "Nothing to send: no open tasks".

### 8.2 Scheduled digest

- A project setting, off by default. When on: **daily** at a chosen UTC+8 time (HH:MM), sent on working days only in Working Days mode; or **weekly** on a chosen weekday at a chosen time, sent on the working day before when that day is not a working day.
- Sent by the first sweep at or after its time. Key `project:<id>:digest:<date>`, so it is sent once per due date.
- Not sent when the project has no open tasks, and not sent while the project is Deferred or Closed; nothing missed is sent on resume.
- Changing the schedule needs the "projects may change the digest schedule" delegation (§9) and is recorded like any other setting.

### 8.3 Recipients and content

- Recipients: people holding an Active project role today (PM, Deputy PM, Owner, Sponsor, Member), Active accounts only. Audit and Oversight grant holders do not receive digests. Eligibility is checked when the digest is built and again before every attempt.
- Content, built per recipient:
  1. **Your open tasks**, overdue first, then by due date.
  2. **Other open tasks in this project**, grouped by assignee, by due date within each group.
- Open means Not Started, In Progress or Blocked, tasks and subtasks. Each line: title, assignee, due date, status, an "Overdue" marker where applicable, a "Deadline review required" marker where applicable, and a link.
- The header names the project and "As at Mon 17 Nov 2026, 09:00 (UTC+8)".
- Never included: pending proposals, notes, discussion, decisions, questions or risks. A missing value stays visibly missing; nothing is filled in.

### 8.4 Record

`digest_runs` records the project, who or what started it (person or schedule), the as-at time and the recipient count; its outbox rows link to it, so delivery history shows each recipient's outcome.

## 9. Settings (Q01, C27–C37)

### 9.1 Organisation settings

Administrator only, under System Settings → Notifications and email:

| Setting | Default | Allowed values |
|---|---|---|
| Day counting | Working Days | Working Days or Calendar Days |
| Working weekdays | Monday–Friday | Any non-empty set of weekdays |
| Organisation holidays | None | Dated entries with a name |
| Reminder lead times | 7 and 1 days | 1 to 3 reminders, each 1–30 days, all different |
| Overdue escalation delay | 3 days | 1–10 days |
| Sweep interval | 15 minutes | 5–60 minutes |
| Projects may change the calendar | Off | On / Off |
| Projects may change the timings | Off | On / Off |
| Projects may change the digest schedule | Off | On / Off |

Fixed in this sub-project and shown read-only: 09:00 send time, date-only cutoff 23:59:59, once-per-episode escalation, routing, retry schedule and channels (in-app and email).

### 9.2 Project settings

Project page → Settings → Notifications. Everyone with read access to the project sees the effective values, each labelled "From the organisation" or "Set for this project". A PM, Owner or Sponsor may change a group only where the matching organisation switch is on:

- calendar: day counting, working weekdays, project holidays (additions to the organisation's list only);
- timings: reminder lead times, escalation delay;
- digest schedule (§8.2).

"Use the organisation's value" clears a project override. Turning a switch off keeps existing project values in force but makes them read-only (no setting is silently rewritten); the Administrator can clear them.

### 9.3 Preview, history and effect

- Every change asks for a reason and records actor, reason, field, old and new value and time in `notification_settings_changes` (append-only).
- Before saving a calendar or timing change, a preview lists the notices due in the next 30 days that would move (record, old time, new time) and those that would appear or disappear, with the line "Deadlines and review dates do not change." For an organisation change the preview covers projects that inherit the value.
- A change affects only triggers not yet recorded. Sent notices, skipped notices and their history are never recalculated (Reminders §9).

## 10. Permissions

All new actions follow existing matrix rows; none is new authority.

| Action | Authority |
|---|---|
| View and change organisation notification settings and holidays | Enterprise Administrator |
| View project notification settings | Anyone with current read access to the project |
| Change project notification settings | PM, Owner or Sponsor, where the matching organisation switch is on (Q01; otherwise read-only) |
| Send a manual digest | PM, Owner or Sponsor; Active project (Matrix §5) |
| View project delivery history | PM, Owner or Sponsor |
| View organisation delivery history; Resend; Send test email | Enterprise Administrator |
| Read and mark own notifications | The signed-in person (entries for projects no longer readable show no detail) |

## 11. Database and code

### 11.1 Migration `0020_notifications.sql` (additions only)

- `notification_settings`: one row (`id = 1`) with day counting, weekdays (`smallint[]`, ISO 1–7), lead times (`smallint[]`), escalation delay, sweep minutes, the three delegation switches, `updated_by`, `updated_at`; CHECK constraints for every bound in §9.1.
- `project_notification_settings`: `project_id` primary key; nullable overrides for day counting, weekdays, lead times and escalation delay; digest fields (enabled, frequency `daily|weekly`, weekday, time).
- `holidays`: id, `project_id` (null for organisation), date, name, added by/at, removed by/at; a unique current entry per scope and date.
- `notification_settings_changes`: append-only (scope, project, field, old, new, reason, actor, at).
- `notification_triggers`: id, `key` unique, kind, project, record kind and id, `fire_at`, `decided_at`, outcome (`sent`, `skipped_obsolete`, `skipped_paused`, `no_recipient`, `cancelled_ineligible`), recipients (`uuid[]`), detail (`jsonb`). Append-only.
- `notifications`: id, user, trigger, project, kind, summary, link, `created_at`, `read_at`; index on (user, `read_at`, `created_at`).
- `email_outbox`: as §7.2, with `first_failure_at`, `next_attempt_at`, `attempts`, `possible_duplicate`, `resend_of`; index on (status, `next_attempt_at`).
- `email_attempts`: append-only (outbox row, attempt number, started, finished, outcome, SMTP code, error class).
- `digest_runs`.
- Indexes the sweep needs on open tasks and risks (verified by the measurement in §12).

### 11.2 Code

- `app/src/notifications/calendar.ts`: pure working-day and firing-time functions (§3–§4).
- `app/src/notifications/settings.ts` + service + controller: effective settings, delegation, preview, history.
- `app/src/notifications/sweep.ts`: one sweep: load open tasks, risks, projects, settings and recent transitions; compute due triggers; for each, in its own transaction, insert the trigger (`ON CONFLICT (key) DO NOTHING` decides who fires it), resolve recipients, insert notifications and outbox rows. Also scheduled digests.
- `app/src/notifications/notifications.controller.ts`: list, unread count, mark read.
- `app/src/email/`: transports (`m365` XOAUTH2 with token cache, `smtp`, `log`), composition with the letterhead, the outbox writer used by every service, and the email worker.
- `app/src/digests/`: build, preview and send.
- `app/src/worker/`: register the sweep as a pg-boss schedule with a singleton key (so overlapping sweeps never run together), its interval read from the settings; register the email worker on the existing `email` queue.
- The existing `CodeSender` keeps `send` (sign-in codes) and `sendSetupInvitation`; invitations, hold alerts and delegated-closure notices are written through the outbox writer instead.
- Web: header bell, `#/notifications`, project Settings → Notifications, Send action-item email, project delivery history, the "No independent escalation recipient" flag, deadline mode and non-working-day warnings in task detail and the authorise, amend and deadline-review forms, Administrator notification and email settings and delivery history.

## 12. Errors, testing and measurement

### 12.1 Errors

- A sweep that fails part-way leaves every trigger it already recorded; the next sweep continues, and the unique key prevents repeats.
- A sweep still running when the next is due is not started twice (singleton).
- A provider outage leaves emails retrying on schedule; in-app notices already exist. Delivery never changes task, risk or project state.
- Missing or rejected email configuration fails the affected emails as `failed` with a plain reason, and the Administrator settings page shows it.
- Invalid settings are refused with a message naming the bound ("Each reminder must be 1–30 days before the due date").

### 12.2 Tests (`node:test`; one database test file at a time)

- **Calendar (pure, table-driven):** reminders over weekends and holidays and for non-working due dates; overdue examples (due Monday → Friday 09:00, due Friday → Thursday 09:00); Calendar Days; due date set in the past, with and without an immediate escalation; episodes on amendment and reopening; risk review due and missed, including a non-working review date; the next-slot rule.
- **Sweep (database, fake clock):** each trigger kind; every routing row, including Owner/Sponsor to other Owner/Sponsors and the PM, the PM as child assignee, and `no_recipient` with the project flag; Deferred skip and the resumption summary; "Deadline review required" suppression; catch-up consolidation after a gap; ineligible and obsolete cancellation; a rerun firing nothing twice; scheduled digests on working days and the weekly fallback.
- **Outbox (fake transport):** retry times measured from the first failure; permanent failure; attempt count kept across a restart; cancellation when eligibility or relevance changes; an uncertain send resent once and marked as a possible duplicate, then left for an Administrator; the XOAUTH2 token requested once and reused until near expiry. Microsoft 365 is never called by tests.
- **HTTP:** settings authority and delegation switches; bounds; preview; manual digest authority, content per recipient and Active-only; notifications list, unread count, mark read and the no-access display; delivery history visibility; Resend.
- **Existing emails:** invitations, hold alerts and delegated-closure notices now arrive through the outbox with the same content.
- **Web:** bell count and label, Notifications page states, settings form (effective value labels, read-only without delegation), digest preview.
- **Names:** every invented name in tests and seed data is checked to be fictitious; no real organisation name or acronym (see the no-organisation-names rule).

### 12.3 Measurement

Before claiming the sweep is cheap, it is timed on a seeded realistic dataset (200 users, 300 projects, 30,000 open tasks and subtasks, 3,000 risks, a year of holidays) with query plans recorded. The aim is **under 2 seconds per sweep**. The results, met or missed, are written into this section before the work is reported done.

## 13. Out of scope

- Specific-time deadlines (tasks stay date-only).
- Personal opt-outs from notifications (none is specified).
- Repeated escalation after the first per episode, and other escalation sequences: configurable in the documents, but no bounds are approved.
- Editable send time (09:00), date-only cutoff and routing.
- Graph API sending and other email providers.
- Moving sign-in codes and the setup invitation into the outbox.
- Notifications about discussion, proposals, questions or decisions (sub-project 4 and later add their own).
- Leadership and Administrator dashboards (sub-project 7); this sub-project adds only the project-page flag.
