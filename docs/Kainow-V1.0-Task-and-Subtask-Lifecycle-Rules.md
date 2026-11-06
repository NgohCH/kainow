# Kainow V1.0 — Task and Subtask Lifecycle Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules; configurable defaults where specified  
**Scope:** Task statuses, transitions, assignment, subtasks, completion, reopening, cancellation and related configuration. Development methods and environment setup are excluded.

## 1. Purpose and related documents

This document defines how authorised tasks move through their lifecycle in Kainow V1.0. It supplements:

- **Kainow-V1.0-Product-Summary.md** — purpose and feature baseline.
- **Kainow-V1.0-Role-Management-Permissions.md** — role appointment and management.
- **Kainow-V1.0-Project-Lifecycle-Rules.md** — project status, deferral, closure and reopening.
- **Kainow-V1.0-Proposals-and-Configurable-Business-Rules.md** — proposal authorisation, amendments, configuration authority and policy history.

The transitions below are accepted defaults. Supported permissions and workflow conditions may be configured within the mandatory protections and V1.0 scope. Unconfigured projects use the accepted defaults.

## 2. Task statuses

| Status | Meaning |
| --- | --- |
| Not Started | Authorised work has not started. |
| In Progress | Work is underway. |
| Blocked | Work cannot proceed; a blocking reason is recorded. |
| Completed | The task has been marked complete under the applicable completion rules. |
| Cancelled | The commitment has been explicitly cancelled under the applicable authorisation rules. |

**Overdue** is a calculated indicator based on the due date, not a manually selected status. **Awaiting Membership** is an assignment indicator, not an additional task status.

An AI proposal is not an authorised task merely because it resembles a task or has one of these labels.

## 3. Default transitions and permissions

All operational transitions are subject to project-state restrictions and the actor's current permissions.

| Transition | Default authority | Conditions |
| --- | --- | --- |
| Not Started → In Progress | Assignee, Project Manager or Deputy Project Manager | Project is Active; assignee has active project membership. |
| Not Started / In Progress → Blocked | Assignee, Project Manager or Deputy Project Manager | Blocking reason required. |
| Blocked → Not Started / In Progress | Assignee, Project Manager or Deputy Project Manager | Record how the blocker was resolved. |
| Not Started / In Progress / Blocked → Completed | Assignee, Project Manager or Deputy Project Manager | Completion note required; parent/subtask conditions apply. |
| Completed → In Progress | Project Manager or Deputy Project Manager | Reopening reason required; preserve previous completion history. |
| Any non-cancelled status → Cancelled | Project Owner or Project Sponsor authorises a cancellation proposal | Reason required; unfinished subtasks must be explicitly addressed. |

Owner/Sponsor status alone does not automatically grant every operational task permission. A small-team Manager holding Owner/Sponsor responsibility can exercise cancellation-authorisation authority in that capacity.

Cancelled tasks cannot be restored. Renewed work uses a new linked authorised task.

## 4. Assignment and required information

- Every authorised actionable task has one assignee and a due date.
- Work requiring several actionees is divided into separately assigned subtasks.
- AI must not invent an assignee or date. An authorised person supplies missing information before a proposal becomes an actionable commitment.
- Dates and deadlines use UTC+8.
- Assignment does not itself grant access or active membership.
- When assignment triggers an invitation, show **Awaiting Membership** clearly.
- Accepting an invitation does not automatically start or complete a task.
- Starting work requires the assignee to have active project membership.

### Membership expiry

- A completed task remains completed when its assignee's membership later expires.
- Unfinished tasks retain their assignee and history; expiry does not silently reassign or complete them.
- Any reassignment follows the authorised amendment process.

This document does not automatically restore task access when an expired membership is extended or replaced. Access follows the applicable active membership and permission rules.

## 5. Subtask structure

