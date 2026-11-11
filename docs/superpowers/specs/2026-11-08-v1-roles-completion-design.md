# V1.0 sub-project 1b: completing roles and access — design

Date: 8 November 2026. Status: for review by the Product Owner. Nothing here is built yet.

## Why

Sub-project 1 ([design](2026-11-08-v1-projects-roles-permissions-design.md)) built projects, roles, invitations and permission checks, "core first". It left out parts of the accepted rules that sub-project 2 (tasks and authorised records) should not have to work around: account disable with membership holds and investigation, Audit/Oversight grants, archiving, the outgoing Project Manager's handover, the Administrator's department transfer, "Sign out all sessions", and nine minor findings from its final review.

The rules come from the key documents ([Intent Card](../../Kainow-V1.0-Intent-Card.md), [Product Summary](../../Kainow-V1.0-Product-Summary.md), [Consolidated Specification](../../Kainow-V1.0-Consolidated-Product-Specification-and-Decision-Register.md)) and the supplementary [Role-Management Permissions](../../Kainow-V1.0-Role-Management-Permissions.md), [Invitation and Membership Lifecycle](../../Kainow-V1.0-Invitation-and-Membership-Lifecycle-Rules.md), [Sign-in, Access Requests and Account Lifecycle](../../Kainow-V1.0-Sign-in-Access-Requests-and-Account-Lifecycle-Rules.md) and [Permission Matrix](../../Kainow-V1.0-Permission-Matrix.md). They are not reopened here.

## What the Product Owner decided (8 November 2026)

| Question | Decision |
| --- | --- |
| Scope | **All of the gap**: account disable, On Hold and investigation; Audit/Oversight; archive (manual and automatic); PM handover; department transfer; Sign out all sessions; the nine review minors. |
| What a grant allows | **Read everything, read-only**: the project's details, people, history, notes and proposals for the grant's dates. Audit and Oversight behave the same for now; the requested scope is recorded. "Inspect deleted content" is reserved for sub-project 5. |
| Who records and approves requests | **Managers record, another approves**: an Administrator, the Owner or a Sponsor records a request for a named person; a different eligible manager approves. Neither the grantee nor the recorder may approve. |
| PM handover | **Invite-style**: the PM names an eligible address and chooses their own role afterwards (Deputy PM, Member, or leave). The replacement accepts through the usual seven-day link; the switch happens then, in one step. |
| Hold alerts | **Flag plus email**: an on-screen flag and a short email to the PM (to the Owner and Sponsors if the PM is the one on hold), naming the project and that action is needed, nothing more. |

## Records (migration 0013, additions only)

| Change | Fields | Notes |
| --- | --- | --- |
| `users.status` widened | `invited`, `active`, `disabled` | An account made for an invitee starts `invited` and becomes `active` at its first successful sign-in. Existing accounts stay `active`. |
| `memberships` gains a hold | held_at, held_by, hold_reason, restored_at, restored_by, restore_reason | A hold is current when held_at is set and restored_at is empty or earlier than held_at. |
| `membership_events.kind` widened | adds `held`, `finding` | `restored` exists already. |
| `membership_findings` | id, membership, finding (text), recommendation `restore`/`revoke`, recorded_by, at | Append-only. |
| `access_grants` | id, project, user, kind `audit`/`oversight`, purpose, scope (text), starts_on, expires_on, requested_by, requested_at, decision `approved`/`declined` (null while waiting), decided_by, decided_at, decision_reason, suspended_at/by/reason, revoked_at/by/reason | One row per request. |
| `grant_events` | id, grant, kind `requested`/`approved`/`declined`/`extended`/`suspended`/`restored`/`revoked`, previous and new dates, actor, reason, at | Append-only. |
| `project_archive_events` | id, project, kind `archived`/`unarchived`, actor, reason, at | Append-only. |
| `project_department_changes` | id, project, from_department, to_department, actor, reason, files_decision `kept_in_place`, at | Append-only. |
| `invitations` gains a handover | kind `role`/`handover` (default `role`), outgoing_membership_id, outgoing_role `deputy_pm`/`member`/`leave` | A handover is always for the PM role. |

## Rules

### Accounts, holds and investigation

- **Membership state** in order of precedence: Revoked; Expired (expiry continues during a hold); **On Hold**; Scheduled; Active. On Hold gives no access.
- **Disabling** any account (Administrator; the final active Administrator stays protected) ends its sessions and unused sign-in codes, holds every Scheduled or Active membership with the reason "Account disabled", and alerts each affected project (flag plus email). Expired and Revoked memberships are untouched. Re-enabling restores sign-in only; holds stay.
- **Findings**: the project's PM or any manager of the held role records a finding with a recommendation. Findings are visible only to their author, the project's PM and that role's managers.
- **Restore** (manager of the held role, reason required): the account is enabled and its domain still eligible; the membership is not Expired or Revoked; the memberships as they would be afterwards keep the role rules (one PM and one Owner on any day, required roles outside Draft, separation). No new invitation. A Scheduled membership returns as Scheduled.
- **Revoke** works as now and also ends a hold.
- **Flag**: a project with any membership On Hold shows "A member is On Hold — investigation needed" to its role managers on My Projects and the project page.

### Audit and Oversight grants

