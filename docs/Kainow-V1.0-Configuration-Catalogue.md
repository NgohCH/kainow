# Kainow V1.0 — Configuration Catalogue

**Version:** 1.0  
**Date:** 6 November 2026  
**Edition:** Product handover; accepted requirements consolidated, not evidence of implementation or delivery acceptance.  
**Scope:** Product only; development method and environment setup excluded.

## 1. Purpose and authority

This catalogue collects accepted V1.0 configuration in one place. **Default** means the accepted starting behaviour, not a hardcoded value that can never change. **Mandatory** means it cannot be disabled by configuration. **Not specified** means no numerical bound or selection has been approved; it is not unlimited and must not be silently invented.

**EA** = Enterprise Administrator. **Project delegate** = PM/Owner/Sponsor explicitly delegated by EA for that operational setting and within EA bounds. Project delegates cannot edit role-permission definitions, approval/security policy or their own delegation (Q01). Holding the project role alone is insufficient. **View owner** = user adjusting only their own permitted dashboard display. There is no general user-settings page; display preferences live directly in dashboards. EA has system settings; authorised project delegates have project settings.

Rows group related fields; the later technical configuration contract must enumerate exact keys, types, supported validation, inheritance and effective values. This catalogue is the product baseline, not an executable schema. Ordinary record values such as a task's due date follow record permissions and are not arbitrary policy settings.

## 2. Access, roles and lifecycle

| ID | Setting / accepted default | Authority and allowed variation | Constraints / decisions |
| --- | --- | --- | --- |
| C01 | Eligible organisation email domain(s): established at organisation setup | EA establishes verified organisation eligibility and decides exceptions | Same organisation only; no automatic admission by domain. Exact domain list supplied at setup. |
| C02 | Ordinary membership expiry: none | EA policy; project default/expiry within delegation; extensions by role manager | Start date required, not before project creation; end if supplied cannot precede start. No mandatory six-month term; D26/D28. |
| C03 | Audit/Oversight: 30-day default, 90-day maximum per grant/extension | EA may configure duration/maximum; grant managers act within it | Always scoped/time-limited, no automatic renewal or self-approval; D69/O04. |
| C04 | Leadership scope: explicit start, optional expiry | EA designates scope | Summary only, never automatic discussion access; D48. |
| C05 | Invitations: seven elapsed days | EA security policy | Fresh resend invalidates older link. Exact numeric alternative bounds not settled; remains seven until configured contract approved. |
| C06 | Role combinations: fewer than seven active distinct participants may combine PM/Owner/Sponsor | EA supported policy; not a delegated role-policy editor | Default threshold seven; required PM/Member different; exactly one PM, max one Owner, no agreed Deputy/Sponsor cap. No silent invalidation of prior approvals. |
| C07 | Role appointment/extension authorities | EA supported policy with mandatory accountability | Default authorities in Permission Matrix. No implicit project-wide override or self-grant. |
| C08 | Supported project transition roles and required transition fields | EA policy; delegated operational choices only | Default transitions in lifecycle document. Fixed lifecycle meanings; no arbitrary workflow builder. |
| C09 | Stage/substage catalogue | EA base; project delegate may add/retire supported entries | Initiation, Planning, Execution, Review & Acceptance, Closure; optional defined substages. History/duration preserved; not compulsory sequential gates. |
| C10 | Closure outcomes | EA/project delegated controlled choices with fixed meanings | Delivered, Partially Delivered, Abandoned defaults; Deferred is project status, not Delivered. Outcome/acceptance cannot hide unfinished work. |
| C11 | Passwordless code: 10 minutes, five incorrect attempts | EA security policy | Single-use; resend invalidates old; no password mode. Other numeric bounds require explicit security contract; D66. |
| C12 | Session: 30-minute idle, 12-hour maximum | EA security policy | Warning/recoverable draft; current/all-session sign-out; no auto-submit; D67. |
| C13 | Recovery custodian/address and designated Administrators | EA / controlled organisation setup | Named accounts; first-admin invitation closes; verify recovery before go-live; O07. |
| C14 | Archive: 12 months after Closed; only Closed projects | EA timing; PM/O/S may archive earlier or unarchive | Unarchive remains Closed/read-only; restore administrative exception does not reactivate work; O02/Q04. |

## 3. Approvals, source access and data fields

