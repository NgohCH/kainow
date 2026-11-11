# V1.0 sub-project 2a: authorised records — design

Date: 9 November 2026. Status: for review by the Product Owner. Nothing here is built yet.

## Why

Kainow's purpose is accountable execution: an authorised proposal must become a record people work on. Today "Approve" only marks a proposal; nothing follows. Sub-project 2a makes authorisation create one task, decision, question or risk, and gives tasks, questions and risks their accepted lifecycles. Sub-project 2b then adds amendments, cancellation, decision replacement/withdrawal, closure accounting and the deadline review on resume.

Rules come from the key documents ([Intent Card](../../Kainow-V1.0-Intent-Card.md), [Product Summary](../../Kainow-V1.0-Product-Summary.md), [Consolidated Specification](../../Kainow-V1.0-Consolidated-Product-Specification-and-Decision-Register.md)) and [Task and Subtask Lifecycle](../../Kainow-V1.0-Task-and-Subtask-Lifecycle-Rules.md), [Proposals and Configurable Business Rules](../../Kainow-V1.0-Proposals-and-Configurable-Business-Rules.md), [Questions, Decisions and Risk Lifecycle](../../Kainow-V1.0-Questions-Decisions-and-Risk-Lifecycle-Rules.md) and [Permission Matrix](../../Kainow-V1.0-Permission-Matrix.md). They are not reopened here. Defaults are used where the documents allow configuration; the settings screens belong to sub-project 7.

Evidence that shaped it: in the Product Owner's provisional review of 205 real-minute proposals (8 November 2026), 46 had owner problems, mostly one action naming several people. V1.0 requires one assignee per task.

## What the Product Owner decided (8–9 November 2026)

| Question | Decision |
| --- | --- |
| Slicing | **Two slices.** 2a: authorising into records, human proposals, task states and subtasks, question and risk lifecycles, splitting multi-person actions. 2b: amendments and cancellation, decision supersede/withdraw, closure accounting, deadline review on resume/reopen, completion reconciliation, multiple approvals. |
| Proposals approved before 2a | **Re-authorise.** They show "Approved before records existed" and the Owner or a Sponsor authorises each through the new step; nothing becomes a commitment automatically. |
| Several people named on an action | **Lead plus subtasks.** The reviewer picks one accountable person; Kainow suggests one subtask per other named person (same wording and due date, editable), all authorised together. Picking one person and keeping the rest as written is also allowed. |
| Turning a written name into an assignee | **Pick or invite.** Choose from the project's people (Active or Scheduled), a likely match pre-selected; or enter an eligible email, which sends an invitation and marks the task Awaiting Membership. The name as written in the notes stays on the record. |

## Records (migration 0014, additions only)

| Record | Fields | Notes |
| --- | --- | --- |
| `human_proposals` | id, project, kind `action`/`decision`/`question`/`risk`, text, owner (as written), due (as written), proposed_by, proposed_at, review_status `pending`/`approved`/`rejected`, reviewed_by/at, reject_reason | "Human proposal — no discussion source". |
| `tasks` | id, project, parent_id (null for top level), title, assignee_id, owner_as_written, due_on (date), status `not_started`/`in_progress`/`blocked`/`completed`/`cancelled`, invitation_id (when awaiting membership), origin (proposal item or human proposal; unique), authorised_by, authorised_at | Depth at most two below a top-level task. `cancelled` is reserved for 2b. |
| `task_events` | id, task, kind `authorised`/`started`/`blocked`/`unblocked`/`completed`/`reopened`, from/to status, note, override_reason, actor, at | Append-only. |
| `decisions` | id, project, statement, rationale, status `active` (2b adds superseded/withdrawn), origin (unique), authorised_by/at | |
| `questions` | id, project, text, requester_id, status `open`/`answered`/`resolved`/`withdrawn`, origin (unique), authorised_by/at | |
| `question_answers` | id, question, answer, author, at | Append-only; several per question. |
| `risks` | id, project, description, severity `low`/`medium`/`high`/`critical`, responsible_id (optional), review_on (optional), mitigation (text), status `open`/`mitigating`/`resolved`/`accepted`, origin (unique), authorised_by/at | |
| `record_events` | id, record kind + id, kind, from/to status, note, actor, at | Append-only history for questions and risks. |

"Origin" is either an extraction item or a human proposal: two nullable columns with exactly one set and a unique index on each, so a proposal can create only one record (or one task tree).

## Rules

### Authorising

- Owner or Sponsor, while the project is Planned or Active and no required role is missing (as for approving today). Deferred/Closed/Draft refuse.
- The authorised content is the proposal's current reviewed version (the edited wording, owner and due where a reviewer changed them).
- **Task:** needs one assignee and a due date (`YYYY-MM-DD`). The due date defaults from the due reading: an exact day, or the latest day of a range; an event or a needs-date reading must be replaced by a date. Optional `subtasks`: each with title, assignee and due date; they become subtasks of the authorised task in the same transaction (depth one; second-level subtasks are added later on a task — see Task changes).
- **Assignee:** an account with a Scheduled or Active membership in the project, or an `inviteEmail` at an eligible domain: an invitation for the Member role is issued (same rules as the People tab) and the task stores it; the task shows **Awaiting Membership** until the person holds an Active membership.
- **Question:** a requester (a project person), defaulting to the person authorising. Starts Open.
- **Risk:** severity required; responsible person and review date optional. Starts Open.
- **Decision:** rationale optional. Starts Active.
- The proposal's review status becomes approved and the record is linked; the item row is locked so concurrent clicks create one record; a second request returns the existing record.
- Items approved before 2a (approved, no record) show "Approved before records existed" and use the same step.
- **Human proposals:** submitted by a Member (their own), the PM, a Deputy, the Owner or a Sponsor while Draft, Planned or Active; reviewed by Owner/Sponsor with the same Authorise and Reject (reason required).

