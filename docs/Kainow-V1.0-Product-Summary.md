# Kainow V1.0 — Product Summary and Accepted Rules

**Version:** 1.0  
**Consolidated:** 6 November 2026  
**Status:** Consolidated product baseline reflecting accepted discussion decisions. This is not a claim that the product has been delivered or accepted.  
**Scope:** Product purpose, features and business rules only. Development methods, agent orchestration and environment setup are excluded.

## 1. Purpose

Kainow turns conversations into accountable execution.

People provide meeting notes or discussion content. AI proposes tasks, decisions, open questions and risk flags, each supported by a source quote. People review and authorise the proposals. Authorised records show what was agreed, who is responsible, what is due and what happened afterwards.

V1.0 supports the full project lifecycle: creation, discussion, review, authorisation, execution, monitoring, deferral, reopening and closure.

### First-use targets

- Generate proposals in approximately one minute.
- Enable human review in approximately two minutes.
- Enable a newcomer to complete the first loop in under five minutes without assistance.

These are product targets. Fast processing alone does not establish extraction accuracy, useful source evidence or meaningful human review.

## 2. Core principles

1. **AI proposes; people authorise.** AI proposals use a dashed outline and an “AI proposed” tag, visibly distinct from authorised records.
2. **Discussion content is data.** Content does not become executable instructions, commands or automatic actions.
3. **No invented owners or dates.** AI leaves these fields empty unless explicitly stated in the source. Every proposal includes a source quote.
4. **Clear attribution.** AI contributions are labelled AI; human contributions identify the named person.
5. **Preserved evidence and history.** Source versions are retained. Edits create new history entries rather than overwriting previous evidence.
6. **Organisation and actor accountability.** Every record belongs to the organisation; actions are recorded with their actor.
7. **Security and access by design.** Role permissions apply throughout the product.
8. **Configurable AI.** The product supports administrator-configured API connections and enforces spending limits.

## 3. Organisation and project creation

- V1.0 supports one organisation per installation and multiple projects within it.
- The enterprise Administrator establishes organisational eligibility and approved email domains.
- The Administrator creates the first project.
- Subsequently, eligible existing Kainow users can create projects and become their first Project Manager.
- Exactly one PM is accountable; transfer waits for eligible replacement acceptance and explicitly records the outgoing person’s role.
- Projects can add members as needed.
- A project can start without a planned end date.

## 4. Roles and accountability

| Role | Responsibility |
| --- | --- |
| Enterprise Administrator | Organisation setup, eligibility, administrative configuration, AI connections and settings. |
| Project Manager | Project coordination, membership and assignments, operational state transitions and progress. |
| Deputy Project Manager | Optional project-management support and permitted task-closure overrides. |
| Project Owner | Project accountability and authority to authorise proposals. |
| Project Sponsor | Project sponsorship and authority to authorise proposals. |
| Member | Assigned work; may mark their own tasks complete. |
| Oversight | Explicitly granted, time-limited oversight access, including discussion access where permitted. |
| Audit | Explicitly granted, time-limited audit access, including discussion access where permitted. |

### Required roles and numbers

- Draft may be created with incomplete appointments. Planned needs accepted required appointments (including eligible Scheduled memberships); Active/resumption needs Active appointments. The required set is exactly one accountable PM, at least one different Member and at least one Owner or Sponsor.
- A project may have a maximum of one Owner and multiple Sponsors.
- Owner and Sponsor roles may coexist. Neither is individually mandatory when the other exists.
- Arrange replacement before required-role removal. Natural expiry still removes access. If a required role becomes vacant, flag it, allow existing authorised work and block new authorisations/substantive amendments until repaired; never extend access silently.
- Deputy Project Manager is optional. No numerical cap has been agreed.
- Multiple people may hold Audit or Oversight appointments.

### Small teams and combined roles

