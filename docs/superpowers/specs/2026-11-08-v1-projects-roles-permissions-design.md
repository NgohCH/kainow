# V1.0 sub-project 1: projects, roles, membership and permissions — design

Date: 8 November 2026. Status: for review by the Product Owner. Nothing here is built yet.

## Why

The December MVP has one organisation-wide role, the Enterprise Administrator, who can do everything, and its notes and proposals belong to no project. V1.0 ([Intent Card](../../Kainow-V1.0-Intent-Card.md)) is built on projects: every record has a project scope, access follows current project membership, and only a project's Owner or Sponsor authorises proposals. Every later sub-project (tasks, reminders, discussion, dashboards) depends on this one.

The accepted rules come from five V1.0 documents and are not reopened here: [Project Lifecycle](../../Kainow-V1.0-Project-Lifecycle-Rules.md), [Role-Management Permissions](../../Kainow-V1.0-Role-Management-Permissions.md), [Invitation and Membership Lifecycle](../../Kainow-V1.0-Invitation-and-Membership-Lifecycle-Rules.md), [Permission Matrix](../../Kainow-V1.0-Permission-Matrix.md) and [Sign-in, Access Requests and Account Lifecycle](../../Kainow-V1.0-Sign-in-Access-Requests-and-Account-Lifecycle-Rules.md). Where this design picks a default the documents leave open, it says so.

## What the Product Owner decided (8 November 2026)

| Question | Decision |
| --- | --- |
| Scope of this sub-project | **Core first.** Projects with all lifecycle transitions and stage history; the PM, Deputy PM, Owner, Sponsor and Member roles with the appointment matrix; invitations by email; memberships Scheduled/Active/Expired/Revoked; small-team separation; eligible domains; project-scoped permission checks; notes and proposals inside projects. |
| Later sub-projects | Audit/Oversight requests and grants, On Hold and investigations, account disable placing memberships On Hold, archive/unarchive, PM transfer. Closure accounting for unfinished work and deadline review on reopening come with tasks (sub-project 2). |
| Existing notes and proposals | **Start fresh.** They stay in the database for history, belong to no project and are visible to nobody. New work starts in projects. |
| Departments | **An administrator-managed list.** Add, rename, retire; retired departments stay on existing projects but cannot be chosen for new ones. |
| How permissions are enforced | **One central check** with the matrix as a data table, plus a matching filter for lists. |

## Records (migration 0012, additions only)

| Record | Fields | Notes |
| --- | --- | --- |
| `departments` | id, name (unique among active), status `active`/`retired`, created/updated by and at | Renaming keeps the id, so projects follow the new name. |
| `eligible_domains` | id, domain (lower case, unique), added by and at, removed by and at | A removed domain blocks new invitations and acceptances; existing accounts are not touched. |
| `projects` | id, name, purpose, owning_department_id, planned_end (date, optional), status `draft`/`planned`/`active`/`deferred`/`closed`, closure_outcome `delivered`/`partially_delivered`/`abandoned` (set only when closed), created by and at | Name, purpose and owning department are required from creation. |
| `project_departments` | project, department | Contributing departments. The owning department is not repeated here. |
| `project_stage_periods` | id, project, stage, substage (optional), started_at, ended_at (null for the current one), started_by, reason | Stages: Initiation, Planning, Execution, Review & Acceptance, Closure, with the documents' optional substages. A change ends the current period and starts a new one. Created in Initiation. |
| `project_transitions` | id, project, from_status, to_status, actor, reason, closure_outcome, fast_track (bool), at | Append-only (update and delete refused). |
| `memberships` | id, project, user, role `pm`/`deputy_pm`/`owner`/`sponsor`/`member`, starts_on (date), expires_on (date, optional), revoked_at, revoked_by, revoke_reason | One row per person and role in a project. Not revoked + start reached + expiry not reached (UTC+8) = **Active**; start in the future = **Scheduled**; expiry reached = **Expired**; revoked = **Revoked**. Only revocation is stored; the rest is worked out from today's date, as due readings are. |
| `membership_events` | id, membership, kind `appointed`/`extended`/`dates_changed`/`revoked`/`restored`, previous and new dates, actor, reason, at | Append-only history. |
| `invitations` | id, project, email (lower case), role, starts_on, expires_on, invited_by, token_hash, issued_at, expires_at (issued + exactly 7 days), status `invited`/`accepted`/`declined`/`expired`/`revoked`, responded_at, membership_id (when accepted), replaced_by (when resent) | The token is random, stored only as a hash, single use. Resending creates a new invitation and marks the old one replaced, so its link stops working; history is kept. Expired is worked out from `expires_at`. |
| `sources.project_id` | nullable reference to `projects` | Existing notes keep null and are hidden. New notes require a project. |
| `users.role` | allows `member` beside `enterprise_administrator` | People who join by invitation get `member`. Administrator status stays an organisation role. |

