# V1.0 Sub-project 7 — Dashboards and Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build four views:
- a personal dashboard (the new home page);
- a project dashboard and Timeline tab;
- a leadership summary behind EA-granted scopes;
- Administrator analytics with drill-down, saved views, definitions and CSV export.

Alongside them, build:
- personal display preferences (theme, accent, order, hiding, expansion);
- the event catalogue;
- the System Settings › Access and records tab (D90).

**Architecture:**
- Every figure is worked out from the live records on each request (approach A). One module, `app/src/dashboards/measures.ts`, holds the pure measure functions and one batched loader. Every surface and the CSV export use them.
- A new `dashboards` Nest module serves the personal, project and timeline views, and a `leadership` module serves grants and the summary. An `analytics` module serves the panels, drill-down, saved views, definitions, the export and the catalogue.
- Access settings move three constants out of code into a one-row table that the existing archive, grant and invitation code reads.
- One migration, `0029_dashboards.sql`.

**Tech Stack:** TypeScript, NestJS 12, PostgreSQL 16 (plain SQL migrations with checksums), pg-boss 12 (read only, for job health), React + Vite with hash routing, `node:test`. No new dependencies: charts are plain SVG or CSS bars.

**Spec:** `docs/superpowers/specs/2026-11-18-v1-dashboards-design.md` (approved 19 November 2026). Read it in full first. The § numbers below refer to it. Also read:
- `app/src/history/deleted-sql.ts`;
- `app/src/projects/access.service.ts`;
- `app/src/projects/archive.ts` and `grants.ts`;
- `app/src/records/tasks.ts` (`taskIndicators`);
- `app/src/changes/changes.service.ts` around `mayApprove`;
- `app/src/ai/usage.*`.

## Global Constraints

**Migrations and data:**
- One migration, `app/migrations/0029_dashboards.sql` (Task 1). Never edit `0001`–`0028`, because they carry checksums.
- Rebase onto `main` first if the sub-project 5 and 6 branches have merged by execution time.
- `leadership_grant_events` and `access_settings_changes` are append-only, using the existing `kainow_append_only()` trigger.
- Leadership grants are never deleted.

**Filters, used everywhere:**
- Counts and work lists use `liveRecordSql(alias)`.
- Text shown on any dashboard uses the same rule. A cleaned held record shows the existing cleaned label.
- Nothing calls a record filter that lets Deleted or uncleaned held rows through.
- Today is `todayUtc8()`, and every date shown is UTC+8.
- Weeks start Monday 00:00 UTC+8.

**Access:**
- `ProjectAccess` and `canReadContent` are not changed.
- A leadership grant adds no matrix action and no project access.
- Every drill-down and export request rechecks access on the server.

**Values from the spec:**
- **D90 bounds and defaults:**

  | Setting | Bounds | Default |
  |---|---|---|
  | `archive_after_months` | 1–60 | 12 |
  | `grant_default_days` | 1–90, and ≤ `grant_max_days` | 30 |
  | `grant_max_days` | 1–365 | 90 |
  | `invitation_valid_days` | 1–30 | 7 |
  | `analytics_export_allowed` | — | true |

- **Reasons:** 1–1,000 characters after trim. Each runs `refuseSecretsIn` with the existing D75 wording.
- **Thresholds:**
  - Due soon is today to today + 7 days.
  - Significant risk means High or Critical.
  - Personal and leadership lists collapse by default when more than 5 projects are shown.
  - Jobs count as waiting when waiting longer than 15 minutes.
  - Risk descriptions on leadership cards are cut to 120 characters, with `…` added when cut.
- **Analytics period options:** This month, Last month, Last 4 / 12 / 26 / 52 weeks. The default is Last 12 weeks.
- **Default status filter** (analytics and leadership): Planned, Active, Deferred.
- **Timeline default range:** three months back to six months ahead.

**Percentages:** `Math.floor(done * 100 / total)`. A view shows 100% only when every item is done, and 0% only when none is done.

**Exact copy:**
- `Progress not yet measurable`
- `Nothing due yet`
- `No planned end date`
- `Ended n days ago`
- `Not provided`
- `Nothing needs you right now.`
- `Your membership is on hold`
- `Updated HH:MM UTC+8`
- `62% task completion (31 of 50 tasks)`
- `4 cancelled`
- `32 of 40 tasks due so far are done (80%)`
- `Awaiting deadline review: n`
- `includes projects this department owns now and later`
- `Only counts are shown: you are not a participant in this project.`
- `Project invitations`
- **Coverage note:** `Counts all authorised records in the project except deleted ones and any under credential review.`
- **Trends note:** `Trends are worked out from current records: changed due dates use the current date, and deleted records are left out of past weeks.`

**CSV:**
- The first lines start with `#` and state:
  - panel;
  - filters;
  - period;
  - measure definitions version;
  - `computedAt` (UTC+8);
  - coverage.
- A cell starting with `=`, `+`, `-` or `@` gets a `'` in front.
- Each export writes an `analytics.exported` audit event that holds the panel and filters, never data.

**Project rules:**
- No real organisation names. Test accounts only: `*@example.org|com|net` or `*@kainow.test`. Use dummy department and project names.
- **Tests:**
  - set `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:15432/kainow_test` (container `kainow-testdb`);
  - run DB tests through `npm test` (`--test-concurrency=1`);
  - check that no other session is running tests against the container before a full suite.
- Never print or open `.env` files, API keys or the protected key file. Never use `git stash`.
- Commit after each task with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A project is nearly done: 199 of 200 leaf tasks Completed.** It shows 99%, never 100%. A project with 1 of 300 done shows 0% and "1 of 300", not an empty state.
   - Test: Task 3, `percent floors: 199/200 is 99, 1/300 is 0 with counts`.
2. **Every leaf task is Cancelled.** The view shows `Progress not yet measurable` with `4 cancelled`, never 0% or 100%.
   - Test: Task 3, `only cancelled leaves is not measurable and shows cancelled count`.
