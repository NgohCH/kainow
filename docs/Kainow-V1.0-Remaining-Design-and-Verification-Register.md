# Kainow V1.0 — Remaining Design and Verification Register

**Version:** 1.0  
**Date:** 6 November 2026  
**Edition:** Product handover; accepted requirements consolidated, not evidence of implementation or delivery acceptance.  
**Scope:** Product only; development method and environment setup excluded.

## 1. What remains and what does not

The V1.0 product scope and accepted decisions D01–D70/O01–O17 are recorded. This register makes the remaining design, organisational setup and verification work explicit. It is not an environment plan, coding packet queue or authority to introduce new features.

“Accepted requirement” is different from “designed”, “implemented” and “verified”. No implementation, security, usability, performance, licensing-file or deployment checks were executed for this handover. A complete handover gives the developer the requirements and exposes the work still needed; it cannot substitute for these checks.

**Types:** Design = developer proposes a concrete solution consistent with scope; Setup = organisation provides actual values/people; Clarification = accepted documents do not settle a material edge case; Verification = evidence required against the resulting product. Do not label a newly invented product policy as a technical detail.

## 2. Design and setup register

| ID | Type / work | Required output and boundary | Must precede |
| --- | --- | --- | --- |
| R01 | Design: application architecture and persistence | Architecture, conceptual-to-physical record mapping, tenancy boundaries, transaction/error contracts. A01–A11 now select modular TypeScript/NestJS/React, PostgreSQL, pg-boss and container/Compose direction. Exact schemas, transactions and runtime versions remain open design work. | Dependent implementation. |
| R02 | Design: exact data contracts | Field types, stable identifiers, required/null rules, source-version offsets/encoding conventions, repeated-quote disambiguation, import normalisation/provenance. Include every minimum field in O06. | Parser/proposal/history integrations. |
| R03 | Design: enforceable permissions | Action IDs/predicates for the matrix, current role/grant/date/audience checks, query/AI/exports/notifications/history paths, default deny and separation. Supported configurable role changes must remain bounded. | Protected feature implementation. |
| R04 | Design: proposal/authorised-state transactions | Version binding, concurrent edits, duplicate approval prevention, multi-person approval/rejection, amendment rules, stale-source handling and partial batch outcomes. | Authorisation and record creation. |
| R05 | Design: account and passwordless sessions | Code generation/storage/rate abuse protection, invitations, disabled-account holds, token/session revocation and recovery audit. Preserve accepted 10m/5 attempts/30m/12h defaults. | Account access implementation. |
| R06 | Setup + design: administrator recovery | Named custodian/address, eligible domain list, active Administrators and controlled no-admin recovery steps. Prevent public promotion and automatic project-access restoration. | First production admission / go-live. |
| R07 | Design: history and source retention | Immutable version linkage, logical-deletion filtering, queued analysis cancellation, permission-aware historical views, archiving and restore. No purge feature introduced. | Storage/history lifecycle. |
| R08 | Design/security: quarantine and grant contract | Detection best-effort, pre-publish holds, encrypted original isolation, sanitised versions, affected-copy/derived-output handling, named grant approval/revocation and credential-rotation notification. | Security-sensitive source processing. |
| R09 | Design + setup: provider data handling | Tested OpenAI/Anthropic models/API compatibility, permitted data categories/destinations, retention/processing configuration, authentication and project credentials, errors/retry/fallback map. No assumption of provider-side cancellation or deletion. | Real AI processing. |
| R10 | Design: spend enforcement and reconciliation | Per-project keys, conservative concurrent reservations, approved pricing/currency units, daily/monthly boundaries, optional user limit participation, delayed/unknown charges and reconciliation without zeroing uncertainty. | Chargeable requests. |
| R11 | Design: configurable policy schema | Exact keys/types/bounds, inheritance/delegation, effective policy, allowed permission changes, validation, preview and migration. Catalogue defaults remain until approved changes. | Configuration editors and migrations. |
| R12 | Design: analysis scheduling | Quiet-period batching, rolling rate window, edited/deleted versions, deduplication, retry total/timeout, current permissions and on-screen Waiting/Queued/Running/Paused/Blocked. | Automatic analysis. |
| R13 | Design: reminders and escalation scheduling | UTC+8 date/time, calendar/working modes, episode IDs, consolidated overlapping triggers, deferral/reopening deadline gates and bounded relevant email retry. | Notifications/digests. |
| R14 | Setup + design: supported calendar/category catalogues | Actual working weekdays/holidays where chosen, department/resource/unit/currency/format/stage/report categories. Retire values and preserve historical meaning; no free-form field builder. | Affected project configuration. |
| R15 | Design: managed external outputs | Configurable email-provider and SharePoint/OneDrive launch connector auth/scopes; future Dropbox/Box/other supported storage extensions, stable external file/version IDs, placement, access/changed/missing status, upload/move conflict/failure recovery and no implicit external deletion. | External writing or distribution. |
| R16 | Design: optional finance | Reporting currency/precision, entries/corrections/manual approved FX, budget warnings and incomplete totals; separate AI spend. No banking/accounting/booking scope. | Financial tracking. |
| R17 | Design: metrics and dashboards | A12 configurable Administrator event analytics/reporting and permission-sensitive drill-down; exact catalogue/retention/metrics plus leaf-task denominator, partial permission disclosure, stage durations, current/archived project counts, stale indication, leadership field catalogue and direct-view saved preferences. | Dashboard calculations. |
| R18 | Design: UI and navigation | Reviewed responsive layouts, accessible supported colour/layout options, visual hierarchy, proposal/source review, mobile context, graphics plus equivalent table/values. No final palette/layout imposed by these requirements. | UI implementation acceptance. |
| R19 | Design: assessment instruments | Versioned representative notes/expected-item reference set, human adjudication, quality scoring, timing setup, participant tasks, browser/accessibility matrix. Use O16 thresholds and timing bands. | Evidence-based product acceptance. |
| R20 | Verification: repository notices | Confirm actual AGPL-3.0-only file, ownership and applicable dependency notices against selected code/components. This documentation does not assert repository files were changed. | Distribution/go-live review. |

