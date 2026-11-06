# Kainow V1.0 — Project Lifecycle Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules  
**Scope:** Project statuses, lifecycle transitions, stage handling, deferral, closure and reopening. Proposal, task, question and invitation lifecycles are not fully specified by this document.

## 1. Purpose and related documents

This document defines the accepted project lifecycle for Kainow V1.0. It supplements:

- **Kainow-V1.0-Product-Summary.md** — purpose, features and accepted product rules.
- **Kainow-V1.0-Role-Management-Permissions.md** — authority to appoint, replace, remove and extend project roles.

It can be read independently for the project transitions and permissions below. It does not prescribe development methods or implementation architecture.

## 2. Status, stage and outcome

Project status, stage and closure outcome are separate fields.

| Field | Accepted labels | Meaning |
| --- | --- | --- |
| Status | Draft, Planned, Active, Deferred, Closed | Whether the project is operating. |
| Stage | Initiation, Planning, Execution, Review & Acceptance, Closure | Position in the project lifecycle. |
| Closure outcome | Delivered, Partially Delivered, Abandoned | What ultimately happened when the project closed. |

Deferred is a status, not a final completion outcome. A deferred project may resume.

A project does not require a planned end date. Dates and deadlines use UTC+8.

## 3. Accepted project transitions

| Transition | Who may perform it | Conditions |
| --- | --- | --- |
| Draft → Planned | Project Manager, Project Owner or Project Sponsor | Required appointments accepted; Scheduled appointments may qualify. |
| Draft → Active | Project Manager | Fast-track reason, complete required information, Active accepted appointments and valid separation. |
| Planned → Active | Project Manager, Project Owner or Project Sponsor | Required roles are active and role-separation requirements are satisfied. |
| Active → Deferred | Project Manager, Project Owner or Project Sponsor | Reason required; task and invitation changes become locked. |
| Deferred → Active | Enterprise Administrator, Project Manager, Project Owner or Project Sponsor | Reason and resumed stage required; previous history retained. |
| Active → Closed | Project Owner or Project Sponsor | Closure outcome and reason required; unfinished work must be explicitly accounted for. |
| Deferred → Closed | Project Owner or Project Sponsor | Same closure requirements; an abandoned project can close without being restarted. |
| Planned → Closed | Project Owner or Project Sponsor | Outcome must be Abandoned; reason required. |
| Closed → Active | Project Owner or Project Sponsor | Explicit reopening reason and stage required; previous closure remains in history. |

These are the accepted transitions. Other transitions have not been authorised by this document and must not be inferred from a role's general management responsibilities.

## 4. Required roles and authority

Required accountability at transition: Draft may be incomplete; Planned requires accepted appointments (including eligible Scheduled memberships); Active/resumption requires Active appointments and valid separation. The required set is:

- Exactly one accountable Project Manager.
- At least one Member who is a different person from the required Project Manager.
- At least one Project Owner or Project Sponsor.

A project may have one Owner maximum and multiple Sponsors. Neither Owner nor Sponsor is individually mandatory when the other exists.

### Small-team exception

- A small team has fewer than seven distinct active participants: at most six people, including role holders.
- Project Manager, Owner and Sponsor responsibilities may be combined in a small team.
- A Manager holding Owner or Sponsor responsibility may close or reopen a project in that capacity.
- At seven or more people, the agreed separation rules apply.

### Administrator authority

The Enterprise Administrator may reopen a **Deferred** project. This permission does not extend to closing projects or reopening **Closed** projects.

The Administrator's separate authority to manage Project Manager appointments does not confer Owner/Sponsor lifecycle powers. A person must hold the relevant role to exercise those powers.

## 5. Stage and substage handling

- The Project Manager manages stages and substages while the project is Active.
- A stage change does not automatically authorise proposals, complete tasks or change project status.
- Record the current stage, optional substage and duration of the current stage period.
- Preserve previous stage periods and their durations.
- Reopening starts a new period in the selected stage rather than overwriting earlier stage history.

### Optional default substages

| Stage | Optional substages |
| --- | --- |
| Initiation | Define Purpose; Identify Participants; Confirm Accountability |
| Planning | Define Scope; Break Down Work; Identify Resources; Approve Plan |
| Execution | In Progress; Monitoring & Follow-up |
| Review & Acceptance | Review Deliverables; Resolve Outstanding Items; Confirm Acceptance |
| Closure | Record Outcome; Handover; Close Project |

These are defaults that projects may simplify. They are not mandatory sequential checkpoints for every project.

## 6. Deferral

When an Active project becomes Deferred:

- A reason is required and retained in history.
- Ordinary task and invitation changes are locked; only Q04 administrative restoration and Q05 resume-review date amendments are exceptions relevant here.
- Project access becomes read-only, subject to the authorised lifecycle actions in Section 3.
- Existing records and earlier actions remain preserved.

An authorised person may resume the project or an Owner/Sponsor may close it directly. Closing a Deferred project does not require temporary reactivation.

## 7. Closure

- Closure requires a permitted source status, an authorised actor, a reason and a closure outcome.
- Closing a Planned project uses the outcome Abandoned.
- Unfinished work must be explicitly completed, authorised-cancelled or retained outstanding with a reason. Delivered requires met objectives and no outstanding tasks.
- Unfinished tasks are never silently marked complete.
- Closed project records remain read-only except explicit reopening, Q04 administrative restoration/archive operations and Q05 resume-review date amendments.
- Closure retains project evidence, role/action attribution and history.

