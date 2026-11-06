# Kainow V1.0 — Invitation and Membership Lifecycle Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules and configurable defaults  
**Scope:** Organisational eligibility, project invitations, membership activation, scheduling, expiry, revocation, restoration and effects on assigned work. Development methods are excluded.

## 1. Purpose and related documents

This document defines how an eligible person joins a project, obtains access, loses access and may later regain membership. It supplements:

- **Kainow-V1.0-Product-Summary.md**.
- **Kainow-V1.0-Role-Management-Permissions.md**.
- **Kainow-V1.0-Project-Lifecycle-Rules.md**.
- **Kainow-V1.0-Proposals-and-Configurable-Business-Rules.md**.
- **Kainow-V1.0-Task-and-Subtask-Lifecycle-Rules.md**.

Invitation and membership statuses are separate. An invitation can be Accepted while the resulting membership is Scheduled; accepting an invitation does not necessarily make membership Active immediately.

## 2. Organisational eligibility

- Invitations are limited to people eligible for the same organisation.
- An approved organisational email domain is the normal eligibility basis.
- The Enterprise Administrator decides eligibility questions and exceptions within the same-organisation restriction.
- New users may be invited, but people outside organisational eligibility are not admitted as external participants in V1.0.
- Acceptance rechecks organisational eligibility and applicable role restrictions.
- Sign-in is passwordless. No product password is created or stored.

## 3. Separate status fields

### Invitation status

| Status | Meaning |
| --- | --- |
| Invited | Invitation issued and awaiting a response; no active membership or access is granted by the invitation. |
| Accepted | The recipient accepted the invitation. Membership activation still depends on eligibility, dates and applicable rules. |
| Declined | The recipient declined; associated responsibility requires reassignment. |
| Expired | The invitation's acceptance period ended. A fresh invitation is required. |
| Revoked | An authorised person withdrew the invitation before acceptance. |

### Membership status

| Status | Meaning |
| --- | --- |
| Scheduled | Invitation accepted, but the membership starts on a future date. |
| Active | Invitation accepted, eligibility confirmed and membership start date reached, subject to project-state access restrictions. |
| Expired | The time-limited membership reached its expiry and no longer grants the affected access. |
| Revoked | An authorised person withdrew the membership and its affected access; fresh invitation/acceptance required for readmission. |
| On Hold | Access temporarily suspended pending authorised investigation/restoration/revocation. |

A pending invitation is not an Active membership. A Deferred or Closed project does not need an invented membership status: project-state restrictions apply separately.

## 4. Invitation flow

- Authorised role managers may invite eligible people to the corresponding project roles.
- Existing users accept the project invitation; new users also complete passwordless sign-in.
- Assignment may trigger an invitation when the assignee lacks active project membership.
- Show pending invitation or membership status to the project team.
- A pending invitation grants no access, even if a task is already assigned.
- Accepting an invitation does not automatically start or complete assigned work.
- Future-dated membership remains Scheduled until its start date.
- Acceptance rechecks eligibility and role restrictions, including applicable small-team role combinations and separation requirements.

### Invitation expiry and resending

- Default invitation validity is seven days.
- Invitation duration is configurable under the organisation's business-rule policy.
- Resending creates a new invitation and invalidates the previous invitation's acceptance link.
- Preserve earlier invitation history; a fresh invitation must not erase a previous decline, expiry or revocation.
- Do not automatically resend expired invitations merely because the project reopens.

### Decline and withdrawal

- A declined invitation requires the Project Manager to reassign associated responsibility.
- The Project Manager may revoke an unaccepted invitation originating from task allocation, consistent with the permitted role scope.
- Invitation expiry, decline or revocation does not silently assign the task to another person.

## 5. Authority to manage roles and membership

The accepted role-management matrix determines who may invite, revoke, restore or extend each role. Under the default policy:

| Role | Management authority |
| --- | --- |
| Project Owner | Enterprise Administrator. |
| Project Sponsor | Enterprise Administrator or Project Owner. |
| Project Manager | Enterprise Administrator, Project Owner or Project Sponsor; an existing Manager may also transfer responsibility to an eligible replacement. |
| Deputy Project Manager | Project Manager, Project Owner or Project Sponsor. |
| Member | Project Manager, Project Owner or Project Sponsor. |
| Audit / Oversight | Enterprise Administrator, Project Owner or Project Sponsor, following a recorded request and with an expiry date. |

No person may approve their own Audit/Oversight access under the accepted default rules. Administrative or management responsibility alone does not grant discussion access.