3. **A leadership grant ending today.** The holder keeps access through 23:59 UTC+8 on the last day and loses it at 00:00 UTC+8 the next day.
   - Test: Task 8, `grant works on its last day and ends at 00:00 UTC+8 after`.
4. **The Administrator saves a grant default (60) above a new maximum (45), or lowers the maximum below an existing grant's length.**
   - The first is refused with a plain 400, not a 500 from the CHECK.
   - The existing grant keeps its dates. Its next extension is measured against the new maximum.
   - Test: Task 2, `default above maximum is a 400; existing grant keeps dates; extension uses new maximum`.
5. **A saved preference names a section that no longer exists, or tries to hide "Needs you".** The unknown key is dropped, and "Needs you" stays first and visible after `PUT` and `GET`.
   - Test: Task 6, `unknown sections dropped; needsYou cannot be hidden or moved`.

---

## File Structure

| File | Responsibility |
|---|---|
| `app/migrations/0029_dashboards.sql` | All schema of §12 |
| `app/src/organisation/access-settings.ts`, `.service.ts`, `.controller.ts` | D90 settings: load, validate, change history, archive preview |
| `app/src/dashboards/measures.ts` | Pure measures, definitions, `loadProjectMeasures` batch loader |
| `app/src/dashboards/project-dashboard.service.ts` | `GET /projects/:id/dashboard` |
| `app/src/dashboards/timeline.ts`, `timeline.service.ts` | `GET /projects/:id/timeline` |
| `app/src/dashboards/personal.service.ts` | `GET /dashboard/me` |
| `app/src/dashboards/preferences.ts`, `preferences.service.ts` | Preference schema and `GET/PUT /me/preferences` |
| `app/src/dashboards/dashboards.controller.ts`, `dashboards.module.ts` | Wiring |
| `app/src/leadership/grants.ts`, `grants.service.ts`, `leadership-fields.ts`, `summary.service.ts`, `leadership.controller.ts`, `leadership.module.ts` | D89 grants and the summary |
| `app/src/analytics/filters.ts`, `panels.service.ts`, `system.service.ts`, `trends.service.ts`, `drill.service.ts`, `views.service.ts`, `csv.ts`, `catalogue.ts`, `analytics.controller.ts`, `analytics.module.ts` | Administrator analytics |
| `app/src/dashboards/bench-cli.ts` | `npm run bench-dashboards` |
| `app/web/src/styles.css` | Colour tokens, `[data-theme="dark"]`, `[data-accent=…]` |
| `app/web/src/prefs.ts`, `dashboard.ts`, `analytics.ts`, `leadership.ts` | Pure web helpers (tested) |
| `app/web/src/views/Home.tsx`, `ProjectFigures.tsx`, `Timeline.tsx`, `Customise.tsx`, `Bars.tsx`, `Leadership.tsx`, `LeadershipGrants.tsx`, `AccessSettings.tsx`, `Analytics.tsx`, `Definitions.tsx` | Screens |

---

### Task 1: Migration 0029

**Files:**
- Create: `app/migrations/0029_dashboards.sql`
- Test: `app/src/dashboards/migration.test.ts`

**Interfaces:**
- Produces these tables, as in §12:
  - `leadership_grants`, `leadership_grant_departments`, `leadership_grant_projects`, `leadership_grant_events`;
  - `user_preferences`, `analytics_views`;
  - `access_settings` (one row inserted), `access_settings_changes`.
- Also produces any indexes the measures need. Add at least `tasks (project_id, status)` and `risks (project_id, status, severity)`; the bench in Task 19 may add more in a later migration only if 0029 is already merged, otherwise in 0029.

- [ ] **Step 1: Write the failing tests** in `migration.test.ts`:
  - `access_settings has one row with the defaults` asserts `(12, 30, 90, 7, true)`.
  - A second insert fails, because the primary key is the constant `true`.
  - `bounds are enforced by CHECK`: `archive_after_months = 61`, `invitation_valid_days = 0`, and `grant_default_days = 91` each fail. `grant_default_days = 60, grant_max_days = 45` fails.
  - `leadership grant to oneself is refused`: `granted_by = user_id` violates the CHECK.
  - `append-only`: UPDATE or DELETE on `leadership_grant_events` and `access_settings_changes` raises.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL (relations do not exist).
- [ ] **Step 3: Write the migration** following §12, in the style of `0028_ai_configuration.sql`:
  - `timestamptz NOT NULL` for times;
  - `btrim(reason) <> ''` checks;
  - `kainow_append_only()` triggers;
  - `analytics_views.name` 1–100 characters after trim;
  - `leadership_grant_events.kind` in `('granted','end_changed','revoked')`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, including the existing migration-checksum tests.
- [ ] **Step 5: Commit** with the message `feat(dashboards): migration 0029 for dashboards, leadership, preferences and access settings`.

### Task 2: Access settings (D90) and the code that reads them

**Files:**
- Create: `app/src/organisation/access-settings.ts`, `access-settings.service.ts`, `access-settings.controller.ts`
- Modify:
  - `app/src/projects/archive.ts`;
  - `app/src/projects/grants.ts` and `grants.service.ts`;
  - `app/src/projects/invitations.service.ts`;
  - `app/src/organisation/organisation.module.ts`.
- Test: `app/src/organisation/access-settings.test.ts`, `access-settings.http.test.ts`; update `app/src/projects/archive.test.ts` and `grants.test.ts`.

**Interfaces:**
- Produces, in `access-settings.ts`:
  - `interface AccessSettings { archiveAfterMonths: number; grantDefaultDays: number; grantMaxDays: number; invitationValidDays: number; analyticsExportAllowed: boolean }`
  - `ACCESS_DEFAULTS: AccessSettings`
  - `ACCESS_BOUNDS`: per numeric key, `{ min, max }`.
  - `validateAccessSettings(next: unknown): { ok: true; value: AccessSettings } | { ok: false; field: string; message: string }`. It also checks that the default length does not exceed the maximum.
  - `loadAccessSettings(db: Pool | PoolClient): Promise<AccessSettings>`
