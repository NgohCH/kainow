# Kainow V1.0 — Shared Resources and Optional Budget Tracking Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules and configurable defaults  
**Scope:** Recording shared resource usage and optional project finances. Booking, allocation, purchasing, payments and development methods are excluded.

## 1. Purpose and product boundary

Kainow records project resource usage and, where needed, project financial information. It does not replace the systems or processes used to reserve resources, allocate capacity, purchase goods or make payments.

**A usage entry is not a confirmed booking or allocation.** Financial figures describe information recorded in Kainow, not a verified accounting ledger.

Financial tracking is optional. People, equipment and facility information remain independently available even when the project does not manage finances in Kainow.

## 2. Related documents

This document supplements:

- **Kainow-V1.0-Product-Summary.md**.
- **Kainow-V1.0-Role-Management-Permissions.md**.
- **Kainow-V1.0-Project-Lifecycle-Rules.md**.
- **Kainow-V1.0-Proposals-and-Configurable-Business-Rules.md**.
- **Kainow-V1.0-Discussion-Evidence-Access-and-History-Rules.md**.
- **Kainow-V1.0-AI-Configuration-Data-Handling-and-Usage-Rules.md**.
- **Kainow-V1.0-Dashboards-Progress-Timeline-and-Settings-Rules.md**.

## 3. Information recorded

| Area | Information |
| --- | --- |
| People | Project participation and task responsibilities; no inferred availability or capacity. |
| Equipment | Resource reference, category, project usage period, quantity and notes. |
| Facilities | Facility reference, project usage period and notes. |
| Finances, when enabled | Stated project budget, recorded expenditure and calculated balance, with currency identified. |

- Shared equipment and facilities use a common organisational reference so different projects can identify the same resource.
- Recording usage does not establish availability or confirm that an external reservation exists.
- Do not infer a person's free time, workload capacity or availability from membership and task assignments alone.
- AI must not invent resource quantities, dates, allocations or financial figures.

## 4. Optional financial tracking

Each project has a **Financial Tracking** setting.

| Setting | Behaviour |
| --- | --- |
| Not Required | Hide financial sections and exclude the project from budget-completeness warnings. |
| Enabled | Show budget, expenditure and balance information. Missing figures display Not provided. |

### Meaning of missing information

- **Not Required** is an explicit project choice that financial tracking is unnecessary.
- **Not provided** means financial tracking is enabled but the relevant information is missing.
- Neither condition means zero expenditure, a zero budget or a healthy financial position.
- Explicitly recorded zero values remain distinguishable from missing values.

### Setting authority

- Project Managers, Owners and Sponsors may manage this setting only within permissions delegated by the Enterprise Administrator.
- The Administrator controls organisation defaults and permitted delegation.
- Default Financial Tracking is Not Required; enabling requires project reporting currency and authorised configuration.
- Disabling financial tracking preserves earlier entries and their history.
- Hiding financial sections does not delete or rewrite financial records.

## 5. Default editing and approval permissions

| Action | Default authority |
| --- | --- |
| Maintain the project's resource-usage records | Project Manager, Deputy Project Manager, Project Owner or Project Sponsor. |
| Establish or change the stated project budget | Project Owner or Project Sponsor authorises the budget or amendment. |
| Record project expenditure | Project Manager or Deputy Project Manager. |
| Change whether financial tracking is required | Project Manager, Project Owner or Project Sponsor, within Administrator-delegated permissions. |

- Budget figures must be human-supplied or explicitly authorised; AI cannot invent them.
- Corrections preserve the original entry and history.
- Editing permissions do not imply access to restricted discussion content or credential secrets.
- Resource and budget changes are locked while the project is Deferred or Closed under the accepted default project lifecycle.

Administrator maintains the shared organisation resource catalogue and may delegate maintenance. Retired resources remain historical but prevent new selection.

## 6. Budget, expenditure and balance

- Identify the currency of each monetary entry.
- Do not add different currencies together or invent exchange rates.
- Show missing budget or expenditure information as Not provided, rather than assuming zero.
- Label any calculated balance **“Balance based on recorded expenditure”**.
- A calculated balance is not a verified accounting balance and may not represent spending recorded outside Kainow.
- Do not calculate a definitive balance when required inputs are missing or currencies are incompatible.
- Budget-overrun warnings are advisory. They do not authorise purchases, payments or additional commitments.
- Recording an expenditure is not proof that a payment has been made or approved outside Kainow.

No automatic bank, purchasing or accounting integration is included by these rules.

## 7. Shared resources across projects

