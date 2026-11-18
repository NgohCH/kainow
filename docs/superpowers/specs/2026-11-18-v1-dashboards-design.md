# V1.0 sub-project 7: dashboards and analytics — personal, project, leadership and Administrator — design

**Date:** 18 November 2026
**Status:** Approved by the Product Owner on 19 November 2026, including the D90 bounds, the bench aims and the leadership risk descriptions. Scope, focus and approach were agreed section by section in conversation on 18 November 2026.
**Builds on:** branch `TheLord/subproject-7-design-7fdf29`, cut from the sub-project 6 branch `TheLord/amazing-gates-323bc6` (head ede3479, not yet pushed). Rebase onto `main` once sub-projects 5 and 6 merge. Next migration: `0029_dashboards.sql`.
**Authority:**
- Intent Card principles 4, 5 and 8, and its "Included in V1.0" dashboard line.
- Product Summary §6 (O14 leadership information), §10 (progress), §12 and §19.
- Consolidated Specification:
  - §11 and §13 (dashboard appearance, retention);
  - D48, D49, D50 and D57;
  - O02 (archive), O04, O14, O15, Q01 and Q04;
  - A12 and A16.
- Dashboards, Progress, Timeline and Settings Rules (all sections).
- Administrator Analytics and Reporting Rules (all sections).
- Permission Matrix §5 rows "View personal/project dashboard" and "View/configure own leadership summary layout", §1 row "Grant leadership summary scope", and §8.
- Configuration Catalogue C04, C58, C59, C60 and C64.
- UI, Navigation and Accessibility Requirements §2, §3 and §8.
- Remaining Design and Verification Register R11 (in part), R17 and R18 (in part).
- The sub-project 5 design (`2026-11-16-v1-history-deletion-design.md`), whose Deleted and held filters every figure here uses.
- The sub-project 6 design (`2026-11-18-v1-ai-configuration-design.md` §7.4), whose AI usage views are linked, not rebuilt.
- The new decisions D88–D90 below.

## 1. Purpose and the why

The Intent Card's purpose ends: "Everyone can then see who is responsible, what is due and what happened." Sub-projects 1–6 record all of that, but today a person sees it one project at a time. The home page is a list of projects with an open-task count. There is no view of a person's own work across projects, no task-completion figure, no timeline, no leadership summary and no organisation-wide view of how projects are going.

Sub-project 7 adds four views, each limited to what the viewer may currently see:

1. **Personal dashboard** (the new home page): what needs me, my tasks across projects, and my projects.
2. **Project dashboard and timeline**: a fuller Overview tab and a new Timeline tab.
3. **Leadership summary**: a cross-project summary for people the Administrator explicitly grants it to, by organisation, department or named projects.
4. **Administrator analytics**: answers the Product Owner's two questions for an Administrator: *how are projects progressing against their timeline?* and *what issues need attention?* It covers both project problems and system problems.

It also adds limited personal display controls, a versioned event catalogue, CSV export of analytics tables, and an Administrator settings tab for three access settings that are still fixed in code.

### Goals

- Every figure is worked out from the live authoritative records at the moment it is asked for. Deleted items and held items whose credential is not yet cleaned never appear, and are never counted.
- One shared module defines every measure (task completion, On-time completion, stage duration, overdue, and the others). Every view and every export uses it, so the same project shows the same figure everywhere.
- Each view shows only what its viewer may see: participants see their projects; leadership grant holders see summary fields for their scope; Administrators see counts, and record lists only where they are also participants.
- Missing data is labelled ("Progress not yet measurable", "Nothing due yet", "No planned end date", "Not provided"), never shown as zero or as healthy.
- Every view shows when it was worked out ("Updated 10:42 UTC+8") and what each measure means.
- Personal controls change presentation only, work by keyboard without dragging, keep contrast at WCAG 2.2 AA, and can never hide "Needs you", warnings or the AI-proposed marking.

### Non-goals (7)

- Resource and budget figures. Sub-project 8 adds them to the project dashboard, the leadership field catalogue and the Administrator panels. This sub-project leaves a named place for them (§6.3, §7.2) but shows nothing there.
- Backup, restore and storage health panels. These belong to operations (sub-project 10), which adds them to Administrator analytics.
- Exports other than CSV of analytics tables, and filing exports in external storage (sub-project 9).
- A Gantt chart, inferred start dates, dependencies, weighted progress, or any formula the Administrator writes (Dashboards rules §2 and §4; Administrator Analytics rules §4).
- A copy of the events in a separate analytics store, and snapshot tables (approach A, §2).
- Named-person activity figures for the Administrator other than the AI usage that O14 already allows.
- A separate user settings page (Consolidated Specification §11).