- Changed signatures:
  - `archiveState(input & { afterMonths: number })`;
  - `loadArchiveState(db, projectId, status, today)` now reads `archive_after_months` itself, so its callers do not change;
  - `defaultGrantEnd(startsOn, days)`;
  - `grantSpanOk(fromDay, toDay, maxDays)`.
- `ARCHIVE_AFTER_MONTHS`, `GRANT_DEFAULT_DAYS` and `GRANT_MAX_DAYS` are removed. `VALID_FOR_MS` in `invitations.service.ts` is replaced by the setting. `setup.service.ts` keeps its own 7 days.
- `AccessSettingsService`:
  - `get(): Promise<{ settings; defaults; bounds; changes: ChangeRow[] }>`
  - `preview(next: Partial<AccessSettings>, today): Promise<ArchivePreviewRow[]>`, where each row is `{ projectId, name, closedOn, archivedNow: boolean, archivedAfter: boolean }` and only changed projects are listed.
  - `update(user, next, reason): Promise<AccessSettings>` writes the row and one `access_settings_changes` row, plus audit event `access_settings.changed`.
- **Endpoints:** `GET /admin/access-settings`, `POST /admin/access-settings/preview` and `PUT /admin/access-settings`, all `@RequireAction('organisation.manage')`.

- [ ] **Step 1: Write the failing pure tests:**
  - `validateAccessSettings` accepts the defaults.
  - It refuses each bound with a message naming the field and range, for example `Archive delay must be 1–60 months.`
  - It refuses default 60 with maximum 45, naming the default length.
  - `archiveState` with `afterMonths: 3` archives 3 months after closing.
  - An unarchive before the due date does not stop automatic archive at the due date. This is today's rule, kept.
- [ ] **Step 2: Write the failing http tests:**
  - `non-EA gets 403` on all three routes.
  - `reason required` returns 400.
  - `history row has previous and next`.
  - `preview lists only changed projects`, with three Closed projects:
    - one closed 2 months ago;
    - one closed 14 months ago;
    - one closed 14 months ago and unarchived 13 months after closing.

    Setting 1 month lists the first project only. Setting 13 months lists the third: archived now, and after the change still archived because the unarchive came before the new due date. The test spells out each expected row.
  - `new invitation uses new validity; existing keeps its expiry`, using `FakeClock` and `invitations.expires_at`.
  - `default above maximum is a 400; existing grant keeps dates; extension uses new maximum` (Review Focus 4).
- [ ] **Step 3: Run** `npm test`. Expected: FAIL.
- [ ] **Step 4: Implement**:
  - The service writes the settings row and its history row in one transaction.
  - The preview runs `archiveState` twice for each Closed project, with the current months and the new months.
  - Map a CHECK failure to a 400 only as a fallback: validate first.
- [ ] **Step 5: Run** `npm test`. Expected: PASS, including the existing `archive.http.test.ts`, `grants.http.test.ts` and `invitations.http.test.ts` unchanged apart from the removed constants.
- [ ] **Step 6: Commit** with the message `feat(settings): access and records settings replace the archive, grant and invitation constants`.

### Task 3: Shared measures

**Files:**
- Create: `app/src/dashboards/measures.ts`
- Test: `app/src/dashboards/measures.test.ts` (pure), `app/src/dashboards/measures.db.test.ts`

**Interfaces:**
- Produces these types:
  - `type LeafRow = { status: TaskStatus; dueOn: string; completedOn: string | null; deadlineReviewRequired: boolean }`
  - `type Completion = { state: 'measurable'; done: number; total: number; cancelled: number; percent: number } | { state: 'not_measurable'; cancelled: number }`
  - `type OnTime = { state: 'measured'; due: number; done: number; late: number; percent: number; awaitingReview: number } | { state: 'nothing_due'; awaitingReview: number }`
  - `type PlannedEnd = { state: 'none' } | { state: 'ahead'; days: number } | { state: 'ended'; daysAgo: number }`
- Produces these functions:
  - `taskCompletion(leaves: LeafRow[]): Completion`. Cancelled leaves count only in `cancelled`.
  - `onTimeCompletion(leaves: LeafRow[], referenceDay: string): OnTime`
  - `referenceDay(input: { status: ProjectStatus; today: string; deferredOn: string | null; closedOn: string | null }): string`
  - `plannedEnd(planned: string | null, today: string): PlannedEnd`
  - `percent(done: number, total: number): number` (floor)
- `interface ProjectMeasures` holds:
  - `projectId`, `completion`, `onTime`;
  - `overdue`, `blocked`, `dueSoon`;
  - `stage: { stage; substage; days }`, `plannedEnd`;
  - `questions: { open; answered }`;
  - `risks: { bySeverity: Record<'low'|'medium'|'high'|'critical', number>; significant: number; overdueReviews: number }`;
  - `flags: { missingRole: boolean; noIndependentEscalation: boolean; deadlineReview: boolean; escalationsOpen: number }`;
  - `pendingInvitations`, `nextTaskDue: string | null`, `nextRiskReview: string | null`.
- `loadProjectMeasures(db: Pool | PoolClient, projectIds: string[], today: string): Promise<Map<string, ProjectMeasures>>` is one batched loader with a fixed number of queries, not one per project.
- Constants:
  - `MEASURES_VERSION = '1'`;
  - `MEASURE_DEFINITIONS: readonly { key: string; label: string; definition: string }[]`, one entry per row of the §3 table;
  - `COVERAGE_NOTE`, the exact copy.
- Eligible leaf: a row in `tasks` passing `liveRecordSql`, not Cancelled, with no live child. A parent whose children are all Deleted is a leaf.
- Late: `completedOn` (UTC+8 day of the completion) is after `dueOn`.
- Flags reuse the functions `projects.service.ts` already uses for the Overview flags (missing role, No independent escalation recipient, deadline review). Do not copy their logic.

