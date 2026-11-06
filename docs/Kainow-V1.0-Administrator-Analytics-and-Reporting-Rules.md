# Kainow V1.0 — Administrator Analytics and Reporting Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted direction and requirements; detailed contracts/verification outstanding.  
**Scope:** Product runtime and design only; development agents and workstation setup excluded.

## 1. Accepted intent

Enterprise Administrators need an organisation-wide view of Kainow activity and operational health. V1.0 must capture every defined business/operational event and measurement needed for analytics and reporting. The Administrator dashboard is configurable and supports drill-down. This extends the existing personal/project and leadership dashboards; it does not replace their audiences or rights.

“All datapoints” means a complete, defined event/measurement catalogue for the supported product. It is not unrestricted copying of all source bodies, credentials or quarantined originals into telemetry. The catalogue and completeness checks must be explicit so omissions are detectable.

## 2. Coverage catalogue

| Area | Events/measurements to define and capture |
| --- | --- |
| Projects/departments | Creation, owning/contributing attribution, lifecycle/stage/substage changes, stage duration, deferral/reopening, closure outcomes and archive/restoration. |
| Identity/membership/access | Invitations and outcomes, membership/role transfer/expiry/hold/restoration, eligible grant lifecycle and relevant access/security events. Sensitive investigation findings are separate restricted records. |
| Discussion/sources/proposals | Permitted activity volumes, source publication/version/deletion changes, extraction outcomes, proposal revisions, approval/rejection/withdrawal and reason classifications without copying restricted text. |
| Tasks/questions/decisions/risks | Authorisation, status transitions, assignment/due-date amendments, completion/overdue/blocking, question resolution, decision changes and risk mitigation/review/acceptance. |
| Resources/finance | Usage entries, supported units/periods and optional budget/expenditure/corrections with permission-aware summaries. Currency groups and incomplete data remain visible. |
| AI | Project/provider/model, person or event attribution, attempts/fallback/outcomes, queued/running timing, tokens where available, estimates/reservations/confirmed costs and cap use. |
| Jobs/communications/external files | Queue delays, retries/failures/uncertain outcomes, email delivery and relevant source/destination operations/version checks. Service acceptance is not proof of reading or external approval. |
| Operations | Health status/errors, approved update attempts/outcomes, backups and restore-test outcomes. A log message alone is not proof of a recoverable backup. |

This specifies coverage areas; exact event names, payload fields and supported metric formulas still require the R02/R17 technical catalogue. A failure/reason classification must not expose a confidential free-text explanation as an analytics dimension.

## 3. Event and metric contract requirements

Each applicable event needs stable identity, event type/schema version, time, organisation/project association, named actor or service/AI event attribution, relevant record/version reference, outcome and defined measurements. Use correlation identifiers to associate related operations and avoid double-counting retries. Present dates/times using UTC+8.

Link analytics to authoritative business/history records. Preserve immutable source events/history and version metric definitions. Exact storage/index/aggregation mechanism is left to design; no separate analytics database is mandated. Analytics must not change transaction correctness or expose a partially approved operation as completed.

Distinguish confirmed, estimated, unknown, missing and not applicable values. Unknown spend is not zero. Ratios need named numerator/denominator, measurement period and coverage. Task completion keeps the accepted eligible-leaf formula and is distinct from successful project delivery. Do not mix currency groups or silently include AI spend in ordinary project expenditure.

## 4. Views, configuration and drill-down

Default reporting levels are organisation, department and project. Named-person detail is available only through the applicable permissions. Supported drill-down continues from a metric to its permitted underlying record/history/usage detail; a record/source link never grants access.

Provide configurable supported filters, time periods, grouping, displayed measures, chart/table choices and column/layout choices. Administrators manage system-wide event/metric/report definitions and permitted configuration. A view's saved display choices cannot expand the user's access. Configuration of new arbitrary executable formulas, workflow code or plugin loading is outside V1.0.

