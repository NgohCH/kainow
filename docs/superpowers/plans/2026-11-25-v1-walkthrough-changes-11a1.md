# 11a.1 Walkthrough Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Product Owner's walkthrough changes before v0.1.

**Architecture:** One additive migration (0040); extensions to the records, projects, dashboards and users services; two new pages and one preference in the web app, using the 11a building blocks.

**Tech Stack:** NestJS/TypeScript, PostgreSQL 16, React 19/Vite 8 (no new dependency).

**Spec:** docs/superpowers/specs/2026-11-25-v1-walkthrough-changes-11a1-design.md

## Global Constraints

- No new npm dependency. No permission, audience or lifecycle rule becomes wider. Every existing `#/…` address keeps working.
- No real organisation name or domain anywhere; dummy data uses "Example Organisation" and `example.org`.
- Next free numbers: decisions D133–D139, catalogue C114–C115, migration `0040_walkthrough.sql` (check again on main before merging). Shipped migrations are never edited.
- New text columns: in the quarantine registry, credential-checked on entry, length limits in the relaxed form of 0039. Audit detail holds ids, kinds and counts only.
- Colours only in the token block of `styles.css`, mirrored in `prefs.ts`, contrast-checked: text 4.5:1, edges 3:1. Never colour alone. No sideways page scroll at 375 px.
- Dates in UTC+8.
- Server tests: `cd app && npx tsc -p tsconfig.json && node --test --test-concurrency=1 dist/<path>.test.js` with `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kainow_test_sp11`, `KAINOW_TEST_PG_DOCKER=kainow-testdb`; one test process at a time; no other session's database. Web: `cd app/web && npm test && npm run build`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A task whose project the viewer lost access to: the task page gives the same refusal as `GET /records/tasks/:id`, with no title (Task 2).
2. A description near 4,000 characters holding a short secret: cleaning succeeds and restores (Task 1).
3. A person whose department is retired afterwards: the profile still loads and saves other changes (Task 3).
4. Renaming a stage while another person changes to it: one wins, the other gets a plain message, never two names for one period (Task 5).
5. A project deferred, resumed, then closed: each bar stops on the right day, with no negative or doubled days (Task 6).

---

### Task 1: Migration 0040 and the unique-name rule

**Files:** Create `app/migrations/0040_walkthrough.sql`, `app/src/db/walkthrough-schema.test.ts`; Modify `app/src/db/migrate.test.ts`, `app/src/quarantine/registry.ts`, `registry.db.test.ts`, `clean.db.test.ts`.

**Interfaces — Produces:** `tasks.description text NULL` and `human_proposals.description text NULL` (each NULL or non-blank and ≤ 4000, relaxed form); `users.department_id uuid NULL REFERENCES departments`; `project_stage_changes` accepts kind `renamed`; unique indexes on registered text columns recreated with `AND strpos(<col>, '[credential removed]') = 0`.