### Anti-goals (failure even if it works)

- A count, label, filter option, collapsed header or chart that reveals anything the viewer may not read: a Deleted or uncleaned held item, a restricted source or meeting, a private AI question, or a project outside a leadership grant's scope.
- A leadership grant, analytics access or a saved display choice that opens project content, discussions, minutes, quotes or management actions.
- The same project showing different task-completion figures in two places.
- A missing value shown as 0%, 100% or a healthy colour.
- A personal choice that hides an essential warning, "Needs you", or the dashed "AI proposed" distinction.
- A settings change that silently changes existing invitations or grants, or silently archives or unarchives projects without a preview.

## 2. Decisions taken with the Product Owner

| Topic | Decision (18 November 2026) |
|---|---|
| Size | One sub-project, not split into 7a and 7b. |
| Settings | Include an Administrator settings tab for the three access settings still fixed in code: automatic archive delay, Audit/Oversight grant length, invitation validity (§9). |
| Leadership scope | A grant covers the whole organisation, one or more departments' owned projects (now and later), or named projects (D89). |
| Personal, project, timeline and leadership dashboards | As played back: §4, §5 and §6. |
| Administrator analytics focus | Project progress against timeline, and issues: both project problems and system problems, in separate panels (§7). |
| Timeline measure | On-time completion (D88), shown on the project dashboard, the leadership summary and Administrator analytics. |
| Approach | A: work every figure out from the live records on each request. Not B (a new single event table with an extra write on every action: dozens of write paths touched, old data to copy in, a second copy of the truth that could miss a writer or keep Deleted content) and not C (snapshots: minutes stale, and every deletion, hold or access change would also have to correct the snapshots). If the load aim in §14 is missed, a snapshot for trends alone may be added later without changing anything else. |

### 2.1 New Decision Register entries

| ID | Decision |
|---|---|
| D88 | **On-time completion** (18 November 2026). Alongside Task completion, dashboards show On-time completion: of the eligible leaf tasks whose due date has passed (due date before today, UTC+8), the share that are Completed. It is shown as "32 of 40 tasks due so far are done (80%)". Tasks completed after their due date count as done; the drill-down shows how many finished late. Tasks awaiting deadline review are left out and counted separately. With none due yet it reads "Nothing due yet". For a Deferred project it is worked out as at the day it was deferred, and for a Closed project as at the day it closed. It measures meeting due dates, not delivering the project's outcome. |
| D89 | **Leadership summary scopes** (18 November 2026). An Enterprise Administrator grants leadership-summary access to a named person, with a reason, a start date, an optional end date and one scope: the whole organisation; one or more departments, covering every project each owns now or later; or one or more named projects. The grant screen states that a department scope "includes projects this department owns now and later". The grant shows the approved summary fields only, never project content, discussions, minutes, quotes or management actions, and gives no project access. An Administrator cannot grant leadership access to themselves. Revoking ends access at once. |
| D90 | **Access-setting bounds** (18 November 2026). The Enterprise Administrator sets, with a reason: automatic archive delay 1–60 months (default 12); Audit/Oversight default grant length 1–90 days (default 30) and maximum length per grant or extension 1–365 days (default 90; the default length may not exceed it); invitation validity 1–30 days (default 7). A change applies to invitations sent and grants requested or extended afterwards. A change to the archive delay shows, before saving, which Closed projects would be archived or unarchived at once, and applies to all Closed projects once saved. The numeric bounds were proposed by this design and approved by the Product Owner on 19 November 2026 (Consolidated Specification §13: unspecified bounds are not unlimited). |

### 2.2 Open questions from earlier sub-projects this touches

- The records design (2a) and the roles-completion design deferred "the settings screens" to sub-project 7. The delegated project settings that exist today (approvals, analysis, notifications, calendar, AI) already have screens. This sub-project adds only the three Administrator access settings above. The other settings in the Configuration Catalogue that have no screen yet stay where they are; §15 lists them.
- The reminders design (3) left the leadership and Administrator dashboards to this sub-project and added only the project-page "No independent escalation recipient" flag. That flag is now also counted in Administrator analytics.

