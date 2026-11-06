# Kainow V1.0 — Core Records and Project Data Configuration Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules and project-level configuration direction  
**Scope:** Core information records, relationships, required information and permitted project-specific field configuration. No database, storage engine, programming language or development method is selected.

## 1. Purpose

Kainow must preserve a consistent chain from discussion to proposal, human authorisation and accountable project records. Individual projects also need flexibility over optional information, categories and field requirements.

This document defines the minimum information the product retains and how projects may configure permitted fields without removing core accountability protections. It is a conceptual product data specification, not a physical database schema.

## 2. Related documents

This document supplements the V1.0 Product Summary and the accepted documents covering:

- Role-management permissions.
- Project lifecycle.
- Proposals and configurable business rules.
- Task/subtask lifecycle.
- Invitation and membership lifecycle.
- Questions, decisions and risk lifecycle.
- Reminders, notifications and escalation.
- Discussion, evidence, access and history.
- AI configuration, data handling and usage.
- Dashboards, progress, timeline and settings.
- Shared resources and optional budget tracking.

Detailed lifecycle documents determine when information is required and who may supply or amend it. Optional fields must not be mistaken for unconditional requirements on every project or record.

## 3. Core information records

| Record | Essential information retained |
| --- | --- |
| Project | Name, organisation, creator, status, stage/substage where used, stage history, role assignments, Financial Tracking setting and applicable policy. |
| Person and membership | Person identifier, name, eligible email, organisation, project role, start/expiry dates where applicable and membership status. |
| Discussion source | Project, title/reference, supplied content, named submitter, submission time and source versions. |
| Proposal | Type, content, AI/human origin, source references where applicable, version, review status and authorisation history. |
| Task | Description, one assignee and due date for authorised actionable work, status, parent relationship where applicable, next review date where supplied and change history. |
| Question | Question, requester, answers with attribution, status and resolution/reopening history. |
| Decision | Authorised wording, supporting evidence where applicable, authorisation, status and links to superseded versions. |
| Risk | Description, status, severity where provided, optional Risk Responsible Person, mitigation links and review/acceptance history. |
| Resource usage / finance | Project/resource references and recorded usage or financial entries, according to the optional Financial Tracking setting. |
| Policy, access and usage history | Policy versions, permission grants, actions, actors, timestamps and project/user AI usage attribution. |

These are conceptual records. Grouping information in the table does not require storing it in a single technical record or table.

### Conditional information

- A project end date is optional.
- Membership expiry is configurable; Audit/Oversight appointments remain time-limited under the relevant policy.
- Financial information is optional when Financial Tracking is Not Required.
- AI task proposals may lack source-unstated owners/dates, but authorised actionable tasks require an assignee and due date.
- Human-originated proposals without a discussion source retain their explicit human-origin label; no source quote is fabricated.
- Risk acceptance requires its reason and next review date under the accepted default risk rules.

## 4. Identity and organisation/project scope

- Each record has a stable identifier and an organisation association.
- Project-scoped records identify their project.
- Links must not cross organisations.
- Names, emails or category labels are not substitutes for stable record identity.
- A person may participate in several projects without losing the continuity of their identity and historical contributions.
- Names and labels may change without breaking record references or earlier history.
- Deactivating a person does not erase their contributions, assignments or earlier approvals.
- Linking two records does not automatically grant access to either record.

V1.0 supports one organisation per installation; organisation association remains required rather than being omitted on that basis.

## 5. Evidence and relationship chain

Preserve structured links between:

1. The discussion source and exact source version.
2. The source-based proposal and its supporting quote.
3. The proposal version reviewed and its human authorisation.
4. The resulting authorised task, decision, question or risk.
5. Subsequent amendments, replacements, resolutions and lifecycle actions.

Additional relationships include parent/subtask links, risk-to-mitigation-task links, invitation-to-membership links, project resource usage and request-to-project/user AI usage attribution.

- Source edits do not silently alter earlier proposal evidence or authorised records.
- Repeated authorisation actions must not create duplicate authorised records.
- Superseded records and amendments remain linked to their predecessors.
- Protected credentials remain separate from ordinary project records and history.

## 6. Missing, Not Required and zero

These meanings are distinct:

| Value condition | Meaning |
| --- | --- |
| Missing / Not provided | Relevant information has not been supplied. |
| Not Required | An explicit permitted choice that the information or optional module is not needed. |
| Explicitly zero | A value of zero was supplied; it is not missing information. |