Dates follow the documents: membership starts at 00:00 UTC+8 on its start date; a date-only expiry ends access at 00:00 after the last valid date; membership and invitation start dates cannot precede the project's creation date.

## Rules enforced

- **Required roles** for a project: exactly one PM; at least one Member who is a different person from the PM; at least one Owner or Sponsor. At most one Owner; any number of Sponsors and Deputy PMs.
- **Gates.** Draft may be incomplete. Draft → Planned needs the required roles accepted (Scheduled or Active memberships count). Planned → Active, Draft → Active (fast track) and Deferred/Closed → Active need the required roles Active and separation valid.
- **Small teams.** A project with six or fewer distinct people holding non-revoked, non-expired memberships may combine PM, Owner and Sponsor in one person. At seven or more, PM, Owner and Sponsor must be different people. An appointment or acceptance that would make the seventh person while a combination exists is refused with the reason.
- **Missing accountability.** On an Active project whose required roles are not all Active, the project is flagged; approving or rejecting proposals is refused; existing records stay readable and role repairs stay allowed. Access is never extended to cover the gap.
- **No silent changes.** Expiry ends access on its date even for a required role. Reopening does not revive expired memberships or invitations.

## The nine transitions

Exactly as accepted; any other is refused.

| Transition | Who | Required |
| --- | --- | --- |
| Draft → Planned | PM, Owner or Sponsor | Required roles accepted |
| Draft → Active (fast track) | PM | Reason; required roles Active; separation valid |
| Planned → Active | PM, Owner or Sponsor | Required roles Active; separation valid |
| Active → Deferred | PM, Owner or Sponsor | Reason |
| Deferred → Active | Enterprise Administrator, PM, Owner or Sponsor | Reason; resumed stage; required roles Active; separation valid |
| Active → Closed | Owner or Sponsor | Reason; outcome |
| Deferred → Closed | Owner or Sponsor | Reason; outcome |
| Planned → Closed | Owner or Sponsor | Reason; outcome must be Abandoned |
| Closed → Active | Owner or Sponsor | Reason; stage to reopen in; required roles Active; separation valid |

Resuming or reopening starts a new stage period in the chosen stage. A small-team PM who also holds Owner or Sponsor may close or reopen in that capacity (the check uses roles held, not job titles). Closure does not yet require dispositions for unfinished tasks, questions or risks; that rule arrives with sub-project 2 and will then apply.

## Permission checks

`authorize(person, action, projectId)` returns allowed, or refused with a reason a person can read. It checks, in order: the account is active; the action is in the matrix; the person's **effective roles** in the project (memberships Active today); the project's status; the action's extra condition. The matrix is one data table, `PROJECT_MATRIX`:

| Action | Roles | Project states | Extra condition |
| --- | --- | --- | --- |
| `project.view` | any participant | all | — |
| `project.edit` (name, purpose, contributing departments, planned end) | PM, Owner, Sponsor | Draft, Planned, Active | — *(default chosen here: the documents give no explicit editor)*. Moving the owning department is refused: only the Enterprise Administrator transfers ownership, with a reason (Consolidated Specification §3); that transfer comes with external file storage. |
| `project.transition` | per the transition table | per the transition table | per the transition table |
| `project.stage` | PM | Active | reason optional |
| `role.manage` (appoint, invite, extend, change dates, revoke) for Owner | Enterprise Administrator | appointments: all; invitations: Draft, Planned, Active | separation and required-role checks |
| `role.manage` for Sponsor | Enterprise Administrator, Owner | as above | as above |
| `role.manage` for PM | Enterprise Administrator, Owner, Sponsor | as above | exactly one PM; replacing ends the old appointment in the same action |
| `role.manage` for Deputy PM, Member | PM, Owner, Sponsor | as above | PM and required Member different |
| `note.import` | PM, Deputy PM, Owner, Sponsor | Draft, Planned, Active | — |
| `note.view` | any participant | all | — |
| `extraction.run` | PM, Deputy PM, Owner, Sponsor | Draft, Planned, Active | spend cap as today |
| `proposal.edit`, `meeting_date.set` | PM, Owner, Sponsor | Draft, Planned, Active | — |
| `proposal.review` (approve, reject) | Owner, Sponsor | Planned, Active | no missing accountability; Draft cannot authorise |

