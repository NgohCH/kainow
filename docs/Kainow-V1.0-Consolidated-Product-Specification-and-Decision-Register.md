# Kainow V1.0 — Consolidated Product Specification and Decision Register

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Reconciled V1.0 product handover edition. Accepted requirements; downstream design/verification tracked separately. Not delivery acceptance.  
**Scope:** Product requirements only. Development methods, agent orchestration and environment setup are excluded.

## 1. How to use this document

This is the primary working reference for Kainow V1.0 product intent, accepted defaults and outstanding decisions. It consolidates the original 18 supporting documents, decisions D01–D70 and resolutions O01–O17. START-HERE indexes the complete current handover, including the Intent Card and shared catalogues.

This handover reconciles the supporting requirements with D01–D70 and O01–O17. Use START-HERE for document order, the Permission Matrix for default actions, the Configuration Catalogue for settings and the Remaining Design and Verification Register for explicit downstream work. Q01–Q06 below now settle the six handover clarifications; Q02 explicitly replaces the older Calendar Days default with Working Days. Any new conflict requires a recorded Owner decision; exact visual design/technical contracts are not implied by scope acceptance.

The supporting files in this edition have been edited to remove superseded statements and incorporate accepted resolutions. This document explains V1.0 end to end; use the indexed specialist references for detailed transition conditions. Old versions remain historical rather than current instructions.

## 2. Product purpose and scope

Kainow turns conversations into accountable execution. People supply meeting notes or minutes and discuss project work. AI proposes tasks, decisions, questions and risks with supporting evidence. People review and authorise them. The product shows responsibilities, deadlines, progress and subsequent history.

V1.0 supports one organisation per installation, multiple projects, departmental ownership and contribution, full project lifecycle, shared discussion, project-focused AI assistance, external deliverable management and consolidated action-item emails.

### Mandatory principles

- AI proposes; people authorise. AI proposals have a dashed outline and an “AI proposed” label.
- Discussion, minutes and feedback are data, never executable instructions or approval authority.
- AI does not invent owners or dates. Human additions are separately attributed.
- Source versions, approvals and changes remain traceable. Authorisation applies to an exact version.
- Records carry organisation scope and project scope where applicable; actions retain their actor.
- Access controls apply throughout ordinary views, previews, search, AI retrieval, emails, exports and history.
- Passwordless sign-in only, for eligible invited people. Domain matching alone grants no access.
- Project-specific AI credentials, approved destinations and enforceable spending allowances.
- Logical deletion only in V1.0; no ordinary permanent-deletion capability.
- Dates and deadlines use UTC+8.

### First-use targets

Proposal generation approximately one minute; meaningful human review approximately two minutes; a newcomer’s first useful loop under five minutes without assistance. Measure quality and actual human understanding, not just speed.

### Outside V1.0

Audio recording, transcription, Gantt charts, advanced portfolio management, multiple organisations per installation, outside-organisation participants, public API, plugin loading, arbitrary workflow builders, unrestricted custom fields, general document editing, resource booking/allocation, full financial accounting and a general-purpose AI assistant remain outside scope.

Project discussion and action-item emails are included; a general chat or email-client replacement is not. Typed-meeting minute-taking is included (D74); audio recording and transcription are not.

The selected product licence is **AGPL-3.0-only**, replacing the original UNLICENSED wording. V1.0 adds no commercial restrictions; future commercial arrangements require a separate decision. Repository: https://github.com/NgohCH/kainow.

## 3. Organisation, departments and accountability

Each project has exactly one owning department and may have multiple contributing departments. Member affiliation is separate from project role. Outputs identify named and departmental contributions, with AI assistance labelled separately.

Department affiliation does not grant access. Reporting distinguishes owned projects from contributed-to projects and counts each project once in organisation totals. Only the Enterprise Administrator transfers departmental ownership, recording a reason and explicitly addressing external folder relocation.

The Administrator creates the first project. Subsequently, eligible existing users create projects and become their first PM. A Draft can exist before the remaining required roles are filled.

### Required roles

- Exactly one accountable Project Manager, with optional multiple Deputies.
- At least one Member who is a different person from the required PM.
- At least one Owner or Sponsor: maximum one Owner, multiple Sponsors permitted.
- Fewer than seven distinct active participants is a small team. PM, Owner and Sponsor responsibilities may combine; required PM and Member remain distinct.
- At seven or more, PM, Owner and Sponsor responsibilities must be held by different people where those roles exist. Resolve combinations before the seventh participant activates.
- Audit/Oversight are additional scoped, time-limited grants, not replacements for the primary project role.

### Default role-management authority

| Role | Appointment, replacement, removal and extension authority |
| --- | --- |
| Owner | Enterprise Administrator. |
| Sponsor | Enterprise Administrator or Owner. |
| PM | Enterprise Administrator, Owner or Sponsor; outgoing PM may transfer to an eligible accepting replacement. |
| Deputy or Member | PM, Owner or Sponsor. |
| Audit/Oversight grant | Enterprise Administrator, Owner or Sponsor; recorded request and no self-approval. |

Administrative authority does not confer general project-content access or Owner/Sponsor approval powers. Expiry always removes access as scheduled; required-role continuity never silently extends access.

## 4. Membership and sign-in

Invitation states: Invited, Accepted, Declined, Expired, Revoked. Membership states: Scheduled, Active, On Hold, Expired, Revoked. Account states: Invited, Active, Disabled. Keep these separate from project status and additional grants.

Invitations default to seven days from issue. Resending invalidates the old acceptance link and preserves history. Acceptance checks eligibility, dates and role restrictions. A pending invitation grants no access. Assignment can trigger an invitation and shows Awaiting Membership.

Every membership has a start date no earlier than project creation; expiry is configurable, with no mandatory six-month default. Ordinary membership defaults to no expiry. A project may have no planned end date. Date-only membership starts at 00:00 UTC+8 and expires at 00:00 after the stated final day.

Disabling an account invalidates sessions and pending sign-in codes and places current memberships On Hold. It does not revive already expired/revoked appointments. PM investigates within role authority. Account re-enablement alone does not clear project holds.

Eligible On Hold restoration is explicit and recorded, without a new invitation. Expired membership may be extended after eligibility review. Revoked membership requires a fresh invitation and acceptance. Reuse stable identity/history but grant only the newly approved role and current access.

Passwordless email codes default to ten-minute validity and five incorrect attempts. Resending invalidates the old code. Sessions default to thirty-minute inactivity and twelve-hour maximum, with warning and recoverable-draft preservation. Provide current-session and all-session sign-out.

First-Administrator setup uses a controlled invitation. Support additional Administrators and protect the final active Administrator from ordinary removal without replacement. The controlled recovery model is accepted in O07; nominate its custodian/address and verify the operational procedure before go-live. Administrator-approved email changes require verification of the new eligible address, preserve identity/history and invalidate sessions and pending codes.

## 5. Project lifecycle

Statuses: **Draft, Planned, Active, Deferred, Closed**. Stages: **Initiation, Planning, Execution, Review & Acceptance, Closure**. Optional substages follow the supporting specification. Closure outcomes: **Delivered, Partially Delivered, Abandoned**. Deferred is not a closure outcome.

| Transition | Default authority and conditions |
| --- | --- |
| Draft → Planned | PM/Owner/Sponsor; required appointments accepted, including eligible Scheduled appointments. |
| Planned → Active | PM/Owner/Sponsor; required appointments Active and separation valid. |
| Draft → Active | PM fast-track; complete mandatory information, accepted Active appointments, separation and recorded reason. |
| Active → Deferred | PM/Owner/Sponsor; reason required. |
| Deferred → Active | Administrator/PM/Owner/Sponsor; reason and resumed stage required. |
| Active or Deferred → Closed | Owner/Sponsor; outcome, reason and unfinished-work disposition required. |
| Planned → Closed | Owner/Sponsor; Abandoned outcome and reason. |
| Closed → Active | Owner/Sponsor; reason and reopened stage required. |

PM manages stage/substage while Active. Preserve all stage periods; resumption/reopening starts a new period.

Deferred and Closed projects remain readable under valid permissions. Stop ordinary edits, discussion posts, imports, AI operations and scheduled digests. Permit specifically authorised role/access repair and lifecycle actions, Q04 administrative restoration and Q05 resume-review date amendments. Expiry continues.

Closing requires each unfinished task to be explicitly cancelled through authorisation or retained outstanding with a reason. Delivered requires no outstanding tasks; otherwise select Partially Delivered or Abandoned. Unresolved questions need an explicit disposition. Risks needing ongoing review must be handed to an active project before closure.

On resumption or reopening, outstanding tasks retain status and assignee but require **new authorised due dates** before start, resume or completion. Allow comments/evidence once Active; already-finished work uses approved completion reconciliation. Preserve previous deadlines; display Deadline review required. Completed and Cancelled work remains unchanged. Recheck assignee membership.

## 6. Proposals, approvals and records

Proposal states: Pending Review, Authorised, Rejected, Withdrawn, Superseded. Source-based proposals carry quotes and source versions. Human-originated proposals without a discussion source carry an explicit human-origin label.

Owner/Sponsor authorises by default. One human approval is the default; configurable multiple approvals must use distinct people for the same version. Combined roles never count twice. Self-approval is permitted where the person holds valid approval authority, unless stricter policy applies. Audit/Oversight self-approval remains prohibited.

Any-order multiple approvals authorise only after all requirements are met. Rejection ends that review. Revisions create new versions and reset pending approval counts; preserve historical approvals. Prevent silent concurrent overwrite. Repeated approval actions must not create duplicate authorised records.

Substantive scope, assignment or due-date changes require an amendment by default. Progress notes, supporting evidence and permitted lifecycle actions use their ordinary permissions. Evidence edits cannot rewrite the original approval basis. Applying a new policy to pending proposals requires impact preview and an explicit decision to restart review; existing policy is retained by default.

### Tasks and subtasks

States: Not Started, In Progress, Blocked, Completed, Cancelled. Overdue and Awaiting Membership are indicators, not lifecycle states. One assignee and a due date per actionable task. Support at most two subtask levels below a top-level task.

Assignee/PM/Deputy can start, block, resume and complete under the supporting conditions; required notes and reasons remain applicable. PM/Deputy reopens completed work. Owner/Sponsor authorises cancellation. Cancelled is final; renewed work uses a new linked authorised task.

Parent completion requires children Completed or Cancelled unless PM/Deputy records an override. An override preserves unfinished children. Reopening a child reopens completed ancestors in the same action. Pending-membership tasks cannot start or complete; deadlines continue and PM receives invitation-failure alerts.

### Questions, decisions and risks

- Questions: Open, Answered, Resolved, Withdrawn. Answers do not automatically resolve questions. Requester/PM/Deputy may resolve or reopen; reopened questions return Open. Multiple answers remain separately attributed. Withdrawn is final; renewed questions use a linked new record.
- Decisions: Active, Superseded, Withdrawn. Owner/Sponsor authorises substantive replacement or withdrawal. Identify affected work and flag review without automatic cancellation or amendment.
- Risks: Open, Mitigating, Resolved, Accepted. Default severity Low/Medium/High/Critical, with controlled definitions. Risk Responsible Person/PM/Deputy manage mitigation. Owner/Sponsor accepts exposure or approves resolution. Accepted continuing risk requires reason and review date. Closure-only final acceptance may explicitly state No further review required with a reason. Reopening returns Open; reversing acceptance needs Owner/Sponsor authority. Resolution requires an explanation and evidence where available; task completion alone is insufficient.

## 7. Discussion, minutes and AI assistance

Shared project threads/replies support discussion, queries, feedback, extraction and draft reports/specifications. Human edits preserve earlier versions. PM/Deputy moderation is recorded and distinct from the original author.

PM/Deputy/Owner/Sponsor import minutes. Members submit minutes for their review before publication. Show the intended audience before publication.

Project-related minutes default to active members. Restricted minutes default to PM/Deputy/Owner/Sponsor. PM/Owner/Sponsor manage audiences within Administrator policy; new members inherit the current policy, including earlier shared minutes. Audit/Oversight extends access only within its explicit scope/period.

AI analysis is **on by default for a project with Administrator-approved AI configuration**, subject to valid project credentials and spending allowance. Project authorities can disable or adjust permitted batching/frequency. Track processed source versions and attempts to avoid duplicate proposals. Automatic analysis never authorises records.

Use only information available to the requester and the intended result audience. Shared replies use sources available to the discussion audience. Restricted-source answers appear in separately permissioned result views. Wider sharing requires explicit permission/review; prevent indirect reconstruction through repeated queries, previews or quotations.

Feedback defaults to Open, Reviewed, Closed; PM/Deputy reviews and escalates configuration/provider issues to the Administrator. Feedback does not silently train a model, change instructions or amend approved records.

## 8. AI credentials, usage and spending

Support multiple Administrator-approved API providers/models and configured fallback. Each project uses its own credentials; no cross-project borrowing. Attribute user requests individually and automatic requests to their configured event. Track attempts and available tokens/costs, distinguishing estimates, reservations and confirmed amounts.

**Blank spending limit = zero allowance.** Explicit zero has the same effect. No setting silently means unlimited. An approved AI configuration can remain enabled while operations display Blocked — no spending allowance.