- [ ] **Step 1: Write the failing pure tests:**
  - `percent floors: 199/200 is 99, 1/300 is 0 with counts`
  - `only cancelled leaves is not measurable and shows cancelled count`
  - `no leaves is not measurable`
  - `late completion counts as done and as late`
  - `deadline review tasks are left out of due and counted in awaitingReview`
  - `nothing due before reference day is nothing_due`
  - `Deferred project uses the deferral day, Closed uses the closing day`
  - `plannedEnd none / ahead 10 / ended 3`
  - `due on the reference day is not yet due`, because the rule is "due date before".
- [ ] **Step 2: Write the failing DB tests:**
  - `parent with live subtasks is not a leaf; two levels; all-subtasks-Deleted parent is a leaf`
  - `Deleted and uncleaned held tasks are not counted; cleaned held are`
  - `overdue at the UTC+8 day boundary`: a task due on 13 Nov is not overdue at 23:59 UTC+8 on 13 Nov, and is overdue at 00:00 UTC+8 on 14 Nov.
  - `significant risks and overdue reviews`
  - `batch loader runs a fixed number of queries for 1 and 20 projects`: wrap the pool and count queries.
- [ ] **Step 3: Run** `npm test`. Expected: FAIL.
- [ ] **Step 4: Implement** `measures.ts`.
- [ ] **Step 5: Run** `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** with the message `feat(dashboards): shared measures`.

### Task 4: Project dashboard endpoint

**Files:**
- Create: `app/src/dashboards/project-dashboard.service.ts`, `dashboards.controller.ts`, `dashboards.module.ts`
- Modify: `app/src/app.module.ts`
- Test: `app/src/dashboards/project-dashboard.http.test.ts`

**Interfaces:**
- Consumes: `loadProjectMeasures`, `ProjectAccess.load` and the `project.view` decision.
- Produces `GET /projects/:id/dashboard`, returning `{ measures: ProjectMeasures; invitations: { count: number; names?: string[] }; decisions: { active: number; recent: {id,title,at}[] }; questions: { oldestOpen: {id,text,at}[] }; risks: { significant: {id,description,severity,reviewOn}[] }; computedAt: string; coverage: string }`. The 5 most recent decisions and 5 oldest open questions use `liveRecordSql`.
- Invitation `names` go only to PM, Deputy, Owner and Sponsor.
- No `project.view` returns a 404, as `GET /projects/:id` does.

- [ ] **Step 1: Write the failing tests:**
  - `member sees figures; names hidden from member, shown to PM`
  - `audit grant holder sees figures`
  - `stranger gets 404`
  - `Deleted decision is absent from recent and count`
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(dashboards): project dashboard endpoint`.

### Task 5: Timeline endpoint

**Files:**
- Create: `app/src/dashboards/timeline.ts`, `timeline.service.ts`; route in `dashboards.controller.ts`
- Test: `app/src/dashboards/timeline.test.ts`, `timeline.http.test.ts`

**Interfaces:**
- Produces:
  - `type TimelineLine = { day: string; kind: 'stage' | 'status' | 'archive' | 'tasks_due' | 'risk_review' | 'planned_end'; label: string; detail?: unknown }`
  - `timelineRange(query: { from?: string; to?: string }, today: string): { from: string; to: string } | { error: string }`. The default is three months back to six months ahead. It refuses `from > to`, bad dates, and spans over 731 days.
  - `groupByMonth(lines): { month: string; lines: TimelineLine[] }[]`, oldest first.
  - `GET /projects/:id/timeline?from=&to=` (`project.view`).
- Task due dates give one line per day (`3 tasks due`), with titles in `detail`, live records only.

- [ ] **Step 1: Write the failing tests:**
  - `range defaults; from after to is 400; span over two years is 400`
  - `one line per due day with count`
  - `status transitions and archive events appear`
  - `Deleted task drops out of a due-day count`
  - `no line is inferred`: a project with no dates returns only the lines it has.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(dashboards): project timeline`.

### Task 6: Preferences (server)

**Files:**
- Create: `app/src/dashboards/preferences.ts`, `preferences.service.ts`; routes in `dashboards.controller.ts`
- Test: `app/src/dashboards/preferences.test.ts`, `preferences.http.test.ts`

**Interfaces:**
- Produces:
  - `type Prefs = { theme: 'light' | 'dark'; accent: 'teal' | 'blue' | 'plum' | 'slate'; home: { order: HomeSection[]; hidden: HomeSection[]; showCompleted: boolean; includeArchived: boolean }; leadership: { fields: { order: string[]; hidden: string[] } }; expanded: Record<string, boolean>; timeline: { hiddenKinds: TimelineLine['kind'][] } }`
  - `HomeSection = 'needsYou' | 'myTasks' | 'myProjects'`
  - `DEFAULT_PREFS`
  - `normalisePrefs(input: unknown): Prefs` drops unknown keys and values, forces `needsYou` first and never hidden, keeps `name` and `refresh` leadership fields visible, and caps `expanded` at 1,000 entries.
  - `GET /me/preferences` and `PUT /me/preferences` (`@AnySignedInUser`). `PUT` stores `normalisePrefs(body)` and returns it. It writes no audit row.

- [ ] **Step 1: Write the failing tests:**
  - `unknown sections dropped; needsYou cannot be hidden or moved` (Review Focus 5)
  - `bad theme falls back to light`
  - `each user reads only their own`
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(dashboards): personal preferences`.

### Task 7: Personal dashboard endpoint

**Files:**
- Create: `app/src/dashboards/personal.service.ts`; route in `dashboards.controller.ts`
- Modify: `app/src/changes/changes.service.ts`, to extract the approval check
- Test: `app/src/dashboards/personal.http.test.ts`