## 3. Concepts and shared measures

All measures live in one server module, `app/src/dashboards/measures.ts` (pure functions plus SQL fragments), and one web helper for labels. Every view and the CSV export call them. Each measure has a definition text, which is shown in the "About these figures" notes and on the Definitions page.

**Common filters, applied to every count:**
- Projects: never the Deleted or held filters (projects are not deleted); archive state from `archiveState`.
- Records: `liveRecordSql` from sub-project 5 (Deleted excluded; held records counted only once cleaned, as work views already do). Titles and descriptions shown on a dashboard use the same rule, so a cleaned held record shows "Credential removed — under review", as elsewhere.
- Today is `todayUtc8`. All dates and times are shown in UTC+8.

| Measure | Definition |
|---|---|
| Eligible leaf task | An authorised task (a row in `tasks`) with no live subtasks, not Cancelled, passing the record filter. A parent whose subtasks are all Deleted counts as a leaf. |
| Task completion | Completed eligible leaf tasks ÷ eligible leaf tasks × 100, shown as "62% task completion (31 of 50 tasks)". Cancelled leaf tasks are shown separately ("4 cancelled"). With no eligible leaf tasks: "Progress not yet measurable". An overridden parent completion changes nothing, since only leaves count. |
| On-time completion | D88. Due so far = eligible leaf tasks with `due_on` before the reference day and no deadline review pending. Done = those Completed. Late = Done whose completion day (UTC+8) is after `due_on`. The reference day is today, or the deferral day for Deferred projects, or the closing day for Closed ones. With nothing due: "Nothing due yet". "Awaiting deadline review: n" is shown beside it when n > 0. |
| Overdue | The existing `taskIndicators` rule: not Completed or Cancelled, `due_on` before today, no deadline review pending. All tasks (not only leaves) are listed; counts are of tasks. |
| Blocked | Tasks with status Blocked. |
| Due soon | Not finished, due today to today + 7 days. |
| Stage and stage duration | The open `project_stage_periods` row: stage, substage and whole days since `started_at`, as the existing Overview shows (`stageDuration`). |
| Planned end | Days from today to the project's planned end date, "Ended n days ago" when past, or "No planned end date". |
| Open questions | Questions Open or Answered. |
| Risks | Open or Mitigating risks by severity. "Significant" = High or Critical. Overdue review = Open, Mitigating or Accepted with `review_on` before today. |
| Vacant required role | The existing missing-role flag (D03). |
| Escalations | Open escalation flags (`escalation-flags`), and the "No independent escalation recipient" flag. |
| Pending invitations | Invitations Invited and not expired. |
| Refresh time | The time the server worked the figures out. Every response carries `computedAt`. |

Every view states coverage in its "About these figures" note: "Counts all authorised records in the project except deleted ones and any under credential review." No view is ever limited to part of a project's records for an ordinary participant, because records have no audiences. Where a view is limited (an Administrator who is not a participant sees counts but not lists), the view says so in words (§7.3).

## 4. Personal dashboard

Route `#/` (replaces "My Projects"; "My Projects" stays as the section name). Endpoint `GET /dashboard/me`. Sections, in this default order:

### 4.1 Needs you

Items waiting for the viewer's own action, across their projects, each with project name, what it is, since when and a link:
- **Approvals:** pending `change_requests` (every kind, including `authorise_proposal`, `deadline_review`, `reconcile_completion` and `risk_handover`) that the viewer may approve now and has not already approved. Eligibility uses the existing approval check, not a copy of it.
- **Minutes submissions** waiting for the viewer's review, where they may publish.
- **Questions to resolve:** questions the viewer requested whose status is Answered.
- **Possible credential copies** to confirm or dismiss (PM and Deputy), as a count with a link (never the text).
- **Deadline review** to prepare, for a PM or Deputy of a Deferred or Closed project that has one open.

"Needs you" cannot be hidden or moved below other sections. With nothing waiting it reads "Nothing needs you right now."

### 4.2 My tasks

Tasks assigned to the viewer in projects whose content they may read today (`canReadContent`: an Active membership), grouped Overdue, Due in the next 7 days, Later, and Awaiting deadline review. Each row: title, project, due date (with "overdue n days" where it applies) and status. *Design call:* tasks in projects where the viewer's membership is Scheduled, On Hold, Expired or Revoked are not listed, because the viewer cannot read that project's content. The "Awaiting membership" indicator therefore never appears here; it stays on the project's Work tab for its managers. "Needs you" uses the same rule. Completed and Cancelled are not listed. A "Show completed (last 30 days)" toggle is saved as a preference.

