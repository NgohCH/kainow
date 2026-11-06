# Kainow V1.0 — User Journeys and Product Acceptance Criteria

**Version:** 1.0 — reconciled handover edition  
**Status:** Reconciled accepted journeys and assessment thresholds; detailed fixtures/scripts tracked separately  
**Date:** 6 November 2026  
**Scope:** Product outcomes and acceptance only

## 1. Purpose

Kainow turns conversations into accountable execution. V1.0 must let a person supply meeting notes or minutes, review source-backed proposals, authorise appropriate records and see who is responsible for the resulting work.

Acceptance must establish correctness, privacy and usability as well as speed. A fast response, a matching quotation or a passing automated check alone does not prove that Kainow meets its purpose.

This document defines the journeys to assess and the accepted benchmark conditions. It complements the detailed V1.0 product rules; it does not replace their permission matrices, lifecycle rules or configuration boundaries. Agreement to this document does not establish that the product has been delivered or accepted.

## 2. Meeting input: V1.0 and future scope

### V1.0

Users supply meeting notes or minutes directly to Kainow. These may be written by a person or produced by an independent AI tool. Kainow processes the supplied content into proposed tasks, decisions, questions and risks.

The supplied text and its preserved version are Kainow’s source evidence. A quotation proves what that version contains; it does not independently prove what was said in the meeting or whether externally generated minutes are accurate.

Meeting content is data. Instructions embedded in it must not become commands, tool calls, links to follow or approval authority.

### Future versions

Native meeting minute-taking within Kainow is a future capability. It is not required for V1.0 acceptance. Recording, transcription, live meeting participation and their associated consent and retention rules are not authorised by this future direction and require a separate specification.

## 3. Required user journeys

| ID | Journey | Required outcome |
| --- | --- | --- |
| UJ-01 | First useful loop | Supply notes, obtain source-backed proposals, review and authorise selected items, then see the resulting responsibilities. |
| UJ-02 | Project setup | Create a project with one owning department, participating departments, required roles and permitted project settings. |
| UJ-03 | Invitation and membership | Invite eligible people, activate membership after acceptance and enforce dates, expiry, holds and revocation. |
| UJ-04 | Task execution | Assign, start, block, complete and reopen tasks under the agreed permissions and subtask rules. |
| UJ-05 | Project lifecycle | Activate, defer, resume and close a project with explicit outcomes and preserved history. |
| UJ-06 | Evidence and privacy | Read permitted supporting quotes; access full discussions only through approved, scoped and time-limited grants. |
| UJ-07 | AI controls | Use the project’s configured credentials and approved models, attribute usage and enforce applicable spending limits. |
| UJ-08 | Dashboards and resources | Understand progress, stage duration, departmental contribution, resource usage and optional finances. |
| UJ-09 | Action-item email | Send consolidated authorised actions only to eligible recipients without disclosing restricted content. |
| UJ-10 | Project outputs | Register and file outputs in approved external storage, preserving versions, attribution and approval status. |
| UJ-11 | Configuration | Apply permitted organisation and project settings with recorded changes and policy versions. |
| UJ-12 | Accessibility | Complete essential journeys with keyboard navigation and assistive technology, against the WCAG 2.2 AA target. |

## 4. First useful loop

Assess the following sequence through the actual user interface:

1. A user with the required project access supplies notes or minutes.
2. Kainow preserves the source version and generates reviewable proposals.
3. Each source-based proposal identifies its type, source quotation and AI or human attribution. AI proposals remain visually distinct from authorised records.
4. An authorised person inspects the proposals, corrects missing or incorrect details, and authorises or rejects items under the applicable policy.
5. Authorised records appear in the project with their evidence and history. Actionable tasks have the required assignee and due date.
6. The user can see who is responsible, what is due and what remains unresolved.

Extraction must leave unstated owners and dates empty. A human may supply these during review; record that human contribution separately from the source-backed extraction.

No proposal becomes authorised merely because it was generated, displayed, included in an email or selected by an AI model. An assignment awaiting accepted membership must be visibly pending and must not grant project access.

## 5. Accepted benchmark scenario

| Condition | Agreed treatment |
| --- | --- |
| Main input scenario | Meeting notes or minutes containing **5,000–8,000 words**. |
| Reviewable content | **5–40 reviewable items**, covering tasks, decisions, questions and risks as supported by the source. |
| Short meetings | Include shorter inputs with fewer items; no minimum proposal quota. |
| Content variation | Include ambiguity, missing owners or dates, repeated references, non-actionable discussion and statements that must not become commitments. |
| Proposal count | Follow the source. The benchmark range describes assessment cases, not a requirement to invent or suppress proposals. |
| Model and setting | Declare the approved provider/model, relevant configuration, device, network and test conditions. |
| Comparison | Report results by input length and item count. A five-item review is not equivalent to a forty-item review. |

The word range is an assessment condition, not a product input ceiling. It does not establish an upload-size limit or supported file formats.