## 3. Handover clarification decisions — accepted

The six product clarifications have been discussed and accepted. The table records their current disposition; details are in the consolidated specification, section18. Q02 replaces the older Calendar Days default with Working Days. These are approved product rules, not proof of implementation.

| ID | Accepted outcome | Remaining dependent work |
| --- | --- | --- |
| Q01 | EA controls policy/security/role definitions/delegation; project authorities adjust explicitly delegated operational settings only. | R03/R11 exact predicates, keys/types, validation and unagreed numerical bounds. Defaults apply until a supported non-default contract is approved. |
| Q02 | Working Days default, initially Mon–Fri; configurable holidays/weekdays. Prior-working-day reminders, no early escalation, relevant consolidated downtime recovery; deadlines unchanged. | R13 exact scheduler calculations/event keys and boundary tests; no new policy assumed. |
| Q03 | Investigation follows role authority; quarantined-original access requires another EA's separate grant,24-hour default, fresh extension, reveal confirmation/logging, no export/email/AI. | R05/R08 grant storage/enforcement, encryption and controlled recovery verification. |
| Q04 | Only Closed projects archived; PM/O/S may unarchive without reopening. Authorised restoration allowed as administrative exception while Deferred/Closed, audience preview, status/history preserved, no automatic processing. | R07 transaction/state enforcement and negative checks. |
| Q05 | PM/DPM prepares resume review while Deferred/Closed; O/S approves new non-past/different outstanding dates; existing lifecycle authority activates; unapproved work remains blocked. | R04 exact approval/activation transaction and partial-batch concurrency handling. |
| Q06 | MYR default, MYR/SGD/USD launch currencies; initial resource units; configurable tested AI models/email provider; SharePoint/OneDrive initially, Dropbox/Box/other supported cloud storage later. | R09/R14/R15 connector compatibility, exact supported model IDs, catalogues/authentication/scopes and evidence. |