Reserve conservative request costs before concurrent execution. Retain uncertain reservations until reconciliation, never recording unknown costs as zero. Retry/fallback is bounded, configured and cannot bypass data permissions or caps. Provider charges can arrive later; do not promise exact immediate billing.

AI costs remain tracked and constrained even when ordinary project financial tracking is Not Required. O03–O05 settle launch services, daily/monthly periods, retry/timeout defaults and project currency rules. Secure connector authentication, pricing reconciliation and exact storage contracts remain design/verification work.

## 9. Reminders and communication

Default task reminders: seven days and one day before due date. Escalate once at three days overdue per episode. An unfinished subtask passing its parent deadline has a separate escalation. Blocked status does not extend deadlines. Completed/Cancelled work stops reminders.

Member/Deputy escalates to PM; PM to Owner/Sponsors; Owner/Sponsor to another accountable person, never only self. If none exists, flag No independent escalation recipient rather than inventing one. Inactive-member work alerts go to PM, then eligible Owner/Sponsor if PM unavailable, then Administrator with minimal administrative information.

Pause task/risk-review reminders and ordinary digests during deferral/closure; expiry and appropriate security/access/failure notices continue. On resumption, recalculate task reminders after new deadlines are authorised and send one consolidated summary, not a backlog. Flag overdue risk reviews. Risk date-only reviews are due at the end of the UTC+8 date, with default 09:00 due-day notice and next-morning missed-review notice. Projects configure calendar/working-day intervals; responsible person and PM receive notice, or PM alone if unassigned.

Manual consolidated action-item emails are available to PM/Owner/Sponsor. Scheduled daily/weekly digests require project enablement and a UTC+8 time. Send relevant authorised information only, filter recipients/content at delivery and pause when Deferred/Closed. Bounded temporary-failure retries must avoid duplicating confirmed deliveries. Email acceptance by the service is not proof of reading.

## 10. Outputs, resources and optional financial tracking

Files live in approved external storage, managed through a Kainow register. Administrator configures destinations. Primary structure:

`Owning Department > Project > Year > Report Type`

Use issue year in UTC+8, one primary type/location and extra searchable categories. One authoritative copy serves participating departments. Existing references may stay in approved locations with their placement clearly labelled.

Members prepare drafts/submit existing documents. PM/Deputy manages register/filing. Owner/Sponsor approves outputs, with additional review configurable. Approval does not automatically authorise commitments mentioned in a document. Preserve versions and attribution; show missing/moved/changed files and reconcile explicitly. A working link is not proof of unchanged content. Both Kainow and external-storage permissions apply.

Shared people/equipment/facilities indicate usage only, not reservation/allocation. Administrator maintains/delegates the resource catalogue. Retired references remain in history but prevent new selection.

Financial Tracking defaults to **Not Required**. Delegated PM/Owner/Sponsor may enable it. Missing data differs from zero. Owner/Sponsor approves budget establishment/amendment; PM/Deputy records expenditure. Default detail access: PM/Deputy/Owner/Sponsor; others need explicit configuration. Leadership has permitted summaries only.

One project reporting currency; no automatic conversion or mixed-currency total. Foreign-currency references enter project totals only with human-authorised rate/date/converted amount. Organisation summaries group by currency. Correct expenditure through linked adjustments; refunds reference expenditure where possible. Disabling hides ordinary sections but preserves authorised historical access through a labelled history view. Keep AI billing separate to avoid double-counting.

## 11. Dashboards, configuration and interface

Personal, project and explicitly granted leadership-summary views show permitted work, status, stage duration, blockers, questions/decisions/risks and resource indicators. Leadership grants have start date, optional expiry and revocation; they do not grant raw sources or management powers.

Task completion = Completed eligible leaf tasks / all eligible leaf tasks × 100; exclude Cancelled and count no parents twice. With none, show Progress not yet measurable. Distinguish task completion from delivery outcome. Metrics limited to visible records must disclose partial coverage. Whole-project aggregates require their own permission.

Over five projects, use collapsible sections, collapsed by default; five or fewer expanded by default. Saved choices override defaults. Remember preferences across filtering, provide Expand/Collapse All and show refresh/staleness information.

UI must be intuitive, logically organised, easy to navigate and elegant: familiar controls, plain language, balanced spacing, readable hierarchy, restrained colours and calm consistency. Summary first; maintain project/evidence context and distinguish saving/saved/failed. WCAG 2.2 AA target, keyboard and screen-reader support, alternatives to dragging, responsive and zoomed use. Exact visual design remains open.

No separate user settings page. Personal colours/arrangement/reset live on dashboards. Administrator has System Settings; PM/Owner/Sponsor has only delegated Project Settings. No delegation means read-only for that setting. Fields/categories are a defined catalogue, not arbitrary custom-field creation.

Policy changes retain actor, reason, previous/new values, effective time and version. New required fields apply to new records by default; existing records show deficiencies when substantively amended. Retrospective application needs explicit impact review. Settings cannot silently rewrite commitments or grants.

## 12. Retention, logical deletion and access

Administrator configures retention/archiving by category, respecting linked evidence. Retention does not physically erase stored content in V1.0.

Deleted content is marked Deleted, with actor/time/reason, hidden from ordinary views/search/exports and excluded from future AI processing, including queued analysis not yet executed. Explicitly authorised audit access may inspect retained content with its Deleted label. Existing authorised records and source links remain historical; flag affected records rather than silently rewriting commitments. Restoration is authorised/recorded and does not restart processing automatically.

Moderation can hide inappropriate messages with a reason and preserved versions. Secret capture follows accepted O01 security quarantine: retained encrypted originals under separate security grants, sanitised working content, processing exclusion and rotation/revocation follow-up. No physical deletion exception is introduced.

Collect only necessary project information. Account disablement, membership restrictions and source permission changes apply to future access and stored AI-result views. Previously read/emailed information cannot be recalled by changing access.

## 13. Configuration register: accepted defaults

| Setting | Default or mandatory boundary | Authority |
| --- | --- | --- |
| Small-team threshold | Fewer than seven active people; PM/Member distinct | Administrator-controlled supported policy options; mandatory accountability retained |
| PM count | One accountable PM; multiple optional Deputies | Role managers within accepted requirements |
| Invitation validity | Seven days from issue | Administrator or expressly delegated project authority |
| Membership expiry | No expiry by default; configurable; no mandatory six-month term | Role-specific managers |
| Audit/Oversight term | Thirty days; mandatory end; ninety-day default maximum per grant/extension | Administrator sets bounds; separate eligible approver grants/extends |
| Sign-in code | Ten minutes; five incorrect attempts; single use | Administrator |
| Session | Thirty-minute idle; twelve-hour maximum | Administrator |
| Proposal approval | One human; multiple distinct approvals supported | Administrator and explicit project delegation |
| Self-approval | Allowed with eligible role; never for Audit/Oversight grants | Administrator may tighten proposal policy |
| Automatic AI | On with approved project setup; operational only with credentials and allowance | Administrator bounds; delegated PM/Owner/Sponsor controls |
| AI spend cap | Blank or zero means zero allowance | Approved administrative controls |
| Task reminders | Seven/one day before; three-day overdue escalation | Administrator and permitted project delegation |
| Scheduled digest | Requires enablement; daily/weekly and UTC+8 send time | Delegated PM/Owner/Sponsor |
| Minutes | Project-related shared with active members; explicit restricted exception | PM/Owner/Sponsor within organisation policy |
| Financial Tracking | Not Required | Delegated PM/Owner/Sponsor |
| Financial detail | PM/Deputy/Owner/Sponsor | Explicit project policy within organisation bounds |
| Categories/resources | Controlled values; retire without rewriting history | Administrator; catalogue maintenance may be delegated |
| Required fields | New records by default; retrospective application reviewed | Administrator and explicit project delegation |
| Dashboard appearance | Per-user controls; preserve accessibility and essential warnings | Individual user, within supported options |
| Retention | Configured archiving/access; no automatic physical deletion | Administrator |

Unspecified numerical bounds are not unlimited; record them as open until defined.

## 14. Accepted reconciliation decision register

All entries below were explicitly accepted in this conversation. Wording summarises the decisions; operative details above retain their qualifications.