- **Request**: an Administrator, the Owner or a Sponsor records it for a named, enabled account: kind, purpose, requested scope, start and end. Default end is start + 30 days; the end may be at most 90 days after the start.
- **Decide**: an Administrator, the Owner or a Sponsor approves or declines with a reason, but not the grantee and not the recorder. No independent approver means the request waits.
- **State** (worked out in UTC+8): Requested, Declined, Scheduled, Active, Suspended, Expired, Revoked.
- **Extend** (manager, not the grantee): a new end at most 90 days after the current end.
- **Suspend / restore / revoke**: by a manager with a reason; expiry continues during suspension; revoke is final.
- **Access**: an Active grant on an enabled account gives `project.view` and `note.view` only. A grant holder sees the project in My Projects labelled "Audit access" or "Oversight access". Holds and membership restoration do not create, restore or extend grants.

### Archive

- Only Closed projects. PM, Owner or Sponsor archives or unarchives with a reason.
- **Archived** = the latest archive event is `archived`, or the project closed 12 months or more ago (UTC+8 calendar months) and no `unarchived` event is later than that point. Reopening the project clears it (a Closed → Active transition ends archive state).
- Archived projects move to a collapsed "Archived" section on My Projects. Nothing else changes; the project stays Closed and read-only.

### PM handover

- The current, Active PM issues it: an eligible address, their own role afterwards. One open handover per project. It can be withdrawn and resent like an invitation.
- **Acceptance** (only while Draft, Planned or Active): in one transaction, the replacement's PM appointment starts today, the outgoing PM appointment is revoked with the reason "Handed over", and the chosen role (if not `leave`, and not already held) is appointed from today. The memberships as they would be afterwards must keep the role rules.

### Department transfer

- Administrator only, with a reason, to an active department other than the current one. It cannot also be a contributing department. The change is recorded with `files_decision = kept_in_place` until managed storage exists (sub-project 9).

### Sign out all sessions

- Any signed-in person ends every one of their sessions.

### The review minors

1. Every id in a path or body is checked with the strict UUID pattern: 404 for a path id, 400 for a body field.
2. An invitation or handover cannot be issued or accepted when the membership it would create has an expiry already past: "That membership would already have ended."
3. Invitation and handover responses say `delivered: false` when the email failed; the People tab says "The email was not sent. Send again."
4. Unanswered invitations can be withdrawn while Deferred or Closed; a second open invitation to the same address and role is refused: "An invitation is already waiting; send it again instead."
5. In production, start-up logs a warning when `APP_URL` is not set.
6. The administrator's project list loads in a single query.
7. Creating a project rechecks that the creator's email domain is still eligible.
8. A lifecycle message clears when moving between a project's tabs.
9. Sub-project 1's spec says approving is refused while a required role is missing and rejecting is allowed; editing a pending proposal's wording is not a substantive amendment.

## Permissions added

| Action | Who | States |
| --- | --- | --- |
| Disable / enable account | Enterprise Administrator | — |
| Record finding | PM of the project, manager of the held role | all |
| Read findings | their author, the project's PM, managers of the held role | all |
| Restore from hold | manager of the held role | all |
| Record grant request; extend; suspend; restore; revoke | Enterprise Administrator, Owner, Sponsor (not the grantee for extend) | all |
| Approve / decline grant | Enterprise Administrator, Owner, Sponsor; not the grantee, not the recorder | all |
| Use grant | holder of an Active grant | read-only actions |
| Archive / unarchive | PM, Owner, Sponsor | Closed |
| Issue / withdraw handover | the current Active PM | Draft, Planned, Active (withdraw: all) |
| Department transfer | Enterprise Administrator | all |
| Sign out all sessions | any signed-in person | — |

## Screens

- **People** (Administrator): every account with its state (Invited, Active, Disabled) and Disable/Enable with a confirmation.
- **Project → People**: On Hold badge; Record finding, Restore and Remove where allowed; a findings list for those who may read it; a **Grants** section (record, approve/decline, extend, suspend, restore, revoke; exact dates); **Hand over** for the PM.
- **Project overview**: the hold flag; Archive/Unarchive on Closed projects; **Move to another department** for Administrators.
- **My Projects**: grant labels, the hold flag, a collapsed "Archived" section.
- **Top bar**: "Sign out everywhere".
- **Invitation page**: a handover reads "You are asked to take over as Project Manager of <project>."

## Testing

Test-first, as in sub-project 1. Pure functions: membership state with holds; grant state at UTC+8 boundaries; archived at exactly 12 months; handover planning. HTTP: disable holds only current memberships, ends sessions, emails the right person; re-enable leaves holds; restore keeps the role rules; findings hidden from others; grant approval refused for grantee and recorder; 90-day limit; grant holder read-only; suspended, expired and disabled grants give nothing; archive only when Closed; handover switch and outgoing role; department transfer Administrator-only; sign out everywhere; one test per minor. Then a browser walk-through in the Docker install, the accessibility audit over the new screens, and a fresh whole-branch review.

## Not in this sub-project

Inspect-deleted-content scope (sub-project 5); a settings screen for the 12-month archive delay, grant limits and invitation validity (delegated settings, sub-project 7); moving project files (sub-project 9); leadership summary grants (sub-project 7); quarantine security grants (sub-project 5); task effects of holds (sub-project 2).
