# V1.0 Sub-project 1: Projects, Roles and Permissions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every note, run and proposal inside a project, with projects, a lifecycle, the five core project roles, invitations and memberships, and one central permission check that enforces the accepted V1.0 matrix.

**Architecture:** Pure rule modules (`membership.ts` for dates and roles, `matrix.ts` for the permission table, `lifecycle.ts` for transitions) hold every rule and are unit-tested exhaustively. A `ProjectAccess` service loads a person's memberships and a project's state and applies those rules (`authorize`, `visibleProjectIds`). Project, membership and invitation services and controllers use it, and the existing notes and extraction services call it instead of the old administrator-only route check.

**Tech Stack:** TypeScript, NestJS, PostgreSQL 16 (plain SQL migrations), `node:test`, React + Vite.

**Spec:** `docs/superpowers/specs/2026-11-08-v1-projects-roles-permissions-design.md`

## Global Constraints

- Dates are calendar days `'YYYY-MM-DD'` in UTC+8. "Today" is `todayUtc8(now)` from the injected clock, never `new Date()` directly. Membership starts at 00:00 UTC+8 on `starts_on`; a date-only `expires_on` ends access at 00:00 UTC+8 after that date (the membership is Active on `expires_on`, Expired the day after).
- Invitations expire exactly 7 × 24 hours after `issued_at`.
- Membership, invitation and stage start dates may not precede the project's creation date (UTC+8).
- History tables (`project_transitions`, `membership_events`, `project_stage_periods` rows once ended) are append-only; enforce with triggers like migration 0009.
- A person without an Active membership in a project gets **404 "Project not found"** for that project's content, so its existence is not revealed. A participant without the needed role gets **403** with the matrix's reason. The administrator-only organisation actions keep the existing route-level check.
- Every refusal message is a full sentence a person can act on. Exact texts are in Task 2.
- No note content in audit details. Audit actions use the `project.*`, `membership.*`, `invitation.*`, `department.*`, `domain.*` families.
- Pre-project notes (`sources.project_id IS NULL`) are visible to nobody, through any route.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `v1/projects-roles`.

## Running the tests

Server (from `app/`), with the throwaway database:

```bash
docker run -d --rm --name kainow-testdb -e POSTGRES_PASSWORD=test -e POSTGRES_DB=kainow_test -p 127.0.0.1:55432:5432 postgres:16
```

```bash
rm -rf dist && KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kainow_test npm test
```

(`rm -rf dist` first: stale compiled tests from other branches otherwise run too.) Web (from `app/web/`): `npm test` and `npm run build`.

## Review Focus

1. **Date boundaries in UTC+8**: a membership with `starts_on = 2026-11-10` is Scheduled at 2026-11-09T15:59:59Z and Active at 2026-11-09T16:00:00Z; one with `expires_on = 2026-11-10` is Active at 2026-11-10T15:59:59Z and Expired at 2026-11-10T16:00:00Z. (Task 2)
2. **One person holding several roles** counts once for the small-team limit, and the PM may never be the only Member. (Task 2)
3. **Lists never leak**: project, note and run lists for a non-member, a revoked member and an administrator without a role contain nothing from that project, and pre-project notes appear for nobody. (Tasks 3 and 5)
4. **Invitation links are single use**: a used, replaced, revoked or expired token, or a token presented by a different signed-in email, never creates a membership. (Task 4)
5. **Concurrent appointment**: two requests that would each create the project's only Owner, or the seventh person, cannot both succeed; the second is refused. (Task 4)

---

### Task 1: Migration 0012

**Files:**
- Create: `app/migrations/0012_projects_roles.sql`
- Modify: `app/src/db/migrate.test.ts` (add to `REAL_FILES`)
- Test: `app/src/db/projects-schema.test.ts` (database test, same setup as `due-schema.test.ts`)

**Interfaces:**
- Produces tables and columns exactly as the spec's "Records" table: `departments`, `eligible_domains`, `projects`, `project_departments`, `project_stage_periods`, `project_transitions`, `memberships`, `membership_events`, `invitations`; `sources.project_id uuid NULL REFERENCES projects(id)`; `users.role` check widened to `('enterprise_administrator', 'member')`.
- Constraints: `projects.closure_outcome` non-null exactly when `status = 'closed'`; `memberships` unique on `(project_id, user_id, role)`; `memberships.expires_on IS NULL OR expires_on >= starts_on`; `invitations.token_hash` unique; at most one stage period per project with `ended_at IS NULL` (partial unique index); `departments.name` unique among active (partial unique index on `lower(name)` where status = 'active'); `eligible_domains.domain` unique where `removed_at IS NULL`.