- V1.0 supports at most two subtask levels below a top-level task: top-level task → subtask → second-level subtask.
- Work needing deeper nesting must be re-scoped into additional tasks.
- Each task or subtask has its own single assignee and due date.
- Completing or cancelling a parent does not silently complete or cancel its subtasks.

### Parent completion

- By default, a parent can be completed when all its subtasks are Completed or explicitly Cancelled.
- A Project Manager or Deputy may override that requirement with a recorded reason.
- An override preserves the unfinished subtasks and their actual statuses; it does not manufacture completion evidence.

### Reopening under a completed parent

- Reopening a subtask beneath a completed parent requires that parent to be reopened in the same action.
- Apply this consistently through any completed ancestors within the supported two-level hierarchy.
- Preserve the previous completion and reopening history.

## 6. Completion and reopening

- Members can mark their own tasks complete, subject to the configured workflow and subtask rules.
- Project Managers and Deputies can mark tasks complete under the default permissions.
- Completion requires a note by default and records who performed the action.
- Reopening a completed task requires a reason and defaults to Project Manager/Deputy authority.
- Reopening preserves the earlier completion record rather than erasing it.
- A status change does not itself change the authorised assignee, due date or substantive commitment.

## 7. Cancellation and substantive amendments

- Cancellation is an explicit human-authorised change, not deletion.
- By default, an Owner or Sponsor authorises the cancellation proposal.
- Cancellation requires a reason and explicit treatment of unfinished subtasks.
- Existing source evidence, proposals, approvals and task history remain traceable.
- Changes to substance, assignee or due date require an amendment proposal and Owner/Sponsor authorisation under the default policy.
- Routine progress updates and permitted completion/reopening actions follow task permissions; they do not automatically require proposal reauthorisation.
- A pending amendment or cancellation proposal does not silently change the current task commitment.

Authorisation roles and amendment requirements may be configured under the separate business-rule policy. AI cannot authorise those changes.

## 8. Project-state restrictions

- Deferred/Closed projects prevent ordinary task changes. Q05 permits the resume-review date-amendment exception; Q04 permits administrative restoration without restarting work.
- Reopening the project does not automatically change task statuses, assignees or deadlines.
- Expired memberships and old invitations are not automatically reactivated by project reopening.
- Unfinished work must be explicitly accounted for when the project closes; tasks must not be silently marked complete.

At closure, each unfinished task is authorised-cancelled or explicitly retained outstanding with a reason. Delivered requires no outstanding tasks and accepted objectives. No automatic cancellation/transfer is implied.

## 9. Reminders, overdue work and escalation

- Default reminders occur seven days and one day before the due date.
- The default overdue escalation occurs three days after the due date.
- Reminder timing and escalation recipients/sequence are configurable under the approved delegation rules.
- Blocked tasks retain their due dates. While the project is operating, reminders and escalation continue; Blocked is not an automatic deadline extension.
- Completed and Cancelled tasks stop generating future reminders.
- An unfinished subtask passing its parent deadline triggers the separately agreed parent-deadline escalation.
- Dates and notification calculations use UTC+8.

Pause ordinary task/risk notifications while Deferred/Closed. Resumption requires new authorised outstanding-task dates and a consolidated summary rather than missed-message replay. Calendar/working-day counting and alert consolidation follow the notification specification.

## 10. Configuration in V1.0

### Configuration authority

- The Enterprise Administrator controls organisation-wide business rules and which settings may be delegated.
- Project Managers, Owners and Sponsors may change only settings explicitly delegated to them, within organisation-level bounds.
- Configuration does not itself grant task, discussion or authorisation access.

### Supported configurable policy areas