No outstanding approval for these six product choices remains. Technical designs and tests are still required; do not treat all numeric limits or service implementations as settled. Any new material policy choice found during design must be recorded explicitly rather than invented.

## 4. Verification evidence required for delivery

| Area | Required evidence | Failure implication |
| --- | --- | --- |
| Core value loop | Real supported notes → source-backed proposals → exact-version human approval → visible owner/due date; humans understand action and source. | Passing a deterministic mock is insufficient. |
| Semantic extraction | At least12 representative inputs; short and 5,000–8,000 words, English/Bahasa Melayu/mixed, ambiguity/non-commitments; two agreed human references. At least95% generated proposals supported and90% expected items captured, by type/volume. | Affected capability remains unmet if threshold fails. |
| Mandatory integrity | Exact quote/version/location, no invented owners/dates, no automatic approval or unauthorised disclosure across accepted cases. | Demonstrated failure blocks affected capability. |
| Real human review/time | At least5 newcomers uncoached; member and management journeys; typical5–20/rare21–40 bands, 1m generation/2m review/<5m first loop, errors/help/limitations reported. | Do not hide misses in averages or call simulated review usability evidence. |
| Access/security | Each matrix action allowed/denied under account/membership/grant/date/project/audience changes; query and stored-answer, export/email/history/quarantine negative cases. | No blanket-admin or hidden-source bypass accepted. |
| Lifecycle | Vacancy, role separation, invitations/expiry/hold/readmission, parent override, new deadlines after pause, closure/handover and inactive archived views. | No silent restore of permission, old deadlines or commitments. |
| AI cost/service | Concurrent caps, blank-zero, delayed costs, error/fallback/timeout, invalid credentials, source changes and API service compatibility. | Unknown cost not zero; provider response not human approval. |
| External outputs/email | Supported formats, version changes/approval, failed writes, unchanged prior reference, no duplicate deliveries, current recipient access. | No successful-delivery or approved-file claim from an uncertain outcome. |
| Presentation | Current/previous major Edge/Chrome/Firefox/Safari at release; responsive desktop/tablet/mobile; manual keyboard, zoom, screen-reader and accessible charts plus automated checks. | Record actual browser versions, failures and applicable limitation. |
| Handover/acceptance | Requirements traceability, test evidence, known limitations and recorded Product Owner delivery assessment. | Requirements agreement or document completeness is not product acceptance. |

## 5. Handover status

No product implementation repository was inspected in this work. Historical runner/broker/observer tests are outside this handover and do not verify these product requirements. Detailed designs, technical baseline and actual acceptance evidence must be prepared against this current package. Unassessed remains Not Assessed; do not change it to Passed because a document exists.

## 6. Accepted architecture direction A01–A12 and remaining verification

[Architecture design](Kainow-V1.0-Application-Architecture-and-Operations-Design.md) records the accepted choices; [Administrator analytics](Kainow-V1.0-Administrator-Analytics-and-Reporting-Rules.md) records the accepted new dashboard requirement. R01 is partially settled, not implementation-ready or verified. R02–R20 remain dependent technical/setup/verification work as applicable.

Additional concrete designs still required: exact version/host/CPU matrix; protected source/file storage; action/event schemas and analytics metric definitions; transaction/RLS policies; global AI queue ownership and uncertain external outcomes; updater integrity/privilege/migration/maintenance/recovery contract; recoverable backup dataset/key recovery and actual restore tests; runtime/analytics retention distinction; workload and operational thresholds. No shorter retention for optional telemetry is approved merely by naming a dashboard. Any material new product choice needs explicit decision.

## 7. Accepted storage refinements and still-required contracts

A13–A19 select managed SharePoint/OneDrive source storage, designated direct access, credential/key recovery direction, diagnostic retention, provisional capacity and failure behaviour. Still required: exact provider ACL/version-retention and file/schema contract, designation authority, encryption/key management, backup method and complete restore procedure, safe low-space threshold, atomic fail/queue-resume behaviour and measured storage growth/load/recovery evidence. [Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md)