- [ ] **Step 1: Write the failing schema tests**: `project_transitions` and `membership_events` refuse UPDATE and DELETE (`23001`); a second open stage period for a project fails (`23505`); a closed project without an outcome and an open project with one fail (`23514`); a membership expiring before it starts fails (`23514`); two active departments named `Registry` and `registry` fail (`23505`) while a retired one does not block; inserting a user with role `member` succeeds; a source with `project_id` null still inserts.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Add `'0012_projects_roles.sql'` to `REAL_FILES`; full server suite passes.**
- [ ] **Step 5: Commit** (`Add records for departments, domains, projects, memberships and invitations`).

---

### Task 2: Rules: membership dates, required roles, separation, the matrix and transitions

**Files:**
- Create: `app/src/projects/membership.ts`, `app/src/projects/matrix.ts`, `app/src/projects/lifecycle.ts`
- Test: `app/src/projects/membership.test.ts`, `app/src/projects/matrix.test.ts`, `app/src/projects/lifecycle.test.ts` (pure, no database)

**Interfaces:**
- Produces:

```ts
// membership.ts
export type ProjectRole = 'pm' | 'deputy_pm' | 'owner' | 'sponsor' | 'member';
export type MembershipState = 'scheduled' | 'active' | 'expired' | 'revoked';
export interface MembershipRow { userId: string; role: ProjectRole; startsOn: string; expiresOn: string | null; revokedAt: Date | null }
export function todayUtc8(now: Date): string;
export function membershipState(m: MembershipRow, today: string): MembershipState;
export function effectiveRoles(rows: MembershipRow[], userId: string, today: string): ProjectRole[];  // Active only
export function requiredRolesCheck(rows: MembershipRow[], today: string, mode: 'accepted' | 'active'): { ok: boolean; missing: string[] };
export function separationCheck(rows: MembershipRow[], today: string): { ok: boolean; reason: string | null };

// matrix.ts
export type ProjectStatus = 'draft' | 'planned' | 'active' | 'deferred' | 'closed';
export type ProjectAction = 'project.view' | 'project.edit' | 'project.stage' | 'note.import' | 'note.view'
  | 'extraction.run' | 'proposal.edit' | 'meeting_date.set' | 'proposal.review';
export const PROJECT_MATRIX: Record<ProjectAction, { roles: ReadonlyArray<ProjectRole | 'participant'>; states: ReadonlyArray<ProjectStatus>; refusal: string }>;
export const ROLE_MANAGERS: Record<ProjectRole, ReadonlyArray<ProjectRole | 'administrator'>>;
export function decide(input: { action: ProjectAction; roles: ProjectRole[]; status: ProjectStatus }): { allowed: true } | { allowed: false; reason: string };
export function canManageRole(input: { target: ProjectRole; roles: ProjectRole[]; isAdmin: boolean; status: ProjectStatus }): { allowed: true } | { allowed: false; reason: string };

// lifecycle.ts
export interface TransitionRequest { from: ProjectStatus; to: ProjectStatus; roles: ProjectRole[]; isAdmin: boolean; reason: string | null;
  outcome: 'delivered' | 'partially_delivered' | 'abandoned' | null; stage: string | null; fastTrack: boolean;
  requiredAccepted: boolean; requiredActive: boolean; separationOk: boolean }
export function checkTransition(r: TransitionRequest): { allowed: true } | { allowed: false; reason: string };
export const STAGES: readonly string[];  // 'Initiation', 'Planning', 'Execution', 'Review & Acceptance', 'Closure'
```

- Matrix rows and refusal texts (exact):