| Area | Configurable policy | Accepted default |
| --- | --- | --- |
| Operational transitions | Eligible roles for starting, blocking, resuming, completing and reopening | As listed in Section 3. |
| Cancellation | Eligible human approving roles and approval requirements | Owner/Sponsor authorises a cancellation proposal. |
| Transition information | Required completion notes, blocking reasons, resolution details and reopening reasons | Required as listed in Section 3. |
| Parent completion | Whether an override is permitted and which roles may exercise it | Manager/Deputy override with recorded reason. |
| Amendments | Eligible human approvers and changes requiring reauthorisation | Substance, assignee and due-date changes require Owner/Sponsor authorisation. |
| Reminders and escalation | Timing, recipients and escalation sequence | Seven-day/one-day reminders; three-day overdue escalation. |
| Labels | Presentation labels within supported task semantics | Not Started, In Progress, Blocked, Completed, Cancelled. |

### Boundaries

- Human authorisation, explicit access, source integrity and preserved history cannot be disabled.
- V1.0 retains one assignee per task, a due date for actionable tasks and the maximum two-level subtask depth.
- Settings cannot silently complete children, erase history, invent evidence or grant access.
- Configurable labels do not create arbitrary new workflow states or executable behaviour.
- Exact editable fields, allowed values and validation limits must be specified before implementation. Configuration support does not imply that every product rule is freely editable.

### Policy history

- Configuration changes record the actor, reason, previous/new settings and effective date/time, and create a policy version.
- Preserve the policy version associated with earlier approvals.
- Explicitly state the effect on pending work and existing projects.
- Do not silently rewrite commitments or migrate existing task records.

## 11. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 12. Accepted reopening and accountability detail

### Accepted O10 — Reopening task detail

Outstanding work retains status/assignee but cannot start, resume or complete until new due dates are authorised. Once project is Active, comments and evidence updates are permitted. Review each outstanding parent/subtask individually; parent date changes do not cascade. Flag children due after parent.

PM/Deputy can prepare batch date amendments showing every previous/new date. Approval follows project policy; fully authorised tasks proceed independently, remaining tasks keep Deadline review required, and parent conditions still apply.

If work actually finished outside Kainow during the pause, record actual completion date/evidence through Owner/Sponsor-approved completion reconciliation under applicable policy. This narrow exception avoids inventing a future due date simply to close already-finished work. Preserve prior commitment/history.

### Accepted O11 — Closure outcome detail

Delivered requires Owner/Sponsor confirmation that agreed objectives were met and no outstanding tasks. A completion percentage alone is insufficient. Overridden parents never hide unfinished children. Explicitly complete, cancel or retain each unfinished child.

Unresolved questions require reasons or accepted handover; those affecting delivery acceptance prevent Delivered. Risks requiring ongoing review move to an accepting active project. Where no further review is necessary, Owner/Sponsor may record final risk acceptance with reason and explicit No further review required. This closure-only exception removes the next-review-date requirement for that disposition.

Cancellation cannot disguise unmet objectives. Receiving projects accept handed-over work through linked records; origin outcome reflects actual delivery. Partially Delivered and Abandoned remain available with reasons.

Missing required role: existing authorised work may continue, but new authorisations and substantive amendments wait for role repair. Awaiting Membership tasks cannot start or complete; deadlines continue.

## 12. Accepted deadline-review gate

### Q05 — Deadline review before resume/reopen (Accepted)

A resume review may run while the project remains Deferred or Closed. PM/Deputy lists every outstanding task and subtask and proposes replacement due dates, showing previous dates, statuses and assignees. Owner/Sponsor approves amendments under project approval policy as a narrow exception to read-only restrictions, not a general reopening of approvals.

The actor with existing lifecycle authority then resumes/reopens after required roles and memberships are valid. Only tasks with approved replacement dates may start, resume or complete after activation; others show Deadline review required. Every outstanding task/subtask needs its own replacement date, different from its previous date and not already past when authorised. Partial approvals are allowed; approved tasks proceed independently, subject to parent conditions. Status/assignee remain unchanged unless separately amended. Flag child dates later than parents without automatic adjustment.

For work actually completed during the pause, use the accepted reconciliation exception: actual completion date, explanation/evidence and Owner/Sponsor approval; do not fabricate a future deadline. Reopening does not resend invitations, restore expired access or replay missed notifications.