## 6. Timing targets and measurement

Retain the product’s existing targets:

- Proposal generation in approximately **one minute**.
- Human authorisation review in approximately **two minutes**.
- A newcomer’s first complete useful loop in **under five minutes without assistance**.

Report whether each target is achieved for each assessed input size and item count. Retaining the target does not justify rushed approval, skipped evidence checks or a claim that forty items can always be reviewed as quickly as five.

For comparable measurements, use these boundaries:

| Measure | Start | Finish |
| --- | --- | --- |
| Generation elapsed time | User submits the notes for processing. | The complete proposal set is available for review, or a clear failure is shown. |
| Active human review | Reviewer begins inspecting the generated set. | Reviewer finishes the intended review, corrections and authorisation/rejection decisions. Record interruptions and system waiting separately. |
| First useful loop | A newcomer begins supplying notes in an accessible, prepared project. | The newcomer can see the resulting authorised responsibilities. Include intervening system waits and navigation. |

Record sign-in and project/invitation setup as separate journey results so that their effort remains visible. The timing scenario must disclose that the core-loop project and access were prepared beforehand.

Record all assessed runs, including failures and incomplete attempts. Do not present only the fastest result. If a target is missed, report the actual result and its conditions; any revised acceptance threshold requires an explicit product decision.

## 7. Extraction quality and evidence

Evaluate real-model results against a human-reviewed reference for each assessment input. Mocks can check processing contracts and instrumentation but cannot establish extraction capability or human usability.

Assess and report:

- **Missed items:** relevant tasks, decisions, questions or risks omitted from the proposals.
- **Unsupported items:** invented or misleading commitments, interpretations or classifications.
- **Source accuracy:** quotations match the preserved source version and support the proposal’s meaning.
- **Owner/date accuracy:** explicitly stated people and dates are represented correctly; missing details remain empty.
- **Duplication:** repeated discussion does not create misleading duplicate commitments.
- **Review burden:** corrections, evidence checks and navigation needed before safe authorisation.
- **Human outcomes:** whether reviewers detect errors and correctly distinguish proposals from authorised records.

Exact quotation matching is necessary for source integrity but does not establish semantic support. For example, a person mentioned in a discussion is not automatically the task assignee.

Accepted thresholds: at least 95% of generated proposals supported and 90% of expected items captured across the test set, with breakdowns by type/size. Two human reviewers agree references before scoring. Mandatory safeguards remain non-negotiable and are tested independently of averages.

## 8. Permission and lifecycle acceptance

Assess both permitted actions and denied actions. The journey set must cover:

- Role separation, required project roles and authorised role transfer.
- Same-organisation eligibility and invitation acceptance before membership access.
- Account disablement, On Hold investigation, valid restoration and fresh admission after revocation.
- Expiry of membership and audit/oversight grants without silent extensions.
- Members completing their own tasks; subtask completion requirements and recorded authorised overrides.
- Deferral locks and explicit resumption without silently reviving expired invitations or changing commitments.
- Authorised question resolution, decision replacement and risk handling under their separate lifecycle rules.
- Shared project discussion/ordinary minutes for active members, Restricted source audiences, permissioned AI answers, explicit summary publication and additional scoped grants without leakage.
- History identifying the actor, affected project and relevant policy or record version.

An administrator’s configuration or backup role-management authority must not be treated as blanket discussion access or approval authority.

## 9. Dashboards, communications and outputs

Dashboard assessment must confirm correct task-completion calculations, stage duration, clear missing-data labels and usable navigation when more than five projects are shown. Personal colour and arrangement choices must preserve accessibility and the distinction between AI proposals and authorised records. There is no separate user settings page; personal dashboard controls and authorised system/project settings follow the agreed specification.

Department reporting must separate ownership from participation and avoid counting the same project several times in organisation totals. Shared resources indicate usage; they do not book or allocate resources. Optional financial tracking must distinguish Not Required, Not Provided and an explicit zero. AI usage limits remain applicable even when project financial tracking is not required.

Email assessment must verify accurate authorised actions, eligible recipients, permission-filtered content and visible delivery failures. Delivery must not change task or approval state.

External outputs must use the structure:

`Owning Department > Project > Year > Report Type`

Verify one primary filing location, additional searchable categories, named and departmental attribution, separate AI labels, version/approval history and confirmation of filing success. Kainow permissions and external-storage permissions must both be respected. An external link does not grant access.

## 10. Real-user assessment and acceptance record

Observe newcomers using the actual interface without coaching through the core loop. Record completion, errors, requests for help, elapsed time and misunderstandings. A simulated review delay cannot establish human understanding or the two-minute review target.

For each assessed journey, retain a concise acceptance record containing:

- Journey ID, product version and applicable configuration.
- Input/reference version and test conditions where relevant.
- Expected and observed outcome, including denied actions.
- Timings, quality results and usability observations where applicable.
- Supporting evidence, known limitations and unresolved defects.
- The named person recording the result and the Owner’s acceptance decision where applicable.