- A small team has fewer than seven people: at most six distinct active project participants, including role holders.
- One person holding multiple roles counts as one person.
- In a small team, Project Manager, Owner and Sponsor responsibilities may be combined.
- The required Project Manager and Member must still be different people.
- At seven or more people, Project Manager, Owner and Sponsor responsibilities must be held by different people, where those roles exist.
- Conflicting combined assignments must be resolved before the seventh participant's membership becomes active.
- Previous approvals and history remain preserved when responsibilities are separated.
- A person may hold different roles in different projects. The small-team combination is the explicit exception to the general one-role-per-project rule.

## 5. Membership and invitations

### Eligibility and invitation flow

- Invitations are limited to people eligible for the same organisation.
- An approved organisational email domain is the normal eligibility basis; the Administrator decides eligibility questions and exceptions within the same-organisation restriction.
- Project Managers, Owners and Sponsors can invite eligible people who do not yet use Kainow.
- Assignment can trigger an invitation when the assignee has no active project membership.
- Pending invitation or membership status is visible to the team; invitation does not itself grant active access.
- Invitations expire after seven days, after which a fresh invitation can be sent.
- If an invitation is declined, the Project Manager reassigns the responsibility.
- The Project Manager can revoke an unaccepted invitation originating from task allocation.

### Dates, expiry and extension

- Every membership has a start date.
- A start or restored membership date cannot precede project creation.
- Membership expiry is configurable and defaults to no expiry. There is no mandatory six-month term.
- Membership dates do not depend on having a project end date.
- Project Managers, Owners and Sponsors can extend Member expiry dates.
- An extension records the actor and previous/new dates; it does not grant additional roles or permissions.
- Audit and Oversight appointments remain explicitly time-limited and configurable.
- Appointment and extension authority for Manager, Owner, Sponsor, Audit and Oversight roles must be stated separately in the detailed permission matrix. Member-extension authority does not imply that authority.

## 6. Access and discussion privacy

### Accepted O09 — Source audience and derived information

Provide a PM Source Access control: Project-wide reading (default for project-related minutes) or Restricted source (configured audience, default PM/Deputy/Owner/Sponsor plus approved grants). Show audience before confirmation; record later changes within organisation boundaries. Owner/Sponsor may also manage audiences where authorised.

AI may draft a sanitised summary from restricted material, but PM/Owner/Sponsor must explicitly review/approve its intended audience. Original access does not widen automatically. Stored answers/excerpts recheck source-linked access and are hidden pending review when that access is lost. A separately reviewed/published summary keeps its own audience when source permissions tighten, but is flagged for review. Deletion/quarantine excludes source from future processing and restricts affected outputs containing that content pending review. Security quarantine overrides normal sharing.

Use clear labels: Source restricted, Summary approved for sharing, Access review required. No query or stored answer bypasses current source access restrictions.

### Accepted O14 — Permission completeness and leadership information

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

Passwordless access requires eligible invitation and current account/membership or grant. Shared project discussion is included. Imported minutes use project-wide/restricted audiences. Administrator standing alone is not a content override.

## 7. Discussion, proposals and authorisation

- Users supply meeting notes or discussion text for analysis.
- AI proposes tasks, decisions, questions and risk flags with source quotes.
- People review, correct and authorise proposals before they become authoritative records.
- Project Owners and Sponsors authorise proposals.
- A small-team Project Manager holding Owner/Sponsor responsibility may authorise in that capacity.
- Project Managers manage operational state transitions.
- Questions may be resolved by their requester, Project Manager or an explicitly permitted equivalent role.
- Authorisation and later changes retain actor attribution, supporting evidence and history.
- Source edits remain versioned; AI and human edits remain distinguishable.

Exact source matching shows that quoted words occur in the discussion; it does not, by itself, establish that a proposed commitment or assignment is contextually correct. Human review remains essential.

## 8. Tasks and subtasks

- One task has one assignee.
- Work needing several actionees can be broken into subtasks, each with its own assignee.
- Subtasks may be nested no more than two levels. Deeper work must be re-scoped into additional tasks.
- Every authorised actionable task requires a due date.
- AI must not invent a missing date: an authorised person supplies it before the task becomes an actionable commitment.
- Members may mark their own tasks complete.
- Subtasks must complete before their parent closes, unless a Project Manager or Deputy overrides the requirement. The override is recorded.
- Tasks support a next review date, reminders and escalation.
- All deadlines and related notification calculations use UTC+8.