### 4.3 My projects

Every project the viewer can see today (as `GET /projects` does: participant roles and active Audit/Oversight grants), excluding archived projects unless "Include archived" is ticked. Each project is a section:
- **Header (always visible):** name, status, stage and days, task completion, and attention flags: overdue count, blocked count, missing required role, No independent escalation recipient, deadline review required. A project where the viewer's own membership is On Hold shows only its name and "Your membership is on hold", as `GET /projects` does today, and no figures (*design call*).
- **Expanded:** the viewer's roles or grant, owning department, On-time completion, planned end, open questions, significant risks count, next due task date, and a link to the project dashboard.

More than five projects shown: sections collapsed by default; five or fewer: expanded. A saved choice for a project always wins. A newly visible project with no saved choice uses the default for the current count. Changing filters never resets saved choices. Expand all and Collapse all set and save every shown project.

A grant holder (Audit/Oversight) sees the header and summary figures for the granted project, as `project.view` allows today.

## 5. Project dashboard and timeline

### 5.1 Overview (project dashboard)

The existing Overview tab (`GET /projects/:id`, which keeps its current fields) gains a figures block from `GET /projects/:id/dashboard`, available to anyone with `project.view`:
- Task completion with the leaf counts and cancelled count; On-time completion with done, late and awaiting-review counts.
- Status, stage, substage and days in stage (as today), and planned end.
- Overdue, blocked and due-soon counts, each linking to the Work tab filtered to those tasks.
- Pending invitations count (PM, Deputy, Owner, Sponsor see the names; others see the count).
- Decisions: Active count and the five most recent.
- Questions: Open and Answered counts and the five oldest open.
- Risks: a severity table of Open and Mitigating counts, the significant ones listed, and overdue reviews.
- Attention flags as today (missing role, No independent escalation recipient, deadline review).
- "Last updated" and "About these figures".

A compact horizontal bar shows task completion, with the numbers in text beside it and a visually hidden sentence for screen readers. The risk severity counts are a small table, not a pie chart.

### 5.2 Timeline tab

New tab `#/projects/<id>/timeline`, endpoint `GET /projects/:id/timeline?from=&to=` (default: three months back to six months ahead), for anyone with `project.view`. A dated list grouped by month, newest month at the bottom, with a "Today" marker:
- stage periods (start and end, with duration);
- status transitions (Planned, Active, Deferred, resumed, Closed, reopened) and archive or unarchive;
- task due dates (one line per date: "3 tasks due", expandable to titles), with completion where done;
- risk review dates;
- the planned end date.

It shows only recorded dates. It never draws bars between dates, infers start dates or shows dependencies. Filters: show or hide each kind of line (saved as a preference).

## 6. Leadership summary

### 6.1 Grants (D89)

- New table `leadership_grants` and append-only `leadership_grant_events` (§12).
- Managed only by an Enterprise Administrator on a new **System Settings › Leadership** tab: grant (person, scope, start date, optional end date, reason), change end date (reason), revoke (reason). The list shows each grant's state: Scheduled, Active, Ended or Revoked.
- The person must be an Active account. A grant to oneself is refused.
- Account disablement blocks the grant, as for other grants. Expiry ends access at 00:00 UTC+8 after the last day.
- A grant gives no project access. `ProjectAccess` and `canReadContent` are unchanged, and the matrix gains no actions for leadership holders.
- Department scope covers projects whose owning department is in the scope, at the moment of each request. If a project's owning department is transferred, it leaves or joins the scope at once.

### 6.2 The summary view

Route `#/leadership`, shown in the main menu as "Leadership" only to someone with an Active leadership grant. Endpoint `GET /dashboard/leadership`. Projects in scope (default filter: Planned, Active and Deferred; options: Draft, Closed, Include archived; department filter within scope) as collapsible cards, with the same five-project rule and saved choices as §4.3. Each card shows the viewer's chosen fields from §6.3. With more than one grant, the union of scopes applies.

A leader whose grant scope also covers projects where they are a participant sees the same summary card; their participant view stays in "My projects".

### 6.3 Leadership field catalogue (C60)