Distinguish **Passed**, **Failed**, **Not Assessed** and **Blocked by an Unresolved Product Rule**. An incomplete or unassessed journey must not be presented as passed. Product acceptance requires the Owner’s recorded assessment of the evidence; automated checks alone do not constitute that decision.

## 11. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 12. Accepted assessment method and graphics

### Accepted O15 — Visual and interaction boundaries

Responsive web for desktop/tablet/mobile; no native app required. Assess current and previous major Edge, Chrome, Firefox and Safari releases at product release, with a documented matrix. Keep proposal/evidence/approval context accessible together, using linked views where small screens require them.

Final layouts/type/palette/components are reviewed through separate mockups. Preserve intuitive, logical, calm, elegant design and WCAG 2.2 AA target with manual accessibility checks.

Use helpful graphics alongside text/numbers: bars for comparisons, pie/doughnut only for a small meaningful whole, flowcharts for stages/approval routes/relationships, timelines for known dates. Graphics respect permissions, identify measure/period, supply accessible text/tabular values and never depend only on colour. Avoid decoration and misleading comparisons.

### Accepted O16 — Acceptance method

English interface initially; assess English, Bahasa Melayu and mixed English–Malay notes. Declare testing before listing additional language support. Use at least twelve representative inputs covering short meetings and 5,000–8,000 words, 5–40 reviewable items, ambiguity and non-commitments. Two human reviewers agree references before scoring and preserve versions.

Proposed thresholds were accepted: at least 95% of generated proposals supported and 90% of expected items captured across the assessment set, reported by item type and meeting size. Exact source references, no invented owners/dates, no automatic authorisation and no unauthorised disclosure are mandatory. A demonstrated failure blocks acceptance of the affected capability.

Observe at least five newcomers without coaching, including member and management/review journeys. Record errors, assistance and time. Timing bands are **5–20 items (typical)** and **21–40 (rare higher volume)**; shorter-than-five meetings still receive correctness/usability assessment without a quota. Retain original timing targets and disclose misses rather than average them away.

Combine automated accessibility checks with manual keyboard, zoom, screen-reader and responsive assessment; graphics require accessible equivalent values. A target miss remains unmet until corrected or explicitly accepted by Owner as a documented limitation. Method approval is not product acceptance.

Timing bands are 5–20 and 21–40 items; short meetings with fewer than five still receive correctness/usability testing, with no extraction quota. Source quote exactness, invented ownership/dates, automated approval and access denial require explicit positive/negative scenarios. Detailed corpus fixtures, matching/adjudication procedure and assistive-technology scripts are design tasks, not invented new product thresholds.

## 12. Accepted clarification coverage

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

### Required additional acceptance cases

- Deny project-role permission-policy edits and self-expansion of delegation; show effective/inherited operational settings.
- Exercise non-working deadline warnings, preceding-day reminders, holiday calendars, no-early escalation and relevant duplicate-free downtime recovery.
- Deny own security grant and ordinary-Audit secret inspection; verify24-hour expiry, fresh extension, confirmation and log; no independent EA remains blocked.
- Archive/unarchive retains Closed; restore previews current audience and does not trigger work/AI/email or alter lifecycle history.
- Resume with partial approved replacement dates: approved work proceeds only after activation; others blocked; changed roles/approval/date races cannot bypass gates.
- Validate MYR/SGD/USD and initial units, no implicit conversion, configurable approved email service and SharePoint/OneDrive; do not claim Dropbox/Box support before connector verification.

These cases are specified, not executed by this documentation update.

## 13. Accepted architecture/analytics verification requirements

- Verify 200 registered/10 concurrent active users with a documented mixed workload; report latency/errors/queue times rather than assume capacity from technology choice.
- Enforce two global AI slots across multiple workers and preserve retries/uncertain cost across restarts. Permission/source changes invalidate queued access.
- Exercise supported Linux container and Windows Linux-VM/runtime deployment paths with actual pinned versions.
- Verify release-specific EA approval, pre-update backup, migration compatibility, health outcomes and actual recovery. Test daily encrypted/30-day backup policy, 24-hour data-loss/four-hour restoration targets; live history remains indefinitely retained.
- Reconcile defined analytics events/metrics without duplicate retries, test configured filters/charts/exports and permission-checked organisation/department/project/person/record drill-down. Protect restricted sources, finance, investigations and secrets.

[Architecture](Kainow-V1.0-Application-Architecture-and-Operations-Design.md) and [analytics](Kainow-V1.0-Administrator-Analytics-and-Reporting-Rules.md) give accepted requirements. No application tests or deployment were run in this documentation update.

## 14. Accepted storage/recovery verification additions

A13–A19 require evidence for source version/access/backup consistency, designated provider access, protected credential recovery, 30-day diagnostic rotation without audit/analytics loss, measured 20/50 GB application profiles, quota/backup/low-space failure warnings, update blocks and explicit healthy resumption. All are specified, not executed. [Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md)