Closure follows O11 below. Cancellation does not disguise undelivered objectives, and handover requires the receiving active project’s acceptance.

## 8. Reopening and resumption

### Deferred → Active

The Enterprise Administrator, Manager, Owner or Sponsor may resume a Deferred project. A reason and resumed stage are required.

### Closed → Active

Only an Owner or Sponsor may reopen a Closed project. A reopening reason and stage are required. A small-team Manager can do so only when also holding the relevant Owner/Sponsor responsibility.

### Rules applying to both

- Preserve previous closure, deferral and stage history.
- Begin a new period in the selected stage.
- Do not automatically reactivate expired memberships.
- Do not automatically resend invitations.
- Review every outstanding task/subtask due date. New dates require authorisation before start, resume or completion; preserve earlier dates. Approved completion reconciliation handles work already finished during the pause.
- Reopening does not grant additional roles or bypass existing access restrictions.

## 9. Evidence and accountability

Lifecycle actions retain their actor and history. Reasons required by Section 3 must be recorded as part of the action.

Project status changes do not replace proposal authorisation. AI may propose information but does not independently authorise project transitions or commitments.

## 10. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 11. Accepted preparation, reopening and closure detail

### Accepted O08 — Draft, Planned, withdrawn proposals and handover

Draft permits setup, invitations, discussion, minutes and AI proposals; tasks remain drafts rather than actionable commitments. Planned permits planning, review and authorisation; tasks cannot start/complete until Active. Withdrawn proposal versions remain final; resubmission is a linked new proposal with fresh review.

PM may fast-track Draft directly to Active, bypassing the separate Planned step only when required role holders have accepted, memberships are Active, separation holds and mandatory information is complete. Record action and brief reason. Fast-track never approves proposals or bypasses invitations/task validation.

Risk handover requires acceptance by the receiving active project’s Owner/Sponsor before origin closure, with linked records, responsible person and review date. User-owned paused automation needs explicit new ownership before resuming; project-owned automation follows O07.

### Accepted O10 — Reopening task detail

Outstanding work retains status/assignee but cannot start, resume or complete until new due dates are authorised. Once project is Active, comments and evidence updates are permitted. Review each outstanding parent/subtask individually; parent date changes do not cascade. Flag children due after parent.

PM/Deputy can prepare batch date amendments showing every previous/new date. Approval follows project policy; fully authorised tasks proceed independently, remaining tasks keep Deadline review required, and parent conditions still apply.

If work actually finished outside Kainow during the pause, record actual completion date/evidence through Owner/Sponsor-approved completion reconciliation under applicable policy. This narrow exception avoids inventing a future due date simply to close already-finished work. Preserve prior commitment/history.

### Accepted O11 — Closure outcome detail

Delivered requires Owner/Sponsor confirmation that agreed objectives were met and no outstanding tasks. A completion percentage alone is insufficient. Overridden parents never hide unfinished children. Explicitly complete, cancel or retain each unfinished child.

Unresolved questions require reasons or accepted handover; those affecting delivery acceptance prevent Delivered. Risks requiring ongoing review move to an accepting active project. Where no further review is necessary, Owner/Sponsor may record final risk acceptance with reason and explicit No further review required. This closure-only exception removes the next-review-date requirement for that disposition.

Cancellation cannot disguise unmet objectives. Receiving projects accept handed-over work through linked records; origin outcome reflects actual delivery. Partially Delivered and Abandoned remain available with reasons.

## 12. Accepted archive and resume-review procedure

### Q04 — Archive, unarchive and restoration (Accepted)

Only Closed projects may be archived. Default archive timing is twelve months after closure, Administrator-configurable; PM/Owner/Sponsor may archive earlier. PM/Owner/Sponsor may unarchive into ordinary navigation, but the project stays Closed/read-only until a separately authorised reopening.

PM/Deputy may restore Deleted discussion messages with a reason/history; PM/Owner/Sponsor may restore Deleted imported sources after reviewing their intended audience; restoring a Deleted authorised record requires Owner/Sponsor approval, retaining its previous lifecycle status and approval history. These are narrowly permitted administrative actions even while Deferred/Closed; they do not reactivate work or reopen the project.

Preview who will regain visibility. Current account, membership, audience and grant restrictions still apply. Restoration never automatically triggers AI, emails, invitations, deadlines or task execution. Quarantined originals cannot return through ordinary restoration; security review must produce a sanitised version. Record actor, time and reason for archive, unarchive and restore.

### Q05 — Deadline review before resume/reopen (Accepted)

A resume review may run while the project remains Deferred or Closed. PM/Deputy lists every outstanding task and subtask and proposes replacement due dates, showing previous dates, statuses and assignees. Owner/Sponsor approves amendments under project approval policy as a narrow exception to read-only restrictions, not a general reopening of approvals.

The actor with existing lifecycle authority then resumes/reopens after required roles and memberships are valid. Only tasks with approved replacement dates may start, resume or complete after activation; others show Deadline review required. Every outstanding task/subtask needs its own replacement date, different from its previous date and not already past when authorised. Partial approvals are allowed; approved tasks proceed independently, subject to parent conditions. Status/assignee remain unchanged unless separately amended. Flag child dates later than parents without automatic adjustment.

For work actually completed during the pause, use the accepted reconciliation exception: actual completion date, explanation/evidence and Owner/Sponsor approval; do not fabricate a future deadline. Reopening does not resend invitations, restore expired access or replay missed notifications.
