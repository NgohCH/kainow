# Sub-project 1b: Completing Roles and Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account disable with membership holds and investigation, Audit/Oversight grants, archiving, the outgoing PM's handover, the Administrator's department transfer, sign-out-everywhere and the nine review minors on top of sub-project 1.

**Architecture:** Pure rules (hold-aware membership state, grant state, archive state) in small modules beside `membership.ts`; `ProjectAccess.load` reads holds and grants so the one central check stays the only gate; new services per area (holds, grants) following `memberships.service.ts`; handover reuses the invitation table and routes. Migration 0013 adds columns and append-only history tables.

**Tech Stack:** TypeScript, NestJS, PostgreSQL 16 (plain SQL migrations), React + Vite, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-08-v1-roles-completion-design.md`

## Global Constraints

- Dates are `YYYY-MM-DD` in UTC+8 (`todayUtc8`); membership and grant states are worked out on read, never stored.
- Every project route goes through `ProjectAccess`; a non-participant gets 404, a participant without authority 403 with the reason, a rule or state conflict 409 with a plain sentence, bad input 400.
- History tables are append-only through `kainow_append_only()`.
- Grants: default end = start + 30 days; end at most 90 days after the start (and an extension at most 90 days after the current end); no approval by the grantee or the recorder.
- Archive delay: 12 calendar months after closure (UTC+8); constant `ARCHIVE_AFTER_MONTHS = 12`.
- Copy fixed by the spec: "A member is On Hold — investigation needed"; "Handed over"; "Account disabled"; "That membership would already have ended."; "The email was not sent. Send again."; "An invitation is already waiting; send it again instead."; "You are asked to take over as Project Manager of <project>."
- Test DB: `KAINOW_TEST_DATABASE_URL`; HTTP tests run with `--test-concurrency=1`. Never type or print secrets.

## Review Focus

1. Disabling an ordinary member while only one administrator is active must succeed (today's `UsersService.disable` refuses any disable when one admin is left). → Task 3 test "disabling a member does not need a second administrator".
2. A hold suspends that person's grants in the same project: a held member with an Active grant reads nothing there. → Task 2 (`grantGivesAccess`) and Task 5 test "a hold suspends grants in that project".
3. Disabling, restoring and disabling again: the second disable holds the membership again (held_at newer than restored_at) and never duplicates history for already-held rows. → Task 3 test "disable, restore and disable again".
4. A handover accepted after the outgoing PM stopped being PM (replaced, expired or revoked) is refused: "This handover is no longer valid." → Task 7 test.
5. Archive exactly at the 12-month boundary in UTC+8, and reopening clears archive state even after a manual archive. → Task 2 `archiveState` tests and Task 6 test.

---

### Task 1: Migration 0013

**Files:**
- Create: `app/migrations/0013_roles_completion.sql`
- Test: `app/src/db/roles-completion-schema.test.ts`

**Interfaces:**
- Produces the tables and columns in the spec's Records table, with these exact names: `users.status` check `('invited','active','disabled')`; `memberships.held_at, held_by, hold_reason, restored_at, restored_by, restore_reason`; `membership_events.kind` check adds `'held','finding'`; `membership_findings(id, membership_id, finding, recommendation, recorded_by, at)`; `access_grants(id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at, decision_reason, suspended_at, suspended_by, suspend_reason, revoked_at, revoked_by, revoke_reason)`; `grant_events(id, grant_id, kind, previous_expires_on, new_expires_on, actor_id, reason, at)`; `project_archive_events(id, project_id, kind, actor_id, reason, at)`; `project_department_changes(id, project_id, from_department_id, to_department_id, actor_id, reason, files_decision, at)`; `invitations.kind ('role','handover') DEFAULT 'role'`, `outgoing_membership_id`, `outgoing_role ('deputy_pm','member','leave')`.

- [ ] **Step 1: Write the failing schema test** `roles completion schema`: insert a user with status `invited`; a grant with `expires_on < starts_on` is refused by a check; `membership_findings`, `grant_events`, `project_archive_events`, `project_department_changes` refuse UPDATE and DELETE ("is append-only"); `access_grants.kind` refuses `'auditor'`; an invitation with `kind = 'handover'` and `role <> 'pm'` is refused by a check; `outgoing_role` accepts `leave`.
- [ ] **Step 2: Run it** — `cd app && rm -rf ./dist && npx tsc -p tsconfig.json && node --test dist/db/roles-completion-schema.test.js`. Expected: FAIL (relations missing).
- [ ] **Step 3: Write `0013_roles_completion.sql`** — additive only; widen checks by dropping and re-adding the named constraints; triggers via `kainow_append_only()`; index `access_grants (project_id, user_id)`.
- [ ] **Step 4: Run it** — same command. Expected: PASS. Then the full suite: `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** — `git add app/migrations/0013_roles_completion.sql app/src/db/roles-completion-schema.test.ts && git commit -m "Add records for holds, findings, grants, archive, department changes and handovers"`

