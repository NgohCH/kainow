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
| Notice email timing | Each person chooses, per project, how notice emails reach them (§6.1). Default: one email a day per project, urgent notices immediately. Choices: daily with urgent immediately, every notice immediately, daily only, off (in-app only). Decided 10 November 2026. |
| Personal holidays | Each person may record away dates; no notice emails or digests reach them on those dates, and the daily email after their return catches up. Escalations addressed to someone away (or with email off) also go to the next people in the routing (§5). Decided 10 November 2026. This is a Product Owner decision beyond Reminders §8 ("no personal opt-out policy … is established by this document"); in-app notices remain for everyone. |

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

If the worker was down, the next sweep finds every trigger that came due. For each task only the latest reminder that is still relevant is sent; earlier reminders for that task are recorded `skipped_obsolete`. A reminder is no longer relevant once its task's deadline has passed. Email is then consolidated per recipient and project according to each person's choice (§6.1), so nobody gets a flood (Q02).

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
- **Cover while away or with email off.** When a recipient of an overdue escalation, a parent-deadline escalation or an unavailable-assignee alert is away (§6.1) on the day it fires, or has chosen "Off" for the project, the notice also goes to the next people in its routing who are not away: PM → every Owner and Sponsor; Owner or Sponsor → the PM and the other Owners and Sponsors; cover never adds the task's assignee and never adds the minimal Administrator fallback. The covering recipients are recorded on the trigger. If everyone in the chain is away or off, nobody extra is added; the original recipients still get the in-app notice.
- **Resumption summary** fires once when a Deferred or Closed project returns to Active (not on a first activation from Draft or Planned). Each recipient's summary lists, filtered to what that person can read: tasks still marked "Deadline review required", tasks overdue on their current date, and risks whose review date has passed. Missed reminders are not replayed (D24).

## 6. In-app notifications and consolidation

- Every recipient of a fired trigger gets one row in `notifications`: project, kind, a plain-language summary ("Reminder: 'Draft the tender' is due on Mon 17 Nov"), the record's link and `read_at`.
- **Bell.** Every signed-in page has a bell in the main header with the unread count (hidden when zero, capped as "99+"). It refreshes on navigation and every 60 seconds while the page is visible. Its accessible name includes the count ("Notifications, 3 unread").
- **Notifications page (`#/notifications`).** Newest first, 30 at a time with "Show more". Each entry shows the project, the summary, when it fired (UTC+8) and a link; "Mark read" per entry and "Mark all read". Opening the link marks the entry read.
- **Access at display time.** Each entry is shown with its summary only while the person can still read the project; otherwise it shows "You no longer have access to this project" and no detail.
- **Email.** Notice emails are one per person per project, timed by that person's choice (§6.1), one line per item with its link ("Kainow: 3 items need your attention in <project>"). Each trigger keeps its own history row, so separate triggers for the same task stay distinguishable (O12).
- **Content of every notice.** Project name, record kind, title, due or review date, and a link. A link grants no access. Notes, discussion, rationale, mitigation and evidence are never included. The Administrator fallback contains only the project name.

### 6.1 Email preferences and personal holidays

Each person sets these for themselves in an **Email preferences** section of the Notifications page (no separate user-settings page, §11 of the Consolidated Specification). Nobody else can change them.

| Choice (per project) | Behaviour |
|---|---|
| **Daily, urgent immediately** (default) | One email at the 09:00 slot on the project's working days, listing every non-urgent notice for that project not yet emailed. Urgent notices go out at the sweep that fires them, one email per project per sweep. |
| **Every notice immediately** | One email per project per sweep that fires anything for the person. |
| **Daily only** | Everything, urgent included, waits for the 09:00 email. |
| **Off** | No notice emails for this project; in-app only. Nothing is caught up later. Cover (§5) applies. |