| ID | Setting / accepted default | Authority and allowed variation | Constraints / decisions |
| --- | --- | --- | --- |
| C15 | Approval: one eligible Owner/Sponsor | EA policy | Multiple approvals count distinct people, any order, exact same version; rejection ends review; D11–D13. |
| C16 | Self-approval: allowed for eligible O/S | EA may configure stricter policy | Valid small-team combined role allowed; no self-approval for Audit/Oversight/security grants. |
| C17 | Submit/review/reject/withdraw/amendment policy | EA supported role-policy choices | Default matrix; substantive commitment/assignee/date changes require authorisation. AI never a human approver. |
| C18 | Apply policy changes to pending proposals: retain prior policy | EA or authorised policy manager; explicit migration decision | Impact preview, review restart when migrated; preserve prior versions and approvals. |
| C19 | Minutes audience: Project-wide active participants | EA bounds; PM/O/S manages project/source audience | Restricted default audience PM/DPM/O/S; source-level designation before confirmation; O09. |
| C20 | Restricted sources and separately published summary audience | Authorised source manager/reviewer within EA policy | Explicit review for wider summary, original remains restricted; derived/stored answer access rechecked. |
| C21 | Export enablement and scope | EA; delegated project controls | Current read AND enabled export policy; restricted read alone insufficient for bulk export; O14. |
| C22 | Record categories, labels, optional catalogue fields | EA catalogues; project delegate can add/retire permitted values | Controlled selections, stable historical meaning, no unrestricted custom-field builder; D54/D63. |
| C23 | Required/optional predefined fields | EA/delegated project data policy | Mandatory identity, attribution, evidence, human approval and actionable task assignee/due date cannot be hidden. New required fields prospective by default; D62. |
| C24 | Risk severity definitions | EA; permitted project refinements | Low/Medium/High/Critical defaults with comparable meanings. Mandatory reason and review/accountability for continuing acceptance; O11 closure exception. |
| C25 | Task transition information | EA/delegated supported workflow | Completion note, blocking/resolution/reopening/override reasons by default. Maximum two subtask levels below top level; cannot configure deeper arbitrary nesting. |
| C26 | Questions/decisions/risks transition permissions and information | EA policy; explicitly delegated operational data choices only | Fixed supported states, no automatic question resolution or risk acceptance; exact defaults in matrix. |

## 4. Notifications and communication

| ID | Setting / accepted default | Authority and allowed variation | Constraints / decisions |
| --- | --- | --- | --- |
| C27 | Task reminders: seven days and one day before due | EA / project delegate | Date-only default 09:00 UTC+8 on reminder date; specific time uses interval before deadline. Do not send already-past pre-reminders on initial authorisation. |
| C28 | Overdue escalation: three days, once per episode | EA/project delegate supported timing/routing/repetition | Member/DPM→PM; PM→O/S; O/S→other accountable role; no self-only or invented recipient. New due date new schedule; D64. |
| C29 | Parent-deadline escalation: immediate when unfinished child passes parent deadline | EA/project delegate supported routing | Independent trigger/history, consolidate overlapping delivery; no silent child date change. |
| C30 | Day counting: Working Days; initially Monday–Friday | EA bounds/project delegate chooses Working or Calendar, weekdays and holidays | Q02: preceding-working-day reminders; no early escalation; deadlines unchanged; elapsed-time exclusions remain. |
| C31 | Date-only task cutoff: 23:59:59 UTC+8 | EA organisation policy, explicitly delegated options | Keep within stated date; dates never silently shift. UTC+8 fixed V1.0. |
| C32 | Risk review: 09:00 due-date notice, or preceding working day for a non-working review date; actual-date overdue retained | EA/project delegate supported notification choices | Responsible person + PM; PM if unassigned. Does not automatically change risk state. |
| C33 | Deferred/Closed: pause ordinary task/risk notices and digests | EA/project supported pause policy within lifecycle restrictions | Security/access/expiry/failure notices continue; no access extensions. Resume consolidated summary, new authorised outstanding dates; D21–D24/O10. |
| C34 | Channels: in-app and email | EA channel policy; delegated project options | Permission/minimum disclosure at delivery/retry; no personal opt-out overriding required policy. |
| C35 | Manual action-item email: PM/O/S | EA/project enablement and approved recipients | Current access, authorised content only. Email delivered does not mean read/accepted. |
| C36 | Scheduled digest: explicitly enabled daily or weekly at selected UTC+8 time | EA/project delegate | No unapproved default send time; paused Deferred/Closed, current eligibility on send. |
| C37 | Temporary email retries: initial plus 3 at 5m, 30m, 2h from initial failure | EA approved bounded delivery policy | No duplicate confirmed deliveries; cancel obsolete notices, permanent failure requires correction; O04/O12. |