### Task 2: Pure rules

**Files:**
- Modify: `app/src/projects/membership.ts`
- Create: `app/src/projects/grants.ts`, `app/src/projects/archive.ts`
- Test: `app/src/projects/membership.test.ts`, `app/src/projects/grants.test.ts`, `app/src/projects/archive.test.ts`

**Interfaces:**
- Produces: `MembershipRow` gains optional `heldAt: Date | null; restoredAt: Date | null`; `isHeld(m: MembershipRow): boolean` (heldAt set and (restoredAt null or restoredAt < heldAt)); `MembershipState` adds `'on_hold'`; `membershipState` precedence revoked → expired → on_hold → scheduled → active. `effectiveRoles` excludes held rows. `current()` (Scheduled or Active) excludes held rows.
- Produces in `grants.ts`: `type GrantKind = 'audit' | 'oversight'`; `interface GrantRow { id: string; userId: string; kind: GrantKind; startsOn: string; expiresOn: string; requestedBy: string; decision: 'approved' | 'declined' | null; suspendedAt: Date | null; revokedAt: Date | null }`; `type GrantState = 'requested' | 'declined' | 'scheduled' | 'active' | 'suspended' | 'expired' | 'revoked'`; `grantState(g: GrantRow, today: string): GrantState` (precedence: revoked → declined → requested → expired → suspended → scheduled → active); `GRANT_DEFAULT_DAYS = 30`, `GRANT_MAX_DAYS = 90`; `defaultGrantEnd(startsOn: string): string`; `grantSpanOk(fromDay: string, toDay: string): boolean` (toDay ≥ fromDay and at most 90 days after); `mayDecide(input: { deciderId: string; grant: GrantRow }): { allowed: true } | { allowed: false; reason: string }` (refuses grantee: "Nobody can approve access for themselves." and recorder: "The person who recorded the request cannot also decide it."); `grantGivesAccess(g: GrantRow, today: string, memberships: MembershipRow[]): boolean` (Active and no held membership of the same user in the project).
- Produces in `archive.ts`: `ARCHIVE_AFTER_MONTHS = 12`; `archiveState(input: { status: ProjectStatus; closedOn: string | null; events: Array<{ kind: 'archived' | 'unarchived'; at: string }>; today: string }): { archived: boolean; automatic: boolean }` — not archived unless status is `closed`; `closedOn` and event days are UTC+8 days of the latest closing; only events on or after `closedOn` count; the latest such event decides; with none, archived automatically when `today >= closedOn + 12 months` (same day of month, clamped to the month's last day).
- Suspension restore is modelled by clearing `suspended_at` and recording a `restored` grant event (no restored column).

- [ ] **Step 1: Write the failing tests.**
  - `membership.test.ts` "a hold sits between expiry and the dates": held Active → `on_hold`; held and expired → `expired`; held and revoked → `revoked`; restored (restoredAt > heldAt) → `active`; held again after restore (heldAt > restoredAt) → `on_hold`; `effectiveRoles` ignores held rows; `requiredRolesCheck` does not count held rows.
  - `grants.test.ts` "grant state follows decision, suspension and dates": requested (decision null) → `requested`; declined → `declined`; approved, start 2026-11-10, at 2026-11-09 → `scheduled`; at 2026-11-10 → `active`; expires 2026-11-20, at 2026-11-21 → `expired`; suspended → `suspended`; revoked wins over all.
  - "grant spans": `defaultGrantEnd('2026-11-09') === '2026-12-09'`; `grantSpanOk('2026-11-09','2027-02-07')` true (90 days), `'2027-02-08'` false; end before start false.
  - "nobody decides their own grant or the one they recorded": the two refusal texts above; a third person allowed.
  - "a hold suspends the grant in that project": Active grant + held membership of the same user → false; + held membership of another user → true.
  - `archive.test.ts` "archived twelve months after closing, in UTC+8": closedOn 2026-11-09 → not archived on 2027-11-08, archived (automatic) on 2027-11-09; closedOn 2027-01-31 → archived on 2028-01-31 not 2028-01-30; status `active` → never; manual `archived` event → archived, `automatic: false`; `unarchived` after the 12 months → not archived; events before `closedOn` (an earlier closure, then reopen) are ignored.
- [ ] **Step 2: Run them** — `npx tsc -p tsconfig.json; node --test dist/projects/membership.test.js dist/projects/grants.test.js dist/projects/archive.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions above. Day arithmetic on `YYYY-MM-DD` strings through `Date.UTC`.
- [ ] **Step 4: Run them** — same command. Expected: PASS. Full suite: `npm test` (membership changes must not break sub-project 1 tests).
- [ ] **Step 5: Commit** — "Add the rules for holds, grants and archiving"

### Task 3: Accounts — disable holds memberships, Invited state, sign out everywhere

**Files:**
- Modify: `app/src/users/users.service.ts`, `app/src/users/users.controller.ts`, `app/src/auth/auth.service.ts`, `app/src/auth/auth.controller.ts`, `app/src/auth/tokens.ts`, `app/src/auth/code-senders.ts`, `app/src/testing/fakes.ts`, `app/src/projects/access.service.ts`
- Create: `app/src/projects/holds.ts`
- Test: `app/src/users/users.http.test.ts`, `app/src/projects/holds.http.test.ts`, `app/src/auth/auth.http.test.ts`

**Interfaces:**
- Consumes: Task 2 `isHeld`, `membershipState`.
- Produces: `holdMembershipsOf(c: PoolClient, userId: string, actorId: string | null, at: Date, today: string): Promise<Array<{ projectId: string; projectName: string; heldRole: ProjectRole }>>` in `holds.ts` — holds every not-revoked, not-expired, not-already-held membership (reason "Account disabled"), writes a `held` membership event per row, returns one entry per affected project. `alertRecipients(c, projectId, heldUserId, today): Promise<string[]>` — the Active PM's email unless the PM is the held user, else Active Owner and Sponsor emails (excluding the held user).
- Produces: `CodeSender.sendHoldAlert(email: string, projectName: string, link: string): Promise<void>` (log sender prints `[hold alert, development only] <email>: <project> <link>`; SMTP subject "Kainow: action needed in <project>", body names the project, says a member is On Hold and links to `${appUrl}/#/projects/<id>/people`). `CaptureSender.holdAlerts: Array<{ email: string; projectName: string; link: string }>`.
- Produces: `ProjectAccess.load` selects `held_at AS "heldAt", restored_at AS "restoredAt"` and returns `ProjectContext.onHold: boolean` (any row `isHeld` and not Expired/Revoked). `GET /projects` rows and the project detail gain `onHold: boolean`, shown only to the project's role managers (false for others).
- Produces: `POST /auth/logout-all` (signed in): revokes every session of the user, clears the cookie, 204.
- Account `invited`: `AuthService.accountForInvitee` creates `status = 'invited'`; successful `verify` sets `active` for `invited`; `invited` accounts can request codes and sign in; `UsersService.disable/enable` treat `invited` like `active`.

- [ ] **Step 1: Write the failing tests.**
  - `users.http.test.ts` "disabling a member does not need a second administrator": one active admin disables a member → 204.
  - `holds.http.test.ts` "disabling holds current memberships and alerts each project":
    - member with Active (project A), Scheduled (project B), Expired (project C) and Revoked (project D) memberships;
    - after `POST /users/:id/disable`: A and B rows `on_hold` with `hold_reason = 'Account disabled'`, C and D untouched;
    - `CaptureSender.holdAlerts` has the PM of A and the PM of B, once each;
    - `GET /projects/A` as A's PM shows `onHold: true`;
    - the disabled user's session gets 401.
  - "if the Project Manager is the one disabled, the Owner and Sponsors are told": alerts go to the Owner and a Sponsor, not the PM.
  - "re-enabling leaves holds in place": enable → 204; memberships still `on_hold`.
  - "disable, restore and disable again": restore (Task 4 route; set `restored_at` by SQL in this test), disable again → held again, exactly two `held` events for the row.
  - `auth.http.test.ts` "sign out everywhere ends every session": two sign-ins of one user; `POST /auth/logout-all` on the first → both sessions get 401.
  - "an invitee's account is Invited until first sign-in": invite unknown address, request code → `users.status = 'invited'`; verify → `active`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** In `UsersService.disable`, apply the last-administrator check only when the target is an administrator; call `holdMembershipsOf` in the same transaction; after COMMIT send each alert (failures logged, not thrown). `UsersService` injects `CODE_SENDER` and reads `appUrl` from config.
- [ ] **Step 4: Run them** and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** — "Hold memberships when an account is disabled; sign out everywhere"

### Task 4: Findings and restoring from hold

**Files:**
- Create: `app/src/projects/holds.service.ts`
- Modify: `app/src/projects/members.controller.ts`, `app/src/projects/projects.module.ts`, `app/src/projects/projects.service.ts` (membership view gains `state: 'on_hold'`, `heldAt`, `holdReason`)
- Test: `app/src/projects/holds.http.test.ts`

**Interfaces:**
- Consumes: `checkMembershipsAfter`, `canManageRole` (`via: 'appointment'`), `isHeld`, `OrganisationService.isEligible`.
- Produces routes: `POST /memberships/:id/findings` `{ finding: string (1–4000), recommendation: 'restore' | 'revoke' }` → 201 (PM of the project or manager of the held role; membership must be held: else 409 "This membership is not On Hold."); `GET /memberships/:id/findings` → `{ findings: [{ id, finding, recommendation, recordedBy, at }] }` for the finding authors, the project's PM and managers of the held role, else 403 "Only the investigators and the managers of this role can read the findings."; `POST /memberships/:id/restore` `{ reason }` → 200 (manager of the held role; account `active`, domain eligible, not Expired/Revoked, `checkMembershipsAfter` on the restored rows; sets `restored_at/by/reason`, writes a `restored` event; refusals: "The account is disabled; an Administrator must enable it first." / "That address is not in an eligible organisation domain." / "This membership has ended; extend it before restoring it."). Revoking a held membership works through the existing route.

- [ ] **Step 1: Write the failing tests** in `holds.http.test.ts`:
  - "the Project Manager records a finding; other members cannot read it" (PM 201; Member GET 403; Owner GET 200 for a held Member; finding text returned).
  - "restore needs an enabled account and keeps the role rules" (restore while disabled → 409 text above; enable, restore → 200, state `active`; a held Scheduled row restores as `scheduled`; restoring a held Owner while another Owner was appointed meanwhile → 409 "Those dates would give the project two Owners at the same time.").
  - "a restore needs a reason and the role's manager" (no reason 400 "A reason is required."; a Member → 403).
  - "revoking a held membership ends it".
- [ ] **Step 2: Run** `node --test dist/projects/holds.http.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `HoldsService` (transactions with the project lock via `access.context(..., c, true)`), controller routes, membership view fields.
- [ ] **Step 4: Run** it and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** — "Record findings and restore memberships from hold"

### Task 5: Audit and Oversight grants

**Files:**
- Create: `app/src/projects/grants.service.ts`, `app/src/projects/grants.controller.ts`
- Modify: `app/src/projects/access.service.ts`, `app/src/projects/matrix.ts`, `app/src/projects/projects.service.ts`, `app/src/projects/projects.module.ts`
- Test: `app/src/projects/grants.http.test.ts`, `app/src/projects/matrix.test.ts`

**Interfaces:**
- Consumes: Task 2 `grants.ts`.
- Produces: `ProjectContext.grants: GrantRow[]` (all of the project's grants) and `ProjectContext.grantKinds: GrantKind[]` (this user's grants for which `grantGivesAccess`); `GRANT_ACTIONS: readonly ProjectAction[] = ['project.view', 'note.view']`; `authorize`: when `roles` is empty but `grantKinds` is not, allow only `GRANT_ACTIONS` (403 "Audit and Oversight access is read-only." otherwise); `visibleProjectIds` includes projects with an access-giving grant; `GET /projects` rows gain `access: 'audit' | 'oversight' | null`.
- Grant managers: `GRANT_MANAGERS = ['administrator', 'owner', 'sponsor']`, refusal "Only an Enterprise Administrator, the Owner or a Sponsor can manage Audit and Oversight access."
- Routes (all bodies validated; dates via `isCalendarDate`; user ids via strict UUID):
  - `POST /projects/:id/grants` `{ userId, kind, purpose, scope, startsOn, expiresOn? }` → 201 `{ grant }`; `expiresOn` defaults to `defaultGrantEnd(startsOn)`; span over 90 days → 400 "Access can be granted for at most 90 days at a time."; target must be an enabled account (`invited` or `active`).
  - `POST /grants/:id/approve|decline` `{ reason? }` (decline needs a reason) → `mayDecide`; only from `requested` (else 409 "This request has already been decided.").
  - `POST /grants/:id/extend` `{ expiresOn }` (not the grantee: 403 "Nobody can extend their own access."; span from current end ≤ 90 days; grant must be approved and not revoked).
  - `POST /grants/:id/suspend|restore|revoke` `{ reason }` (reason required; restore only when suspended; revoke final: 409 "This access was revoked; record a new request instead.").
  - `GET /projects/:id` includes `grants: [{ id, user: { id, displayName, email }, kind, purpose, scope, startsOn, expiresOn, state, requestedBy, decidedBy }]` for role managers and the Administrator; grant holders see only their own.
  - Every change writes a `grant_events` row and an audit event `grant.<kind>`.

- [ ] **Step 1: Write the failing tests** in `grants.http.test.ts`:
  - "a manager records a request and a different manager approves it" (Owner records for X; Owner approve → 403 recorder text; X cannot approve → grantee text; Sponsor approves → 200, state `active`).
  - "the holder can read but not change anything" (X `GET /projects/:id` 200, `myRoles: []`; `GET /projects/:id/notes` 200; `POST /projects/:id/notes` 403 "Audit and Oversight access is read-only."; review approve 403).
  - "access ends with the grant" (suspend → X gets 404; restore → 200; clock past `expiresOn` → 404; revoke → 404 and restore 409).
  - "at most 90 days" (start 2026-11-09, end 2027-02-08 → 400 text; default end 2026-12-09).
  - "a disabled account's grant gives nothing" (disable X → X can't sign in; grant state unchanged in the listing).
  - "a hold suspends grants in that project" (X is Member and has an Active Audit grant; disable then re-enable X → X gets 404 in that project).
  - "My Projects shows the access label" (`access: 'audit'`).
  - `matrix.test.ts`: `GRANT_ACTIONS` equals `['project.view','note.view']`.
- [ ] **Step 2: Run** the two files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** — "Add Audit and Oversight access with recorded requests and independent approval"

### Task 6: Archive and department transfer

**Files:**
- Modify: `app/src/projects/projects.service.ts`, `app/src/projects/projects.controller.ts`, `app/src/projects/matrix.ts`
- Test: `app/src/projects/archive.http.test.ts`

**Interfaces:**
- Consumes: Task 2 `archiveState`.
- Produces: matrix action `'project.archive'` (roles pm, owner, sponsor; states `['closed']`; refusal "Only the Project Manager, the Owner or a Sponsor can archive a project, and only once it is Closed."). Routes `POST /projects/:id/archive|unarchive` `{ reason }` → 200 (`unarchive` when not archived: 409 "This project is not archived."; `archive` when archived: 409 "This project is already archived."). Project detail and list rows gain `archived: boolean`, `archivedAutomatically: boolean`. `closedOn` is the UTC+8 day of the latest `project_transitions` row with `to_status = 'closed'`.
- Produces: `POST /projects/:id/department` `{ departmentId, reason }` — Administrator only (403 "Only an Enterprise Administrator can move a project to another owning department."; non-admin participants get the same 403, non-participant non-admins 404); active department, not the current one (409 "The project already belongs to that department."), not a contributing one (409 "That department contributes to this project; remove it from the contributing departments first."); reason required; writes `project_department_changes` with `files_decision = 'kept_in_place'` and audit `project.department_moved`.

- [ ] **Step 1: Write the failing tests** in `archive.http.test.ts`:
  - "only a Closed project can be archived, by its PM, Owner or Sponsor" (Active → 403 text; Member on Closed → 403; Owner on Closed → 200, `archived: true, archivedAutomatically: false`; unarchive → `archived: false`).
  - "a Closed project is archived twelve months after closing" (close via transition at clock 2026-11-09; advance clock to 2027-11-08T16:00:00Z → `archived: true, archivedAutomatically: true`; unarchive → false and stays false).
  - "reopening ends archive state" (archive, reopen Closed → Active, `archived: false`).
  - "the Administrator moves a project to another department with a reason" (PM → 403; admin without reason → 400 "A reason is required."; admin → 200, owning department changed, change row with `kept_in_place`; to a contributing department → 409 text).
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** — "Archive Closed projects, and let the Administrator move a project's department"

### Task 7: PM handover

**Files:**
- Modify: `app/src/projects/invitations.service.ts`, `app/src/projects/invitations.controller.ts`, `app/src/projects/memberships.service.ts`
- Test: `app/src/projects/handover.http.test.ts`

**Interfaces:**
- Consumes: `planReplacement`, `checkMembershipsAfter`, `insertAppointment`.
- Produces: `POST /projects/:id/handover` `{ email, outgoingRole: 'deputy_pm' | 'member' | 'leave', displayName? }` → 201 `{ invitation, delivered }` — only the user holding the Active PM membership (403 "Only the current Project Manager can hand over the project."); project Draft/Planned/Active; eligible domain; the address is not the PM's own (400 "Choose someone else to take over."); one open handover per project (409 "A handover is already waiting; send it again or withdraw it."). Stored as `invitations.kind = 'handover'`, `role = 'pm'`, `starts_on` = today, `outgoing_membership_id`, `outgoing_role`. `byToken` returns `kind`. Resend and revoke reuse the invitation routes; the current PM (and role managers of `pm`) may revoke it.
- Acceptance (existing `POST /invitations/by-token/:token/accept`): for `kind = 'handover'`, the outgoing membership must still be the Active PM (else 409 "This handover is no longer valid."); in one transaction revoke the outgoing PM row with reason "Handed over", insert the replacement's PM appointment from today (reason "Accepted a handover"), and if `outgoing_role` is not `leave` and the outgoing person does not already hold it, appoint it from today; the memberships as they would be afterwards pass `checkMembershipsAfter`.

- [ ] **Step 1: Write the failing tests** in `handover.http.test.ts`:
  - "the replacement accepts and becomes Project Manager; the outgoing PM becomes a Member" (PM hands over to lee with `member`; lee accepts → lee `pm` Active; old PM row revoked "Handed over"; old PM holds `member` Active; events recorded).
  - "leaving the project" (`leave` → old PM has no current role; `GET /projects/:id` as old PM 404).
  - "only the current PM can hand over, once at a time" (Owner → 403 text; second handover → 409 text; to own address → 400).
  - "a handover is refused once the outgoing PM is no longer PM" (handover issued; Owner appoints a new PM; lee accepts → 409 "This handover is no longer valid.").
  - "withdrawing a handover" (revoke route → link no longer valid).
  - "the invitation page says it is a handover" (`byToken` → `kind: 'handover'`).
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** — "Let the Project Manager hand over to an accepting replacement"

### Task 8: The review minors

**Files:**
- Modify: `app/src/projects/memberships.service.ts`, `invitations.service.ts`, `projects.service.ts`, `organisation.service.ts` (export a shared `UUID` from `app/src/common/uuid7.ts` or `access.service.ts` and use it everywhere ids are checked), `app/src/config.ts`, `app/src/main.ts`, `docs/superpowers/specs/2026-11-08-v1-projects-roles-permissions-design.md`
- Test: `app/src/projects/minors.http.test.ts`, `app/src/config.test.ts`

**Interfaces:**
- Produces: `export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` used for every id check; invitation and handover responses `{ invitation, delivered: boolean }`; `appUrlWarning(env: NodeJS.ProcessEnv): string | null` in `config.ts` returning "APP_URL is not set; invitation links will point to http://localhost:3000." when `NODE_ENV === 'production'` and `APP_URL` is empty, logged once at start-up in `main.ts`.

- [ ] **Step 1: Write the failing tests** in `minors.http.test.ts`, one per minor:
  - "a malformed id is not found, never a server error" (36 hyphens on `/memberships/:id/extend`, `/invitations/:id/resend`, `/projects/:id/edit` → 404; as a body `userId` → 400).
  - "an invitation for a membership that has already ended is refused" (`expiresOn` yesterday → 400 "That membership would already have ended."; acceptance after the clock passes `expires_on` → 409 same text).
  - "a failed invitation email is reported" (sender throws → 201 with `delivered: false`).
  - "unanswered invitations can be withdrawn while Deferred; a second open invitation is refused" (Deferred revoke → 200; duplicate invite → 409 text).
  - "the administrator's project list is one query" — assert by behaviour: 3 projects listed with role holders; count statements with a pool wrapper in the test (`all` built from ≤ 2 queries).
  - "creating a project rechecks the creator's domain" (remove the domain; member creates → 403 "Your email domain is no longer eligible; ask an Administrator.").
  - `config.test.ts` "a missing APP_URL in production is warned about" (returns the text; null in development or when set).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**, and correct sub-project 1's spec (approve refused, reject allowed while a required role is missing; editing wording is not a substantive amendment).
- [ ] **Step 4: Run** them and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** — "Fix the minor findings from sub-project 1's review"

### Task 9: Web screens

**Files:**
- Modify: `app/web/src/api.ts`, `app/web/src/projects.ts`, `app/web/src/App.tsx`, `app/web/src/views/People.tsx`, `app/web/src/views/ProjectPage.tsx`, `app/web/src/views/Projects.tsx`, `app/web/src/views/Invitation.tsx`, `app/web/src/styles.css`
- Test: `app/web/src/projects.test.ts`

**Interfaces:**
- Consumes: the routes and fields of Tasks 3–8.
- Produces helpers in `projects.ts`: `membershipStateLabel('on_hold') === 'On Hold'`; `grantStateLabel(s: GrantState): string` ('Waiting for approval', 'Declined', 'Starts later', 'Active', 'Suspended', 'Expired', 'Revoked'); `accessLabel(a: 'audit' | 'oversight'): string` ('Audit access', 'Oversight access'); `canManageGrants(roles, isAdmin): boolean`; `canArchive(status, roles): boolean`.

- [ ] **Step 1: Write the failing tests** in `projects.test.ts` for the five helpers with the exact labels above.
- [ ] **Step 2: Run** `cd app/web && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers and the screens in the spec's Screens section: People (all accounts, state, Disable/Enable with `confirm`); Project People (On Hold badge, Record finding, findings list, Restore, Grants section, Hand over form); Overview (hold flag "A member is On Hold — investigation needed", Archive/Unarchive with reason, Move to another department for Administrators); My Projects (access labels, hold flag, collapsed `<details>` "Archived"); top bar "Sign out everywhere"; Invitation page handover sentence; clear the lifecycle notice on tab change; "The email was not sent. Send again." when `delivered` is false.
- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit -p .`, `npm run build`. Expected: PASS and a build.
- [ ] **Step 5: Commit** — "Show holds, grants, archive, handover and department moves"

### Task 10: Walk-through, accessibility, docs

**Files:**
- Modify: `tests/a11y/audit.mjs`, `tests/a11y/README.md`, `INSTALL.md`, `README.md`

- [ ] **Step 1:** Rebuild the Docker install (`docker compose up -d --build`) and walk through with test accounts at `kainow.test`: disable a member → hold flag and alert in the log; record a finding; enable and restore; record a grant request as Owner, approve as the Administrator, read as the holder, suspend; close a project and archive/unarchive; hand over from the PM to a new address and accept; move a project's department as the Administrator; sign out everywhere.
- [ ] **Step 2:** Extend the audit to the People list, a project with a held member, the Grants section, the handover form, an archived project and the handover invitation; run it. Expected: TOTAL violations: 0.
- [ ] **Step 3:** README: move these items from "not built" to built. INSTALL "Check that it works": add disable/restore and a grant.
- [ ] **Step 4:** `npm test` (server) and web tests. Expected: PASS.
- [ ] **Step 5: Commit** — "Walk through and document sub-project 1b"