| ID | Accepted decision |
| --- | --- |
| D01 | Draft creation may precede required appointments; Planned requires accepted appointments; Active requires active roles. |
| D02 | One PM, optional multiple Deputies; transfer waits for eligible replacement acceptance and explicit outgoing disposition. |
| D03 | Missing required role flags the Active project, permits existing authorised work, blocks new authorisations/substantive amendments pending repair. |
| D04 | Proposal self-approval allowed with valid authority; stricter policy supported; grant self-approval prohibited. |
| D05 | Pending-member tasks may be authorised but cannot start/complete; deadlines continue. |
| D06 | Cancelled task is final; renewed work is a linked new authorised task. |
| D07 | Closure explicitly disposes unfinished tasks; Delivered has none outstanding. |
| D08 | Deferred resumption and Closed reopening require new authorised outstanding-task deadlines before restart. |
| D09 | Reopened questions/risks return Open; reversal of risk acceptance requires Owner/Sponsor. |
| D10 | Decision replacement/withdrawal identifies affected work without automatic changes. |
| D11 | Default one approval; multiple require distinct people, not role counts. |
| D12 | Any-order approvals for the same version; rejection ends review. |
| D13 | Proposal revision resets pending approval count and preserves previous history. |
| D14 | Pending proposals retain existing policy unless explicitly migrated with review restart. |
| D15 | Routine notes/evidence/lifecycle actions separate from substantive scope/assignee/date amendments. |
| D16 | Project threads/replies, own-message edits with versions, separately recorded moderation. |
| D17 | Management roles import minutes; members submit for publication review. |
| D18 | Delegated audience control; new members inherit current policy for earlier shared minutes. |
| D19 | Automatic AI on by default with Administrator-approved project configuration, valid credentials and allowance. |
| D20 | Shared answers safe for shared audience; restricted results separately permissioned; wider sharing explicit. |
| D21 | Deferred: readable, ordinary posting/import/AI stopped, necessary authorised repairs permitted. |
| D22 | Closed: readable, ordinary posting/import/AI/digests stopped; reopen for new work. |
| D23 | Pause task/risk notifications, never expiry; appropriate security/access/failure notices continue. |
| D24 | Recalculate after new authorised dates; consolidated resumption summary, no missed-message flood. |
| D25 | Delivery-time access checks and minimal administrative fallback for unavailable PM. |
| D26 | UTC+8 start/end boundaries; seven-day invitation elapsed validity. |
| D27 | Scheduled membership can activate during deferral but stays subject to read-only restrictions. |
| D28 | Eligible expired extension without new invitation; revoked requires fresh invitation/acceptance. |
| D29 | Role managers may initiate project holds within authority; reason and appropriate notices. |
| D30 | Hold suspends project grants; explicit review for restoration; revocation ends grants; independent grant holders governed by account/grant status. |
| D31 | Members draft/submit outputs; PM/Deputy register/file; Owner/Sponsor approve. |
| D32 | Approved existing external locations permitted without forced relocation. |
| D33 | Financial Tracking defaults Not Required; disabling preserves history, never stops AI accounting. |
| D34 | Default financial-detail audience PM/Deputy/Owner/Sponsor; others explicit. |
| D35 | Administrator maintains/delegates resource catalogue; retirement preserves history. |
| D36 | Low/Medium/High/Critical risk labels with controlled descriptions. |
| D37 | Responsible person/PM/Deputy manage mitigation; Owner/Sponsor accepts/resolves. |
| D38 | Risk resolution explanation/evidence; mitigation completion alone insufficient. |
| D39 | Separately attributed answers, own revisions, recorded moderation; Withdrawn final. |
| D40 | Closure dispositions for questions/risks; risks needing ongoing review handed to active project. |
| D41 | Approved provider/data/project credentials; blank spending limit means zero allowance. |
| D42 | Conservative cost reservations prevent concurrent overspend. |
| D43 | Unknown charges retain reservation, never become zero cost. |
| D44 | Bounded approved retry/fallback, same-project credentials, caps/access preserved. |
| D45 | Feedback Open/Reviewed/Closed, PM/Deputy review, Administrator escalation where needed. |
| D46 | Manual digests and explicitly enabled daily/weekly schedules; relevant content only. |
| D47 | Recorded delivery and bounded retries without duplicate confirmed deliveries. |
| D48 | Scoped leadership grants, start and optional expiry; summary powers only. |
| D49 | Visible-data metrics disclose partial coverage; full aggregates separately authorised. |
| D50 | Refresh/stale labels and persistent layout/expansion preferences across filters. |
| D51 | One reporting currency per financial project; no automatic FX or mixed totals. |
| D52 | Linked financial adjustments/refunds preserve original entries. |
| D53 | Explicit authorised finance-history view after tracking disabled. |
| D54 | Controlled organisation/local categories; retire old values without rewriting records. |
| D55 | Flag external location/content changes; reconcile rather than silently approve. |
| D56 | Category-specific retention/archiving respects linked evidence; no physical erasure. |
| D57 | Logical deletion, actor/time/reason, ordinary-view exclusion and no future AI processing. |
| D58 | Retained Deleted content only for authorised audit; linked records/history preserved; secret handling follows O01 quarantine. |
| D59 | Recorded hiding/moderation, affected-record review, controlled restoration without automatic analysis. |
| D60 | Necessary data only; consistent protection across every delivery/retrieval surface. |
| D61 | Explicit project delegation; otherwise read-only; versioned setting changes. |
| D62 | Required fields prospective by default; reviewed retrospective effects. |
| D63 | Defined field catalogue and controlled categories; no arbitrary custom-field/workflow builder. |
| D64 | One escalation per overdue episode; authorised date changes restart schedule; task reopening creates one new applicable event. |
| D65 | Risk date-only reviews due end-of-day UTC+8; responsible person/PM notified; no automatic state change. |
| D66 | Single-use emailed code, ten minutes, five incorrect attempts; resend invalidates old. |
| D67 | Thirty-minute idle/twelve-hour maximum session; warning and recoverable drafts. |
| D68 | Controlled initial Administrator invitation, multiple Administrators and safeguarded recovery. |
| D69 | Audit/Oversight default thirty days, required end, configured maximum, independent extension approval. |
| D70 | Administrator-approved verified eligible email change; stable identity/history and invalidated sessions/codes. |
| D71 | Organisation registration at onboarding (9 November 2026): each installation registers its organisation's name, at least one email domain and at least one department before first use, and until then only setup is open. Until then Kainow shows its own default name and logos; afterwards the organisation's name and any wide or square logo an Enterprise Administrator uploads replace them, on the page header, sign-in page, emails, and reports and formal outputs. The product contains no organisation's name or domain. The first Administrator is created through the one-time setup invitation, which closes once accepted. |
| D72 | Delegated closure (9 November 2026): An Owner or Sponsor may delegate preparing and performing a project's closure to its PM, with a recorded reason, revocable by any Owner or Sponsor and ending when the PM changes or the project closes. The delegated PM records dispositions, submits cancellations, offers risk hand-overs, chooses the outcome and closes. Approval of cancellations, final risk acceptance and acceptance of handed-over risks remain Owner/Sponsor acts. Owners and Sponsors are notified when the PM closes. |
| D73 | Discussion quiet period (11 November 2026): Automatic discussion analysis keeps the accepted 300-second default. The supported range is 5 to 30 whole minutes, chosen by the Enterprise Administrator for the organisation and, where delegated, by PM/Owner/Sponsor for a project. At most two automatic analyses per thread in any rolling twenty minutes, unchanged. The displayed explanation always states the effective values. |
| D74 | Typed-meeting minutes (11 November 2026): V1.0 includes minute-taking for meetings typed in Kainow. AI drafts minutes in fixed sections from the meeting's messages, on request, after the quiet period and when the meeting ends; drafts are labelled AI drafts and never official. A PM, Deputy, Owner or Sponsor publishes a chosen draft version as a minutes source with its audience; proposals for authorisation come from the published minutes. Once a person edits a draft, automatic refreshes stop for that meeting. Audio recording, transcription and OCR remain outside V1.0. |
| D75 | Restricted meetings and secrets in messages (11 November 2026): A meeting may be Restricted when started, by a PM, Deputy, Owner or Sponsor; a meeting and its published minutes share one audience. A message, minutes edit or submitted minutes text in which the credential check finds a suspected secret is refused and not stored; the author is told only the kind found. This is the pre-publication hold of O01 for discussion; quarantine of content already stored remains sub-project 5. |
| D76 | AI questions (15 November 2026): A participant asks a project question in a private Ask panel. Kainow's own full-text search selects passages the requester may read (records, current minutes and notes, visible discussion messages, approved shareable summaries); the AI writes an answer only from those passages and cites them; the passages are always shown with the answer, and remain available when the AI cannot run. Answers are private to the requester. Sharing into a thread is allowed only when every passage sent to the AI is readable by the whole thread audience; otherwise a new answer is built for that thread from its audience's material. Each display rechecks that the viewer may read every passage sent. When a message or source an answer used is later hidden, deleted or restricted, a private answer is withdrawn automatically and disappears entirely from view, question included; a shared answer is hidden pending PM/Deputy review (clear or withdraw). PM and Deputy never see private questions. User-initiated AI requests are charged against the requester's personal cap. |
| D77 | AI draft reports and specifications (15 November 2026): A participant may request a draft Status report, Decisions and actions log, Risk summary or Specification, or a free-form draft from a written brief and chosen sources. Facts from records (names, dates, statuses) are written by Kainow, not the AI; the AI writes cited narrative. Drafts are versioned, labelled "AI draft — not approved", private until shared, and visible when shared only to people who may read every passage used. Removal of material affects drafts as answers (D76). Approval, the output register, filing and DOCX/PDF generation belong to the outputs sub-project. |
| D78 | Shareable summaries of restricted sources (15 November 2026): PM, Deputy, Owner or Sponsor in a restricted source's audience may request an AI draft summary of it, with a Leave out box; standing rules always omit personal matters about named people, prices, amounts and contract terms, and credentials. Kainow marks leave-out phrases still in the draft; each must be removed or confirmed before approval. A PM, Owner or Sponsor approves one version for a stated audience, shown before confirming. The approved summary is a separate source labelled "Summary approved for sharing"; the original's audience never widens. When the original's audience tightens the summary keeps its audience and shows "Access review required" to PM/Owner/Sponsor; when the original, or a message in it, is deleted or hidden, the summary is hidden from its wider audience until reviewed. |
| D79 | Secrets refused at import (16 November 2026): Notes imported, versions added and summaries approved by a PM, Deputy, Owner or Sponsor go through the same credential check as messages (D75): text in which the check finds a suspected secret is refused and not stored, and the person is told only the kind found. Detection remains best-effort; after-storage discovery follows D80–D82. |
| D80 | Reporting and holding a suspected secret (16 November 2026): Anyone who can currently read a stored item may report a suspected secret in it, marking the secret text, with a reason. Kainow itself reports when a job's secret check finds a secret in stored content. The item, with the rows derived from it, is held at once: hidden from every ordinary view, search, export, email, notification and AI request, with removal of dependent AI outputs as for deletion (D76–D78), queued jobs skipping it and any approved summary built on it hidden. Security quarantine overrides normal sharing. When the same text appears in other items of the project, it is masked there at once (cleaned in place, the items staying in view as "Possible credential removed — awaiting check") and the PM and Deputies are alerted with where it appears (never the text); a PM or Deputy confirms each place (it joins the case and stays cleaned) or dismisses it (its original text returns). |
| D81 | Quarantine, cleaning and release (16 November 2026): The original text of the item, of the rows derived from it and of any confirmed copy is encrypted with a key kept apart from the database and its backups, and the ordinary copies are cleaned: the marked text and anything the credential check finds become "[credential removed]". This is the only change ever made to a stored version. A PM, Owner or Sponsor in the item's audience reviews the cleaned version, may mark more text, and releases it to its audience; they never see the original. Authorised records stay in view with a "Credential removed — under review" label once cleaned. Administrators, the author and any credential holder the reporter names are notified to revoke or rotate the credential; the notice never contains it. The case lists the disclosures Kainow knows of (AI providers sent to, emails sent) and states that sent copies cannot be recalled. |
| D82 | Security reviewers and quarantined-original grants (16 November 2026): An Enterprise Administrator designates security reviewers (not themselves). A security reviewer requests access to named held cases with a purpose; an Enterprise Administrator other than the requester approves, for 24 hours by default; extension needs fresh approval. Each opening of an original needs explicit confirmation and is logged. Originals are never exported, emailed or sent to AI. A reviewer with a current grant may release a false alarm: the original returns unchanged, with a recorded reason. If no other Administrator is available, access stays blocked (Q03). |
| D83 | Delegated record deletion and restoring (16 November 2026): An Owner or Sponsor may delegate deleting and restoring a project's authorised records to its PM, with a recorded reason, revocable by any Owner or Sponsor, ending when the PM changes. One delegation per project; Deputies cannot receive it. The final-state rule still applies. Owners and Sponsors receive an in-app notice when the PM deletes or restores under the delegation. |
| D84 | Provider fallback (18 November 2026): A project's AI connections are tried in its order (primary, then fallbacks), skipping any not approved for the request's kind of work or, where the request carries restricted material, for restricted sources. After a timeout, lost connection, provider server error or rate limit, the next attempt (default three in all) goes to the next eligible connection, wrapping back to the first; an unusable answer is also retried on the next one. A rejected key or refused request ends the request without retry; a rejected key marks the connection Key rejected, notifies the Administrators and the project's connection managers (never with the key) and keeps later requests off it until the key is replaced. Every attempt reserves and settles separately and records the connection, provider and model used. A request never uses another project's key or allowance. |
| D85 | Spending limits at every level (18 November 2026): Each attempt must fit every applicable limit: organisation monthly, organisation daily where applied, organisation per-person monthly where applied (requests a person made), project monthly, project daily where applied, project per-person monthly where applied. Blank or zero is no allowance at every level; a project with no limits set has no allowance. Project limits are set by an Enterprise Administrator, or by PM/Owner/Sponsor when the Administrator allows projects to set AI limits, never above an Administrator ceiling. Automatic requests are system-initiated and charged to the project. Periods start 00:00 UTC+8. |
| D86 | Approved models and project connections (18 November 2026): An Enterprise Administrator approves each OpenAI or Anthropic model before use, recording its configurable identifier, USD prices per million tokens, the provider's retention and training terms, the kinds of AI work it may do and whether it may receive restricted sources. A project connection pairs an approved model with that project's own API key, entered through a protected form, encrypted with the protected key bound to that project and connection, and never shown again. Connections are managed by an Enterprise Administrator or, when the Administrator allows projects to manage AI connections, by PM/Owner/Sponsor; read-only while Deferred or Closed. Withdrawing a model or disabling a connection stops new requests through it and keeps past usage and records. |
| D87 | Bounded AI operation settings (18 November 2026): Attempts per request including fallback 1–5 (default 3) and timeout per attempt 30–300 seconds (default 120) are set by the Enterprise Administrator, and a project may only lower them. AI requests at once across the installation 1–10 (default 2), Enterprise Administrator only, enforced across all workers. A change applies from a request's next attempt; waiting for a free place does not use an attempt. |
| D88 | **On-time completion** (18 November 2026). Alongside Task completion, dashboards show On-time completion: of the eligible leaf tasks whose due date has passed (due date before today, UTC+8), the share that are Completed. It is shown as "32 of 40 tasks due so far are done (80%)". Tasks completed after their due date count as done; the drill-down shows how many finished late. Tasks awaiting deadline review are left out and counted separately. With none due yet it reads "Nothing due yet". For a Deferred project it is worked out as at the day it was deferred, and for a Closed project as at the day it closed. It measures meeting due dates, not delivering the project's outcome. |
| D89 | **Leadership summary scopes** (18 November 2026). An Enterprise Administrator grants leadership-summary access to a named person, with a reason, a start date, an optional end date and one scope: the whole organisation; one or more departments, covering every project each owns now or later; or one or more named projects. The grant screen states that a department scope "includes projects this department owns now and later". The grant shows the approved summary fields only, never project content, discussions, minutes, quotes or management actions, and gives no project access. An Administrator cannot grant leadership access to themselves. Revoking ends access at once. |
| D90 | **Access-setting bounds** (18 November 2026). The Enterprise Administrator sets, with a reason: automatic archive delay 1–60 months (default 12); Audit/Oversight default grant length 1–90 days (default 30) and maximum length per grant or extension 1–365 days (default 90; the default length may not exceed it); invitation validity 1–30 days (default 7). A change applies to invitations sent and grants requested or extended afterwards. A change to the archive delay shows, before saving, which Closed projects would be archived or unarchived at once, and applies to all Closed projects once saved. The numeric bounds were proposed by this design and approved by the Product Owner on 19 November 2026 (Consolidated Specification §13: unspecified bounds are not unlimited). |
| D91 | **Resource lines and the overlap warning** (20 November 2026). A project records each resource it needs as a resource line: a catalogue item or a one-off description; optional quantity with a unit (missing is Not provided, never zero); optional period; optional needed-by date; notes; and a status Needed, Arranged (outside Kainow), In use, Finished or Cancelled. A PM, Deputy, Owner or Sponsor maintains lines; every participant reads them. When a catalogue item's line has a period, Kainow shows how many other projects' lines of the same item have an overlapping period, naming only projects the viewer can already open and counting the rest. The warning reads "Also recorded by n other project(s) in this period — this is not a booking". It never shows another project's quantity, notes or status. Kainow does not hold quantities owned, availability or utilisation percentages. |
| D92 | **Recorded spending and approved adjustments** (20 November 2026). With Financial Tracking Enabled, a PM or Deputy records spending (date, amount, currency, description, optional reference); an entry in the reporting currency counts at once. An entry in another currency is kept and excluded from totals until a conversion (rate, rate date and converted amount) is approved. Corrections (a replacement amount, which may be zero) and refunds (an amount returned against a recorded entry) are proposed by a PM or Deputy and approved by an Owner or Sponsor under the project's approval policy before totals change; the original entry is never altered. A refund must reference a recorded entry. The budget is proposed by a PM, Deputy, Owner or Sponsor and approved by an Owner or Sponsor; until approved it reads Not provided. |
| D93 | **Budget warnings** (20 November 2026). Two advisory thresholds, default 80% and 100% of the approved budget, each a whole percentage 1–200, the first below the second. The organisation sets defaults; a project may set its own where delegated. When recorded expenditure first reaches a threshold, the PM, Deputies, Owner and Sponsors receive one in-app notice; falling below and rising again notifies again. Warnings never block work and never authorise spending. The bounds were proposed by this design and approved by the Product Owner on 20 November 2026. |
| D94 | **Finance settings and delegation** (20 November 2026). The Enterprise Administrator chooses whether projects may manage their own finance settings (default: allowed, as Q01 lists optional finance among delegable settings), the organisation's default currency (MYR) and which supported currencies are enabled (MYR, SGD, USD at launch, two decimal places). Where allowed, a PM, Owner or Sponsor turns Financial Tracking on or off, chooses the reporting currency (fixed once any budget or spending exists), sets warning thresholds within D93, and may widen financial-detail reading to Members and/or Audit/Oversight holders. The Administrator can always change a project's finance settings. Every change needs a reason and is recorded with previous and new values. |
| D100 | **Output register and versions** (20 November 2026). Each project output has a stable identity, a title, one primary report type from a controlled list, optional additional categories (searchable metadata), an issue date whose UTC+8 year is its filing year, an author, named contributing people and departments (department recorded as at the contribution and never rewritten), and an "AI-assisted" label when any version came from an AI draft. Versions are immutable and numbered; each is Draft, Approved or Superseded. Any active participant may submit an output (a draft report, an uploaded document or a link to an existing document in an approved location); the PM or a Deputy registers it, sets its type, categories and issue date, and files it. Approval of one exact version follows the project's approval policy (one Owner or Sponsor by default; more if the policy requires) and never approves commitments in the text. Approving a version makes any earlier Approved version Superseded. A new version starts as Draft and never inherits approval. |
| D101 | **Output audience** (20 November 2026). An output is Project-wide (every person who may read the project's content) or Restricted to a named audience. An output built from material some project readers cannot read must be Restricted, and its audience may include only people who can read all of that material; the default audience is the PM, Deputies, Owner and Sponsors among them. The PM, Owner or Sponsor sets and changes the audience; widening shows who gains access before confirming. When material an output was built from is later deleted, held or restricted, the output is limited to PM, Deputies, Owner and Sponsors who can still read it and shows "Access review required" until one of them clears or withdraws it. |
| D102 | **Storage connection and destinations** (20 November 2026). An Enterprise Administrator connects Kainow to Microsoft 365 with an app registration whose secret is entered through a protected form, encrypted with the protected key and never shown again. The connection uses the "Sites.Selected" permission: it reaches only the sites the organisation's Microsoft administrator grants it, never every site or mailbox. The Administrator may switch on directory lookup, which adds read-only access to names and addresses in the directory (`User.ReadBasic.All`), so Kainow checks a person is an account in the organisation's tenant before sharing and can use OneDrive destinations; with it off (default) Kainow shares only with addresses on the organisation's approved email domains and offers SharePoint libraries only. The Administrator approves destinations (a SharePoint document library, or the OneDrive of a named account), each for one purpose: the protected source area (exactly one) or outputs (one or more). Kainow shows the permissions each destination needs before approval and checks them afterwards. Withdrawing a destination stops new filing there and keeps every existing reference. |
| D103 | **Filing and sharing** (20 November 2026). Kainow files an output version under `Owning Department › Project › Year › Report Type` in the project's chosen output destination, names it `<Title> v<n>.<ext>`, and reports it filed only when the provider confirms the upload and its checksum matches. An output not readable by the whole project is filed instead in its own folder `Owning Department › Project (restricted) › <Output title>`. Kainow shares folders, read-only: the project folder with the people who may read the project's content, each restricted output's folder with that output's readers. It adds and removes those grants as people join or leave the project or audience, and moves an output's files between the two places when its readers change, so a person never keeps access through a folder after losing it in Kainow. Kainow never removes or changes access it did not grant; site owners and SharePoint administrators keep theirs. A person Kainow cannot share with is shown as "Not shared in SharePoint". The output library must have its own permissions limited to site owners (site collection administrators count as others until the real-tenant probe confirms how they appear); Kainow refuses to approve a library where anyone else can read it and warns if that changes later. |
| D104 | **Managed source area** (20 November 2026). Every source version's uploaded original (if any) and extracted text are written to the protected source area, with the file identity and SHA-256 recorded; each version shows Stored, Waiting to store or Storage failed. Once storage is confirmed the original's bytes are removed from the database and downloads come from the source area through Kainow; the database keeps the working text. Kainow checks the stored files against their checksums when an original is downloaded and in a daily check, and flags a difference as "Changed in storage" instead of serving it. Only the service connection and storage Administrators have direct access; an Enterprise Administrator designates storage Administrators (not themselves), with a reason. When content is held (D80–D82), its stored files are removed permanently from the provider (not to its recycle bin) after their content is kept encrypted under the quarantine key; release puts them back. |
| D105 | **Formats** (20 November 2026). The supported catalogue is: inputs TXT, Markdown, DOCX, selectable-text PDF; outputs Markdown, DOCX, PDF and CSV (tabular reports only). The Enterprise Administrator approves which supported formats the organisation uses; a project uses all approved formats unless its PM, Owner or Sponsor (when the Administrator allows projects to change formats) removes some. Removing a format blocks new imports or generation in it and keeps every earlier file and record. Adding a format converts nothing. |
| D106 | **Project exports** (20 November 2026). Exporting a project's records as CSV needs current read access and an enabled export policy. The Enterprise Administrator's "Project exports allowed" is Off by default. When it is On, each project's export roles apply: by default PM, Deputy, Owner and Sponsor; the PM, Owner or Sponsor may choose from PM, Deputy, Owner, Sponsor, Member, Audit and Oversight. Exports never include Deleted content, uncleaned held items, source or message text, quotes, restricted material or private AI questions. Each export is recorded. An export may be saved as an output (a CSV version) for registering and filing. |
| D107 | **External checks and reconciliation** (20 November 2026). Kainow checks a filed file when it is filed and when someone opens it through Kainow, and daily when the Administrator turns scheduled checks on (Off by default). Each file shows Checked (with time), Changed, Moved, Missing, Access denied or Unverified, and the last check time. A Changed file never keeps its approval: the PM or a Deputy either registers the changed content as a new Draft version (Kainow saves it as a new file and, where the provider's version history still holds the recorded content, restores the original file to it) or leaves it flagged. A file moved or renamed within an approved destination is relinked by the PM or a Deputy; a file moved anywhere else can be relinked only after an Enterprise Administrator approves that place as a destination. Failed operations keep the last confirmed location. Deleting a register entry never deletes the external file. |
| D108 | **Owning department transfer** (20 November 2026). Only an Enterprise Administrator changes a project's owning department, with a reason, choosing for its filed outputs either "Move the folder" (to the new department's folder, verified before the reference changes) or "Keep it where it is" (labelled as kept at its existing approved location). History keeps the old department, the reason and the choice. Leadership department scopes follow the new owner (D89). Contributing departments and earlier attribution are unchanged. A move that can never succeed (a storage location no longer approved, or a refusal that trying again cannot change) is rejected: the project goes back to its earlier department, the reason is shown and the Enterprise Administrators are told (Product Owner, 21 November 2026). |
| D109 | **Backups** (20 November 2026). A backup is taken by Kainow's backup command, which the server runs on a schedule (daily by default) and before every update. It writes to one backup folder the organisation chooses, apart from the running installation. Each backup holds a complete logical copy of the database and, once the protected source area exists, every source file it references. Everything is encrypted with a backup key kept outside the database, its backups and the protected key; designated Administrators keep a recovery copy of it apart from the backups. Each run is recorded in Kainow with its start, finish, outcome, size and checksums, and only a run whose files were written, read back and checked counts as successful. |
| D110 | **Backup retention** (20 November 2026). Backups are kept for 30 days by default; the Enterprise Administrator may set 7 to 365 days, with a reason. The most recent successful backup and the most recent successful pre-update backup are always kept, whatever their age. Expiry removes only backup copies, never live data or history. Source files shared by several backups are removed only when no kept backup needs them. |
| D111 | **Backup status and failures** (20 November 2026). Kainow shows the last successful backup, the last attempt and whether the 24-hour recovery target is met. When a run fails, or when no successful backup is younger than 24 hours, every Enterprise Administrator receives an urgent notice by email and in Kainow, once per episode. A warning stays on every Administrator page until a fresh backup succeeds. Existing work continues. Updates are refused until a successful backup younger than 24 hours exists. A run still unfinished after 6 hours counts as failed (interrupted). |
| D112 | **Restore drill and restore** (20 November 2026). The restore drill restores a chosen backup (the latest by default) into a temporary separate database and never touches the live one. It checks the decryption, that every table's row count matches the count recorded at backup time, that every source file's checksum matches, and that the protected key opens one sealed value of each kind present; it then measures the time against the 4-hour target and removes the temporary database. The result is recorded in Kainow. A passed drill completes go-live step 8. Kainow asks for a new drill after the backup key or backup folder changes. A real restore goes into a new, empty installation only. It then starts in protective read-only, invalidates every session and sign-in code, and does not send queued emails or repeat queued AI, storage or other external work: queued emails show "Not sent — restored from backup" in the delivery history, and queued AI, analysis, extraction and storage work ends with the reason "Not run — restored from backup", AI reservations staying uncertain. Administrators are told the time of the backup restored from and that access changes made after it are lost and must be checked. An Administrator resumes normal use. |
| D113 | **Storage monitoring** (20 November 2026). Kainow measures, every five minutes by default, the used and free space of the disk holding the database and of the backup folder's disk, the database size, and the size and quota of the protected source area where the provider reports a quota ("Unavailable" otherwise, never zero). An Enterprise Administrator sets the warning level (default 80%, 50–95) and the critical level (default 90%, above the warning level, up to 99). Reaching a level sends one notice to every Enterprise Administrator, by email and in Kainow, per episode. A missing check (none for 30 minutes) is itself shown as a warning. |
| D114 | **Protective read-only mode** (20 November 2026). When free space on the database disk falls below the safe floor, Kainow enters protective read-only mode at once. The safe floor is a set amount (default 5 GB, 1–1,000 GB), verified on a test installation. In this mode people can still sign in and out and read everything they may read. Every other change is refused with "Kainow is read-only for now to protect your data. Nothing you have saved is affected." Background work (AI, analysis, reminders, digests, storage, imports) waits with its queue kept. Sign-in codes and urgent operations notices are still emailed, and backups still run. Retained data is never deleted to free space. The mode never ends by itself. An Enterprise Administrator chooses Resume, with a reason, and Kainow accepts it only when a check in the last 10 minutes shows free space at or above the floor and the health checks pass. A banner tells everyone while the mode is on. |
| D115 | **Routine diagnostics** (20 November 2026). Routine technical diagnostics kept by Kainow (storage readings, job-queue archives, backup command logs) are kept for 30 days by default; the Enterprise Administrator may set 7 to 365 days, with a reason. Business records, history, audit and security events, analytics events, backup and drill results and daily storage summaries are kept indefinitely and never expire with diagnostics. Container logs are rotated by size by Docker (three files of 10 MB per service) and documented as such. |
| D116 | **Operations settings and authority** (20 November 2026). Only an Enterprise Administrator changes operations settings (backup retention, storage alert levels, safe floor, diagnostic retention) or resumes from protective mode, each with a reason, recorded with previous and new values. Operations status is visible to Enterprise Administrators only. Running backups, drills and restores are server operations, done by whoever operates the server under the organisation's procedure; Kainow records each run but has no web control to start them. The numeric bounds in D110, D113, D114 and D115 were proposed by this design and approved by the Product Owner on 20 November 2026. |
| D119 | **Releases and signing** (22 November 2026). A Kainow release is a tag `vMAJOR.MINOR.PATCH` on the product's GitHub repository, made by the release script and signed with the Product Owner's SSH release key, whose private part never leaves the Product Owner's computer. Each installation trusts the public keys in its own release-signers file, placed at installation and kept outside git. A release can change that file only when the release itself verifies against the current file. An installation installs only a tag whose signature verifies, whose internal tag name matches the tag, and whose version matches the tag. Untagged commits, pre-release tags and unsigned tags are never installed. |
| D120 | **Checking for releases** (22 November 2026). Kainow checks the product repository for newer release tags once a day, and when an Enterprise Administrator chooses Check now. A newer release sends one notice to every Enterprise Administrator, by email and in Kainow. Checking only reads the list of tags; nothing is downloaded or installed. |
| D121 | **Approving an update** (22 November 2026). An Enterprise Administrator approves one exact release (its tag and commit) with a reason and a start time at least 15 minutes ahead. One approval covers one release; later releases need their own. Only one update can be approved or in progress at a time; it can be cancelled, with a reason, until it starts. A release older than or equal to the running version cannot be approved. Approval is refused while protective read-only mode is on, and, as D111 already requires, while no successful backup younger than 24 hours exists; the update then also takes its own pre-update backup. Every active person is emailed when the update is approved (and when it is cancelled or moved) and again 24 hours before it starts if it was approved more than 24 hours ahead; a banner shows the time and expected length until it starts. |
| D122 | **Installing an update** (22 November 2026). The updater runs only when the server's schedule starts it; it is never left running. After approval it fetches and verifies the release and builds it while the current version keeps running. At the approved time it puts Kainow into maintenance (read-only, with its own banner), takes a pre-update backup, and installs only if that backup succeeds. It then migrates the database, starts the new version and checks its health. The update counts as succeeded only when every check passes; maintenance then ends. If anything fails before the migration starts, Kainow returns to the previous version and normal use by itself, and Enterprise Administrators are told. Every step is recorded in Kainow. |
| D123 | **A failed update after the migration** (22 November 2026). If the migration or anything after it fails, Kainow stays stopped and shows a fixed page saying it is unavailable after a failed update and asking people to contact their Administrator. The updater sends no email (it holds no email settings); the server operator is alerted through the server's log mail. Nothing is restored automatically. The server operator runs the recovery command, which keeps the failed database under another name, restores the update's pre-update backup with the previous version, and starts Kainow in protective read-only as for any restore (D112); an Administrator checks and resumes. Because maintenance blocked every save after the pre-update backup, nothing saved is lost. |
| D124 | **Supported browsers** (22 November 2026). Kainow supports the current and previous major releases of Edge, Chrome, Firefox and Safari at each product release, on desktop, tablet and phone. Each release records a browser matrix with the exact versions checked, how (automated or by hand) and the result; a version not checked is recorded as not checked, never as supported. |
| D125 | **An update that could not start on time** (23 November 2026; confirmed by the Product Owner on 23 November 2026). An approved update that has not started within 60 minutes of its start time (the server was off, or the updater's schedule is missing) is not installed late: it ends as failed before installing (`window_missed`), with nothing changed. The Enterprise Administrators are told, and everyone who was warned of the outage is emailed that the update is cancelled. To install the release, an Enterprise Administrator approves it again for a new time. The updater checks this before preparing or installing, and the worker ends such an update by itself too, so a missing updater cannot keep it open. The Product Owner confirmed this on 23 November 2026: an enterprise announces a scheduled maintenance window beforehand and is ready for that window alone, so an update that misses it waits for a new announced window. |
| D126 | **Cloud hosting** (23 November 2026; Product Owner decision "Cloud VM only"). Within A01 and A09, a V1.0 installation in a cloud environment is a cloud virtual machine running the Docker Compose installation, optionally with a managed PostgreSQL database (A09). Managed container services (for example Azure Container Apps, AWS ECS or Fargate, Google Cloud Run, Kubernetes) are not supported in V1.0; they are a future option. The reason: the updater (a git folder and `docker compose` on the host), backups and restore drills (a local backup disk) and the low-space check (the database disk) all assume a host the operator controls. The 10b load test, run with the API and worker as host Node processes, is accepted for now; it is repeated in full with every service in containers during sub-project 11 (Acceptance), on a virtual machine of the size Kainow will recommend. |
| D127 | **v0.1 test release** (24 November 2026; Product Owner decision). The first published release is v0.1.0, a test release for more people to try and give feedback; V1.0 launches after that feedback. Acceptance results that need more people than are available before v0.1 (two reference reviewers, five newcomers) stay "Partly assessed" or "Not Assessed" until those people have tested; none is recorded as Passed before then. v0.1.0 is published from a new public repository, `sawitclean`, with rewritten history; the old repository becomes private. Detailed in the sub-project 11b design. |
| D128 | **Navigation, Settings hub and page pattern** (24 November 2026; Product Owner decision after the demo walkthrough). A dark side menu grouped by purpose (Work: Home, My tasks, Reviews, Projects; Organisation: Leadership, Analytics, My AI use, Resource catalogue; Administration: Settings, Operations, Security review), each item shown only to those who may use it; a slim top bar with the logo, search, the notifications bell, the AI spend meter and a person menu (Customise, colour scheme, light or dark, Sign out, Sign out everywhere). Home starts with a "Needs you" queue grouped by urgency (overdue, review and decisions, blocked, due soon and risk reviews), then the person's projects in one table. My tasks (`#/my-tasks`) and Reviews (`#/reviews`) are their own pages. The Enterprise Administrator's header links become one Settings hub (`#/settings`) of boxes in four groups, each box showing the setting's current values and state (set up, needs attention, failing, not in use) from a read-only summary (`GET /admin/settings/summary`, Administrators only); every setting keeps its address and gets its own page: "At a glance" first, then each setting in its own box with a Change button. Inside a project the project header (name, state, departments, Project Manager, warnings) stays above binder tabs on every tab; "Notes & discussion" becomes three tabs, Discussion, Notes and Proposals, and the AI review screen keeps its address `#/runs/:id` inside the project. The redesign grants nothing: permissions, lifecycle and approval rules are unchanged. Design: `docs/superpowers/specs/2026-11-24-v1-interface-redesign-11a-design.md` §6 to §7.9. |
| D129 | **Colour schemes and organisation colour** (24 November 2026; Product Owner decision). Each person can choose a colour scheme (Red, Teal, Blue, Plum, Slate, and Organisation when the organisation has a colour) and light or dark, in the person menu. The default is the installation's: the organisation colour when one is set, otherwise Red; a person who chose keeps their choice, and a choice of Organisation falls back to Red if the organisation colour is cleared. An Enterprise Administrator sets or clears the organisation colour on the Organisation page, with a reason; Kainow makes the scheme from it and refuses a colour that cannot carry white text on buttons and the menu. State and attention colours never change with the scheme, and each always comes with a word and a symbol. No organisation's name or branding is used for a scheme. Design §5.1 and §8. |
| D130 | **Correcting a proposal** (24 November 2026; Product Owner decision). On the review screen, beside the source, a reviewer who may edit a proposal's wording can also correct its type (task, decision, question, risk), wording, owner and due date. A reason is required when the type changes (at most 500 characters) and optional otherwise. The AI's original is kept; each correction is recorded with the person's name, their project role, the date and time, what changed and the reason, and shown to everyone who can see the proposal as "Changed by a person" with a Change history ending in the AI's original and the model that made it. A correction is refused once the proposal is authorised; otherwise, as with editing today, it returns the proposal to pending and sets aside approvals given so far. The proposal is authorised as its corrected type. Human proposals are unchanged. Design §9. |
| D131 | **Stage templates** (24 November 2026; Product Owner decision). A stage template is a named, ordered list of stages with optional substages. Kainow ships seven: General (today's five stages and their substages), Software development, Product sales, Research project, Syllabus development, Marketing campaign and Event. The Enterprise Administrator adds, changes, retires and brings back templates on the Stage templates setting page, each with a reason; at least one stays active, and editing a template never changes an existing project. The new-project form asks for the type of project (default General); the project takes a copy of the template's stages and starts in the first one. The Project Manager, Owner or Sponsor may add, reorder, retire or bring back the project's own stages, each with a reason; renaming is not offered, and the current stage cannot be retired. Stages remain non-sequential, past stage periods keep their recorded names, and every project created before this got a copy of General (migration 0037). Design §14. |
| D132 | **Timeline bars** (24 November 2026; Product Owner decision). A Gantt chart stays outside V1.0 (tasks have only a due date, no start date or dependencies). Instead each project's Timeline tab gains a light, read-only "Bars" view above the existing list, for the same date window (default three months back to six months ahead, UTC+8): a date axis with month marks and a "Today" line; one bar per stage period overlapping the window, to today while it is current (marked "Current" with its symbol and word, not by colour alone), and a stage that began before the window starts at its edge with a "continues from <date>" note; markers, each with its symbol and words, for task due dates (grouped per day with a count), risk review dates, resources needed by and the planned end. Nothing is drawn for dates Kainow does not record, and nothing can be changed or dragged. Same audience as the Timeline list; personal "hide kinds" choices apply to the markers. The drawing is hidden from screen readers, which read a short text summary; the month-by-month list stays below as the equivalent. At 375 px the drawing scrolls sideways inside its own box. The timeline response gains `stagePeriods` (every stage period overlapping the window); no other server change. No configuration entry. Design §15. |
| D133 | **Task page and description** (25 November 2026; Product Owner decision after the demo walkthrough of 11a). Every task has its own page (`#/projects/<id>/tasks/<taskId>`), inside the project with the Work tab open: title, description, status with its symbol and word and one sentence on what it means, assignee, due date with overdue or due-soon, who authorised it and when, parent and subtasks, follows and followed by, its source quote, its proposal, its history, and the same actions as its row in Work under the same rules. Blocked reads "Blocked: the work cannot continue. The due date has not moved." with the latest reason, who blocked it and when. Links to tasks everywhere open this page; the old address still opens the Work tab at the row. The description is optional, up to 4,000 characters, given by a person when proposing or authorising an action or adding a subtask, and changed through Propose a change with previous and new values in the history; the AI never fills it. It is checked for credentials on entry and is in the quarantine registry. Reading is exactly as before. Design: `docs/superpowers/specs/2026-11-25-v1-walkthrough-changes-11a1-design.md` §4. |
| D134 | **My profile and a person's department** (25 November 2026; Product Owner decision). My profile (`#/me`, in the person menu) shows the person's name, email, department, current projects and roles (since, until), past roles with the day each ended, and Appearance, which moved there from the person menu. A person chooses one active department from the central list, or none; an Enterprise Administrator can change anyone's. The department is information only and gives no access; one retired later still shows, marked "(retired)", until changed. Changes are audited by ids only. **Ruling:** past roles show the project's current name, so a later rename is visible to someone who has left. Design §5. |
| D135 | **Tab style** (25 November 2026; Product Owner decision). Each person chooses how project tabs look: Boxes (the default), Grey dividers or Tinted dividers. Every style works in all colour schemes, Light and Dark, with edges of at least 3:1 and text of at least 4.5:1, and the open tab is never shown by colour alone. Design §6. |
| D136 | **Proposals, sources and records link to one another** (25 November 2026; Product Owner decision). The Proposals tab links each run to its source; the review links each proposal to the exact passage or message it came from; an authorised proposal links to its record (a task to its page, another record to its row in Work); every record links back to its proposal. A person's own proposal has no source and links to its record, and the record back to it. Every link follows the existing access rules: someone who may not open a source sees what they saw before. Design §7. |
| D137 | **Renaming a stage** (25 November 2026; Product Owner decision; refines D131, which did not offer it). Those who may change a project's stages may rename one, with a reason, within the limits for adding one, and not while the project is Closed, Deferred or archived. The new name shows everywhere in the project, past periods included; the change history keeps the old and new names, the person, the day and the reason. The template is not changed. **Ruling (equal cleaned names):** when cleaning a credential has left two of the project's stages with the same name, renaming one renames that stage only and not the past periods, because Kainow cannot tell whose they are. Design §8. |
| D138 | **Current projects, History, and stages that stop** (25 November 2026; Product Owner decision). Projects shows Current projects (Draft, Planned, Active) first, then History with Deferred (day and reason) and Closed (day and outcome); archived projects stay behind Include archived. Home lists current projects, with a link to History. When a project is deferred or closed its running stage stops that day: the timeline bar ends there with "Stopped when deferred" or "Stopped when closed", it is not called Current and its days stop counting, which the project figures, Leadership and Analytics also say; a stage that ran through an earlier deferral ends its bar there. Stored periods do not change. **Ruling (the stage flow of a Closed project):** it shows the stage where the project stopped, with the later stages still to do; stages are called all done only when no stopped stage is recorded. A project closed while Deferred keeps "Stopped when deferred". Design §9. |
| D139 | **One "due soon"** (25 November 2026; Product Owner decision). Due soon means due from today to seven working days ahead by the project's calendar, in every place the words appear: Needs you, My tasks, Home, the task page and the project's figures (measures version 2). The seven-day reminder email is a separate rule and does not change. Design §10. |
| D140 | **Duplicate project** (25 November 2026; added by the Product Owner). A current Project Manager who may create projects can make one new Draft project from a project in any state, as its only member, all at once or not at all, from a review page (`#/projects/<id>/duplicate`). Before Create: a different name, a different planned end or none, the purpose changed or confirmed, and every text holding one of up to ten "old terms" changed or confirmed (the terms are not stored). Offered: purpose, departments, stages, holidays, required approvals, notification and output settings without people, addresses or connections, tasks with their subtasks (as human proposals, without people, dates or status), risks (none ticked) and planned resources. Never copied: people, access, notes, discussions, decisions, questions, outputs, history, money, AI settings, change requests. Copied proposals follow the normal authorisation rules; an Owner or Sponsor can authorise several at once, each with its own assignee and due date and each on its own. The original's name and link show only to those who may open it; others see "Copied from another project". Nothing is copied while a credential case is open on the original, and the page says so when it opens. The new project says that its proposals can be authorised once it has been started. **Rulings:** (1) an exception to an organisation setting is carried only where the organisation now lets projects set it; otherwise the new project starts with the organisation's value and the page says so. (2) A text typed on the page is replaced by the original's when that original has changed since the page was loaded (Load again), with a note, so that a removed credential cannot return through an edit; text whose original has not changed is kept. (3) A credential case in a project names the projects it was copied to or from ("Check these projects too"), by name to those who may know it (anyone else is told to ask an Enterprise Administrator); Kainow does not search them by itself. Limits: 500 tasks and subtasks, 200 risks, 200 resource lines. Design §14. |
| D141 | **Needs you and tasks by project** (25 November 2026; asked for by the Product Owner). On Home, Needs you and My tasks, and on the My tasks page, show one box per project, headed by its name and its counts by urgency, in the order most overdue, most to review, most due soon, then name. The first three start open; a box shows five rows with "Show all n". My tasks keeps its filters and a choice to group by due date instead. Nothing is added or hidden. **Ruling:** completed tasks come last in a project's box, so open work stays visible. Design §15. |
| D142 | **Task boards on Work, My tasks and Needs you** (26 November 2026; asked for by the Product Owner; refines D141, whose by-project boxes become the second view). A project's Work tab shows its tasks first as boxes in columns, Not started, In progress, Blocked and Completed, each column with its symbol, word, coloured top edge and count; or one column per assignee; List is the other view. A box shows the title, due date, the overdue or due-soon label, the assignee, subtask progress, the reason when Blocked, and any waiting or held label the row shows. A column shows ten boxes, then "Show more". Completed holds the last 30 days and starts folded; Cancelled tasks and older completed ones are in the list. Subtasks appear inside their parent's box. Choosing a box opens a side panel beside the board (below it on a narrow screen) with the task page's details, actions and forms under the same rules, and "Open full page"; closing it (Close or Escape) puts focus back on the box, or on its column's heading when the box has left the board; text typed in the panel is not thrown away without asking. There is no dragging: a task moves only through its actions, which ask for the notes Kainow requires. At phone width one column shows at a time, chosen from a list that gives every column's count. Decisions, questions and risks stay as tables. My tasks has the same columns across projects, with boxes under their project's name, most urgent project first; a subtask assigned to the person has its own box naming its parent; its views are Board (first), By project and Due date, and the filters apply to all three. Home's Needs you has the columns Overdue, Review and decisions, Blocked and Due soon (an empty column is left out), with boxes under project names; By project is the other view. Nothing shown before is hidden and no rule is widened. Status words are in sentence case everywhere ("Not started", "In progress"). **Rulings:** (1) the view chosen on each screen is remembered per person (C116); when the preferences cannot be read, it holds for that visit only. (2) A subtask sits inside its parent's box; it also has a box of its own in the by-assignee view when someone else holds it, and whenever its parent is not in an open column. (3) The by-assignee view shows open tasks and those completed in the last 30 days, completed last. (4) On My tasks a box opens the task page; the side panel is on the project's Work tab only. (5) Home's My tasks section keeps its by-project boxes (D141). (6) A box never shows the blocked reason of a task held for a credential review; the task page shows the block note as before. (7) Subtask progress counts direct, live subtasks, not cancelled ones, the same on Work (from the list) and on My tasks (from the server's counts, since the parent may not be on the list). Design `docs/superpowers/specs/2026-11-25-v1-task-board-clean-look-11a2-design.md` §4 to §6. |
| D143 | **A cleaner look, a light side menu with projects, and spacing** (26 November 2026; asked for by the Product Owner). Pages are white with thin lines and fewer boxes inside boxes: on a project's tabs other than the Overview, parts are divided by rules and keep their state edge; Home, Settings and the Overview keep their boxes. The accent colour is only for selection, links and the main button, and state colours only for states. The side menu is light by default (the page colour with a trace of the scheme colour; the current page marked by a fill, a left edge and bold text, not by colour alone), with the dark menu in the scheme colour as a personal choice. After Work it lists the person's current projects (Draft, Planned and Active; not Deferred, Closed or archived ones), the first ten by name, then "All projects"; a project where the person's membership is on hold is named without a link. Compact or comfortable spacing is a personal choice. On My profile, "Follow the organisation" is the first colour scheme choice (C117). Binder tabs keep the style chosen under D135. Every scheme, Light and Dark, is contrast-checked: text 4.5:1, focus and the current item's edge 3:1, the light menu included. **Rulings:** (1) "Follow the organisation" replaces the separate "Organisation" scheme: both showed and did the same, including Red when the organisation has no colour or one Kainow cannot use; a person who chose "Organisation" before now shows as following. (2) In the Dark theme the "light" menu is a quiet dark: the dark page colour with a trace of the scheme colour. (3) Plain buttons lose their accent edge; the main button and links keep the accent. (4) Progress bars and meters are muted; the Timeline's current stage keeps the accent, since it marks the current stage. (5) The thin edges of boxes and the shading of columns are decorative and need not reach 3:1 (measured about 1.1:1 to 1.3:1): a box is also marked by its heading and the link or button that names it, and a column by its heading; a column's coloured top edge does reach 3:1 (5.9:1 to 8.4:1 in Light and Dark). (6) The reset on My profile also puts back the side menu and spacing. Design §7 and §8. |

**Build rulings on D100–D108 (sub-project 9, 20–21 November 2026).** The entries above are as approved; these refinements were made while building and are written into the design (`docs/superpowers/specs/2026-11-20-v1-external-outputs-design.md`, marked "build ruling"). D100: each contributing person's department is chosen at registration (users carry no department); a submission can be accepted into a registered output; a Draft version cannot be approved once a later one is approved. D101: an output's material is every AI version of its draft; clearing a review is refused until the audience fits the remaining material. D102: directory lookup reads only id, userPrincipalName and mail, treats a `#EXT#` account as a guest and cannot detect a disabled Microsoft account; the destination check creates and removes a folder permission for the checking Administrator. D103: Kainow never alters a permission it did not create (a person who already has one is recorded as external and never invited over); an output's folder is fixed when its first version is filed; project and output folders are created, never adopted. D104: storage Administrators get write on the source area's `projects` folder; moving the source area uses a Retiring status, one move at a time. D106: a saved output-register export holds only outputs every content reader may read. D107: registering changed content is a job, for files Kainow filed only. D108: a move is refused when the new department already holds the project's folder, and a failed move must be retried before another change.

## 15. Supersession and reconciliation notes

| Older wording | Current rule |
| --- | --- |
| More than ten people triggers separation | Seven or more active people; small team fewer than seven. |
| Mandatory six-month membership | Configurable expiry, no required six-month default. |
| At least one PM without an upper count | Exactly one accountable PM, optional multiple Deputies. |
| Every project fully staffed at creation | Draft can begin incomplete; later transitions validate roles. |
| Required role cannot expire without replacement | Expiry removes access; missing-accountability restrictions apply. |
| Full discussion always requires Audit/Oversight | Shared project discussion and normal project minutes available under current project policy; restricted sources separately controlled. |
| No chat functionality | Shared project discussion and project AI included. |
| Automatic AI off by default | On with approved project setup, gated by credentials and allowance. |
| Unspecified spending allowance | Blank equals zero allowance. |
| Reopening retains deadlines | New authorised deadlines required for outstanding tasks before restart. |
| Restoration of revoked membership | Fresh invitation and acceptance; On Hold/expired handled separately. |
| Only Owner/PM eligible for delegated settings | PM/Owner/Sponsor, only within explicit delegation. |
| Permanent removal after retention | Logical deletion/archiving only; security quarantine follows O01. |
| Dedicated User Settings page | No such page; dashboard personal controls and role-specific settings. |
| UNLICENSED | AGPL-3.0-only accepted under O17, without additional commercial restrictions. |

## 16. Acceptance baseline

Assess the real interface and real-model extraction, not mock capability alone. Main scenario: **5,000–8,000 words and 5–40 reviewable items**, plus shorter meetings with fewer items. Item count describes the source, never a proposal quota.

Record provider/model/settings, input/reference version, device/network, all timings and failures. Evaluate missed commitments, unsupported proposals, quote/source meaning, owner/date accuracy, duplication and reviewer understanding. Measure generation, actual human review and newcomer first loop separately and by workload.

Cover setup/access, all record lifecycles, discussion/AI, confidential retrieval, grant expiry, shared resources/optional finance, external outputs, digests, configuration, multi-project navigation and accessible use. Include denied actions and logical-deletion processing exclusions.

Results distinguish Passed, Failed, Not Assessed and Blocked by an Unresolved Product Rule. Owner reviews evidence for product acceptance. This document does not claim those journeys have been implemented or passed.

## 17. Accepted resolutions O01–O17

All 17 product subjects below were reviewed and accepted after the initial consolidation. They supersede inconsistent summaries and earlier open-decision wording in this document and its supporting specifications. Accepted defaults are distinct from technical implementation verification. Detailed designs, integration contracts and operational procedures still require specification; this is not a claim of delivery or a final specification lock.

### O01 — Security quarantine

Preserve the no-permanent-deletion rule. Hold suspected credentials before publication or AI transmission for review; detection is best-effort. When discovered after storage, quarantine affected content and identifiable copies, excluding ordinary access, search, export, notifications and future AI processing. Retain originals encrypted under separately approved security access; ordinary Audit/Oversight does not disclose them. Publish a sanitised version with a visible credential-removal marker and preserved original reference. Notify the Administrator and credential holder to revoke/rotate the credential. Record known prior disclosures; never imply that an email or provider copy was recalled. Sanitised content can return through authorised review, but the secret cannot return to ordinary content. Intentionally configured API credentials remain in separate protected credential storage.

### O02 — Archiving, Deleted-content access and restoration

Archive only Closed projects, by default twelve months after closure, configurable by Administrator. Authorised PM/Owner/Sponsor may archive earlier and may unarchive into ordinary navigation without changing Closed status. Archive changes navigation and visibility, not lifecycle status, valid permissions or stored history. Provide an Archive filter and include permitted historical reporting.

Retain stored records indefinitely under logical deletion. Inspecting Deleted content needs an explicit Inspect Deleted Content scope in a time-limited Audit/Oversight grant. Quarantined originals remain separately protected. PM/Deputy restores discussion messages; PM/Owner/Sponsor restores imported sources; Owner/Sponsor approval is required for deleted authorised records. Current permissions and project-state restrictions apply. Restoration preserves history and does not restart analysis, resend emails, revive grants or alter task dates/status.

### O03 — Launch integrations and configurable formats

Accepted launch services: OpenAI and Anthropic APIs; configurable email providers (Microsoft 365 initially supported); SharePoint document libraries and OneDrive storage initially, with Dropbox, Box and other cloud storage options addable later through supported approved connectors. These are supported launch options, not a permanent provider restriction. Multiple Enterprise Administrators may approve additional supported services and destinations. Delegated PM/Owner/Sponsor can add/change/remove project connections, with project credentials, usage attribution and spending controls. Unsupported protocols require a supported connector extension, not an arbitrary URL or API key. No plugin-loading capability is implied.

Accepted input formats: pasted text, TXT, Markdown, DOCX and selectable-text PDF. Generated outputs: Markdown, DOCX, PDF and CSV for permitted tabular reports. Projects can add/remove formats from the Administrator-approved supported catalogue. Removal blocks new import/generation, preserving old files and history; adding a format does not automatically convert old documents. New parsers/exporters require a supported extension. OCR remains outside V1.0. Actual authentication/permissions and service compatibility must be verified in integration contracts.

### O04 — Configuration defaults and visible analysis limits

| Setting | Accepted default |
| --- | --- |
| Ordinary membership | No expiry; projects may set expiry and authorised role managers extend it. |
| Audit/Oversight grants | Thirty-day default; ninety-day maximum per grant or extension, Administrator-configurable. No automatic renewal. |
| Discussion analysis | After 300 seconds without a new message; at most two automatic analyses per thread in any rolling twenty-minute period. |
| Rate-limited discussion | Wait until eligible, then process latest unprocessed content together. |
| Explicit AI requests | Available subject to permissions and spending limits. |
| Published minutes | Trigger analysis after successful publication, subject to applicable configured limits. |
| AI retry/fallback | Three total attempts per request, including initial and fallback attempts. No automatic retry of permission denial, invalid credentials or exhausted allowance. |
| AI timeout | 120 seconds per attempt; local timeout does not prove provider cancellation or zero charge. |
| Spending periods | Daily and monthly, UTC+8 boundaries. Most restrictive applicable remaining allowance governs; blank/zero means no allowance. |
| Email retry | Initial attempt plus three temporary-failure retries, at five minutes, thirty minutes and two hours after initial failure. |

Every AI attempt consumes applicable reservation/usage allowance. Show effective batching limits near the discussion’s AI status area: “Automatic analysis: after 5 minutes without new messages; maximum 2 analyses per thread in any rolling 20 minutes.” Display Waiting, Queued, Running, Paused or Blocked, with the next eligible time when rate-limited. Reflect configured changes immediately in that explanation.

### O05 — Financial precision and adjustments

Use the selected currency’s standard decimal precision; require currency and distinguish Not Provided from zero. Preserve foreign-currency amounts separately, excluding them from project totals unless an authorised person records the conversion rate, date and converted amount. No automatic exchange-rate lookup.

PM/Deputy proposes adjustments; Owner/Sponsor approves before totals change. Preserve original and linked adjustment. Budget warnings default to eighty and one hundred percent of authorised budget, project-configurable; warnings neither block work nor authorise expenditure. Label totals Based on recorded entries and avoid definitive balances where information is incomplete. Group organisation totals by currency; keep AI costs separately identified.

### O06 — Minimum product field catalogue

| Record | Required product information |
| --- | --- |
| Project | Name, purpose, owning department, status, stage and required appointments at the appropriate transition. Planned end optional. |
| Task/subtask | Title, description, one assignee and due date before authorisation; parent link where applicable, next review optional. |
| Question | Question text and explicitly identified requester; separately attributed answers. |
| Decision | Statement, authorisation and rationale; replacement/withdrawal links as applicable. |
| Risk | Description and severity; responsible person/review date may initially be empty but are required for accepted continuing exposure, subject to O11 closure exception. |
| Resource usage | Resource reference, project, description and relevant period. Quantity requires a unit; missing is not zero. |
| Output | Title, primary report type, issue date, author/contributors, version, approval status and external location. |

Preserve stable identity, organisation/project scope, attribution and history. Source-based proposals require exact source version, quote and location, disambiguating repeated occurrences. Category retirement does not rewrite earlier meaning. End dates cannot precede start dates; resource quantities use permitted units. Mandatory evidence/accountability fields cannot be hidden. Exact field types and offset conventions remain technical-contract details.

### O07 — Administrators, recovery, investigation and grants

Two or more people can be designated Enterprise Administrators, each using a named account with individually attributed actions; no shared administrator account is required. Controlled initial setup uses a one-time invitation and closes after acceptance. Existing active Administrators can restore another eligible Administrator. If none can authenticate, a designated organisational system custodian operates the controlled recovery procedure; there is no public self-service promotion route. Nominate recovery custodian/address and verify the procedure before go-live. Recovery preserves identity/history and does not restore project access automatically.

Detailed investigation findings remain separate from ordinary discussion and limited to authorised investigators/role managers. Affected people receive the decision and appropriate explanation; leadership has no default findings access. If PM is affected, notify eligible Owner/Sponsor, then Administrator with minimal necessary details.

Account disablement blocks all grants. Administrator/authorised grant manager may suspend an independent grant with a reason without creating membership. Restoration is explicit and expiry continues. User-owned schedules pause on disablement; project-owned analysis/digests can continue only with valid authority/configuration, no impersonation and current audience checks.

### O08 — Draft, Planned, withdrawn proposals and handover

Draft permits setup, invitations, discussion, minutes and AI proposals; tasks remain drafts rather than actionable commitments. Planned permits planning, review and authorisation; tasks cannot start/complete until Active. Withdrawn proposal versions remain final; resubmission is a linked new proposal with fresh review.

PM may fast-track Draft directly to Active, bypassing the separate Planned step only when required role holders have accepted, memberships are Active, separation holds and mandatory information is complete. Record action and brief reason. Fast-track never approves proposals or bypasses invitations/task validation.

Risk handover requires acceptance by the receiving active project’s Owner/Sponsor before origin closure, with linked records, responsible person and review date. User-owned paused automation needs explicit new ownership before resuming; project-owned automation follows O07.

### O09 — Source audience and derived information

Provide a PM Source Access control: Project-wide reading (default for project-related minutes) or Restricted source (configured audience, default PM/Deputy/Owner/Sponsor plus approved grants). Show audience before confirmation; record later changes within organisation boundaries. Owner/Sponsor may also manage audiences where authorised.

AI may draft a sanitised summary from restricted material, but PM/Owner/Sponsor must explicitly review/approve its intended audience. Original access does not widen automatically. Stored answers/excerpts recheck source-linked access and are hidden pending review when that access is lost. A separately reviewed/published summary keeps its own audience when source permissions tighten, but is flagged for review. Deletion/quarantine excludes source from future processing and restricts affected outputs containing that content pending review. Security quarantine overrides normal sharing.

Use clear labels: Source restricted, Summary approved for sharing, Access review required. No query or stored answer bypasses current source access restrictions.

### O10 — Reopening task detail

Outstanding work retains status/assignee but cannot start, resume or complete until new due dates are authorised. Once project is Active, comments and evidence updates are permitted. Review each outstanding parent/subtask individually; parent date changes do not cascade. Flag children due after parent.

PM/Deputy can prepare batch date amendments showing every previous/new date. Approval follows project policy; fully authorised tasks proceed independently, remaining tasks keep Deadline review required, and parent conditions still apply.

If work actually finished outside Kainow during the pause, record actual completion date/evidence through Owner/Sponsor-approved completion reconciliation under applicable policy. This narrow exception avoids inventing a future due date simply to close already-finished work. Preserve prior commitment/history.

### O11 — Closure outcome detail

Delivered requires Owner/Sponsor confirmation that agreed objectives were met and no outstanding tasks. A completion percentage alone is insufficient. Overridden parents never hide unfinished children. Explicitly complete, cancel or retain each unfinished child.

Unresolved questions require reasons or accepted handover; those affecting delivery acceptance prevent Delivered. Risks requiring ongoing review move to an accepting active project. Where no further review is necessary, Owner/Sponsor may record final risk acceptance with reason and explicit No further review required. This closure-only exception removes the next-review-date requirement for that disposition.

Cancellation cannot disguise unmet objectives. Receiving projects accept handed-over work through linked records; origin outcome reflects actual delivery. Partially Delivered and Abandoned remain available with reasons.

### O12 — Notification day counting and timing

Projects select working days (default) or calendar days for reminder/escalation intervals. Working-day mode uses project working weekdays/holidays within Administrator-approved settings. Show effective mode near reminder settings and deadline detail. Calendar changes preview/recalculate future notifications with history, never silently change authorised deadlines. Invitation validity, membership/grant expiry, security timeouts and retry intervals remain elapsed-time based.

Date-only task reminders default to 09:00 UTC+8 on the applicable seven-day/one-day reminder dates. Specific-time deadlines use the configured interval before that time. Risk review-due notice defaults 09:00 on the review date; overdue follows date end, with one next-morning missed-review notice. Notification timing follows the configured calendar mode where applicable; exact scheduler implementation belongs to its contract.

Authorised changes into the past show overdue immediately and notify assignee/PM once; already-three-day-overdue work escalates without another three-day delay. Consolidate overlapping alerts for the same task/recipient, preserving each trigger in history. Retry only relevant permitted notices at the accepted elapsed-time points; cancel obsolete reminders. Project pause/closure/resumption rules still govern.

### O13 — External file operations

Record service file identity/version where available. Check on opening/filing, with optional scheduled checks and displayed last-check time. Distinguish Changed, Missing, Access denied and Unverified. Preserve approved-version references; changed content needs a new registered version/review, not inherited approval.

PM/Deputy reconciles moves/renames within approved destinations; outside destinations need Administrator approval. Preserve old/new references. Failed operations retain last confirmed location and incomplete status. Verify destination before declaring relocation complete and avoid duplicate authoritative copies.

Logical deletion of a register entry does not delete the external file. Links do not grant external permissions. On owning-department transfer, Administrator explicitly chooses approved relocation or retention at its existing approved location.

### O14 — Permission completeness and leadership information

Apply account, membership/grant validity, project state and content permissions together. Ungranted actions are denied; Administrator standing is not blanket content access.

| Action | Accepted authority |
| --- | --- |
| Read ordinary project information | Active members within audience policy; Audit/Oversight/leadership only their explicit scope. |
| Submit proposals/output drafts | Active project members, without implied approval. |
| Logically delete discussion messages | Author or PM/Deputy, with history and preserved linked commitments/evidence. |
| Logically delete imported sources | PM/Owner/Sponsor; flag links and exclude future processing. |
| Logically delete authorised records | Owner/Sponsor after appropriate terminal disposition, not a bypass of cancellation/withdrawal/resolution. |
| Inspect Deleted content | Explicit scope in valid Audit/Oversight grant. |
| Inspect quarantined originals | Separately designated security people, separately approved time-limited grant, no self-approval. |
| Manage project connections | Delegated PM/Owner/Sponsor within approved services/destinations; secret values protected. |
| View AI usage | User own usage; PM/Owner/Sponsor project/person breakdown; Administrator organisation usage, without source/credential disclosure. |
| Financial adjustment | PM/Deputy proposes; Owner/Sponsor approves. |
| Export | Current read access plus enabled export policy; restricted reading does not automatically permit bulk export. |

Leadership summaries include project name/scope, PM name, owning department and participating departments, status/stage/substage/duration, task progress, milestones/review dates, overdue/blocked work, significant risks, permitted resource/financial summaries and refresh time. Missing/partial data is labelled. This does not invent a separate milestone-management feature beyond supported timeline/review records.

Leadership users may add/hide/rearrange approved summary fields within their own view and granted scope. No extra raw source, financial-detail or management access; no invented metrics through personalisation.

### O15 — Visual and interaction boundaries

Responsive web for desktop/tablet/mobile; no native app required. Assess current and previous major Edge, Chrome, Firefox and Safari releases at product release, with a documented matrix: [`docs/operations/browser-matrix.md`](operations/browser-matrix.md) (D124; checked automatically by `tests/browsers/` and by hand for Safari with [`docs/operations/safari-check.md`](operations/safari-check.md)). Keep proposal/evidence/approval context accessible together, using linked views where small screens require them.

Final layouts/type/palette/components are reviewed through separate mockups. Preserve intuitive, logical, calm, elegant design and WCAG 2.2 AA target with manual accessibility checks.

Use helpful graphics alongside text/numbers: bars for comparisons, pie/doughnut only for a small meaningful whole, flowcharts for stages/approval routes/relationships, timelines for known dates. Graphics respect permissions, identify measure/period, supply accessible text/tabular values and never depend only on colour. Avoid decoration and misleading comparisons.

### O16 — Acceptance method

English interface initially; assess English, Bahasa Melayu and mixed English–Malay notes. Declare testing before listing additional language support. Use at least twelve representative inputs covering short meetings and 5,000–8,000 words, 5–40 reviewable items, ambiguity and non-commitments. Two human reviewers agree references before scoring and preserve versions.

Proposed thresholds were accepted: at least 95% of generated proposals supported and 90% of expected items captured across the assessment set, reported by item type and meeting size. Exact source references, no invented owners/dates, no automatic authorisation and no unauthorised disclosure are mandatory. A demonstrated failure blocks acceptance of the affected capability.

Observe at least five newcomers without coaching, including member and management/review journeys. Record errors, assistance and time. Timing bands are **5–20 items (typical)** and **21–40 (rare higher volume)**; shorter-than-five meetings still receive correctness/usability assessment without a quota. Retain original timing targets and disclose misses rather than average them away.

Combine automated accessibility checks with manual keyboard, zoom, screen-reader and responsive assessment; graphics require accessible equivalent values. A target miss remains unmet until corrected or explicitly accepted by Owner as a documented limitation. Method approval is not product acceptance.

### O17 — Exact licence

**AGPL-3.0-only**, without additional commercial restrictions for V1.0, is accepted. Future commercial arrangements require separate decision and appropriate rights. AGPL does not require zero-price redistribution/hosting. This decision updates documentation; it does not claim that repository licence files or legal notices have already been changed.

### Detailed specifications still required

The seventeen product subjects and six subsequent handover clarifications Q01–Q06 have accepted resolutions. Exact field/configuration/security/transaction contracts, operational setup and actual verification remain required. These are not grounds to reopen accepted defaults or claim unperformed checks passed. Newly discovered material product questions require explicit decision.


## 18. Supporting document index

All names below are exact supporting filenames. They are reconciled in this handover edition. Additional entry documents and shared catalogues are indexed in START-HERE.

| No. | File | Purpose |
| --- | --- | --- |
| 1 | Kainow-V1.0-Product-Summary.md | Reconciled V1.0 product summary. |
| 2 | Kainow-V1.0-Role-Management-Permissions.md | Role management and combinations. |
| 3 | Kainow-V1.0-Project-Lifecycle-Rules.md | Project transitions and stages. |
| 4 | Kainow-V1.0-Proposals-and-Configurable-Business-Rules.md | Proposal policy, amendments and configuration history. |
| 5 | Kainow-V1.0-Task-and-Subtask-Lifecycle-Rules.md | Operational tasks and nesting. |
| 6 | Kainow-V1.0-Invitation-and-Membership-Lifecycle-Rules.md | Invitation/membership lifecycle. |
| 7 | Kainow-V1.0-Questions-Decisions-and-Risk-Lifecycle-Rules.md | Questions, decisions and risks. |
| 8 | Kainow-V1.0-Reminders-Notifications-and-Escalation-Rules.md | Communication schedules and routing. |
| 9 | Kainow-V1.0-Discussion-Evidence-Access-and-History-Rules.md | Source audiences, evidence/history, logical deletion and quarantine. |
| 10 | Kainow-V1.0-AI-Configuration-Data-Handling-and-Usage-Rules.md | Project credentials, providers, data and usage. |
| 11 | Kainow-V1.0-Dashboards-Progress-Timeline-and-Settings-Rules.md | Metrics, display preferences and settings. |
| 12 | Kainow-V1.0-Shared-Resources-and-Optional-Budget-Tracking-Rules.md | Resource usage and optional finance. |
| 13 | Kainow-V1.0-Core-Records-and-Project-Data-Configuration-Rules.md | Conceptual records and configurable fields. |
| 14 | Kainow-V1.0-Sign-in-Access-Requests-and-Account-Lifecycle-Rules.md | Account, holds, readmission and grants. |
| 15 | Kainow-V1.0-Action-Item-Emails-External-Outputs-and-Department-Attribution.md | Departmental attribution, digests and external filing. |
| 16 | Kainow-V1.0-User-Journeys-and-Product-Acceptance-Criteria.md | Real-model/human assessment and revised workload. |
| 17 | Kainow-V1.0-Project-Discussion-AI-Assistance-and-Minutes-Access-Rules.md | Shared discussion, AI assistance and configurable minutes. |
| 18 | Kainow-V1.0-UI-Navigation-and-Accessibility-Requirements.md | Interface requirements including intuitive/elegant design principles. |

**Handover status:** product documentation assembled and reconciled. Detailed designs/verification and any genuinely unresolved edge semantics are explicitly tracked in the design register. This document does not approve a deployment or claim product acceptance.

## Shared handover references

- [START-HERE](Kainow-V1.0-START-HERE.md).
- [Intent-Card](Kainow-V1.0-Intent-Card.md).
- [Permission-Matrix](Kainow-V1.0-Permission-Matrix.md).
- [Configuration-Catalogue](Kainow-V1.0-Configuration-Catalogue.md).
- [Remaining-Design-and-Verification-Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md).
- [Handover-Manifest](Kainow-V1.0-Handover-Manifest.md).

## 18. Accepted handover clarifications Q01–Q06 — 6 November 2026

### Q01 — Configuration authority and delegation (Accepted)

Mandatory protections cannot be disabled: human authorisation, evidence/history, access checks, project credential separation and spending enforcement. Enterprise Administrators control supported role-permission definitions, approval rules, security settings, organisation limits and delegation. PM/Owner/Sponsor may adjust explicitly delegated operational settings: reminders, calendars, categories, stages, permitted minutes audiences, optional finance, approved connections/formats and project AI allowances within organisation bounds. Project delegates cannot edit role-permission definitions or expand their own delegation. Role appointments still follow the existing role-management matrix.

Show each setting's effective value, inheritance and editing authority. Record actor, reason, previous/new values and effective time. Preview impact on access, pending approvals and existing projects. Never silently rewrite existing commitments or approvals. Exact keys, types and any unagreed numerical bounds remain bounded design work; this decision does not invent new ranges.

### Q02 — Working-day default and notification recovery (Accepted)

Working Days is the default, initially Monday–Friday, with configurable weekdays and holidays. Calendar Days remains selectable. This explicitly replaces the earlier Calendar Days default. Keep an authorised deadline on a non-working day unchanged and show a warning when it is selected. Count reminder intervals using the selected project calendar.

In Working Days mode, a reminder landing on a non-working day is sent on the preceding working day, normally at 09:00 UTC+8. Never escalate early: after the configured overdue interval has passed, deliver at the next eligible notification time. A risk-review date on a non-working day receives its advance notice on the preceding working day; retain its actual review date and overdue calculation.

After system unavailability, send one consolidated still-relevant notification per recipient; skip obsolete reminders and avoid duplicate deliveries. Calendar changes preview/recalculate future notifications, preserving deadlines and delivery history. Invitation validity, membership/grant expiry, security timeouts and retry intervals remain elapsed-time based. Urgent security notices do not wait for working days.

### Q03 — Investigation and quarantined-original security grants (Accepted)

Project access/membership investigations follow existing role-management authority; findings are visible only to named investigators and authorised role managers. This is separate from permission to inspect quarantined originals that may contain secrets.

Inspecting quarantined originals needs a separate time-limited security grant approved by an Enterprise Administrator other than the requester. Project roles and ordinary Audit/Oversight do not suffice. Record purpose, specific records, requester, approver and expiry. Default duration is 24 hours; extension requires fresh approval. Require explicit confirmation before revealing sensitive content and record each inspection. No bulk export, email inclusion or AI processing of quarantined originals. If no independent Administrator is available, access remains blocked until another designated Administrator is available. No emergency self-grant is introduced. Sanitised information can remain available under ordinary permissions.

### Q04 — Archive, unarchive and restoration (Accepted)

Only Closed projects may be archived. Default archive timing is twelve months after closure, Administrator-configurable; PM/Owner/Sponsor may archive earlier. PM/Owner/Sponsor may unarchive into ordinary navigation, but the project stays Closed/read-only until a separately authorised reopening.

PM/Deputy may restore Deleted discussion messages with a reason/history; PM/Owner/Sponsor may restore Deleted imported sources after reviewing their intended audience; restoring a Deleted authorised record requires Owner/Sponsor approval, retaining its previous lifecycle status and approval history. These are narrowly permitted administrative actions even while Deferred/Closed; they do not reactivate work or reopen the project.

Preview who will regain visibility. Current account, membership, audience and grant restrictions still apply. Restoration never automatically triggers AI, emails, invitations, deadlines or task execution. Quarantined originals cannot return through ordinary restoration; security review must produce a sanitised version. Record actor, time and reason for archive, unarchive and restore.

### Q05 — Deadline review before resume/reopen (Accepted)

A resume review may run while the project remains Deferred or Closed. PM/Deputy lists every outstanding task and subtask and proposes replacement due dates, showing previous dates, statuses and assignees. Owner/Sponsor approves amendments under project approval policy as a narrow exception to read-only restrictions, not a general reopening of approvals.

The actor with existing lifecycle authority then resumes/reopens after required roles and memberships are valid. Only tasks with approved replacement dates may start, resume or complete after activation; others show Deadline review required. Every outstanding task/subtask needs its own replacement date, different from its previous date and not already past when authorised. Partial approvals are allowed; approved tasks proceed independently, subject to parent conditions. Status/assignee remain unchanged unless separately amended. Flag child dates later than parents without automatic adjustment.

For work actually completed during the pause, use the accepted reconciliation exception: actual completion date, explanation/evidence and Owner/Sponsor approval; do not fabricate a future deadline. Reopening does not resend invitations, restore expired access or replay missed notifications.

### Q06 — Launch catalogues and configurable services (Accepted)

MYR is the organisation's initial financial currency default; initially support MYR, SGD and USD. A financially tracked project selects one reporting currency. Other supported currencies may be enabled later. No automatic conversion. Resource units initially include hours, days, person-hours, person-days, items, seats and square metres; record usage period separately and do not assume conversions such as one day equalling eight hours.

OpenAI and Anthropic APIs remain AI launch options. Administrators enable tested models and nominate project primary/fallback choices. Model identifiers are configurable rather than frozen product requirements. No calls until project credentials, model selection and positive applicable spending allowances exist.

Email provider is configurable through supported Administrator-approved connections; Microsoft 365 is the initial supported option, not a mandatory sole provider. Use an approved organisational sender and retain the person/project event initiating each message. SharePoint document libraries and OneDrive are the initial storage options; SharePoint is the suggested default destination type, with each project selecting an approved destination. Dropbox, Box and other cloud storage providers may be added later as configurable options once supported connectors are implemented, verified and approved. Their future inclusion is not a claim of V1.0 launch implementation.

Connections receive only needed destinations/operations. Register requested permissions for Administrator approval; do not assume organisation-wide mailbox/file access. Removing a catalogue entry prevents new selection but preserves historical records; removing a connection stops new operations without erasing prior evidence.

## 19. Accepted runtime architecture and Administrator analytics A01–A12

| ID | Area | Accepted decision |
| --- | --- | --- |
| A01 | Hosting | Self-hosted V1.0, one organisation per installation. An organisation may run its instance in its own cloud environment. A service hosted by the developer is a future option. |
| A02 | Updates | Built-in update capability with explicit Enterprise Administrator approval for each release. Automatic checking/notification is permitted. An approved release may install immediately or at its approved maintenance window; no blanket approval for later releases. |
| A03 | Portability | OS-agnostic product goal through a documented portable deployment. Supported browsers access the product. Linux containers run on Linux hosts; Windows hosting uses a supported Linux VM/runtime. Native execution on every OS is not promised. |
| A04 | Initial capacity | 200 registered users and 10 simultaneously active users per installation, with a path to increased capacity through resources and testing. This is a verification target, not an automatic-scaling promise. |
| A05 | AI concurrency | Two simultaneous AI requests per installation by default, Administrator-configurable. The limit spans projects and all workers; additional requests wait visibly and recheck permissions/allowance at execution. |
| A06 | Application structure | A modular application with clear internal boundaries and separately runnable background workers, shipped as one coordinated release. |
| A07 | Backup/recovery | Daily encrypted backups to an approved location separate from the running installation; default 30-day backup retention, Administrator-configurable. Fresh successful backup before update. Maximum acceptable data loss 24 hours and restoration target 4 hours for the supported documented setup. Test restore before go-live and after material backup changes. |
| A08 | Database | PostgreSQL is the single supported primary database engine for V1.0, self-managed or a verified compatible managed service. Approval, authorised record and history must be saved atomically. Application access control and database-level protection are both required design areas. |
| A09 | Deployment packaging | Linux containers with Docker Compose for the initial supported deployment. App, workers, PostgreSQL or managed-database connection configuration, persistent storage and backup configuration form the installation package. |
| A10 | Application stack | TypeScript throughout application code: NestJS backend/workers, React with TypeScript browser interface, PostgreSQL. C#/.NET was considered but not selected for the product. Exact supported Node.js/framework/library versions must be pinned and verified in the technical baseline; that verification has not been performed here. |
| A11 | Background jobs | Durable PostgreSQL-backed queue using pg-boss. Separate AI/email/document-processing queues; jobs and attempt counts survive restarts. Recheck current permissions, source, project state and spending before execution/retry. Apply accepted retry limits without reset on restart. Reconcile uncertain external effects before repeating them. |
| A12 | Administrator analytics | Capture every defined business/operational event and measurements for analytics/reporting. Configurable dashboard with organisation→department→project→permitted record/person drill-down, trends/charts/filters and permitted exports. Default summary levels are organisation, department and project; named-person detail and source/record detail require their relevant permissions. |

These accepted choices extend the handover; they are not implementation or operational acceptance. TypeScript/NestJS replaces the unselected C#/.NET proposal. Exact technical contracts and measured verification remain required.

- [Application Architecture and Operations Design](Kainow-V1.0-Application-Architecture-and-Operations-Design.md).
- [Administrator Analytics and Reporting Rules](Kainow-V1.0-Administrator-Analytics-and-Reporting-Rules.md).

## 20. Accepted managed-source, credential, retention and storage decisions A13–A19

| ID | Area | Accepted rule |
| --- | --- | --- |
| A13 | Managed sources | Imported original files, extracted text and preserved versions reside in a protected SharePoint/OneDrive area managed by Kainow; PostgreSQL stores source/version/permission/quote references. Exact approval evidence is not silently replaced by external edits. Source-area content is part of Kainow recovery, not only the database. |
| A14 | Direct source access | Ordinary users access managed sources through the Kainow front end. Only explicitly designated storage Administrators have direct storage access, alongside the authorised integration connection. Enterprise Administrator status alone does not grant direct access. |
| A15 | Credentials and recovery | Secrets entered via protected settings are encrypted at rest and never redisplayed after saving. Encryption keys remain separate from the database/backups they protect, with separately protected recovery copies maintained by designated Administrators. Record replacement/revocation/rotation without secret values. Use portable deployment-secret handling; supported cloud secret-manager integration may be configured. |
| A16 | Diagnostic retention | Routine technical diagnostics default to 30-day Administrator-configurable retention. Business/history/security-audit records and defined analytics events remain indefinitely retained under existing protections. Diagnostic expiry does not erase evidence; preserve relevant diagnostics for investigation before expiry. |
| A17 | Provisional storage | Application/images/PostgreSQL/queues/diagnostics: 20 GB minimum provisioning target, 50 GB recommended SSD, excluding host OS/base VM. Approximately 30 GB is expected footprint, not a ceiling; 20 GB only suits a smaller initial footprint and requires install/operation/update testing. Managed source quota 25 GB minimum/100 GB recommended initial allocation. Backups sized from retained daily/pre-update copies plus at least 20% headroom. These are estimates requiring verification, not tested guarantees. |
| A18 | Backup failure | Continue existing project work, alert Administrators and keep a persistent dashboard warning. Show last successful backup and whether the 24-hour recovery target is exceeded. Block updates until a fresh successful backup exists. Never report unresolved backup failure as healthy. |
| A19 | Critical storage | At the verified safe free-space threshold enter protective read-only mode: safe reads continue; pause new imports, AI jobs and other data-changing work; block updates and actions unable to reliably persist both change/history. Alert affected location/capacity. Never delete retained evidence automatically. After restored capacity and passing health checks, Administrator confirms resumption. |

Full accepted rules: [Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md). These extend A01–A12; technical implementation/verification remains outstanding.