- Never silently convert missing figures to zero.
- Hiding a field does not mean its value is zero or that the information was declared Not Required.
- Financial Tracking set to Not Required is distinct from Enabled with missing budget figures.
- Do not apply Not Required to core information needed for authorisation, record identity or a mandatory lifecycle condition.

## 7. Time and historical meaning

- Store an unambiguous time for events.
- Display deadlines and relevant dates using UTC+8.
- Date-only task deadlines follow the separately accepted cutoff rule, 23:59:59 UTC+8 by default.
- Preserve history when a name, category, status label or policy changes.
- Category changes must preserve what historical entries originally meant.
- A changed current label must not make an earlier record appear to have been classified or authorised differently at the time.

The exact internal timestamp encoding and other technical representations are left to the technical data specification.

## 8. Project-specific data configuration

Each project can configure its record fields within organisation-approved boundaries.

| Project-configurable area | Permitted flexibility |
| --- | --- |
| Optional fields | Show or hide permitted optional information. |
| Additional project requirements | Require permitted fields for that project's records or lifecycle steps. |
| Categories and dropdowns | Select approved categories/values within delegated bounds. |
| Defaults | Set defaults for fields permitted by policy. |
| Optional modules | Enable or declare Not Required where the product supports it, such as Financial Tracking. |

### Mandatory information and protections

Configuration must retain:

- Stable identifiers and organisation/project associations.
- Source references for source-based proposals.
- AI/human attribution and named human actors.
- Authorisation, version and change history.
- Required lifecycle information, including one assignee and a due date for actionable tasks.
- Explicit access and evidence protections.

Hiding an optional field does not delete its stored values or earlier history. A visible required field also does not grant permission to read restricted underlying information.

## 9. Configuration authority and locations

- The Enterprise Administrator defines organisation-wide data configuration, permitted choices and delegation bounds through System Settings.
- Project Managers, Owners and Sponsors manage only explicitly delegated data settings for their own projects through Project Settings.
- The Administrator's delegation limits cannot be bypassed through project configuration.
- Individual users may personalise permitted dashboard presentation directly on the dashboard; there is no separate User Settings page.
- Personal presentation preferences do not change project-required fields, category policy or record validity.

## 10. Defaults, validation and policy changes

- Validate required fields at the appropriate lifecycle point.
- AI proposals must not be rejected merely because source-unstated owners or dates remain empty; those values are required before an actionable task is authorised.
- Defaults must not silently fill AI proposals with unsupported owners or dates.
- A user-supplied default is not evidence that a value appeared in the discussion.
- Changes to authorised commitments follow the amendment rules rather than ordinary field-default changes.
- Configuration changes record actor, reason, previous/new settings, effective date/time and policy version.
- State how new requirements affect existing records and pending proposals.
- Do not silently invalidate or rewrite existing records when a field becomes required.
- Any required migration or remediation of existing records needs an explicit decision and preserved history.

Configurable fields do not authorise arbitrary executable expressions, scripts, plugins or a general-purpose form/workflow builder in V1.0.

## 11. Security and sensitive information

- Every data view, field and linked record remains subject to the applicable access rules.
- Supporting excerpts and full discussions have distinct access conditions.
- Do not leak restricted values through categories, search, dashboards, notification previews or history.
- API credentials are protected separately and are not ordinary project fields.
- Project-specific AI credentials and project/user usage attribution follow the AI configuration document.

## 12. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 13. Accepted minimum catalogue and logical deletion

### Accepted O06 — Minimum product field catalogue

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

V1.0 has a defined supported optional-field catalogue and controlled categories, not arbitrary user-created fields. New required fields apply prospectively by default; impact-reviewed retrospective application is explicit. Logical deletion retains content/history, excludes it from future processing, and uses controlled inspection/restoration. Source audiences, holds and quarantine apply to derived records and views as specified. Technical representation is tracked in the design register.

## 14. Accepted analytics event references

A12 requires a complete defined business/operational event catalogue for Administrator analytics. Events associate stable ID/type/schema version, time, organisation/project, actor/event origin, related record/version, outcome and applicable measures. Exact types/names/transactions remain R02/R17 contracts. Avoid copied restricted bodies/secrets in events and keep source/record links permission-checked. [Analytics rules](Kainow-V1.0-Administrator-Analytics-and-Reporting-Rules.md).

## 15. Accepted physical source boundary

A13/A14 select managed SharePoint/OneDrive for imported file/text/version content, PostgreSQL for identities/permissions/version/quote associations, Kainow frontend for ordinary access and designated Administrators/service identity for direct access. Exact schema, version IDs, encoding/offset mapping and backup consistency still require design. [Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md)
