# Kainow V1.0 — START HERE

**Version:** 1.0  
**Date:** 6 November 2026  
**Edition:** Product handover; accepted requirements consolidated, not evidence of implementation or delivery acceptance.  
**Scope:** Product only; development method and environment setup excluded.

## 1. What this package is

This is the current **Kainow V1.0 product handover**, dated 6 November 2026. It contains product intent, scope, detailed rules, accepted decisions, permissions, configuration and acceptance requirements. Kainow is the current product name. Earlier intent cards and older drafts are superseded and are not prerequisites.

The package is self-contained for understanding what V1.0 must deliver. It deliberately excludes development methods, environment setup, agent orchestration and historical runner trials. No earlier conversation is required to discover the accepted product rules.

It is **not a completed technical build baseline or a delivery certificate**. The remaining design register names exact contracts, setup values, the accepted Q01–Q06 clarification outcomes and verification evidence still needed before the affected implementation/go-live. Product scope acceptance does not mean these are already done.

## 2. Read in this order

| Order | Document | Purpose |
| --- | --- | --- |
| 1 | [Intent-Card](Kainow-V1.0-Intent-Card.md) | Purpose, non-negotiable principles, V1.0 boundary. |
| 2 | [Product-Summary](Kainow-V1.0-Product-Summary.md) | Readable overview of the complete product. |
| 3 | [Consolidated-Product-Specification-and-Decision-Register](Kainow-V1.0-Consolidated-Product-Specification-and-Decision-Register.md) | Primary detailed requirements and accepted D01–D70/O01–O17. |
| 4 | [Permission-Matrix](Kainow-V1.0-Permission-Matrix.md) | Default action-by-role authority and conditions. |
| 5 | [Configuration-Catalogue](Kainow-V1.0-Configuration-Catalogue.md) | Accepted settings/defaults, authority and change rules. |
| 6 | [Remaining-Design-and-Verification-Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) | Accepted Q01–Q06 outcomes, remaining technical design/setup and required delivery evidence. |
| 7 | [User-Journeys-and-Product-Acceptance-Criteria](Kainow-V1.0-User-Journeys-and-Product-Acceptance-Criteria.md) | User journeys and real assessment requirements. |

After the first six, read the specialist rules relevant to the feature being designed. Use the whole package for implementation; the Intent Card alone is too short to define every transition.

## 3. Document authority and change control

- The Intent Card summarises current purpose and mandatory protections. The consolidated specification is the primary detailed product reference; its D01–D70, O01–O17, Q01–Q06 and A01–A19 are accepted decisions. Q02 changes the earlier Calendar Days default to Working Days.
- The specialist documents, matrix and catalogue are reconciled explanations of those requirements, not independent permission to add scope. They include configurable defaults, not arbitrary scripting or workflow-building authority.
- “Product Owner” in handover decisions means the person accepting the product scope; “Project Owner” is an application role. An Enterprise Administrator can configure supported policy but is not automatically an authorised project approver or source reader.
- A real contradiction requires a recorded clarification/change, not a guess or a silent preference for an older document. Preserve the accepted defaults until an authorised change is effective. The six handover questions are now resolved in Q01–Q06; remaining technical contracts, numerical validation bounds, setup and verification remain expressly visible.
- New product requirements need a recorded decision and consistent updates to affected files. Accepted policy may be changed after go-live through bounded, versioned settings; this cannot silently rewrite old commitments, approval bases, access grants or evidence.
- The name is Kainow. The actual existing repository address remains `https://github.com/NgohCH/katempor`; this package does not assert a repository rename or source change.

## 4. Complete current document index

All files are Markdown and V1.0. The manifest lists byte hashes for the other package documents. The ZIP is a transport copy; the filenames below identify the current set, not historical drafts.