Use helpful bars, pie/donut charts where a meaningful whole is represented, trend views or supported flow/timeline graphics with equivalent text/numbers/table values. Show last refresh, measurement interval, metric meaning, stale/partial data and unavailable detail. Exact palettes, default period, refresh thresholds and component layouts remain design choices to specify, not silently approved values.

## 5. Permissions and disclosure

Enterprise Administrator analytics access includes permitted organisation-level operational and business aggregates. Department/project drill-down remains summary-oriented unless the actor also has the underlying record/source/financial/usage permission. Named-person usage/activity detail follows its relevant permission; ordinary administrative standing does not confer investigation or source-body access.

Recheck permissions at every drill-down and export, including cached results, record history, snippets and source links. Summary access does not make restricted minutes readable. Counts/labels must not indirectly disclose restricted detail; metrics limited to visible records are labelled partial, and any whole-project aggregate is a separately authorised summary scope. Financial detail remains under its explicit policy, leadership remains summary-only and independent Audit/Oversight/security grants retain their accepted boundaries.

Credential values, quarantined originals and restricted source bodies are excluded from ordinary analytics payloads, diagnostics and exports. Only explicitly permitted sanitised classifications/measurements and references may be used. Changes of source audience, deletion/quarantine and loss of access must propagate to derived views under O09. No new permanent-deletion or audit-bypass route is introduced.

## 6. Reports and export

Provide permitted report exports using the accepted project/system supported formats: CSV for tabular data and supported document formats where applicable. Export requires both current read access and enabled export policy. Revalidate current permissions when background generation executes and when results are retrieved; an export job cannot preserve expired access.

Reports identify filters, period, metric definitions, generation/refresh time, currency grouping, coverage and material uncertainty. Record the requesting actor/event. Registration or filing of an approved output still follows the existing external-output version/approval process; a dashboard export does not authorise project commitments or email distribution.

## 7. Configuration limits and event retention

Configurability covers supported views/filters/reports and governed metric definitions. It cannot switch off mandatory business history, approval evidence, access/security recording or spend enforcement. Minimise stored event payloads and reference protected content rather than copying it.

A16 now accepts 30-day default configurable retention for routine technical diagnostics. The design must distinguish those diagnostics from indefinitely retained business/history/security and defined analytics evidence. No new shorter retention for accountable evidence is approved. Existing logical-deletion/quarantine rules and backup-copy rotation remain unchanged.

## 8. Acceptance requirements

- A versioned event catalogue maps every supported business/operational action to its required event, outcome and measurements; test missing events and duplicate retries.
- Known fixtures reconcile project/department/organisation totals without duplicate participating-department counts or double-counting parent tasks and attempts.
- Verify supported filters/configuration, chart/table equivalence, scope-sensitive drill-down and permitted report exports.
- Negative tests cover insufficient/expired grants, restricted minutes, source changes/deletion/quarantine, finance detail, named-person detail and background exports after access changes.
- Show pending/unknown/estimated/stale/partial values correctly; never convert unavailable cost or data to zero/success.
- Evaluate dashboard/report load within the accepted 200-user/10-concurrent baseline and ensure analytics does not bypass global AI/cost/job controls.

These are requirements, not tests executed in this documentation work. See the [Permission Matrix](Kainow-V1.0-Permission-Matrix.md), [Configuration Catalogue](Kainow-V1.0-Configuration-Catalogue.md) and [Architecture Design](Kainow-V1.0-Application-Architecture-and-Operations-Design.md).

## 9. Accepted diagnostics and storage-health reporting

A16 now sets routine diagnostics to 30-day configurable retention. Business/security/history and defined analytics events remain indefinitely retained under their existing protections. This resolves the earlier unspecified diagnostic period, not a purge of accountable events. Administrator reporting includes storage usage/growth, configurable 80%/90% alerts, backup last-success/failure and recovery-target breach, protective-mode status and explicit restoration/resumption outcome. Unknown provider quota stays unavailable. [Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md)