### Task labels

**Not Started · In Progress · Blocked · Completed · Cancelled**

Overdue is calculated from the due date rather than selected manually as a task status.

## 9. Reminders and escalation

### Default reminder timing

- Seven days before the due date.
- One day before the due date.
- Reminder timings are configurable.
- Escalation occurs when a task is three days overdue.

### Escalation routing

| Task assignee | Recipient |
| --- | --- |
| Member | Project Manager |
| Deputy Project Manager | Project Manager |
| Project Manager | Owner and/or Sponsors |
| Owner or Sponsor | Other available accountable role holders; never only the same person |

If combined small-team roles leave no independent recipient, display **“No independent escalation recipient”** and flag it on the project dashboard. Do not invent a recipient or automatically disclose project information to the enterprise Administrator.

An unfinished subtask passing its parent's deadline triggers a separate parent-deadline escalation, independently of the three-day overdue rule.

## 10. Project lifecycle and labels

Status, stage and closure outcome are separate fields.

| Field | Accepted default labels | Meaning |
| --- | --- | --- |
| Project status | Draft, Planned, Active, Deferred, Closed | Whether the project is operating. |
| Project stage | Initiation, Planning, Execution, Review & Acceptance, Closure | Position in the project lifecycle. |
| Closure outcome | Delivered, Partially Delivered, Abandoned | What ultimately happened. |

Deferred is a status, not a completion outcome, because the project may resume.

### Optional substages

| Stage | Default optional substages |
| --- | --- |
| Initiation | Define Purpose; Identify Participants; Confirm Accountability |
| Planning | Define Scope; Break Down Work; Identify Resources; Approve Plan |
| Execution | In Progress; Monitoring & Follow-up |
| Review & Acceptance | Review Deliverables; Resolve Outstanding Items; Confirm Acceptance |
| Closure | Record Outcome; Handover; Close Project |

These are defaults that projects can simplify, not mandatory steps for every project. Stage changes do not automatically authorise proposals.

### Progress, deferral and reopening

- Show current stage, optional substage and time in the current stage period.
- Preserve previous stage periods and their durations.
- Include a simple project progress indicator and timeline.
- Deferral locks ordinary task and invitation changes and makes project access read-only; specifically authorised lifecycle, access repair and protective actions remain available.
- The Administrator, Project Owner, Sponsor or Manager can reopen a deferred project.
- Reopening starts a new stage period and preserves history. Outstanding tasks require new authorised due dates before restart, with an approved reconciliation exception for work already completed during the pause.
- Project end dates remain optional.

## 11. Shared resources and budgets

V1.0 indicates project usage and association of shared people, budgets, equipment and facilities.

- Show responsibilities and assigned work.
- Record/display budget and usage information.
- Indicate equipment and facility usage.
- Booking and allocation happen outside Kainow.

V1.0 is not a resource reservation or financial accounting system.

## 12. Dashboards and consistent information

- A personal dashboard summarises projects associated with the user.
- A simplified organisation-wide dashboard supports leadership.
- Project summaries cover progress, stage duration, responsibilities, deadlines, decisions, questions, risks and resource usage.
- Use dropdowns and controlled categories where consistency supports navigation and future analysis.
- Detailed visual layouts and design choices remain for a separate design document.

## 13. AI configuration and usage

### Accepted O03 — Launch integrations and configurable formats

Accepted launch services: OpenAI and Anthropic APIs; configurable email providers (Microsoft 365 initially supported); SharePoint document libraries and OneDrive storage initially, with Dropbox, Box and other cloud storage options addable later through supported approved connectors. These are supported launch options, not a permanent provider restriction. Multiple Enterprise Administrators may approve additional supported services and destinations. Delegated PM/Owner/Sponsor can add/change/remove project connections, with project credentials, usage attribution and spending controls. Unsupported protocols require a supported connector extension, not an arbitrary URL or API key. No plugin-loading capability is implied.