| Document | Use |
| --- | --- |
| [Kainow-V1.0-AI-Configuration-Data-Handling-and-Usage-Rules.md](Kainow-V1.0-AI-Configuration-Data-Handling-and-Usage-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Action-Item-Emails-External-Outputs-and-Department-Attribution.md](Kainow-V1.0-Action-Item-Emails-External-Outputs-and-Department-Attribution.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Configuration-Catalogue.md](Kainow-V1.0-Configuration-Catalogue.md) | Accepted settings/defaults, authority and change rules. |
| [Kainow-V1.0-Consolidated-Product-Specification-and-Decision-Register.md](Kainow-V1.0-Consolidated-Product-Specification-and-Decision-Register.md) | Primary detailed requirements and accepted D01–D70/O01–O17. |
| [Kainow-V1.0-Core-Records-and-Project-Data-Configuration-Rules.md](Kainow-V1.0-Core-Records-and-Project-Data-Configuration-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Dashboards-Progress-Timeline-and-Settings-Rules.md](Kainow-V1.0-Dashboards-Progress-Timeline-and-Settings-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Discussion-Evidence-Access-and-History-Rules.md](Kainow-V1.0-Discussion-Evidence-Access-and-History-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Handover-Manifest.md](Kainow-V1.0-Handover-Manifest.md) | Package membership, static validation and SHA256 hashes. |
| [Kainow-V1.0-Intent-Card.md](Kainow-V1.0-Intent-Card.md) | Purpose, non-negotiable principles, V1.0 boundary. |
| [Kainow-V1.0-Invitation-and-Membership-Lifecycle-Rules.md](Kainow-V1.0-Invitation-and-Membership-Lifecycle-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Permission-Matrix.md](Kainow-V1.0-Permission-Matrix.md) | Default action-by-role authority and conditions. |
| [Kainow-V1.0-Product-Summary.md](Kainow-V1.0-Product-Summary.md) | Readable overview of the complete product. |
| [Kainow-V1.0-Project-Discussion-AI-Assistance-and-Minutes-Access-Rules.md](Kainow-V1.0-Project-Discussion-AI-Assistance-and-Minutes-Access-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Project-Lifecycle-Rules.md](Kainow-V1.0-Project-Lifecycle-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Proposals-and-Configurable-Business-Rules.md](Kainow-V1.0-Proposals-and-Configurable-Business-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Questions-Decisions-and-Risk-Lifecycle-Rules.md](Kainow-V1.0-Questions-Decisions-and-Risk-Lifecycle-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Remaining-Design-and-Verification-Register.md](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) | Accepted Q01–Q06 outcomes, remaining technical design/setup and required delivery evidence. |
| [Kainow-V1.0-Reminders-Notifications-and-Escalation-Rules.md](Kainow-V1.0-Reminders-Notifications-and-Escalation-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Role-Management-Permissions.md](Kainow-V1.0-Role-Management-Permissions.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-START-HERE.md](Kainow-V1.0-START-HERE.md) | Entry point, authority and full index. |
| [Kainow-V1.0-Shared-Resources-and-Optional-Budget-Tracking-Rules.md](Kainow-V1.0-Shared-Resources-and-Optional-Budget-Tracking-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Sign-in-Access-Requests-and-Account-Lifecycle-Rules.md](Kainow-V1.0-Sign-in-Access-Requests-and-Account-Lifecycle-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-Task-and-Subtask-Lifecycle-Rules.md](Kainow-V1.0-Task-and-Subtask-Lifecycle-Rules.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-UI-Navigation-and-Accessibility-Requirements.md](Kainow-V1.0-UI-Navigation-and-Accessibility-Requirements.md) | Specialist product requirements; consult with the shared matrix/catalogue. |
| [Kainow-V1.0-User-Journeys-and-Product-Acceptance-Criteria.md](Kainow-V1.0-User-Journeys-and-Product-Acceptance-Criteria.md) | User journeys and real assessment requirements. |

## 5. Minimum handover workflow for the receiving developer

1. Read the Intent Card, summary and consolidated decisions; confirm the current scope and exclusions.
2. Use the matrix and catalogue for permissions/settings; design exact contracts rather than inferring authority from role titles.
3. Work through the design register, resolving only relevant narrow questions before dependent implementation. Record designs separately from approved product requirements.
4. Map implemented behaviour and assessment evidence to the user journeys and decisions. Real-model extraction, human usability, security and external-service behaviour each require their own evidence.
5. Present actual outcomes and limitations for Product Owner delivery acceptance. Do not use historical development-environment test counts as product evidence.

## 6. Completeness boundary

This handover includes the previously missing current Intent Card and reading guide, the 19 reconciled product references, full default permission action catalogue, configuration catalogue, design/verification register, architecture/analytics references and package manifest. It gives another developer a coherent requirements starting point, including the six accepted clarification decisions and A01–A12 architecture/analytics choices, without claiming the still-required technical designs or product validation already exist.

## 7. Accepted runtime and analytics references

Read these after the consolidated product requirements and before dependent technical design. They document accepted direction, not a completed technical build baseline.

| Document | Purpose |
| --- | --- |
| [Application Architecture and Operations Design](Kainow-V1.0-Application-Architecture-and-Operations-Design.md) | Self-hosting, approved updates, capacity, TypeScript/modular stack, PostgreSQL/queues, containers and recovery targets. |
| [Administrator Analytics and Reporting Rules](Kainow-V1.0-Administrator-Analytics-and-Reporting-Rules.md) | Complete defined event coverage, configurable reporting and permission-checked drill-down. |

The current package contains 28 Markdown documents. Hosted-service operation remains future scope. TypeScript throughout is selected; .NET/C# is not the product stack.

## 8. Accepted managed-source, credential and storage rules

[Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md) records A13–A19. Read it with the architecture and permission references. Capacity figures are provisional planning targets pending release verification.