Default fields (all shown by default, rearrangeable and hideable except name and refresh time):
- name; owning department; contributing departments; PM name;
- status; stage, substage and days in stage;
- task completion; On-time completion; planned end;
- overdue count; blocked count;
- significant risks: counts of open High and Critical risks, plus each one's description cut to 120 characters (risks have no separate title), severity and review date;
- next dates: the next task due date and the next risk review date;
- attention flags: missing required role, No independent escalation recipient, deadline review required;
- refresh time.

The catalogue is a fixed list in code (`leadership-fields.ts`). Sub-project 8 adds resource and budget summary fields. Leaders cannot add fields that are not in the catalogue. No field links into project content; the card links to the project only if the viewer can already see it.

## 7. Administrator analytics

Route `#/admin/analytics` (a new "Analytics" item in the Administrator menu). Requires the existing organisation permission `audit.view`, renamed in code to `analytics.view` and given to `enterprise_administrator`.

### 7.1 Filters

Period (This month, Last month, Last 4 / 12 / 26 / 52 weeks; default Last 12 weeks), department, project status (default Planned, Active, Deferred), owned or contributed, Include archived. The period affects trends and "in the period" counts; current-state panels (progress, problems) always show now.

### 7.2 Panels (default order)

1. **Project progress.** One row per project: name, owning department, status, stage and days, task completion, On-time completion (with late count), planned end, overdue, blocked. Sortable columns. A bar chart of On-time completion per project, with the table as its equivalent; projects with "Nothing due yet" are listed under the chart, not drawn as zero. Department roll-up rows above the projects: each project counts once, under its owning department; "Also contributes to" lists other departments' projects separately without adding them to totals.
2. **Project problems.** Organisation totals, then per department and per project: overdue tasks, blocked tasks, open High and Critical risks, overdue risk reviews, vacant required roles, open escalations, No independent escalation recipient, deadline reviews pending, invitations expired in the period.
3. **System problems:**
   - emails: failed and uncertain in the period, and now waiting to retry (`email_outbox`);
   - AI: Active projects whose analysis would be Blocked now, by reason (sub-project 6 readiness), and connections in Key rejected;
   - jobs: pg-boss jobs failed in the period, by queue, and jobs waiting longer than 15 minutes;
   - security: credential cases awaiting review (count only) and "protected key not installed".
   Each line links to the screen where the Administrator can act (AI settings, security review, and so on).
4. **Trends (weekly, weeks start Monday 00:00 UTC+8).** Tasks authorised, completed and became overdue; proposals authorised and rejected; projects moving into Active, Deferred and Closed. A simple line or bar chart per measure with an equivalent table. *Design call:* trends are worked out from the records as they are now. "Became overdue" places a task in the week of the day after its current `due_on`, if it was not Completed or Cancelled by then (`completed_at`, or the cancellation event). Earlier due dates changed by amendment are not reconstructed. Records Deleted since then drop out of past weeks. The panel's "About these figures" says: "Trends are worked out from current records: changed due dates use the current date, and deleted records are left out of past weeks."
5. **AI usage.** A link to the existing organisation usage view (sub-project 6); its figures are not repeated.

Sub-project 8 adds a resources and finance panel; sub-project 10 adds a backups and storage panel.

### 7.3 Drill-down

Organisation → department → project, as counts. At project level:
- If the Administrator is an active participant in that project or holds an active grant there, the drill-down lists the underlying tasks or risks (titles, assignees, dates) with links, under the same rules as the project's Work tab.
- Otherwise the panel shows counts only and says: "Only counts are shown: you are not a participant in this project."
- Named-person rows appear only in the AI usage view, as O14 already allows.

Every drill-down request rechecks access on the server.

### 7.4 Configuration and saved views

An Administrator may show, hide and reorder panels and columns, switch each chart between chart and table, and save named views (filters plus layout) for themselves (`analytics_views`). A saved view never widens what is shown. "Reset" returns to the defaults.

### 7.5 Definitions page

`#/admin/analytics/definitions` lists every measure (§3) with its definition and version, and the event catalogue (§10).

### 7.6 Export

Every table in the analytics page has "Download CSV", `GET /admin/analytics/export?panel=&...filters`. The request rechecks the permission and the organisation setting `analytics_export_allowed` (default on, §9) and builds the file from the same measures at that moment. The first lines of the file, each starting with `#`, state the panel, filters, period, measure definitions version, `computedAt` (UTC+8) and coverage. The export is recorded as an `analytics.exported` audit event with the panel and filters (no data). Cells that start with `=`, `+`, `-` or `@` are prefixed with `'` against formula injection. Synchronous: no background job, so no stored file outlives access.