- [ ] Tests (RED): columns and limits (4,001 characters refused, blank refused); two stages in one project that differ only in two secrets both clean without error and restore; a permanent registry test listing every unique index containing a registered text column without the marker exception (must be empty, and not vacuous); cleaning and restoring a 4,000-character description on both tables.
- [ ] Implement. A UNIQUE table constraint becomes a partial unique index only after checking that no `ON CONFLICT` relies on it; adjust any that does.
- [ ] Run migrate, quarantine/*, projects and resources tests: PASS. Commit `feat(db): walkthrough columns; unique names no longer stop cleaning`.

### Task 2: Task description and the full task reply (server)

**Files:** Modify `app/src/records/records.service.ts`, `records.controller.ts`, `app/src/changes/task-handlers.ts`, the human-proposal and authorise paths; Create `app/src/records/task-page.http.test.ts`; existing records and changes tests.

**Interfaces — Produces:** `GET /records/tasks/:id` → `{ task: TaskView & { description: string | null }, history, parent: {id,title}|null, subtasks: {id,title,status,dueOn}[], authorised: {by,at}, blocked: {reason,by,at}|null, proposal: { kind:'run', runId, itemId } | { kind:'human', proposalId } | null }`. `description?` accepted by `POST /projects/:id/proposals` (actions), both authorise routes (actions), and `amend_task` terms (task and subtask). `GET /projects/:id/records`: each record gains `proposal` in the same shape.

- [ ] Tests (RED): description through each path; refused over 4,000 and with a credential, blank stored as null; amending records previous and new; blocked reason is the latest block and null once unblocked; a non-member, a held member and a grant holder get exactly today's answers; `proposal` is null for someone who may not open the proposal.
- [ ] Implement; run records, changes, extraction, search tests: PASS. Commit `feat(records): task description and full task reply (D133)`.

### Task 3: Profile and department (server)

**Files:** Create `app/src/users/profile.service.ts`, `profile.controller.ts`, `profile.http.test.ts`; Modify `users.service.ts`, `users.controller.ts`, analytics audit catalogue.

**Interfaces — Produces:** `GET /me/profile` → `{ name, email, department: {id,name,retired}|null, roles: { projectId, projectName, role, since, until: string|null, canOpen }[], pastRoles: { projectId, projectName, role, since, endedOn }[] }`; `PUT /me/department {departmentId|null}`; `PUT /users/:id/department` (Enterprise Administrator only); `GET /users` rows gain `department`. Audit `person.department_changed` (ids only).

- [ ] Tests (RED): current and past split at expiry and revocation (UTC+8 day); a future start is listed as current with its since date; a retired or unknown department refused (400) on save but shown if already held; a Member's `PUT /users/:id/department` 403; setting a department changes no project access (compare readable projects before and after); no one can read another person's profile.
- [ ] Implement; run users, auth, organisation, analytics tests: PASS. Commit `feat(users): my profile and department (D134)`.

### Task 4: Due soon everywhere; tab-style preference (server)

**Files:** Modify `app/src/dashboards/measures.ts`, `personal.service.ts`, `preferences.ts`, tests.

**Interfaces — Produces:** one `dueSoonEnd(today, calendar)` used by measures, My tasks and Needs you; `Prefs.tabStyle: 'boxes' | 'grey' | 'tinted'`, default `'boxes'`, unknown values → `'boxes'`.

- [ ] Tests (RED): a task 9 calendar days ahead but 7 working days ahead is due soon in all three; one at 8 working days in none; a holiday in the project calendar shifts all three; the reminder email test unchanged; preference round trip.
- [ ] Implement; run dashboards, notifications, leadership, analytics tests: PASS. Commit `feat(dashboards): one due-soon rule; tab style preference (D135, D139)`.

### Task 5: Rename a stage (server)

**Files:** Modify `app/src/projects/projects.service.ts`, `projects.controller.ts`, `project-stages.http.test.ts`.

**Interfaces — Produces:** `POST /projects/:id/stages/:stageId/rename {name, reason}` through the existing `changeStages` lock; renames `project_stages.name` and that project's `project_stage_periods.stage` in one transaction; `stageChanges` gains kind `renamed` with previous and next.

- [ ] Tests (RED): active and retired stage; current period renamed; a change of letter case allowed for the stage itself; another stage's name refused; Member 403; Closed, Deferred, archived refused; over 80 and credential refused; template and other projects untouched; two concurrent changes leave one consistent name.
- [ ] Implement; run projects and dashboards tests: PASS. Commit `feat(projects): rename a stage (D137)`.

### Task 6: Where stages stop; project history fields (server)

**Files:** Create `app/src/projects/stage-periods.ts` and test; Modify `app/src/dashboards/timeline.service.ts`, `measures.ts`, `app/src/projects/projects.service.ts`, tests.

**Interfaces — Produces:** pure `clipPeriods(periods, transitions)` → periods with `endedOn` and `stopped: 'deferred'|'closed'|null`, used by timeline `stagePeriods`, project detail `stagePeriods` and the stage measure; project summary gains `deferred: {on, reason}|null`, `closed: {on, outcome}|null`.

- [ ] Tests (RED): deferred; closed; deferred then resumed then closed; closed then reopened; deferred and resumed the same day; draft project with no transitions; `stage.days` stops at the deferral; a Deferred project's `reason` shown only to those who see it in project detail today.
- [ ] Implement; run projects, dashboards, leadership tests: PASS. Commit `feat(projects): a stage stops when its project is deferred or closed (D138)`.

### Task 7: Task page (web)

**Files:** Create `app/web/src/views/TaskPage.tsx`, `app/web/src/taskPage.ts`, `taskPage.test.ts`; Modify `App.tsx`, `ProjectPage.tsx`, `Work.tsx` (share `TaskDetails`), the proposal, authorise and amend forms, and every task link in spec §4 (web and server: `personal.service.ts`, `digest.ts`, `summaries.ts`, `search/query.ts`, `drill.service.ts`).

**Interfaces — Produces:** `taskHref(projectId, taskId)`; `statusMeaning(status): string`.

- [ ] Tests (RED): `taskHref`; `statusMeaning` for all five statuses; the Blocked sentence; server link tests for tasks versus other kinds; the old Work address still parses.
- [ ] Implement; `npm test`, build; affected server tests; demo at 1280 and 375 px: block and unblock a task. Commit `feat(web): task page (D133)`.

### Task 8: My profile and tab styles (web)

**Files:** Create `app/web/src/views/MyProfile.tsx`; Modify `App.tsx`, `ui/PersonMenu.tsx`, `views/People.tsx`, `views/Customise.tsx`, `prefs.ts`, `prefs.test.ts`, `styles.css`, `ui/menu.ts`.

- [ ] Tests (RED): `#/me` route and no highlighted menu entry; `data-tabs` attribute from preferences; contrast of each style's edges, text and badges in every scheme, Light and Dark; the open tab differs by more than colour.
- [ ] Implement; `npm test`, build; demo: change department, colour scheme and each tab style; keyboard through the menu. Commit `feat(web): my profile and tab styles (D134, D135)`.

### Task 9: Links between proposals, sources and Work (web)

**Files:** Modify `ProjectProposals.tsx`, `Review.tsx`, `HumanProposals.tsx`, `Work.tsx`, `TaskPage.tsx`; server `proposal-runs` gains `sourceKind` and the parts of the source address.

- [ ] Tests (RED): source address for note, minutes, summary and discussion; record address per kind; no link when the source is restricted; `proposal-runs` leak test extended.
- [ ] Implement; `npm test`, build; extraction and notes tests; demo: proposal → source, proposal → record, record → proposal. Commit `feat(web): proposals, sources and records link to one another (D136)`.

### Task 10: Rename stage, project history, stopped bars (web)

**Files:** Modify `ProjectStages.tsx`, `Projects.tsx`, `Home.tsx`, `ui/home.ts`, `ui/stages.ts`, `ui/timelineBars.ts`, `TimelineBars.tsx`, tests.

- [ ] Tests (RED): current/Deferred/Closed/archived grouping; Home lists current only; a stopped bar is not Current, ends on its day and says why; stage flow for a Deferred project; rename draft checks.
- [ ] Implement; `npm test`, build; demo: rename a stage, defer and close a test project. Commit `feat(web): stage rename, project history, stopped stages (D137, D138)`.

### Task 11: Checks and documents

- [ ] Accessibility audit: task page (each status), My profile, Projects History, rename form, three tab styles (1200 and 375 px, Light and Dark); the audit fails on any violation or sideways scroll.
- [ ] Browser smoke follows a task link, the profile and each tab style; run in the four browsers.
- [ ] Documents: D133–D139, C114–C115, INSTALL.md, app/README.md, CHANGELOG, screenshots; tests for the two 11a fixes left unchecked (AI limits first save, Deliveries count).
- [ ] Full server suite once at the end, in the background. Commit `docs: 11a.1 decisions, catalogue and checks`.