Initial appointments during project creation follow the separately accepted creation rules; they are not inferred from a general invitation permission.

## 6. Membership dates, expiry and extension

- Every membership has a start date.
- A start or restored membership date cannot precede project creation.
- Membership expiry is configurable and defaults to no expiry; no mandatory six-month term.
- A project may start without a planned end date. Membership dates do not require a project end date.
- Audit and Oversight appointments are explicitly time-limited.
- Authorised extensions record the actor, previous/new dates and history.
- Extending an appointment does not grant additional roles or permissions.
- Expiry removes the affected access as scheduled. Required-role continuity must not be maintained by silently extending access.

## 7. Revocation and restoration

- Membership expiry or revocation removes the affected access without deleting historical contributions or approvals.
- Restoration requires an authorised action, valid dates and current eligibility checks.
- Restoration must satisfy the applicable role restrictions.
- Restoration preserves the earlier expiry or revocation in history.
- Restoring project membership does not automatically restore expired Audit/Oversight permissions.
- Invitation acceptance or membership restoration does not automatically revive an old invitation link or change task commitments.

On Hold restoration needs account eligibility, valid dates, investigation disposition and authorised role-manager action; no fresh invitation. Eligible Expired membership may be explicitly extended without fresh invitation. Revoked membership always needs a new invitation and acceptance. Editing a date alone does not authorise restoration.

## 8. Effects on tasks and accountability

- Tasks are not silently reassigned when an invitation is declined, expires or is revoked, or membership becomes inactive.
- The Project Manager is alerted to unfinished work affected by inactive membership.
- Completed tasks remain completed when membership later expires.
- Unfinished tasks retain their history and require authorised reassignment under the task/amendment rules.
- Assignment or authorisation does not bypass eligibility, membership or access checks.

## 9. Project deferral and closure

- Invitations cannot be accepted while the project is Deferred or Closed.
- Deferral locks ordinary invitation changes under the project lifecycle rules.
- Invitation expiry continues during deferral; the clock is not paused by read-only project status.
- Membership expiry continues to remove affected access as scheduled; project deferral does not extend it.
- Reopening does not revive expired invitations or expired membership permissions.
- Members whose appointments remain valid are subject to the project's read-only restrictions while Deferred or Closed.

An otherwise eligible Scheduled membership becomes Active when its start arrives during deferral, but project permissions remain read-only. This does not resume the project. Invitation acceptance remains blocked while Deferred/Closed.

## 10. Required-role expiry

Projects require a Manager, a different person as Member, and at least one Owner or Sponsor, as defined in the product baseline.

- Arrange replacements before a planned change would leave a required role unfilled.
- Nevertheless, a required role holder's access expires when scheduled if no valid extension or replacement has taken effect.
- Flag the project as missing required accountability when that occurs.
- Block project activation or resumption until required replacements are appointed and applicable role conditions are satisfied.
- Do not silently extend access to preserve a required role.

This clarifies any earlier wording that could be read as preventing natural expiry until a replacement exists. Role continuity is a management requirement, not authority for indefinite access.

On an already Active project, flag missing accountability. Continue existing authorised work; block new authorisations and substantive amendments until repair. Permit necessary authorised role/access repairs and protective actions. Do not automatically defer or extend expired access.

## 11. Configuration and policy history

- The Enterprise Administrator controls organisation-wide configuration and delegated project settings.
- Project Managers, Owners and Sponsors may adjust only explicitly delegated operational settings; role-permission definitions, approval policy, security policy and delegation remain Administrator-controlled.
- Invitation validity, membership-expiry defaults/durations and relevant role-management permissions are configurable within mandatory protections and supported capabilities.
- Accepted defaults apply until an authorised policy change takes effect.
- Changes retain actor, reason, previous/new settings, effective date/time and policy version.
- Preserve the policy version used for prior authorisations and grants.
- Explicitly state how pending invitations and existing memberships are affected; do not silently extend appointments or grant access.
- Dates and deadline presentation use UTC+8.

Configuration cannot fabricate human acceptance, remove required attribution/history or bypass explicit access and organisational eligibility.

## 12. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 13. Exact dates and grants

Membership starts at 00:00 UTC+8 on its start date. Date-only expiry is 00:00 after its final valid date. Invitations default to exactly seven elapsed days from issue; show exact expiry. Audit/Oversight default thirty days, maximum ninety per grant/extension unless Administrator changes it; no automatic renewal. Holds suspend additional grants; restoration needs explicit grant review, revocation ends them and expiry continues.