## 8. Personal controls and preferences

- **Where:** a "Customise" button on the personal dashboard, the leadership summary and the analytics page opens an inline panel. There is no settings page.
- **What:**
  - theme: Light or Dark, applied across the whole app;
  - accent: four presets (Teal, the default, plus Blue, Plum and Slate), each checked at 4.5:1 for text and 3:1 for controls in both themes;
  - section order, with Move up and Move down buttons (no dragging);
  - hide or show optional sections;
  - per-project expansion;
  - timeline line kinds;
  - "Show completed" for My tasks;
  - Reset to defaults.
- **Never hideable:** "Needs you", attention flags, warnings and errors, and the dashed "AI proposed" styling. The AI-proposed and authorised styles keep their contrast and dashed outline in every theme and accent.
- **Storage:** `user_preferences` (one row per user, a jsonb document validated by a schema in code; unknown keys dropped). `GET /me/preferences`, `PUT /me/preferences`. Saved on change. A Dark theme is done by overriding the existing CSS custom properties under `[data-theme="dark"]`; the 31 hard-coded colours in `styles.css` move to tokens first.
- Preferences affect only presentation. They are not business settings, carry no reason and write no audit row.

## 9. Administrator settings: access and records (D90)

New tab **System Settings › Access and records** for the Enterprise Administrator:

| Setting | Default | Bounds | Replaces |
|---|---|---|---|
| Automatic archive delay after closing | 12 months | 1–60 | `ARCHIVE_AFTER_MONTHS` in `projects/archive.ts` |
| Audit/Oversight default grant length | 30 days | 1–90, and not above the maximum | `GRANT_DEFAULT_DAYS` in `projects/grants.ts` |
| Audit/Oversight maximum length per grant or extension | 90 days | 1–365 | `GRANT_MAX_DAYS` |
| Invitation validity | 7 days | 1–30 | `VALID_FOR_MS` in `projects/invitations.service.ts` |
| Analytics export allowed | On | On or Off | (new) |

- Stored in `access_settings` (one row) with append-only `access_settings_changes` (actor, reason, previous and new values, effective time), as `analysis_settings` does.
- Each setting shows its effective value, default and bounds.
- Invitation validity applies to project invitations sent or resent afterwards. *Design call:* the one-time organisation setup invitation (`organisation/setup.service.ts`) and the Administrator recovery links keep their fixed validity. They are security paths, and the screen says "Project invitations". Grant lengths apply to grants requested or extended afterwards; existing grants keep their dates.
- Archive delay: after saving, `archiveState` reads the setting in force at the moment of evaluation and keeps its present rule unchanged: an explicit unarchive counts only if made on or after the automatic due date. Before saving, the screen previews every Closed project whose archive state the new delay would change (name, closing date, now and after). This includes a project that was unarchived before the new, later due date and would therefore archive again at that date. *Design call:* the rule is not changed. The preview makes every effect visible, which meets "never silently", and the change history is not read at evaluation time.
- Changes need a reason. The go-live install fills the defaults.

## 10. Event catalogue (A12, R17)

- `app/src/analytics/catalogue.ts` lists every action Kainow records, as entries `{ name, table, version, area, meaning, actor, subject, measurements }`. It covers the `audit_events` actions and the per-domain event tables (`task_events`, `record_events`, `project_transitions`, `membership_events`, `grant_events`, `project_archive_events`, `notification_triggers`, `email_attempts`, `discussion_events`, `ai_assist_events`, `quarantine_events`, `source_events`, the sub-project 6 event tables, and the others found at build time). It also covers the new leadership, settings and export events.
- **A completeness test** reads every `writeAudit` action literal and every event-table `CHECK` list (through the database catalogue) and fails if any is missing from the catalogue, or if the catalogue names one that no longer exists.
- The catalogue is the documentation that the Definitions page shows. It does not change how events are written, and no new event store is added. Payloads stay as they are: no event carries source text, and none may (sub-project 5 tests already enforce this).
- Trends read the dated event tables directly (§7.2).

## 11. Permissions (additions)

