# V1.0 sub-project 2b: changing authorised work, closure accounting and deadline review — design

**Date:** 9 November 2026
**Status:** Approved in conversation by the Product Owner on 9 November 2026, part by part; this document records that design.
**Builds on:** sub-project 2a (authorised records, PR #6) and onboarding (PR #8). Branch `v1/records-2b`.
**Authority:** Consolidated Specification §5 (closure, resumption), §6 (approvals, amendments, task/decision/risk rules), D03–D15, D40, O10, O11, Q05; Proposals and Task Lifecycle rules §7–8; Permission Matrix rows on amendment, cancellation and closure. One new decision (D72, delegated closure) is recorded in §11.

## 1. What 2b adds

2a turned authorised proposals into records people work on. 2b lets that work change only through authorisation, and accounts for it when a project pauses, closes or comes back:

1. **One approval model** for everything that needs Owner/Sponsor authorisation, with a configurable number of distinct approvers (1–3).
2. **Task amendments** (wording, assignee, due date, added subtasks) and **task cancellation**.
3. **Decision replacement and withdrawal**, flagging the work they affect.
4. **Closure accounting**: every unfinished task, open question and live risk gets a disposition before closing; risks can be handed to another active project; an Owner/Sponsor may delegate closing to the PM.
5. **Deadline review** before outstanding work restarts after a pause or closure, and **completion reconciliation** for work finished during the pause.

## 2. Decisions taken with the Product Owner

| Question | Decision |
|---|---|
| Slicing | One slice (one spec, plan, review and PR). |
| Multiple approvals | Built now. |
| Who sets the count | Administrator sets the organisation default and whether projects may override; if allowed, a project's Owner/Sponsor sets its own count. |
| Bounds | 1 to 3 distinct approvers. |
| Scope of the count | One count for every kind of authorisation. |
| Who proposes task changes | The task's assignee (own task) and PM, Deputy, Owner, Sponsor (any task). |
| Decision affected work | The Owner/Sponsor ticks the affected tasks, questions and risks; each gets a review flag. |
| Risk hand-over at closure | Included; the receiving project's Owner/Sponsor accepts. |
| Closing by the PM | An Owner/Sponsor may delegate preparing and closing to the PM (D72). |

## 3. The approval model

### 3.1 Policy

- `approval_policy` (organisation, one row): `required` 1–3 (default 1), `projects_may_override` (default false).
- `projects.required_approvals` nullable 1–3; used only while overrides are allowed. Set by an Owner or Sponsor of the project.
- Every change is recorded in `approval_policy_changes`: scope (organisation or project id), old and new values, reason, actor, time.
- **Effective count** for a project: its own value when overrides are allowed and it has one, else the organisation's.
- Each change request records the effective count **when submitted** (`required_approvals`). A policy change shows how many pending requests it affects (organisation-wide or in the project); the person changing it chooses **Keep their current count** (default) or **Restart their review**, which resets their approvals and records the new count (D14).
- Turning project overrides off makes projects follow the organisation count again for new requests; pending requests keep theirs unless restarted.

### 3.2 Change requests

`change_requests`:

| Column | Meaning |
|---|---|
| id, project_id | |
| kind | `authorise_proposal`, `amend_task`, `cancel_task`, `supersede_decision`, `withdraw_decision`, `deadline_review`, `reconcile_completion`, `risk_handover` |
| target_kind, target_id | The proposal (`extraction_item` / `human_proposal`) or record (`task` / `decision` / `risk`) it acts on |
| batch_id | Groups the requests of one deadline review or one closure cancellation batch |
| version | Current version, starting at 1 |
| required_approvals | Count captured at submission (or at a restart) |
| status | `pending` (Pending Review), `authorised`, `rejected`, `withdrawn`, `superseded` |
| submitted_by/at, decided_at, reason (rejection or withdrawal) | |

`change_request_versions` (append-only): request, version, `terms` jsonb, `reason` (the proposer's), author, time. Revising a pending request adds a version; the request's `version` moves forward.

`approvals`: request, version, approver, time; unique (request, version, approver). Approvals on older versions stay as history and no longer count.

**Rules**

- **Who approves:** people who hold an active Owner or Sponsor membership in the request's project (a small-team PM who also holds Owner or Sponsor counts in that capacity). Each person counts once per version, whatever roles they hold (D11). Audit/Oversight holders never approve. Approving one's own request is allowed (D04).
- **Any order** (D12). The request is authorised when approvals on the current version reach `required_approvals`; its change is applied **in the same transaction** as that last approval, under the target's row lock. A repeated or concurrent approval never applies a change twice.
- **Rejection** by any eligible approver, with a reason, ends that request (D12).
- **Withdrawal** by the submitter (or the PM) while pending.
- **Revision** by the submitter while pending: new version, approvals reset (D13).
- **Not enough approvers:** when fewer eligible approvers exist than `required_approvals`, the request shows `Not enough approvers: needs N, the project has M.` and cannot complete; it continues once approvers are added.
- **One open request per record:** a record (task, decision or risk) has at most one pending request. A second is refused: `This task already has a change waiting for authorisation.` (decision/risk wording likewise). A proposal has at most one pending `authorise_proposal` request.
- **Pending changes nothing** on the target (spec §6).
- **Missing required role** (D03): approvals are refused with the existing missing-accountability message; submissions are allowed and wait.
- **Project state:** `authorise_proposal` while Planned or Active (as 2a); `amend_task`, `cancel_task`, decision changes while Active; `deadline_review` and `reconcile_completion` while Deferred, Closed or Active; closure `cancel_task` batches and `risk_handover` offers while Active or Deferred (closing a Deferred project needs no reactivation); acceptance of a hand-over in the receiving project while it is Active. A request whose project leaves the allowed state cannot be approved until it returns; the panel says why.
- **Re-check at application:** the terms are re-validated when applied (assignee eligibility, a date not in the past where required, the target still in a state the change allows). A failure refuses the approval with the reason; the request stays pending for revision or withdrawal.

### 3.3 2a's proposals join the model

Authorising an AI or people's proposal creates an `authorise_proposal` request whose version 1 terms are the authoriser's choices (task: assignee or invited email, due date, subtasks; risk: responsible person; decision and question: none beyond the proposal). The authoriser's click is the first approval.

- With a count of 1 this is exactly 2a's behaviour: one click creates the record (201 with the record).
- With 2 or 3 the reply is 202 with the request; later approvers see the terms and approve them. Changing a term revises the request.
- An AI proposal's edit (2a's `extraction_item_edits`) after approvals began supersedes the pending request (`superseded`); authorisation starts again on the new wording.
- 2a's idempotency holds: the record is created once, by the approval that completes the count.

## 4. Task amendments and cancellation

**Proposers:** the task's assignee for their own task; PM, Deputy, Owner and Sponsor for any task. Others: `Only the assignee, the Project Manager, a Deputy, an Owner or a Sponsor can propose changes to this task.`

### 4.1 Amendment (`amend_task`)

Terms: any of `title`, `assigneeId` or `inviteEmail`, `dueOn`; plus `reason` (required). At least one value must differ from the task (`Change at least one of the wording, the assignee or the due date.`). Status is never part of an amendment.

- The task shows **Change waiting** while pending.
- On authorisation: the task is updated; `task_events` gets `amended` with `detail` {field: {from, to}}, the reason and the approvers; source evidence and the original authorisation are untouched.
- A new assignee invited by email: the invitation (2a's `issueMemberInvitation`) is issued **at authorisation**, and the task shows Awaiting Membership until accepted. The 2a appointment checks apply.
- A due date in the past is allowed with a warning on the form; the task is overdue at once (O12). A subtask later than its parent is flagged (2a indicator).
- Completed or Cancelled tasks cannot be amended (`A completed or cancelled task cannot be changed; propose a follow-up task instead.`).

### 4.2 Adding a subtask (`amend_task` with `addSubtask`)

Terms: `title`, `assigneeId` or `inviteEmail`, `dueOn`, `reason`. Depth rules from 2a (at most two levels). On authorisation the subtask is created (`task_events` `authorised` with note "Added by amendment"). **This replaces 2a's direct "Add subtask" by the PM/Deputy**: adding a commitment now needs authorisation.

### 4.3 Cancellation (`cancel_task`)

Terms: `reason` (required) and, for each unfinished subtask (any depth), `cancel` or `keep`.

- On authorisation: the task and the subtasks marked `cancel` become **Cancelled** (`task_events` `cancelled`, with the reason). Cancelled is final: no action, amendment or reopen applies.
- A kept subtask stays open under a Cancelled parent and is shown as "Parent cancelled".
- Parent completion now treats Cancelled children as finished (2a §parent completion).
- **Follow-up:** a Cancelled task offers **Propose follow-up task**, which creates a people's proposal (2a) with `follows_task_id`; once authorised, the new task shows "Follows <task>" and the old one "Followed by <task>".

## 5. Decisions

Proposers and approvers: Owner and Sponsor (they choose the affected work). Decisions gain statuses `superseded` and `withdrawn`, links `replaces_id`, and an origin `origin_request_id` (a decision created by replacement has no minutes quote; the one-origin constraint becomes "exactly one of item, proposal, request").

- **Supersede** (`supersede_decision`) terms: `statement`, `rationale`, `reason`, `affected` [{kind, id}]. On authorisation: the old decision becomes Superseded; a new Active decision is created with `replaces_id`; both show the link.
- **Withdraw** (`withdraw_decision`) terms: `reason`, `affected`. On authorisation: Withdrawn.
- Superseded and Withdrawn are final; a replacement can itself be replaced later.
- **Affected work** (D10): each listed open task, question or risk gets a row in `review_flags` (record kind, id, cause `decision_changed`, decision id, raised by/at, cleared by/at, note). Flags show **Review: decision changed**; the PM or a Deputy clears one with a note. Flags never block work. The Overview shows the count of open flags.

## 6. Closure accounting

Closing remains `Active or Deferred → Closed` (and `Planned → Closed`, Abandoned) with outcome and reason. A **Closing** screen first collects a disposition for every open item; **Close** is refused until each has one, naming what is missing.

| Item | Dispositions |
|---|---|
| Task or subtask not Completed/Cancelled (children of overridden parents included) | **Cancel** (a `cancel_task` request in the closure batch, reason per task) or **Keep outstanding** with a reason |
| Question Open or Answered | **Resolve at closure** with a note; **Withdraw** with a reason; **Leave unresolved** with a reason and an optional tick "affects delivery acceptance" |
| Risk Open, Mitigating, or Accepted with a review date | **Hand over** to another active project; or **Final acceptance — No further review required** with a reason |

- **Cancellations** follow the approval count. With a count of 1 and a closer who is an approver, the closer's approval applies them at once; otherwise Close waits until the batch is authorised.
- **Delivered** is offered only when no task is kept outstanding, no unresolved question is ticked "affects delivery acceptance", and the closer ticks **The agreed objectives were met** (O11). Otherwise Partially Delivered or Abandoned, each with a reason.
- **Risk hand-over** (`risk_handover`, raised in the **receiving** project): the closer picks an Active project they are not closing; that project's Owner/Sponsor sees the offer on its Work tab and **Accepts** (choosing a responsible person among its active members and a review date) or **Declines** with a reason. Acceptance follows the receiving project's count. On acceptance a linked risk is created there ("Handed over from <project>") with the description and severity; the origin shows "Handed over to <project>". Close waits until every hand-over is accepted or the disposition is changed.
- **Final acceptance** is an Owner/Sponsor act (O11) even under delegated closure.
- Dispositions are stored in `closure_dispositions` (project, record kind, id, disposition, reason, flags, by, at) as they are chosen, so closing can be prepared over several sittings; changing one replaces it with history. Close writes the transition and marks the dispositions final in one transaction.
- The closed project's Overview lists what was kept outstanding and what was left unresolved.

### 6.1 Delegated closure (D72)

- On the Overview, an Owner or Sponsor chooses **Let the PM close this project** with a reason; any Owner or Sponsor can revoke it. Stored in `closure_delegations` (project, delegated by, reason, at, revoked by/at). It ends when the PM changes or the project closes.
- The delegated PM may prepare dispositions, submit the cancellation batch, offer risk hand-overs, choose the outcome (including the Delivered confirmation) and press **Close**.
- Approvals of cancellations, final risk acceptance and acceptance of hand-overs stay with Owners and Sponsors; the PM's approval does not count unless they also hold Owner or Sponsor in a small team.
- When the PM closes under delegation, the project's Owners and Sponsors receive an email (sender from onboarding, with the letterhead).

## 7. Deadline review and completion reconciliation

**Marking.** When a project becomes Deferred or Closed, every task and subtask not Completed or Cancelled gets `deadline_review_required = true` (`task_events` `review_required`). Status, assignee and due date are unchanged.

**While marked**, after the project is Active again: start, resume and complete are refused with `This task needs a new authorised due date first.`; comments and evidence are allowed (O10); the task shows **Deadline review required** instead of Overdue.

**Preparing** (PM or Deputy; while Deferred, Closed, or Active for tasks still marked): the **Deadline review** screen lists every marked task with status, assignee and membership state (flagged when expired or On Hold), the previous due date, and a new-date field. Each new date must differ from the previous one and not be in the past (re-checked at application); a subtask later than its parent is flagged, not adjusted. **Submit** creates one `deadline_review` request per task, sharing a `batch_id`.

**Approving** (Owner/Sponsor, under the count): **Approve all** or task by task; rejection is per task. On authorisation the task gets its new date, loses the mark, and `task_events` records `deadline_reviewed` {from, to}. This is the narrow exception to read-only while Deferred or Closed (Q05).

**Resuming or reopening** keeps 2a/sub-project 1 authority and does not wait for every review; tasks still marked keep the badge. No invitation is resent, no expired access restored, no notification replayed.

**Completion reconciliation** (`reconcile_completion`): the assignee, PM or a Deputy proposes, for a marked task, the actual completion date (not in the future, not before the pause began), an explanation and optional evidence (text or a link). On authorisation the task becomes Completed with `completed_at` = that date (end of day UTC+8), loses the mark, and `task_events` records `reconciled`. Parent completion rules still apply.

## 8. Interface

- **Work tab:** a **Waiting for authorisation** section first (requests the viewer may approve, then those they submitted); per task **Propose a change**, **Propose cancellation**, **Propose follow-up task** (Cancelled), the **Change waiting**, **Review: decision changed**, **Deadline review required**, **Parent cancelled** and **Follows** labels; per decision **Propose a replacement** / **Propose withdrawal** (Owner/Sponsor).
- **Request panel** (shared by every kind): current and proposed terms side by side, `Approvals 1 of 2` with names, the reason, and the actions the viewer may take (Approve, Reject with reason, Revise, Withdraw), or why none.
- **Overview:** open review flags count; delegation control; **Prepare closure** (opens the Closing screen) for Owner/Sponsor or the delegated PM; **Deadline review** for PM/Deputy while marked tasks exist.
- **Administration → Approvals:** the organisation count and the override switch, with the affected-pending preview and the keep/restart choice; the change history.
- **Project Overview → Approvals** (Owner/Sponsor, when overrides are allowed): the project count, same preview.
- Accessibility pass extended to every new screen and panel state.

## 9. Records, migration and existing data

Migration `0017_changes.sql` adds `approval_policy` (seeded `required = 1`, `projects_may_override = false`), `approval_policy_changes`, `projects.required_approvals`, `change_requests`, `change_request_versions`, `approvals`, `review_flags`, `closure_dispositions`, `closure_delegations`, decision statuses and links, `tasks.deadline_review_required`, `tasks.follows_task_id` (and `human_proposals.follows_task_id`), `tasks.completed_at` if absent, and new `task_events` kinds (`amended`, `cancelled`, `review_required`, `deadline_reviewed`, `reconciled`). History tables are append-only as in 2a.

Existing data: records authorised in 2a are unchanged; projects already Deferred or Closed when the migration runs have their outstanding tasks marked by the migration. Every write in this document is audited (`writeAudit`) with actor and subject.

## 10. Testing

- Unit: effective-count resolution; request state machine (approve to count, any order, distinct people, revision reset, rejection, withdrawal, supersede on proposal edit); disposition completeness and the Delivered rule; deadline-review date rules; reconciliation date rules.
- HTTP, per kind: count 1 and count 2 paths; a second approval by the same person (no effect); two approvers at once (applied once); not enough approvers; missing required role; wrong project state; a second open request refused; re-check failure at application; grant holders refused.
- Policy: organisation and project counts; override switch; keep vs restart for pending requests; history rows.
- Closure: refused until every item has a disposition; Delivered refused with an outstanding task or a delivery-affecting question; hand-over accept/decline across projects; delegated PM can close but cannot approve; Owner/Sponsor email on delegated close.
- Deadline review: marking on defer/close; refused task actions while marked; partial approval; reconciliation; resume without all reviews.
- 2a regressions: authorising with count 1 behaves exactly as before.
- Accessibility pass on the new screens; Docker walk-through of a full cycle (amend, cancel, supersede, defer, review, resume, close with hand-over).

## 11. Decision Register entry (to add)

**D72 — Delegated closure (9 November 2026).** An Owner or Sponsor may delegate preparing and performing a project's closure to its PM, with a recorded reason, revocable by any Owner or Sponsor and ending when the PM changes or the project closes. The delegated PM records dispositions, submits cancellations, offers risk hand-overs, chooses the outcome and closes. Approval of cancellations, final risk acceptance and acceptance of handed-over risks remain Owner/Sponsor acts. Owners and Sponsors are notified when the PM closes.

## 12. Out of scope

Rewording questions and changing a risk's description or severity (2a's question and risk actions remain); question hand-over to another project; logical deletion and restoration of records (sub-project 5); reminders, escalation and the resumption summary email (sub-project 3); separate approval counts per kind.