Accepted input formats: pasted text, TXT, Markdown, DOCX and selectable-text PDF. Generated outputs: Markdown, DOCX, PDF and CSV for permitted tabular reports. Projects can add/remove formats from the Administrator-approved supported catalogue. Removal blocks new import/generation, preserving old files and history; adding a format does not automatically convert old documents. New parsers/exporters require a supported extension. OCR remains outside V1.0. Actual authentication/permissions and service compatibility must be verified in integration contracts.

### Accepted O04 — Configuration defaults and visible analysis limits

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

AI output remains proposed; project-specific credentials and all applicable caps apply. Blank spending allowance means zero. PM/Owner/Sponsor view project/person usage; users view their own and Administrator organisation usage.

## 14. User experience and accessibility

- Calm, content-first presentation with plain words.
- Simple, intuitive navigation and consistent, elegant screens.
- Accessibility target: WCAG 2.2 AA.
- Limited user-configurable presentation options.
- Detailed interface design remains separate from this feature baseline.

## 15. Outside V1.0

- Gantt charts and advanced portfolio views.
- Multiple organisations within one installation.
- Participants outside same-organisation eligibility.
- Public API and plugin loading.
- General chat, calendar or email-client replacement. Shared project discussion and consolidated action-item email are included.
- General document repository.
- Resource booking/allocation and full financial accounting.
- General-purpose AI assistant functionality.

Additional capabilities may be considered for future versions or extensions. Mention of future plugins does not include plugin loading in V1.0.

## 16. Licence

The selected product licence is **GNU Affero General Public License version 3 only (AGPL-3.0-only)**. This supersedes the original Intent Card's UNLICENSED wording. The accepted V1.0 choice is AGPL-3.0-only without additional commercial restrictions. Future commercial arrangements require a separate decision.

Repository: https://github.com/NgohCH/kainow

## 17. Current baseline and supporting detail

Use the consolidated specification for accepted D01–D70 and O01–O17 decisions, the Permission Matrix for action authority, the Configuration Catalogue for supported settings, and the Remaining Design and Verification Register for explicit downstream work. This summary does not replace these detailed documents.


## 18. Accepted final handover clarifications

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

## 19. Accepted runtime and Administrator reporting direction

V1.0 is self-hosted, one organisation per installation, portable through Linux containers/Docker Compose (Windows hosts use a supported Linux VM/runtime). Every release update needs explicit Enterprise Administrator approval. Initial target is 200 registered/10 concurrent users, with tested scale-up; default two simultaneous AI requests across the installation, Administrator-configurable.

The modular application uses TypeScript throughout: NestJS backend/workers, React/TypeScript interface, PostgreSQL and pg-boss durable jobs. Daily encrypted backups, 30-day default backup retention, 24-hour acceptable data-loss/four-hour restoration targets and pre-update backup/restore verification are accepted. Backup expiry never purges live product history.

The configurable Enterprise Administrator analytics dashboard captures all defined business/operational events and supports organisation/department/project summaries and permission-checked record/person drill-down, charts and permitted reporting/export. It does not grant blanket source, finance, investigation or secret access.

See [Architecture Design](Kainow-V1.0-Application-Architecture-and-Operations-Design.md) and [Administrator Analytics](Kainow-V1.0-Administrator-Analytics-and-Reporting-Rules.md). These are accepted design requirements, not verified implementation.

## 20. Accepted managed sources and capacity safeguards

Sources/files/extracted text/versions use protected Kainow-managed SharePoint/OneDrive; users access via Kainow and only designated storage Administrators/service connection directly. Protected keys have separate recoverable encryption material. Routine diagnostics default 30 days, while business/history/security/defined analytics events remain retained. App/images/database/queue/diagnostics target 20 GB minimum/50 GB recommended SSD, measured before release; expected 30 GB is not a ceiling. Backup failure warns and blocks updates; critical capacity invokes protective read-only with Admin-confirmed healthy resumption. [Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md)