- Use a common organisational resource reference for the same equipment or facility used by multiple projects.
- Each project's usage record retains its own association, period, quantity where applicable, notes and actor/history.
- Usage tracking does not reserve the resource, enforce an allocation or guarantee that other projects can use it at the same time.
- Cross-project views must respect project access permissions; a shared resource reference does not grant access to another project's details.
- Resource categories and units support consistent selection and future analysis.

Resource booking, allocation and conflict resolution continue outside Kainow in V1.0.

## 8. AI API spending is separate

- Track project AI API usage and spending regardless of the Financial Tracking setting.
- Organisation, project and applicable user AI spending caps remain enforced when financial tracking is Not Required.
- Display AI spending separately from manually recorded project expenditure by default.
- Do not automatically add AI spending into manual expenditure totals or balances.
- An explicit inclusion rule is required before combining them, with a method that prevents double-counting.
- Preserve the distinction between estimated and actual/reported AI cost.

The separate AI configuration document governs project-specific credentials, per-user attribution, fallback and operational caps.

## 9. Dashboards and presentation

- Show permitted resource-usage information in project and leadership summaries as appropriate.
- When financial tracking is Not Required, do not treat absent financial fields as missing project data or trigger budget-completeness warnings.
- When enabled, show missing financial figures as Not provided.
- Do not use colour or a healthy-status indicator to disguise missing information.
- Distinguish human-entered figures from calculated values and show relevant update information.
- Personal dashboard customisation does not change the project's Financial Tracking setting or underlying records.

## 10. Configuration and history

Supported configurable areas include:

- Financial Tracking setting and permitted defaults.
- Resource categories and units.
- Permitted editors.
- Budget approval requirements.
- Budget warning thresholds.

Configuration follows the accepted authority model:

- Enterprise Administrator manages organisation-wide rules and delegation limits.
- Project Managers, Owners and Sponsors manage only their own explicitly delegated project settings.
- Policy changes retain actor, reason, previous/new settings, effective date/time and policy version.
- State the effect on existing projects and records explicitly.
- Changes must not erase history, fabricate approvals, grant access implicitly or silently alter existing commitments.

The Configuration Catalogue records accepted values and defaults. Exact field types and unagreed bounds belong to the configuration/data contract and must not be invented as product requirements. Configurability does not introduce full accounting or resource booking into V1.0.

## 11. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 12. Accepted financial details and access

### Accepted O05 — Financial precision and adjustments

Use the selected currency’s standard decimal precision; require currency and distinguish Not Provided from zero. Preserve foreign-currency amounts separately, excluding them from project totals unless an authorised person records the conversion rate, date and converted amount. No automatic exchange-rate lookup.

PM/Deputy proposes adjustments; Owner/Sponsor approves before totals change. Preserve original and linked adjustment. Budget warnings default to eighty and one hundred percent of authorised budget, project-configurable; warnings neither block work nor authorise expenditure. Label totals Based on recorded entries and avoid definitive balances where information is incomplete. Group organisation totals by currency; keep AI costs separately identified.

Default financial-detail readers are PM/Deputy/Owner/Sponsor; others need explicit project policy. Leadership sees permitted summaries only. When tracking is disabled, authorised readers retain an explicitly labelled financial-history view. Project reporting uses one currency and grouped organisation totals; no automatic FX or mixed-currency total. Do not automatically combine AI costs with manual expenditure.

## 13. Accepted launch currencies and resource units

### Q06 — Launch catalogues and configurable services (Accepted)

MYR is the organisation's initial financial currency default; initially support MYR, SGD and USD. A financially tracked project selects one reporting currency. Other supported currencies may be enabled later. No automatic conversion. Resource units initially include hours, days, person-hours, person-days, items, seats and square metres; record usage period separately and do not assume conversions such as one day equalling eight hours.

OpenAI and Anthropic APIs remain AI launch options. Administrators enable tested models and nominate project primary/fallback choices. Model identifiers are configurable rather than frozen product requirements. No calls until project credentials, model selection and positive applicable spending allowances exist.

Email provider is configurable through supported Administrator-approved connections; Microsoft 365 is the initial supported option, not a mandatory sole provider. Use an approved organisational sender and retain the person/project event initiating each message. SharePoint document libraries and OneDrive are the initial storage options; SharePoint is the suggested default destination type, with each project selecting an approved destination. Dropbox, Box and other cloud storage providers may be added later as configurable options once supported connectors are implemented, verified and approved. Their future inclusion is not a claim of V1.0 launch implementation.

Connections receive only needed destinations/operations. Register requested permissions for Administrator approval; do not assume organisation-wide mailbox/file access. Removing a catalogue entry prevents new selection but preserves historical records; removing a connection stops new operations without erasing prior evidence.
