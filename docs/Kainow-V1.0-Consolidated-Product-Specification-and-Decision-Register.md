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

Native meeting minute-taking, recording/transcription, Gantt charts, advanced portfolio management, multiple organisations per installation, outside-organisation participants, public API, plugin loading, arbitrary workflow builders, unrestricted custom fields, general document editing, resource booking/allocation, full financial accounting and a general-purpose AI assistant remain outside scope.

Project discussion and action-item emails are included; a general chat or email-client replacement is not. Native minute-taking is a future direction requiring its own specification.

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

Responsive web for desktop/tablet/mobile; no native app required. Assess current and previous major Edge, Chrome, Firefox and Safari releases at product release, with a documented matrix. Keep proposal/evidence/approval context accessible together, using linked views where small screens require them.

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