## 5. AI and service connections

| ID | Setting / accepted default | Authority and allowed variation | Constraints / decisions |
| --- | --- | --- | --- |
| C38 | Launch AI catalogue: OpenAI and Anthropic API | EA approves supported providers/models/data destinations | No browser automation/subscription credential substitute in the product; no arbitrary endpoint/plugin loading. Exact tested models selected in integration contract. |
| C39 | Project AI connection, project key, primary/fallback order | EA; explicitly delegated PM/O/S | Separate project keys; protected write/replace/revoke controls; no secret read/export or cross-project borrowing. |
| C40 | Auto analysis: on with EA-approved project setup | EA; project delegate may disable/adjust permitted options | Requires valid credentials and positive applicable allowance; enabled may show Blocked if no allowance; D19. |
| C41 | Discussion analysis: 300-second quiet period, max 2 per thread per rolling 20m | EA/project delegate supported batching/frequency | Latest unprocessed content together; visible effective limits and Waiting/Queued/Running/Paused/Blocked/next eligible time; O04. |
| C42 | Published minutes: analyse after successful publication | EA/project delegate enabled configuration | Approved source audience, applicable frequency/spend limits; no automatic authorisation. |
| C43 | Explicit AI request | Permitted user, within project configuration | Same access/caps; does not bypass permissions or spend due to manual request. |
| C44 | AI attempts: 3 total including initial and fallback; timeout 120s/attempt | EA/project delegate bounded choices | No retry of denied permission, invalid credentials or exhausted allowance. Timeout is not proof of provider cancellation. |
| C45 | Daily/monthly org/project AI caps; optional per-user caps | EA and explicitly delegated project limit managers | UTC+8 boundaries, most restrictive remaining applies. Blank/zero=zero allowance; no arbitrary dollar defaults. Optional user cap absence is not a blank required cap. |
| C46 | Usage/cost accounting | EA approved pricing/usage contract | Reserve before concurrent requests; retain uncertain reservations; distinguish estimate/confirmed amounts and user/event attribution. No editable option disables enforcement/history. |
| C47 | Feedback: Open/Reviewed/Closed | PM/DPM review, EA configuration/provider escalation | No automatic training, prompt-policy edit, or approval from feedback. |
| C48 | Email provider configurable; Microsoft 365 initially supported. SharePoint/OneDrive initial storage options | EA supported connections/destinations; project approved selection | Dropbox/Box/other storage later through verified supported connectors; no implied launch support. Approved sender, least required operations/destinations; Q06. |
| C49 | Inputs: paste/TXT/Markdown/DOCX/selectable-text PDF | Project delegate adds/removes from EA-approved supported catalogue | Removes new imports only, retains existing evidence. No OCR. Unsupported parser is new technical extension, not arbitrary configuration. |
| C50 | Outputs: Markdown/DOCX/PDF, CSV for tabular reports | Project delegate adds/removes from EA-approved supported catalogue | No automatic conversion of old files; permissions at generation/export. |

## 6. Finance, outputs and views