### Tasks

| Change | Who | Condition |
| --- | --- | --- |
| Not Started → In Progress | assignee, PM, Deputy | project Active; assignee's membership Active |
| Not Started / In Progress → Blocked | assignee, PM, Deputy | reason required |
| Blocked → In Progress | assignee, PM, Deputy | how it was resolved required |
| Not Started / In Progress / Blocked → Completed | assignee, PM, Deputy | completion note required; assignee must hold an Active membership to complete it themselves; subtask rule |
| Completed → In Progress (reopen) | PM, Deputy | reason required; completed ancestors reopen in the same action |
| Add a subtask | PM, Deputy | to a task at depth 0 or 1; needs title, assignee (project person) and due date; recorded as authorised by the PM/Deputy under the parent's authorisation — see Note |

- Every change: project Active (Planned allows nothing operational; Draft has no tasks), the actor's current membership, a `task_events` row with actor, note and time.
- **Parent completion:** allowed when every subtask is Completed (or Cancelled, from 2b). Otherwise refused unless a PM or Deputy records an override reason; unfinished subtasks keep their statuses.
- **Indicators** (worked out on read, UTC+8): **Overdue** when not Completed/Cancelled and today is after `due_on`; **Awaiting Membership** when the assignee holds no Active membership (with the invitation's status when there is one: waiting, declined, expired); **Due after its parent task** when a subtask's date is later than its parent's.
- Nothing is reassigned, completed or cancelled automatically when memberships expire, go On Hold or invitations lapse.

Note on added subtasks: the documents make one assignee per task mandatory and let work needing several people be split into subtasks. Adding a subtask after authorisation is a substantive change in principle (2b amendments); 2a lets the PM/Deputy add subtasks only as part of splitting the parent's existing commitment, recorded with actor and reason, and 2b will route new subtasks through amendments if the Product Owner prefers.

### Questions

| Change | Who | Condition |
| --- | --- | --- |
| Answer | any participant with an Active membership | text; Open → Answered (Answered stays Answered) |
| Resolve | requester, PM, Deputy | from Answered; note optional |
| Reopen | requester, PM, Deputy | from Resolved; reason; → Open; answers kept |
| Withdraw | requester, PM | from Open/Answered; reason; final |

### Risks

| Change | Who | Condition |
| --- | --- | --- |
| Start mitigating | responsible person, PM, Deputy | from Open; mitigation detail required |
| Update mitigation, responsible person or review date | responsible person, PM, Deputy | Open/Mitigating; recorded |
| Accept exposure | Owner, Sponsor | from Open/Mitigating; reason, a responsible person and a review date required |
| Approve resolution | Owner, Sponsor | from Open/Mitigating/Accepted; explanation required |
| Reopen | responsible person, PM, Deputy from Resolved; Owner/Sponsor from Accepted | reason; → Open |

### Everywhere

- Deferred and Closed projects: records are readable; every change is refused.
- Grant holders read records; they change nothing.
- Missing accountability blocks authorising; existing tasks, questions and risks continue.
- Every change keeps actor and time; history is append-only.

## Screens

- **Review screen:** Approve becomes **Authorise**, opening a form in the card: for an action, assignee (pick with a likely match pre-selected, or Invite by email), due date (pre-filled from the reading when it is a day or range) and, when several people are named, **Split into subtasks** with one editable row per other name; for a question, the requester; for a risk, severity and optional responsible person. Approved-before-records items say so.
- **Project → Work** tab (new; read by participants and grant holders): Tasks (tree, status, assignee, due, badges, the actions you may take); Questions (answers and actions); Decisions (list); Risks (severity, responsible person, review date, actions). A task page shows history and the source quote.
- **Notes tab:** "Propose something" for human proposals, listed for review with Authorise and Reject.
- **My Projects:** "Your open tasks: N" per project.

## Errors and edge cases

Same pattern as before (404 outside; 403 with reason; 409 rule or state; 400 input). Fixed texts include: "A task needs one assignee and a due date before it can be authorised."; "Subtasks go at most two levels deep."; "Finish the subtasks first, or record an override."; "The assignee must be an Active member to start this task."; "Answered is not Resolved: the requester, Project Manager or a Deputy confirms the answer.".

- Two authorisations of one proposal at once: one record; the second returns it.
- Invited assignee declines or the invitation expires: the task keeps the assignee and shows it; reassignment waits for 2b amendments.
- Assignee expires or is held: the task keeps its assignee; the PM or a Deputy may still record progress or completion.
- A due date already past at authorisation: allowed; Overdue at once.
- A subtask due after its parent: allowed and flagged.

## Testing

Test-first. Pure functions: task transition table (every state × actor kind × project status), parent completion, ancestor reopening, indicators at UTC+8 boundaries, question and risk transitions. HTTP: authorising each kind; one record however many clicks; split into subtasks; invite gives Awaiting Membership until acceptance; old approvals need re-authorising; human proposals; every transition allowed and refused; grant holders read only; Deferred refuses changes. Web label helpers. Then a Docker walk-through, the accessibility audit over the new screens, and a fresh whole-branch review.

## Not in 2a

Amendments and cancellation; decision supersede/withdraw; closure accounting; deadline review on resume/reopen; completion reconciliation; multiple approvals (2b). Reminders and escalation (sub-project 3). Shared discussion (4). Dashboards beyond the open-task count (7).