The Enterprise Administrator acts in projects only where the table names them (managing Owner, Sponsor and PM appointments; resuming a Deferred project). Holding the administrator role grants no reading of notes or proposals. Deferred and Closed projects are read-only except the transitions out of them and role repair: the role's managers may still appoint, extend, change dates and revoke, so a required role that lapses can be restored before resuming (Consolidated Specification §5, D21, Q05). Invitations stay locked while Deferred or Closed (Product Summary §10).

`visibleProjectIds(person)` lists the projects where the person has an Active membership. Every list of projects, notes or runs filters through it, so a list never shows what `authorize` would refuse. The administrator sees all projects' names, statuses and role holders on the administration side (to manage appointments), not their content.

Organisation-level actions stay on the existing route-level check, administrators only: departments, eligible domains, administrator accounts, AI spend settings.

## Invitations

- Who may invite for a role is `role.manage` for that role. The address must be in an eligible domain (checked again at acceptance).
- The email (existing sender; or the log when `LOG_SIGN_IN_CODES` is on) contains a link to `#/invitations/<token>`. The page asks the person to sign in with an emailed code (existing sign-in), then shows the project, role and dates with Accept and Decline.
- Accepting a link for a new address creates the account (`member`) at that moment. It is refused if the project is Deferred or Closed, the invitation is expired, revoked or replaced, the domain is no longer eligible, the signed-in email differs from the invited one, or the role rules would be broken.
- Accepted invitations create the membership with the invitation's dates (Scheduled or Active). Declining records the decline; the manager reassigns.
- Default validity is exactly seven days from issue, shown on screen. Resend creates a new invitation; revoke withdraws an unaccepted one.

## Changes to existing features

- Notes are created inside a project (`POST /projects/:id/notes`, upload likewise). Reading, extraction, review, editing and meeting dates check the note's project through `authorize`.
- Approving or rejecting a proposal needs Owner or Sponsor in that project, on a Planned or Active project with no missing accountability. The due-date approval rule from the previous sub-project still applies.
- The administrator's People screen is limited to administrator accounts; everyone else joins by invitation.
- The AI spend cap and per-person limits are unchanged; per-project limits are sub-project 6.

## Screens

- **Projects** (new home): the person's projects with status, stage, their roles and a "missing accountability" flag; **New project** (name, purpose, owning department, contributing departments, optional planned end).
- **Project page**, three tabs:
  - *Overview*: details, status, stage history, lifecycle buttons shown only to people allowed to use them, each asking for its reason, outcome or stage.
  - *People*: memberships with role, dates and state; invitations with state and exact expiry; invite, resend, revoke, extend, change dates and remove, each shown only where permitted.
  - *Notes*: today's notes, upload and review screens, inside the project.
- **Invitation page**: sign in, then Accept or Decline.
- **Administration**: Departments and Eligible domains, beside People and AI spending.

Every refused action shows its reason. The footer, accessibility and UTC+8 display follow the existing screens.

## Testing

Written test first.

- **Matrix.** One generated test per action: an allowed case and a denied case for every role not listed, every state not listed, a non-member, a revoked, scheduled and expired member, and an administrator without a project role.
- **Dates.** Membership state at 23:59 and 00:00 UTC+8 around start and expiry; invitation expiry at exactly seven days.
- **Transitions.** Each of the nine with its role gate and requirements; every other pair refused; fast track; small-team PM closing as Owner.
- **Separation.** Combined roles allowed at six people and refused when the seventh would activate.
- **Invitations.** New and existing people; resend voids the old link; decline; revoke; acceptance blocked while Deferred or Closed, after domain removal, and for the wrong signed-in email.
- **Existing features.** The notes, extraction, review and due-date HTTP tests rewritten to run inside a project, plus: an administrator who is not a member cannot read notes; a Member cannot approve; a Draft project cannot authorise.
- **Pre-project data.** Notes with no project are not listed or readable by anyone.
- **Running app.** A browser walk-through (create project, invite, accept in a second account, move through the lifecycle, upload and review inside the project) and the accessibility pass.

## Order of work

1. Migration 0012 and its schema tests.
2. Membership state from dates, effective roles, `authorize` and `PROJECT_MATRIX`, with the generated matrix tests.
3. Departments, eligible domains, projects and the lifecycle API.
4. Memberships, role management and invitations.
5. Notes, extraction and review moved into projects.
6. Screens.
7. Docker check, walk-through, accessibility pass, and a fresh whole-branch review.

## Out of scope

Audit/Oversight grants; On Hold, investigations and account disable affecting memberships; archive/unarchive; PM transfer by the outgoing PM; task-related closure and reopening rules; per-project AI limits; department affiliation of people; leadership summaries.