| ID | Setting / accepted default | Authority and allowed variation | Constraints / decisions |
| --- | --- | --- | --- |
| C51 | Financial Tracking: Not Required | EA/project delegate | Enabling needs reporting currency; disabling retains data/history; AI caps unaffected. |
| C52 | Reporting currency: MYR organisation default; initially MYR, SGD, USD; one selected per financially tracked project | EA supported currency catalogue; project delegate | Standard currency precision; Q06 establishes current default. Foreign reference excluded unless approved manual rate/date conversion; no automatic FX. |
| C53 | Budget warnings: 80% and 100% | EA/project delegate | Advisory; not payment authority. Missing not zero; not accounting balance. Alternative numerical bounds need contract. |
| C54 | Financial-detail audience: PM/DPM/O/S | EA/project explicit policy | Others explicitly granted, leadership permitted summaries only. |
| C55 | Resource units initially hours, days, person-hours, person-days, items, seats, square metres | EA or explicit catalogue delegate | Period separate, no assumed unit conversions; usage only, retired entries historical; Q06. |
| C56 | External filing: Owning Department > Project > Year > Report Type | EA destinations, PM/DPM authorised filing | UTC+8 issue year, one primary type/copy. Existing approved location may be retained and labelled; no external delete from Kainow logical deletion. |
| C57 | External verification | EA/project supported policy | Check at opening/filing, optional scheduled checks; Changed/Missing/Access Denied/Unverified + last checked; no automatic approval of edit. |
| C58 | Dashboard expansion: >5 projects collapsed, up to5 expanded | View owner remembers choices, expand/collapse all | Summary visible, keyboard operable; saved choice overrides new-view default. |
| C59 | Dashboard personalisation: limited colour, arrangement, filters and approved fields | View owner directly in view | Accessible presets/design choices still to specify; cannot change rights, metric meaning or add unapproved information. |
| C60 | Leadership fields | EA approved catalogue; leader add/hide/rearrange own permitted fields | Default name/scope/PM/departments, status/stage/duration, task progress, timeline/review, blockers/risks and permitted resource/finance summaries. |
| C61 | Refresh and stale indication | System design; permitted view filter choices | Show last refresh/staleness and partial metrics. Exact polling/stale threshold not accepted; record in technical design. |

## 7. Mandatory behaviour that is not an off-switch

Human authorisation; exact source and named attribution; record/organisation scope; historical versions; account/membership/grant checks; no invented owners/dates; permission-aware retrieval and stored results; logical deletion and security quarantine; project-specific credential boundaries; spend reservations and no blank-unlimited cap; access checks on emails/exports; and prohibition of arbitrary executable content remain enforced. An optional field or feature setting cannot disable these.

## 8. Changing configuration after go-live

Store actor, reason, old/new value, effective time and policy version. Show effective inherited/overridden settings and delegation boundary. Preview affected records/notifications. Previously authorised commitments retain their approval basis; a setting edit is not a due-date amendment, reassignment, new access grant or automatic reprocessing. Pending proposals retain their old policy unless explicitly migrated with review restart. New required fields apply prospectively unless an authorised impact-reviewed migration is approved.

Changes to weekday/holiday calendars recalculate future notifications without changing task deadlines; delivery history remains. Removing formats/connections does not erase previous evidence or bypass uncertain charges. Denied or invalid settings must fail clearly. Exact numerical bounds not recorded here need a design/Owner decision before the affected editor is enabled; use the accepted default meanwhile, not invented limits.

## 9. Accepted clarification of policy, calendars and launch choices

### Q01 — Configuration authority and delegation (Accepted)

Mandatory protections cannot be disabled: human authorisation, evidence/history, access checks, project credential separation and spending enforcement. Enterprise Administrators control supported role-permission definitions, approval rules, security settings, organisation limits and delegation. PM/Owner/Sponsor may adjust explicitly delegated operational settings: reminders, calendars, categories, stages, permitted minutes audiences, optional finance, approved connections/formats and project AI allowances within organisation bounds. Project delegates cannot edit role-permission definitions or expand their own delegation. Role appointments still follow the existing role-management matrix.

Show each setting's effective value, inheritance and editing authority. Record actor, reason, previous/new values and effective time. Preview impact on access, pending approvals and existing projects. Never silently rewrite existing commitments or approvals. Exact keys, types and any unagreed numerical bounds remain bounded design work; this decision does not invent new ranges.

### Q02 — Working-day default and notification recovery (Accepted)

Working Days is the default, initially Monday–Friday, with configurable weekdays and holidays. Calendar Days remains selectable. This explicitly replaces the earlier Calendar Days default. Keep an authorised deadline on a non-working day unchanged and show a warning when it is selected. Count reminder intervals using the selected project calendar.

In Working Days mode, a reminder landing on a non-working day is sent on the preceding working day, normally at 09:00 UTC+8. Never escalate early: after the configured overdue interval has passed, deliver at the next eligible notification time. A risk-review date on a non-working day receives its advance notice on the preceding working day; retain its actual review date and overdue calculation.

After system unavailability, send one consolidated still-relevant notification per recipient; skip obsolete reminders and avoid duplicate deliveries. Calendar changes preview/recalculate future notifications, preserving deadlines and delivery history. Invitation validity, membership/grant expiry, security timeouts and retry intervals remain elapsed-time based. Urgent security notices do not wait for working days.