**Interfaces:**
- Produces, in `changes.service.ts`: `export function changeMayApprove(ctx: ProjectContext, request: RequestRow, givenApproverIds: string[], userId: string): boolean`. This is the `mayApprove` expression at the list view (pending, eligible, not blocked, not already given). The list view now calls it.
- Produces `GET /dashboard/me`, returning:
  - `needsYou`: `{ kind: 'approval' | 'minutes' | 'question' | 'copies' | 'deadline_review'; projectId; projectName; label; since; link }[]`;
  - `myTasks`: `{ overdue; dueSoon; later; awaitingReview; completed? }`, each a list of `{ id, title, projectId, projectName, dueOn, status, overdueDays? }`;
  - `projects`: `{ id, name, onHold: boolean, header?, expanded? }[]`;
  - `computedAt`.
- Rules from §4:
  - My tasks and Needs you cover only projects where `canReadContent` holds.
  - On-hold projects carry `onHold: true` and no figures.
  - Archived projects are left out unless `?includeArchived=1`.
  - `completed` (the last 30 days) is included only with `?showCompleted=1`.
- **Needs you sources:**
  - pending `change_requests` where `changeMayApprove`;
  - sources with `publication = 'submitted'` the viewer may publish, using the existing publish check in `notes.service.ts`;
  - questions with `requester_id = viewer` and status `answered`;
  - `quarantine_possible_copies` undecided, as a count, for PM or Deputy;
  - an open deadline review for PM or Deputy, using `ClosureService.mayPrepare` or the deadline service's existing check.

- [ ] **Step 1: Write the failing tests:**
  - `approval appears for an eligible Owner, not after they approve, not for a Member`
  - `answered question appears to its requester only`
  - `on-hold membership shows name only and no tasks`
  - `Scheduled membership: project tasks not listed`
  - `tasks grouped overdue / due in 7 days / later / awaiting review`
  - `possible copies show a count, never text`
  - `Nothing needs you right now when empty`: the API returns `needsYou: []`, and the web copy is tested in Task 14.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `loadProjectMeasures` for the headers.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, including `changes.http.test.ts` unchanged.
- [ ] **Step 5: Commit** with the message `feat(dashboards): personal dashboard endpoint`.

### Task 8: Leadership grants (D89)

**Files:**
- Create: `app/src/leadership/grants.ts`, `grants.service.ts`, `leadership.controller.ts`, `leadership.module.ts`
- Modify: `app/src/app.module.ts`
- Test: `app/src/leadership/grants.test.ts`, `grants.http.test.ts`

**Interfaces:**
- Produces:
  - `type LeadershipGrantState = 'scheduled' | 'active' | 'ended' | 'revoked'`
  - `leadershipGrantState(g: { startsOn: string; expiresOn: string | null; revokedAt: string | null }, today: string): LeadershipGrantState`. `expiresOn` is the last day, inclusive.
  - `leadershipProjectIds(db, userId: string, today: string): Promise<string[] | null>` returns `null` when there is no Active grant or the account is not Active. Otherwise it returns the union over Active grants: all projects; projects whose current `owning_department_id` is in scope; or the named projects.
  - `LeadershipGrantsService.list()`, `grant(actor, { userId, scope: { kind, departmentIds?, projectIds? }, startsOn, expiresOn?, reason })`, `changeEnd(actor, id, expiresOn | null, reason)` and `revoke(actor, id, reason)`. Each writes a `leadership_grant_events` row and an audit event (`leadership.granted`, `leadership.end_changed`, `leadership.revoked`).
  - **Endpoints:** `GET /admin/leadership-grants`, `POST /admin/leadership-grants`, `POST /admin/leadership-grants/:id/end` and `POST /admin/leadership-grants/:id/revoke`, all `@RequireAction('organisation.manage')`.
- **Refusals (400):**
  - grant to oneself: `Nobody can grant leadership access to themselves.`;
  - an account that is not Active;
  - an empty departments or projects list;
  - end before start;
  - reason missing or containing a secret.