- **Urgent** notices: overdue escalation, parent-deadline escalation, due date set in the past, unavailable assignee. Not urgent: reminders, risk review due and missed, the resumption summary.
- **Away dates.** A person records date ranges (start and end date, UTC+8, optional note visible only to them). On an away date no notice email and no digest is sent to them; in-app notices still appear. The first daily email due after the away period includes every notice not yet emailed (for "Every notice immediately", the first sweep after the period sends that catch-up). Cover (§5) applies to escalations and alerts while away. Away dates never change deadlines, roles or access.
- A notice is emailed once: each `notifications` row records the outbox email that carried it.
- A change to a preference or away dates takes effect from the next sweep and is recorded with the time (no reason needed; it is the person's own setting).
- Digests (§8) are not affected by these choices except away dates.

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
| Set own email preferences and away dates | The signed-in person, for projects where they hold a role |

## 11. Database and code

### 11.1 Migration `0020_notifications.sql` (additions only)

- `notification_settings`: one row (`id = 1`) with day counting, weekdays (`smallint[]`, ISO 1–7), lead times (`smallint[]`), escalation delay, sweep minutes, the three delegation switches, `updated_by`, `updated_at`; CHECK constraints for every bound in §9.1.
- `project_notification_settings`: `project_id` primary key; nullable overrides for day counting, weekdays, lead times and escalation delay; digest fields (enabled, frequency `daily|weekly`, weekday, time).
- `holidays`: id, `project_id` (null for organisation), date, name, added by/at, removed by/at; a unique current entry per scope and date.
- `notification_settings_changes`: append-only (scope, project, field, old, new, reason, actor, at).
- `notification_triggers`: id, `key` unique, kind, project, record kind and id, `fire_at`, `decided_at`, outcome (`sent`, `skipped_obsolete`, `skipped_paused`, `no_recipient`, `cancelled_ineligible`), recipients (`uuid[]`), detail (`jsonb`). Append-only.
- `notifications`: id, user, trigger, project, kind, `urgent`, summary, link, `created_at`, `read_at`, `outbox_id` (the email that carried it, if any); index on (user, `read_at`, `created_at`) and on (user, project) where `outbox_id IS NULL`.
- `email_preferences`: (user, project) primary key, choice (`daily_urgent_immediate`, `immediate`, `daily`, `off`), `updated_at`; no row means the default.
- `away_periods`: id, user, `starts_on`, `ends_on`, note, `created_at`, `removed_at`.
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
- **Preferences:** each of the four choices; urgent versus non-urgent timing; away dates suppressing notice emails and digests and the catch-up on return; cover to the next routing recipients while away or off, and no extra recipient when the whole chain is away.
- **Web:** bell count and label, Notifications page states, settings form (effective value labels, read-only without delegation), digest preview.
- **Names:** every invented name in tests and seed data is checked to be fictitious; no real organisation name or acronym (see the no-organisation-names rule).

### 12.3 Measurement

Before claiming the sweep is cheap, it is timed on a seeded realistic dataset (200 users, 300 projects, 30,000 open tasks and subtasks, 3,000 risks, a year of holidays) with query plans recorded. The aim is **under 2 seconds per sweep**.

#### Measured results (10 November 2026)

Measured with `app/src/notifications/sweep-bench-cli.ts` (`node dist/notifications/sweep-bench-cli.js`; it refuses to run unless the database is named `kainow_test`, resets it, seeds it and runs `Sweep.run()`). Environment: PostgreSQL 16.15 in a Docker Desktop `postgres:16` container on a Windows 11 developer laptop (16 logical cores), Node 24, reached over the loopback port. This is not production hardware; a trivial `SELECT 1` costs 0.6 ms per round trip here, which matters below.

Data: 200 users, 300 Active projects (a PM, an Owner and 3 to 6 Members each, 1,950 memberships), 30,000 open tasks and subtasks (6,000 of them subtasks) with due dates spread from 60 days before to 60 days after Tuesday 10 November 2026, 31,478 task events (an authorisation for each task and a reopening for about 5%), 3,000 risks with review dates spread the same way, 84 holidays (the organisation's across 2026, plus three project holidays in 20 projects), 55 project overrides (day counting, lead days, escalation delay, 10 daily digests), 200 email preferences and 8 away periods. `ANALYZE` was run after seeding. The clock was fixed at 09:30 UTC+8, so the 09:00 slot work happens.

| Run | Before (as first built) | After the change below |
|---|---|---|
| Cold: the first sweep over all of that history (catch-up) | 392.5 s (54,071 triggers, 26,345 notifications, 1,605 emails) | 405.8 s (the same counts) |
| Warm, same clock, five runs | 6.4 to 8.5 s (median 7.0 s) | 0.89 to 1.16 s (median 1.09 s) |
| 15 minutes later, twice (nothing new is due) | 7.5 s and 6.4 s | 1.10 s and 1.09 s |
| Repeat of the whole benchmark after the final edits (cold; warm five times; +15 minutes twice) | not run | 383.2 s; warm 0.56 to 0.81 s (median 0.56 s); +15 minutes 0.57 s twice |

The two "after" runs differ because the laptop was busier during the first; both are under 2 seconds.

**The aim of under 2 seconds per sweep is met for a normal sweep (0.6 to 1.1 s), but was missed as first built (about 7 s).** The cause was not slow query plans: every per-project query ran in about 1 ms on the server using the existing indexes (`tasks_open_sweep_idx`, `risks_review_sweep_idx`, `task_events_task_idx`, the unique key index on triggers). The time went to about 5,000 database round trips per sweep (about 16 for each of 300 projects, including the settings, holidays and recorded keys read twice) and to about 1.3 s of date-string conversion in the working-day calendar. The change, with behaviour and results unchanged (the cold run recorded the same counts of triggers, notifications and emails before and after: 54,071, 26,345 and 1,605; the individual trigger keys were not compared):

- The sweep reads settings, holidays, open tasks (with the invitation facts), risks, memberships, away dates, email preferences and project transitions for all Active projects in about ten queries per sweep instead of about sixteen per project.
- It plans every project, then asks once, with a set-based anti-join, which of the due keys are not recorded yet (about 0.1 s for 54,000 keys), instead of sending each project's keys separately.
- The calendar memoises its date conversions.

No index was needed, so there is no new migration. The plans below are from `EXPLAIN (ANALYZE, BUFFERS)` on this dataset after the cold run; they can be reproduced with `node dist/notifications/sweep-bench-cli.js --plans-only` (the full run prints them too).

| Read (once per sweep) | Plan | Execution |
|---|---|---|
| Open tasks of all 300 projects, with invitation join, last due-date event and reopen count (30,000 rows) | Index scan on `tasks_open_sweep_idx`; nested loop left join to `invitations` (empty); two index probes per task on `task_events_task_idx` (a backward scan for the latest event, a scan for reopenings); incremental sort by project and id | 181 ms |
| Open risks of all projects (3,000 rows) | Sequential scan of `risks` (the table is small, so the planner prefers it to `risks_review_sweep_idx`), sort | 2.6 ms |
| Which due keys are not recorded: 54,081 keys sent at once | Hash anti join of the unnested keys against a sequential scan of `notification_triggers` (a 169-key project alone uses a nested loop anti join with an index-only scan on `notification_triggers_key_key`, 0.8 ms) | 37 ms |
| Mail candidates: every notification not yet emailed (1,032 rows) | Bitmap index scan on `notifications_unsent_idx`; hash joins to `notification_triggers` (sequential scan), `projects` and `users`; merge join to `email_preferences`; incremental sort | 15 ms |

Settings, holidays, memberships, away dates and transitions are small reads (a few milliseconds each) and are not tabulated. Where the time goes in a warm sweep is the 0.2 s task read, the roughly 0.04 s anti-join, the transfer of 30,000 task rows to the application and the planning of every project in it; a profile of one instrumented warm run of 0.65 s showed 0.47 s inside database calls.

**The cold catch-up is slow and is disclosed here.** The first sweep over this dataset took about 6.5 minutes, because it recorded 54,071 triggers and 26,345 notifications, each trigger in its own transaction (several round trips each, about 7 ms per trigger here). That is the worst case: an installation that starts sweeping with a hundred and twenty days of overdue and reminder history for 30,000 tasks. A normal catch-up after a few days down is a small fraction of it (the sweep tests exercise one). Batching the writes of a project into one transaction would shorten it, at the cost of recording a project's triggers all or nothing; it was not done because it changes the atomic unit and no approval for that is recorded. If the one bulk load at the start of a sweep fails, that sweep skips its project work and its scheduled digests with a fixed warning and the next sweep catches up (a digest is keyed by date, so none is lost or sent twice). Other things still scale with history and are worth watching: the single task read returns every open task, the anti-join sends a key for every due trigger of every open task, and `mailDue` reads every notification not yet emailed (about 1,000 here, 14 to 88 ms). Each is linear and measured fast at this size.


## 13. Out of scope

- Specific-time deadlines (tasks stay date-only).
- Repeated escalation after the first per episode, and other escalation sequences: configurable in the documents, but no bounds are approved.
- Editable send time (09:00), date-only cutoff and routing.
- Graph API sending and other email providers.
- Moving sign-in codes and the setup invitation into the outbox.
- Notifications about discussion, proposals, questions or decisions (sub-project 4 and later add their own).
- Leadership and Administrator dashboards (sub-project 7); this sub-project adds only the project-page flag.