| Action | Who | Notes |
|---|---|---|
| View personal dashboard | Any signed-in Active account | Only own items and projects visible today |
| View project dashboard and timeline | `project.view` (participants and Audit/Oversight holders) | Pending invitation names: PM, Deputy, Owner, Sponsor |
| Grant, change or revoke leadership access | Enterprise Administrator, not to themselves | Reason; D89 |
| View leadership summary | Holder of an Active leadership grant | Summary fields only, within scope |
| Open Administrator analytics; save own views; read definitions | Enterprise Administrator (`analytics.view`) | Counts only below project level unless also a participant |
| Export analytics CSV | Enterprise Administrator while export is allowed | Recorded |
| Change access settings | Enterprise Administrator (`organisation.manage`) | Reason; D90 |
| Change own display preferences | Any signed-in user | Presentation only |

The Permission Matrix and Configuration Catalogue are updated in this branch (§16).

## 12. Data model (migration `0029_dashboards.sql`)

```sql
CREATE TABLE leadership_grants (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id),
  scope_kind    text NOT NULL CHECK (scope_kind IN ('organisation', 'departments', 'projects')),
  starts_on     date NOT NULL,
  expires_on    date,                       -- last day; NULL = no end
  reason        text NOT NULL CHECK (btrim(reason) <> ''),
  granted_by    uuid NOT NULL REFERENCES users (id),
  granted_at    timestamptz NOT NULL,
  revoked_at    timestamptz, revoked_by uuid REFERENCES users (id), revoke_reason text,
  CHECK (granted_by <> user_id),
  CHECK (expires_on IS NULL OR expires_on >= starts_on)
);
CREATE TABLE leadership_grant_departments (grant_id uuid REFERENCES leadership_grants, department_id uuid REFERENCES departments, PRIMARY KEY (grant_id, department_id));
CREATE TABLE leadership_grant_projects    (grant_id uuid REFERENCES leadership_grants, project_id uuid REFERENCES projects,       PRIMARY KEY (grant_id, project_id));
CREATE TABLE leadership_grant_events (id uuid PRIMARY KEY, grant_id uuid NOT NULL REFERENCES leadership_grants,
  kind text NOT NULL CHECK (kind IN ('granted', 'end_changed', 'revoked')), actor_id uuid NOT NULL REFERENCES users,
  at timestamptz NOT NULL, reason text NOT NULL, detail jsonb NOT NULL DEFAULT '{}');   -- append-only trigger

CREATE TABLE user_preferences (user_id uuid PRIMARY KEY REFERENCES users, prefs jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL);
CREATE TABLE analytics_views (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, name text NOT NULL,
  config jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, UNIQUE (user_id, name));

CREATE TABLE access_settings (id boolean PRIMARY KEY DEFAULT true CHECK (id),
  archive_after_months int NOT NULL DEFAULT 12 CHECK (archive_after_months BETWEEN 1 AND 60),
  grant_default_days   int NOT NULL DEFAULT 30 CHECK (grant_default_days BETWEEN 1 AND 90),
  grant_max_days       int NOT NULL DEFAULT 90 CHECK (grant_max_days BETWEEN 1 AND 365),
  invitation_valid_days int NOT NULL DEFAULT 7 CHECK (invitation_valid_days BETWEEN 1 AND 30),
  analytics_export_allowed boolean NOT NULL DEFAULT true,
  CHECK (grant_default_days <= grant_max_days));
INSERT INTO access_settings DEFAULT VALUES;
CREATE TABLE access_settings_changes (id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users, at timestamptz NOT NULL,
  reason text NOT NULL, previous jsonb NOT NULL, next jsonb NOT NULL);                    -- append-only trigger
```

The sketch shows intent; the builder fixes exact names, indexes and the append-only triggers in the project's style. Indexes needed by the measures (for example `tasks (project_id, status)`, `risks (project_id, status, severity)`, a partial index on pending `change_requests`) are added if the bench shows them needed.

## 13. Endpoints