| Action | Roles | States | `refusal` |
| --- | --- | --- | --- |
| `project.view`, `note.view` | participant | all five | (not used: non-participants get 404) |
| `project.edit` | pm, owner, sponsor | draft, planned, active | `Only the Project Manager, Owner or a Sponsor can change the project's details, and not while it is Deferred or Closed.` |
| `project.stage` | pm | active | `Only the Project Manager can change the stage, and only while the project is Active.` |
| `note.import`, `extraction.run` | pm, deputy_pm, owner, sponsor | draft, planned, active | `Only the Project Manager, a Deputy, the Owner or a Sponsor can add notes or run extraction, and not while the project is Deferred or Closed.` |
| `proposal.edit`, `meeting_date.set` | pm, owner, sponsor | draft, planned, active | `Only the Project Manager, Owner or a Sponsor can edit proposals, and not while the project is Deferred or Closed.` |
| `proposal.review` | owner, sponsor | planned, active | `Only the Owner or a Sponsor can approve or reject proposals, and only while the project is Planned or Active.` |

- `ROLE_MANAGERS`: owner ← administrator; sponsor ← administrator, owner; pm ← administrator, owner, sponsor; deputy_pm, member ← pm, owner, sponsor. Role management is allowed only in draft, planned, active; refusal `Only <list> can manage the <role> role, and not while the project is Deferred or Closed.`
- `requiredRolesCheck` `missing` texts: `a Project Manager`, `a Member who is not the Project Manager`, `an Owner or a Sponsor`; `accepted` mode counts Scheduled and Active, `active` mode counts Active only. Exactly one PM.
- `separationCheck`: distinct people over Scheduled and Active rows; if 7 or more and any one person holds two of pm/owner/sponsor, `{ ok: false, reason: 'With seven or more people, the Project Manager, Owner and Sponsors must be different people.' }`.
- `checkTransition` reasons (exact), checked in this order: unknown pair `That status change is not allowed.`; actor `Only <list> can <verb>.` (lists and verbs from the spec's transition table; Deferred → Active includes the administrator; a person holding owner or sponsor qualifies even if also pm); missing reason `A reason is required.` (all except Draft → Planned and Planned → Active); missing outcome `Choose a closure outcome.`; Planned → Closed with other outcome `A project closed from Planned can only be Abandoned.`; missing stage on resume/reopen `Choose the stage to continue in.`; roles not accepted `The required roles are not all accepted yet.`; roles not active `The required roles are not all active yet.`; separation `With seven or more people, the Project Manager, Owner and Sponsors must be different people.`; Draft → Active without `fastTrack` is the fast-track path and needs the PM.

- [ ] **Step 1: Write the failing tests**
  - `membership.test.ts`: the boundary instants in Review Focus 1; revoked wins over dates; `effectiveRoles` returns only Active rows' roles for that user; `requiredRolesCheck` in both modes (PM alone fails "a Member who is not the Project Manager"; two PMs fail "a Project Manager"; owner-or-sponsor either satisfies); `separationCheck` at 6 people with combined PM+Owner ok, at 7 not ok, at 7 with distinct people ok, one person in three roles counts once (Review Focus 2).
  - `matrix.test.ts`: **generated** — for every `ProjectAction` × every `ProjectRole` × every `ProjectStatus`, `decide` allows exactly when the role is in the row (or the row is `participant`) and the status is in the row, and the refusal text equals the row's; `canManageRole` for every target × manager × admin flag × status against `ROLE_MANAGERS`.
  - `lifecycle.test.ts`: each of the nine transitions allowed with its correct actor and inputs; each refused for a wrong actor; every other `from → to` pair refused; each missing-input refusal text; small-team PM who also holds owner can close; administrator can resume Deferred but not close or reopen Closed.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement the three modules.**
- [ ] **Step 4: Run; all pass; full suite passes.**
- [ ] **Step 5: Commit** (`Add the project rules: membership dates, required roles, separation, matrix and transitions`).

---

### Task 3: Access service, departments, domains, projects and lifecycle API

**Files:**
- Create: `app/src/projects/access.service.ts`, `app/src/projects/projects.service.ts`, `app/src/projects/projects.controller.ts`, `app/src/projects/organisation.service.ts`, `app/src/projects/organisation.controller.ts`, `app/src/projects/projects.module.ts`
- Modify: `app/src/app.module.ts` (import `ProjectsModule`), `app/src/auth/permissions.ts` (add `organisation.manage` for the administrator)
- Create: `app/src/testing/projects.ts` (test helper)
- Test: `app/src/projects/organisation.http.test.ts`, `app/src/projects/projects.http.test.ts`, `app/src/projects/lifecycle.http.test.ts`

**Interfaces:**
- Consumes: Task 2 modules.
- Produces:

```ts
export class ProjectAccess {
  /** Throws NotFoundException('Project not found') for non-participants (admins included unless isAdminAction), ForbiddenException(reason) otherwise. */
  authorize(userId: string, action: ProjectAction, projectId: string): Promise<ProjectContext>;
  context(userId: string, projectId: string): Promise<ProjectContext>;           // no action check; 404 if not participant and not admin
  visibleProjectIds(userId: string): Promise<string[]>;                        // Active memberships today
  projectOfSource(sourceId: string): Promise<string>;                          // 404 if null project
  projectOfRun(runId: string): Promise<string>;
}
export interface ProjectContext { project: { id: string; status: ProjectStatus; createdOn: string }; roles: ProjectRole[]; isAdmin: boolean;
  rows: MembershipRow[]; today: string; missingAccountability: boolean }
// test helper (src/testing/projects.ts)
export async function seedProject(pool: Pool, opts: { status?: ProjectStatus; members: Array<{ userId: string; role: ProjectRole; startsOn?: string; expiresOn?: string; revoked?: boolean }> }): Promise<string>;
export async function seedUser(pool: Pool, email: string, role?: 'enterprise_administrator' | 'member'): Promise<string>;
```

- Routes (all `@AnySignedInUser()` except the organisation ones):
  - `GET/POST /departments`, `POST /departments/:id/rename`, `POST /departments/:id/retire` — `@RequireAction('organisation.manage')`.
  - `GET/POST /domains`, `POST /domains/:id/remove` — `@RequireAction('organisation.manage')`.
  - `GET /projects` — the person's visible projects with status, current stage, their roles, `missingAccountability`; for an administrator also every project's id, name, status and role holders (`adminView: true`), never content.
  - `POST /projects` `{ name, purpose, owningDepartmentId, contributingDepartmentIds?, plannedEnd? }` — any signed-in person; the creator becomes PM (starts today, no expiry). If no project exists yet, only an administrator may create (spec: the administrator creates the first project), and the administrator does not become PM; they appoint roles. Creation opens the first stage period in Initiation and records a `project.created` audit entry.
  - `GET /users` (existing, administrators) lists administrator accounts only; `member` accounts are managed through projects.
  - `GET /projects/:id` — `project.view`; details, stage periods, transitions, memberships with states, allowed transitions for this person.
  - `POST /projects/:id/edit` — `project.edit`.
  - `POST /projects/:id/transition` `{ to, reason?, outcome?, stage?, fastTrack? }` — computes inputs from `ProjectContext` and calls `checkTransition`; writes `project_transitions`, starts a new stage period on resume/reopen, sets/clears `closure_outcome`; audit `project.transition`.
  - `POST /projects/:id/stage` `{ stage, substage?, reason? }` — `project.stage`.

- [ ] **Step 1: Write the failing tests**
  - organisation: only administrators manage departments/domains; rename keeps id; retired department cannot be chosen for a new project but stays on an old one; duplicate active name refused; removed domain no longer listed.
  - projects: creation rules (first project by administrator only; later by anyone, creator becomes PM); required fields refused when missing; `GET /projects` for member, non-member, revoked member, administrator (Review Focus 3); 404 for a non-member's `GET /projects/:id`; edit by PM allowed, by Member 403 with the matrix text.
  - lifecycle: each of the nine transitions through the API with seeded members; history rows written; resume/reopen starts a new stage period; Deferred project refuses `project.edit`; `missingAccountability` true on an Active project whose Owner expired.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** `ProjectAccess` loads `projects` and the project's `memberships` in one call, computes `today` from the injected clock, and derives everything else with Task 2 functions.
- [ ] **Step 4: Run; full suite passes.**
- [ ] **Step 5: Commit** (`Add departments, eligible domains, projects and the lifecycle API`).

---

### Task 4: Memberships, role management and invitations

**Files:**
- Create: `app/src/projects/memberships.service.ts`, `app/src/projects/invitations.service.ts`, `app/src/projects/members.controller.ts`, `app/src/projects/invitations.controller.ts`
- Modify: `app/src/auth/code-senders.ts` (add `sendInvitation(email, link, projectName, role, expiresAt)` to the sender interface; the log sender prints the link; the SMTP sender sends a plain message), `app/src/users/users.service.ts` (`createMember(email, displayName)`)
- Test: `app/src/projects/members.http.test.ts`, `app/src/projects/invitations.http.test.ts`

**Interfaces:**
- Consumes: `ProjectAccess` (Task 3), `canManageRole`, `requiredRolesCheck`, `separationCheck` (Task 2).
- Routes:
  - `POST /projects/:id/members` `{ userId, role, startsOn, expiresOn? }` — appoint an existing user directly (the administrator appointing Owner/Sponsor/PM, or a manager appointing an existing account holder); `canManageRole`; dates not before project creation; one PM (appointing a new PM ends the current PM's membership today in the same transaction, with events); at most one Owner; separation re-checked including the new row.
  - `POST /memberships/:id/extend` `{ expiresOn }`, `POST /memberships/:id/dates` `{ startsOn, expiresOn? }`, `POST /memberships/:id/revoke` `{ reason }` — manager of that role; events record previous/new values.
  - `POST /projects/:id/invitations` `{ email, role, startsOn, expiresOn?, displayName? }` — manager of that role; email domain must be eligible (`That address is not in an eligible organisation domain.`); refused while Deferred/Closed.
  - `POST /invitations/:id/resend`, `POST /invitations/:id/revoke`.
  - `GET /invitations/by-token/:token` (`@Public`) — project name, role, dates, status and expiry only (no other project data).
  - `POST /invitations/by-token/:token/accept`, `.../decline` (`@AnySignedInUser`) — the signed-in email must equal the invitation's (`This invitation was sent to a different email address.`). Accept creates the membership and, for a new address, the account must already exist from sign-in: sign-in for an address with no account but an open invitation creates a `member` account at code verification (the only self-service account creation).
- Concurrency: appointments, acceptances and PM replacement lock the project row (`SELECT ... FROM projects WHERE id = $1 FOR UPDATE`) before re-reading memberships and checking the rules (Review Focus 5).
- Sign-in change: `AuthService.requestCode` sends a code to an address with no account only when an unexpired, unrevoked invitation for that address exists and its domain is eligible; verification then creates the `member` account. All other unknown addresses stay silent as today. (Decision: the spec says the account is created at acceptance; it is created one step earlier, at code verification, because accepting needs a signed-in session. An invitee who then declines keeps an account with no project access.)

- [ ] **Step 1: Write the failing tests**
  - members: each role's managers allowed and others refused (403 text from `canManageRole`); appointing a second Owner refused (`A project can have only one Owner.`); a new PM replaces the old one with events; dates before creation refused (`Membership dates cannot be before the project was created.`); extend/revoke write events with previous/new dates; the seventh person refused while a combination exists; **two concurrent Owner appointments: exactly one succeeds**.
  - invitations: issue (eligible domain only) and the log shows the link; accept by the invited existing user creates an Active membership; future `startsOn` gives Scheduled; a brand-new address can request a code, verify, and accept; decline recorded; resend voids the old token (old link → `This invitation link is no longer valid.`); revoke; expiry at exactly 7 days (clock advanced 7 days minus 1 second accepts, 7 days refuses); acceptance refused while Deferred and Closed, after the domain is removed, for a different signed-in email, and a second time with the same token (Review Focus 4).
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; full suite passes.**
- [ ] **Step 5: Commit** (`Add project memberships, role management and invitations`).

---

### Task 5: Notes, extraction and review inside projects

**Files:**
- Modify: `app/src/notes/notes.controller.ts`, `app/src/notes/notes.service.ts`, `app/src/extraction/extraction.controller.ts`, `app/src/extraction/extraction.service.ts`, `app/src/auth/permissions.ts` (remove `note.import`, `note.view`, `extraction.run`, `proposal.review` from the organisation catalogue; they are project actions now)
- Modify tests: `app/src/notes/notes.http.test.ts`, `app/src/extraction/extraction.http.test.ts`, `review.http.test.ts`, `edit.http.test.ts`, `due.http.test.ts` — set up a project with `seedProject` and act as its members
- Test: `app/src/projects/scoping.http.test.ts`

**Interfaces:**
- Consumes: `ProjectAccess.authorize`, `projectOfSource`, `projectOfRun`, `visibleProjectIds`.
- Routes: `POST /projects/:id/notes` and `POST /projects/:id/notes/upload` replace `POST /notes` and `POST /notes/upload` (`note.import`); `GET /projects/:id/notes` replaces `GET /notes` (`note.view`); the remaining `/notes/:id...`, `/extractions/...` and meeting-date routes keep their paths and call `authorize` with the action from the matrix via the source's or run's project. `proposal.review` additionally refuses when `missingAccountability` (`The project is missing a required role, so proposals cannot be approved until it is repaired.`).

- [ ] **Step 1: Write the failing tests** in `scoping.http.test.ts`: a Member can read notes but not add them (403 text) or approve (403 text); an Owner on a Draft project cannot approve; an administrator without a role gets 404 for a note and an empty `GET /projects/:id/notes`; a revoked member gets 404; notes with no project return 404 and never appear in any list; adding a note to a Deferred project is refused; approval refused while accountability is missing; after an Owner's membership expires, the same approval request is refused.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement; rewrite the existing HTTP tests to work inside a seeded project** (the PM imports and runs extraction; the Owner approves).
- [ ] **Step 4: Run; full suite passes.**
- [ ] **Step 5: Commit** (`Move notes, extraction and review inside projects`).

---

### Task 6: Screens

**Files:**
- Create: `app/web/src/projects.ts` + `projects.test.ts` (pure helpers), `app/web/src/views/Projects.tsx`, `ProjectPage.tsx` (Overview, People, Notes tabs), `Invitation.tsx`, `Departments.tsx`, `Domains.tsx`
- Modify: `app/web/src/App.tsx` (routes `#/`, `#/projects/:id`, `#/projects/:id/people`, `#/projects/:id/notes`, `#/invitations/:token`, `#/departments`, `#/domains`; the invitation route also works when signed out, showing sign-in first), `app/web/src/api.ts` (types), `app/web/src/views/Notes.tsx`, `Intake.tsx`, `NoteDetail.tsx` (take a project id)

**Interfaces:**
- Consumes: the API from Tasks 3–5.
- Produces (pure, tested): `membershipStateLabel(state)`, `transitionsFor(status, roles, isAdmin)` (mirrors the lifecycle table for which buttons to show; the server still decides), `formatExpiry(iso)` (`'Expires 15 Nov 2026, 2:30 pm'` UTC+8), `roleLabel(role)`.

- [ ] **Step 1: Write the failing tests** for the helpers, including that `transitionsFor` offers exactly the transitions `checkTransition` would allow for that role and status, ignoring role-gate inputs.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement the helpers and the screens.** Buttons appear only when `transitionsFor` or the project's `allowed` list says so; every server refusal is shown in the page's alert area; each lifecycle action opens a small form for its reason/outcome/stage.
- [ ] **Step 4: `npm test` and `npm run build` pass.**
- [ ] **Step 5: Commit** (`Add the projects, project, invitation and administration screens`).

---

### Task 7: Running app, accessibility and records

**Files:**
- Modify: `README.md` ("What the MVP does today" and "Where things stand"), `INSTALL.md` (after creating the administrator: add a department and an eligible domain, then create the first project), `tests/a11y/audit.mjs` (seed a department, a project with the signed-in admin as PM and Owner, and visit the new screens)

- [ ] **Step 1:** Rebuild the install (`docker compose up -d --build`); migrations apply on the existing database; the earlier notes no longer appear anywhere.
- [ ] **Step 2: Walk-through in the browser** with two accounts (the administrator, and a second address on an eligible domain): add a department and domain; create a project; appoint the administrator as Owner; invite the second person as Member; accept as them (sign-in code from the log); move Draft → Planned → Active; upload a note as PM; confirm the Member can read but not approve; approve as Owner; defer and confirm read-only; resume. Record anything that fails.
- [ ] **Step 3: Accessibility pass** over all screens at both widths: 0 violations.
- [ ] **Step 4:** Update README and INSTALL; commit (`Document projects, roles and invitations, and check them in the running app`).
- [ ] **Step 5:** Final fresh whole-branch review per the execution skill.