### Q06 — Launch catalogues and configurable services (Accepted)

MYR is the organisation's initial financial currency default; initially support MYR, SGD and USD. A financially tracked project selects one reporting currency. Other supported currencies may be enabled later. No automatic conversion. Resource units initially include hours, days, person-hours, person-days, items, seats and square metres; record usage period separately and do not assume conversions such as one day equalling eight hours.

OpenAI and Anthropic APIs remain AI launch options. Administrators enable tested models and nominate project primary/fallback choices. Model identifiers are configurable rather than frozen product requirements. No calls until project credentials, model selection and positive applicable spending allowances exist.

Email provider is configurable through supported Administrator-approved connections; Microsoft 365 is the initial supported option, not a mandatory sole provider. Use an approved organisational sender and retain the person/project event initiating each message. SharePoint document libraries and OneDrive are the initial storage options; SharePoint is the suggested default destination type, with each project selecting an approved destination. Dropbox, Box and other cloud storage providers may be added later as configurable options once supported connectors are implemented, verified and approved. Their future inclusion is not a claim of V1.0 launch implementation.

Connections receive only needed destinations/operations. Register requested permissions for Administrator approval; do not assume organisation-wide mailbox/file access. Removing a catalogue entry prevents new selection but preserves historical records; removing a connection stops new operations without erasing prior evidence.

### C62 — Quarantined-original security grants

Default 24 hours, extension by fresh approval from a different Enterprise Administrator; purpose, specific records, requester, approver and expiry required. Explicit confirmation and inspection log. No export, email inclusion or AI processing; no independent approver means blocked. Ordinary Audit/Oversight duration does not apply. Q03 is accepted; exact implementation keys are not permission to relax these protections.

## 10. Accepted runtime and analytics configuration A01–A12

| ID | Setting / accepted default | Authority / boundary |
| --- | --- | --- |
| C63 | AI concurrency: two requests per installation | Enterprise Administrator; global across workers/projects. Additional requests queued; exact non-default bounds in technical contract. |
| C64 | Administrator analytics views/reports/drill-down | EA manages supported metrics/configuration; permitted users' saved display choices never expand rights. Organisation/department/project summaries, named-person detail only with relevant permission. |
| C65 | Update checking and installation schedule | EA; checking/notification automatic, every release installation explicitly approved. Scheduled approval is release-specific. |
| C66 | Backup schedule/retention: daily encrypted, 30-day default | EA; separate approved location, pre-update backup and restore tests. 24-hour data-loss/four-hour restoration targets. Backup rotation is not live-history purge. |
| C67 | Runtime versions and deployment configuration | Supported pinned Node.js/NestJS/React/PostgreSQL/pg-boss/Compose baseline. No arbitrary provider/runtime selection claimed. Exact images/CPU/host matrix and dependency versions still verified in design. |

See [architecture](Kainow-V1.0-Application-Architecture-and-Operations-Design.md) and [analytics](Kainow-V1.0-Administrator-Analytics-and-Reporting-Rules.md). No new default analytics reporting period, telemetry purge interval, polling threshold or unlimited queue size is invented.

## 11. Accepted source, storage and recovery configuration

| ID | Setting | Authority/boundary |
| --- | --- | --- |
| C68 | Managed source provider/root and designated direct-storage Administrators | Explicit authorised designation; ordinary EA status insufficient. Kainow front end for users, authorised service connection for integration. |
| C69 | Credential encryption/key recovery | Protected authorised settings; separate recovery material; no saved-secret reveal. Exact security contract still required. |
| C70 | Routine diagnostics: 30 days by default | EA-configurable; evidence/security/history/defined analytics retained separately; authorised investigation preservation. |
| C71 | Provisional application SSD 20 GB minimum/50 GB recommended | Excludes host OS/base VM; expected 30 GB not a ceiling. Actual minimum/update headroom must be verified. |
| C72 | Managed source quota 25 GB minimum/100 GB recommended | Initial provisioning estimate; expand with versions/history; backup capacity calculated separately. |
| C73 | Storage alerts 80% warning/90% critical | Administrator-configurable. Protective read-only uses a separately tested safe threshold. |
| C74 | Backup-failure and capacity-protection rules | A18/A19: alerts, persistent warnings, fresh-backup update block; protective mode resumes only after capacity/health restoration and Admin confirmation. |

[Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md)