- [ ] **Step 1: Write the failing tests:**
  - `grant works on its last day and ends at 00:00 UTC+8 after` (Review Focus 3)
  - `scheduled before start`
  - `revoked ends at once`
  - `self-grant refused`
  - `disabled account has no scope`
  - `department scope follows an ownership transfer` (via `POST /projects/:id/department`)
  - `union of two grants`
  - `non-EA 403`
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(leadership): leadership grants`.

### Task 9: Leadership summary

**Files:**
- Create: `app/src/leadership/leadership-fields.ts`, `summary.service.ts`; route in `leadership.controller.ts`
- Test: `app/src/leadership/summary.http.test.ts`

**Interfaces:**
- Produces:
  - `LEADERSHIP_FIELDS: readonly { key: string; label: string; required?: true }[]`, in the §6.3 order. `name` and `refresh` are required.
  - `GET /leadership/me` returns `{ hasGrant: boolean }` for the menu (`@AnySignedInUser`).
  - `GET /dashboard/leadership?status=&department=&includeArchived=` returns `{ cards: LeadershipCard[]; departments: {id,name}[]; computedAt }`. It is a 404 when `leadershipProjectIds` is `null`.
- A card holds only catalogue fields:
  - built from `loadProjectMeasures` and project columns;
  - significant risks as `{ description: cut to 120 characters, severity, reviewOn }`, from live records only;
  - `link: true` only when `ProjectAccess` already gives the viewer `project.view`.
- The department filter options are limited to departments in scope.

- [ ] **Step 1: Write the failing tests:**
  - `holder sees in-scope projects only`
  - `holder gets 404 from GET /projects/:id, records, notes and discussion of an in-scope project`
  - `risk description cut at 120 with ellipsis`
  - `Deleted risk absent`
  - `no grant is 404`
  - `participant leader's card has link true`
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(leadership): leadership summary`.

### Task 10: Analytics permission, filters and the two project panels

**Files:**
- Create: `app/src/analytics/filters.ts`, `panels.service.ts`, `analytics.controller.ts`, `analytics.module.ts`
- Modify: `app/src/auth/permissions.ts` (`audit.view` → `analytics.view`), `app/src/app.module.ts`
- Test: `app/src/analytics/filters.test.ts`, `panels.http.test.ts`

**Interfaces:**
- Produces:
  - `type Period = 'this_month' | 'last_month' | 'last_4w' | 'last_12w' | 'last_26w' | 'last_52w'`
  - `type AnalyticsFilters = { period: Period; from: string; to: string; departmentId: string | null; statuses: ProjectStatus[]; ownership: 'owned' | 'contributed' | 'both'; includeArchived: boolean }`
  - `parseAnalyticsFilters(query: Record<string, unknown>, today: string): AnalyticsFilters | { error: string }`
  - `weekStarts(from: string, to: string): string[]` (Mondays, UTC+8)
  - `PanelsService.progress(filters)` returns `{ departments: Roll[]; projects: Row[]; nothingDue: {id,name}[]; computedAt }`. Each project counts once under its owning department, and `alsoContributesTo` is listed separately.
  - `PanelsService.problems(filters)` returns organisation totals, then per department, then per project, with the nine counts of §7.2 item 2. "Invitations expired in the period" uses the filter period.
  - `GET /admin/analytics?panel=progress|problems|system|trends&…filters` (`@RequireAction('analytics.view')`) returns `{ panel, data, definitionsVersion: MEASURES_VERSION, computedAt }`.

- [ ] **Step 1: Write the failing tests:**
  - `default period is last 12 weeks; weeks start Monday UTC+8`
  - `this month and last month bounds`
  - `bad period is error`
  - `department roll-up counts each project once; contributed listed apart`
  - `nothing-due projects listed, not zero`
  - `member gets 403`
  - `analytics.view exists and audit.view does not`
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `loadProjectMeasures` for every row.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, including the permission tests that cover each action.
- [ ] **Step 5: Commit** with the message `feat(analytics): progress and project problems panels`.

### Task 11: System problems and trends panels

**Files:**
- Create: `app/src/analytics/system.service.ts`, `trends.service.ts`
- Test: `app/src/analytics/system.http.test.ts`, `trends.http.test.ts`

**Interfaces:**
- `SystemService.problems(filters)` returns:
  - `emails: { failed; uncertain; retryWaiting }` (`email_outbox` in the period; retry_wait now);
  - `ai: { blockedByReason: Record<string, number>; keyRejected: number }`, using the sub-project 6 readiness function the analysis tick uses;
  - `jobs: { failedByQueue: Record<string, number>; waitingOver15m: number }`, read from the `pgboss` job table read-only;
  - `security: { casesAwaitingReview: number; protectedKeyInstalled: boolean }`;
  - `links` per line.
- `TrendsService.weekly(filters)` returns `{ weeks: string[]; series: Record<'tasks_authorised'|'tasks_completed'|'tasks_became_overdue'|'proposals_authorised'|'proposals_rejected'|'projects_active'|'projects_deferred'|'projects_closed', number[]>; note: string }`.
- A task "became overdue" falls in the week of `due_on + 1 day` if it was not Completed or Cancelled by then. Live records only. `note` is the exact trends copy.

- [ ] **Step 1: Write the failing tests:**
  - `failed and uncertain emails in the period counted`
  - `job waiting 16 minutes counted, 14 not`
  - `credential cases count only, no text in body`
  - `task due Sunday becomes overdue in the next Monday week`
  - `task completed on its due day never becomes overdue`
  - `Deleted task drops out of past weeks`
  - `transitions into Active, Deferred, Closed counted per week`
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(analytics): system problems and trends`.

### Task 12: Drill-down, saved views, definitions, catalogue and CSV export

**Files:**
- Create:
  - `app/src/analytics/drill.service.ts`, `views.service.ts`, `csv.ts`, `catalogue.ts`;
  - routes in `analytics.controller.ts`.
- Test:
  - `app/src/analytics/drill.http.test.ts`, `views.http.test.ts`;
  - `csv.test.ts`, `export.http.test.ts`;
  - `catalogue.db.test.ts`.

**Interfaces:**
- `GET /admin/analytics/drill?level=org|department|project&id=&measure=` returns `{ counts }`. At project level it also returns `records: {id,title,assignee,dueOn,link}[]` only when the Administrator has an Active role or Active grant there (`ProjectAccess` rechecked). Otherwise it returns `limited: 'Only counts are shown: you are not a participant in this project.'`.
- `GET`, `POST`, `PUT` and `DELETE /admin/analytics/views[/:id]` act on own rows only. Another user's id is a 404. `config` is normalised: unknown keys are dropped and nothing in it can widen what is shown.
- `GET /admin/analytics/definitions` returns `{ version, measures: MEASURE_DEFINITIONS, events: CATALOGUE }`.
- `csv.ts`:
  - `csvCell(v: string | number | null): string` (quoting plus the formula guard);
  - `toCsv(meta: Record<string,string>, columns: string[], rows: unknown[][]): string`.
- `GET /admin/analytics/export?panel=&…filters` returns `text/csv` with the filename `kainow-<panel>-<YYYY-MM-DD>.csv`.
  - It returns 403 with the message `Analytics export is turned off.` when `analyticsExportAllowed` is false.
  - It writes the audit event `analytics.exported` with `{ panel, filters }`.
- `catalogue.ts`:
  - `type CatalogueEntry = { name; table; version; area; meaning; actor; subject; measurements: string[] }`;
  - `CATALOGUE: readonly CatalogueEntry[]`.

  It covers every `writeAudit` action literal and every event-table kind or action CHECK list, plus the new events from Tasks 2, 8 and 12.