| Route | Who | Returns |
|---|---|---|
| `GET /dashboard/me` | signed-in | needsYou[], myTasks[], projects[] with header and expanded figures, computedAt |
| `GET /projects/:id/dashboard` | `project.view` | §5.1 figures, computedAt |
| `GET /projects/:id/timeline` | `project.view` | dated lines for the range |
| `GET /dashboard/leadership` | Active leadership grant | cards with catalogue fields, computedAt |
| `GET/POST /admin/leadership-grants`, `POST /admin/leadership-grants/:id/{end,revoke}` | EA | grants and events |
| `GET /admin/analytics?panel=&filters` | `analytics.view` | panel data, definitions version, computedAt |
| `GET /admin/analytics/drill?level=&id=&measure=` | `analytics.view` | counts, or records where also a participant |
| `GET /admin/analytics/export` | `analytics.view` and export allowed | CSV |
| `GET /admin/analytics/definitions` | `analytics.view` | measures and catalogue |
| `GET/POST/PUT/DELETE /admin/analytics/views` | `analytics.view` | own saved views |
| `GET/PUT /admin/access-settings`, `POST /admin/access-settings/preview` | EA | settings, changes, archive preview |
| `GET/PUT /me/preferences` | signed-in | own preferences |

`GET /projects` keeps working for existing callers.

## 14. Testing and measured aims

- **Measure tests (pure and DB):** the eligible-leaf rule (parents, two levels, Cancelled, all-subtasks-Deleted parent, overridden parent), "Progress not yet measurable", On-time completion (late, deadline review, Deferred and Closed reference days, "Nothing due yet"), stage duration, planned end, overdue at the UTC+8 day boundary.
- **Consistency test:** for a seeded project, the personal header, project dashboard, leadership card, analytics row and CSV row give identical task-completion and On-time figures.
- **Leak tests (mandatory, one per surface: personal, project, timeline, leadership, analytics panels and drill-down, CSV):**
  - a Deleted task, question and risk, and an uncleaned held record, are absent from every list and count;
  - a cleaned held record shows its label;
  - a leadership holder gets no content route (`GET /projects/:id`, records, notes, discussion: 404), sees no project outside scope, and loses access at expiry, on revocation and on account disablement;
  - a department-scope grant follows an ownership transfer;
  - an Administrator who is not a participant gets counts only from drill-down;
  - no view or export contains source text, message text, quotes, private AI questions or credential text.
- **Permission tests** for every new route (allowed, 403 or 404 as the existing patterns do).
- **Settings tests:** bounds, reason required, history rows, archive preview, new invitations and grants use new values while existing ones keep theirs.
- **Catalogue completeness test** (§10).
- **CSV tests:** header lines, formula-injection escaping, export disallowed, audit event.
- **Web helper tests:** label and empty-state wording, expansion defaults with saved choices, preference validation, chart-to-table equivalence data.
- **Bench (`npm run bench-dashboards`, own `kainow_bench` style database):** 200 users, 100 projects, 30,000 tasks with subtasks, 3,000 risks, events for a year. **Aims (approved by the Product Owner, 19 November 2026): `GET /dashboard/me` p95 < 300 ms for a user in 10 projects; `GET /projects/:id/dashboard` p95 < 200 ms; each analytics panel p95 < 500 ms; leadership summary for organisation scope p95 < 500 ms.** Results are recorded in this section, met or missed, as earlier sub-projects did.
- Screens checked at desktop width and at 375 px, by keyboard, in both themes; WCAG 2.2 AA.

## 15. Left to the builder, and open items

- Exact SQL shapes and indexes, guided by the bench.
- The chart drawing: plain SVG or CSS bars with no new chart library, each with an equivalent table and a text summary.
- Which existing project-settings items still lack a screen. Known: categories, stage simplification, required fields and export policy per project are not built and are not part of this sub-project; they stay with their owning sub-projects or a later settings pass, to be placed by the Product Owner.
- **Settled by the Product Owner on 19 November 2026 (approved as proposed):**
  - the D90 bounds;
  - the bench aims;
  - leadership showing High and Critical risk descriptions (cut to 120 characters), since risks have no separate title.

## 16. Documents updated in this branch

- Consolidated Specification §14: D88, D89 and D90.
- Permission Matrix §5 and §8: the rows in §11.
- Configuration Catalogue: C58–C60 and C64 point to this design; the access settings and their bounds are added.
- Remaining Design and Verification Register: R17 marked designed for dashboards and the leadership catalogue, with resources and finance (sub-project 8) and operations panels (sub-project 10) left open.
- `app/README.md`: new screens, the bench and the access settings.

## 17. Outside 7

- Resource and budget figures on any dashboard (8).
- Backup, restore and storage health (10).
- Document exports and external filing (9).
- Delegated project settings not yet built (categories, stages, required fields, project export policy).
- Search across dashboards, and email delivery of dashboards.