- [ ] **Step 1: Write the failing tests:**
  - **Drill:**
    - `non-participant admin gets counts and the limited message`;
    - `participant admin gets records`;
    - `Deleted task absent from records and counts`.
  - **Views:**
    - `own views CRUD; another user's view 404; name unique per user`.
  - **CSV:**
    - `csvCell guards = + - @ and quotes commas, quotes and newlines`;
    - `header lines start with # and carry version, computedAt and coverage`;
    - `export off is 403`;
    - `export writes analytics.exported without data`;
    - `CSV row equals the panel row`.
  - **Catalogue:**
    - `every writeAudit literal under app/src is in the catalogue`: scan the `.ts` sources with a regex for `action: '…'` inside `writeAudit(` calls, resolved from `process.cwd()`;
    - `every event-table CHECK value is in the catalogue`: read `pg_constraint` for the event tables;
    - `the catalogue names nothing that no longer exists`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(analytics): drill-down, saved views, definitions, catalogue and CSV export`.

### Task 13: Colour tokens, dark theme, accents and the web preference helpers

**Files:**
- Modify: `app/web/src/styles.css`, `app/web/src/App.tsx`, to set `data-theme` and `data-accent` on `<html>` from the preferences
- Create: `app/web/src/prefs.ts`, `app/web/src/views/Customise.tsx`
- Test: `app/web/src/prefs.test.ts`

**Interfaces:**
- `styles.css`: the 31 hard-coded colours become custom properties. `[data-theme="dark"]` overrides them, and `[data-accent="teal|blue|plum|slate"]` sets `--accent` and `--accent-contrast`.
- The dashed "AI proposed" outline and the authorised style keep their rules in every theme.
- `prefs.ts` (web):
  - `DEFAULT_PREFS` (the same shape as the server's);
  - `expansionDefault(shownCount: number, saved: boolean | undefined): boolean`, which returns `saved ?? shownCount <= 5`;
  - `moveSection(order, key, dir: 'up' | 'down')`, which never moves `needsYou`;
  - `contrastRatio(hexA, hexB): number`;
  - `ACCENTS`, the hex pairs for light and dark.
- `Customise.tsx` has:
  - theme and accent radio groups;
  - Move up and Move down buttons;
  - show or hide checkboxes;
  - Reset.

  It is keyboard-only operable, with no dragging. It saves through `PUT /me/preferences` on each change.

- [ ] **Step 1: Write the failing tests:**
  - `expansion: 6 shown collapses, 5 expands, saved wins`
  - `moveSection keeps needsYou first`
  - `every accent meets 4.5:1 text and 3:1 controls in both themes`, against the token values exported from `prefs.ts`, which `styles.css` must match. A web test reads `styles.css` and checks that the hex values agree.
- [ ] **Step 2: Run** `npm --prefix web test` (`node --test src/*.test.ts`). Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the web tests and `npm run build:web`. Expected: PASS and a clean build.
- [ ] **Step 5: Commit** with the message `feat(web): colour tokens, dark theme, accents and customise panel`.

### Task 14: Home, project figures and timeline screens

**Files:**
- Create:
  - `app/web/src/dashboard.ts`;
  - `app/web/src/views/Home.tsx`, `ProjectFigures.tsx`, `Timeline.tsx`, `Bars.tsx`.
- Modify:
  - `app/web/src/App.tsx`: `#/` renders `Home`; the menu item stays "My Projects"; add the route `#/projects/<id>/timeline`.
  - `app/web/src/views/ProjectPage.tsx`: add the Timeline tab and `ProjectFigures` on the Overview tab.
- Test: `app/web/src/dashboard.test.ts`

**Interfaces:**
- `dashboard.ts`:
  - `completionLabel(c: Completion): string`;
  - `onTimeLabel(o: OnTime): string`;
  - `plannedEndLabel(p: PlannedEnd): string`;
  - `updatedLabel(iso: string): string` (`Updated HH:MM UTC+8`);
  - `overdueDaysLabel(n)`.

  Each returns the exact copy of the Global Constraints.
- `Bars.tsx`: `<Bars items={{label, value, max, text}[]} caption />` renders CSS bars plus a visually hidden table. A missing value is never drawn as a zero bar: it is listed under the bars.
- `Home.tsx` shows Needs you, My tasks and My projects.
  - Projects are collapsible, using `<button aria-expanded>`, with Expand all and Collapse all.
  - The on-hold message is shown.
  - It has an "Include archived" toggle, and "Show completed" saved as a preference.
- The Timeline tab groups by month with a "Today" marker. It has kind toggles saved as a preference.

- [ ] **Step 1: Write the failing tests** for each label, using the exact copy: 62/31/50, `4 cancelled`, 32/40/80%, `Nothing due yet`, `Ended 3 days ago`, `No planned end date`, and `Updated 10:42 UTC+8` for `2026-11-19T02:42:00Z`.
- [ ] **Step 2: Run** the web tests. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers and screens.
- [ ] **Step 4: Run** the web tests and `npm run build:web`. Expected: PASS. Then check the screens in the browser at desktop width and at 375 px, by keyboard, in both themes.
- [ ] **Step 5: Commit** with the message `feat(web): personal dashboard, project figures and timeline`.

### Task 15: Leadership and access-settings screens

**Files:**
- Create:
  - `app/web/src/leadership.ts`;
  - `app/web/src/views/Leadership.tsx`, `LeadershipGrants.tsx`, `AccessSettings.tsx`.
- Modify: `app/web/src/App.tsx`, to add:
  - the `#/leadership` route and a "Leadership" menu item when `GET /leadership/me` has `hasGrant`;
  - the Administrator routes `#/leadership-grants` and `#/access-settings`, with menu items "Leadership access" and "Access and records".
- Test: `app/web/src/leadership.test.ts`

**Interfaces:**
- `leadership.ts`:
  - `grantStateLabel(state)`: `Scheduled`, `Active`, `Ended` or `Revoked`;
  - `scopeLabel(scope)`, where department scope adds `includes projects this department owns now and later`;
  - `visibleFields(prefs, LEADERSHIP_FIELDS)`, which keeps the required fields.
- `AccessSettings.tsx` shows the effective value, default and bounds for each setting, and a reason field. A change to the archive delay calls the preview and lists the projects that would change before Save is enabled. The invitation setting is labelled `Project invitations`.

- [ ] **Step 1: Write the failing tests:**
  - `scope label wording`
  - `required fields cannot be hidden`
  - `state labels`
- [ ] **Step 2: Run** the web tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the web tests and `npm run build:web`. Expected: PASS. Then check in the browser.
- [ ] **Step 5: Commit** with the message `feat(web): leadership summary, leadership access and access settings screens`.

### Task 16: Analytics and definitions screens

**Files:**
- Create: `app/web/src/analytics.ts`, `app/web/src/views/Analytics.tsx`, `Definitions.tsx`
- Modify: `app/web/src/App.tsx`, to add `#/admin/analytics`, `#/admin/analytics/definitions` and the "Analytics" menu item
- Test: `app/web/src/analytics.test.ts`

**Interfaces:**
- `analytics.ts`:
  - `filtersToQuery(f): string` and `queryToFilters(q): Filters`, which round-trip;
  - `PERIOD_LABELS`;
  - `sortRows(rows, column, dir)`, which puts "Nothing due yet" last in both directions;
  - `chartTableEquivalent(series)`, which returns the table rows behind a chart.
- `Analytics.tsx` has:
  - the filters;
  - the five panels, with show, hide, reorder and chart/table switches;
  - saved views and Reset;
  - a "Download CSV" link per table;
  - drill-down with the limited message;
  - an "About these figures" note per panel;
  - an AI usage link to the existing view.

- [ ] **Step 1: Write the failing tests:**
  - `filters round-trip`
  - `nothing-due sorts last`
  - `chart and table carry the same numbers`
- [ ] **Step 2: Run** the web tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the web tests and `npm run build:web`. Expected: PASS. Then check in the browser.
- [ ] **Step 5: Commit** with the message `feat(web): Administrator analytics and definitions`.

### Task 17: Cross-surface consistency and leak suites

**Files:**
- Test: `app/src/dashboards/consistency.http.test.ts`, `app/src/dashboards/leaks.http.test.ts`

**Interfaces:**
- Consumes every endpoint from Tasks 4–12. No production code is expected. A failure here is fixed in the owning module, with that fix committed in this task.

- [ ] **Step 1: Write the consistency test.** One seeded project has:
  - 50 leaves: 31 Completed, 4 Cancelled, some late, 2 awaiting review;
  - Deleted and held tasks.

  `task completion and On-time are identical` across:
  - the personal header;
  - the project dashboard;
  - the leadership card;
  - the analytics progress row;
  - the CSV row.
- [ ] **Step 2: Write the leak tests.** One `describe` per surface: personal, project, timeline, leadership, each analytics panel, drill-down, CSV. Each item carries a unique marker word, as in `history/leaks.http.test.ts`. Each surface is first shown to display the item before it is deleted or held. The cases:
  - a Deleted task, question and risk, and an uncleaned held record, are absent from lists, counts and text;
  - a cleaned held record shows its label;
  - a leadership holder gets 404 from content routes, sees nothing out of scope, and loses access at expiry, on revocation and on account disablement;
  - a non-participant Administrator gets counts only;
  - no response or CSV contains source text, message text, quotes, private AI questions or credential text.
- [ ] **Step 3: Run** `npm test`. Expected: PASS. Fix any failure at its source.
- [ ] **Step 4: Commit** with the message `test(dashboards): consistency and leak suites across every surface`.

### Task 18: Bench

**Files:**
- Create: `app/src/dashboards/bench-cli.ts`
- Modify: `app/package.json`, adding `"bench-dashboards": "node dist/dashboards/bench-cli.js"`

**Interfaces:**
- The bench uses its own database, as `src/quarantine/bench-cli.ts` does. It seeds 200 users, 100 projects, 30,000 tasks with subtasks, 3,000 risks and a year of events.
- It times p95 over 50 runs each for:
  - `GET /dashboard/me` (a user in 10 projects);
  - `GET /projects/:id/dashboard`;
  - each analytics panel;
  - `GET /dashboard/leadership` (organisation scope).
- It prints met or missed against the aims of 300, 200, 500 and 500 ms.

- [ ] **Step 1: Write the bench**, following the pattern of `quarantine/bench-cli.ts`.
- [ ] **Step 2: Run** `npm run build && npm run bench-dashboards`, in the background if it runs long. Expected: a p95 table.
- [ ] **Step 3: Respond to a missed aim.** Add indexes (in 0029 if not yet merged) or tighten queries, then run again. If an aim is still missed, record it as missed. Do not change the aims.
- [ ] **Step 4: Record the results**, met or missed, in spec §14.
- [ ] **Step 5: Commit** with the message `perf(dashboards): bench and results`.

### Task 19: Documents

**Files:**
- Modify:
  - `docs/Kainow-V1.0-Consolidated-Specification.md` (§14: D88, D89, D90 as approved);
  - `docs/Kainow-V1.0-Permission-Matrix.md` (§5 and §8: the §11 rows);
  - `docs/Kainow-V1.0-Configuration-Catalogue.md` (C58–C60 and C64 point to the design; access settings and bounds added);
  - `docs/Kainow-V1.0-Remaining-Design-and-Verification-Register.md` (R17 designed for dashboards and the leadership catalogue; resources and finance stay with 8, operations panels with 10);
  - `app/README.md` (new screens, `bench-dashboards`, access settings).

- [ ] **Step 1: Make the edits**, copying the decision texts from spec §2.1, with D90 marked approved on 19 November 2026.
- [ ] **Step 2: Run** `npm test` once more on the whole branch. Expected: PASS.
- [ ] **Step 3: Commit** with the message `docs(dashboards): decision register, permission matrix, configuration catalogue, R17 and README`.
