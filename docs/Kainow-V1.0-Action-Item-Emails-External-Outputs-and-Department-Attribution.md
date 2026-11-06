# Kainow V1.0 — Action-Item Emails, External Outputs and Department Attribution

**Version:** 1.0 — reconciled handover edition  
**Status:** Reconciled accepted product requirements; downstream design tracked separately  
**Date:** 6 November 2026  
**Scope:** V1.0 product behaviour only

## 1. Purpose

Kainow consolidates authorised action items for communication to project members and manages the organisation of project outputs held in approved external storage. Each project has one owning department. Other departments can participate, contribute and receive attribution without duplicating the project or its authoritative outputs.

This document records the accepted rules for these capabilities. It does not select an email provider or external-storage service, grant access to a live destination, or describe the development method.

## 2. Relationship to the product specification

These rules supplement the V1.0 specifications for role management, project lifecycle, reminders and notifications, discussion/evidence access, AI configuration, and core records.

For this capability, the earlier boundary that Kainow is not a document repository is clarified: Kainow manages a register of project deliverables and their external filing, links, versions and status. The actual files remain outside Kainow. General document editing remains outside scope.

Consolidated action-item emails supplement individual reminders and escalations. Sending or receiving an email does not authorise a proposal, acknowledge a task, complete work or change a deadline.

## 3. Department ownership and participation

| Item | Agreed rule |
| --- | --- |
| Owning department | Every project has exactly one owning department. |
| Participating departments | A project can have multiple participating departments. |
| Member affiliation | Record a participant’s department separately from their project role. |
| Contribution attribution | Identify the people and departments contributing to an output. Label AI assistance separately. |
| Access | Department affiliation or participation alone grants no project, discussion or document access. |
| Department reporting | Distinguish projects owned by a department from projects to which it contributes. |
| Organisation totals | Count each project once in organisation-wide project totals, even when several departments contribute. |
| Ownership transfer | Only the Enterprise Administrator can change the owning department, with a recorded reason and preserved history. |

Owning department is an organisational classification; it is separate from the Project Owner role. A department does not inherit the Project Owner’s approval powers.

Changing a participant’s department must not rewrite the recorded attribution of earlier contributions. Attribution identifies contribution, not approval authority.

## 4. Consolidated action-item emails

### 4.1 Content

A project digest consolidates authorised tasks and subtasks, showing their assignees, due dates, current status and overdue indicators where applicable. Include links to the relevant Kainow records and related outputs when the recipient is permitted to access them.

Pending AI proposals must not appear as authorised commitments. Missing information must remain visibly missing; AI must not invent an assignee, due date or completion statement to make a digest appear complete.

Each digest must identify the project and the time represented by its contents. Due dates and displayed reporting times follow the product’s UTC+8 rule. Later changes to a task do not rewrite the historical email content.

### 4.2 Sending and configuration

- The Project Manager, Project Owner or Project Sponsor can review and send a consolidated digest.
- Scheduled sending can be enabled through project settings, within the Enterprise Administrator’s permitted settings and delegation.
- Project settings govern the digest’s schedule and available content choices. No default sending frequency has yet been selected.
- Configured scheduled delivery distributes existing authorised information; it does not grant AI authority to approve work.

### 4.3 Recipients and privacy

Send only to active project members. Determine eligibility and permitted content at delivery time, including for scheduled emails. Members whose access is On Hold, expired or revoked must not receive the project digest.

Each recipient receives only information allowed by their access. A common project digest must not expose restricted items to recipients who cannot view them. Full discussions and restricted evidence are excluded. Links do not grant access, and an external file link does not replace the external service’s permission checks.

### 4.4 Delivery history

Record the initiating person or configured schedule, recipients, content version, send time and delivery outcome. A failed delivery must be visible and must not be described as successful. Avoid duplicate delivery when handling a recoverable failure.

Keep this communication history under the applicable project access and history rules. It must not expose credentials or restricted source content.

## 5. External storage and folder structure

The Enterprise Administrator configures approved external storage. Each project uses an authorised location within that configuration.

Use this primary structure:

`Owning Department > Project > Year > Report Type`

For example:

`Corporate Information Centre > Campus Network Upgrade > 2026 > Specifications`

The example illustrates the structure only; it does not establish a department list or storage destination.

| Level | Rule |
| --- | --- |
| Department | Use the project’s owning department from a controlled list. |
| Project | Use the project’s registered identity and display name. Shared participation does not create another project tree. |
| Year | Default to the output’s issue year in UTC+8. |
| Report Type | Select one primary type from a controlled list. |

An output can carry additional categories as metadata and appear in multiple relevant searches. Keep one authoritative copy and primary filing location rather than duplicating it across categories or participating departments.

## 6. Filing and the document register

Kainow files generated project outputs into the configured external destination. Authorised users can register existing external documents.

The register records:

- Stable output identity and project association.
- Title, primary report type, additional categories and issue year.
- External location or link.
- Author and contributing people and departments.
- AI assistance attribution where applicable.
- Version and Draft, Approved or Superseded status.
- Approval reference where applicable, and the history of subsequent changes.

Recording a document or filing it successfully does not approve its contents. Approval requires the applicable human authority and recorded approval. An AI-generated specification or report remains a draft until authorised under the relevant rules.

## 7. Versions, access and failures

Preserve previous versions and approval history. A revision must not silently replace an approved output or inherit its approval without the required review.

Folder placement grants no access. Access through Kainow requires the relevant Kainow permission, and opening the external file also requires the storage service’s permission. External permissions must be managed consistently with the intended audience; Kainow cannot assume that its own restrictions control a separately shared external file.

Show missing files, inaccessible links and unsuccessful filing clearly. Do not report an output as successfully stored without confirmation from the external destination. Preserve enough history to distinguish a registered link from a confirmed filing outcome.

Ownership transfer must explicitly address any required folder relocation. Preserve the old owning department and transfer reason in history. Do not silently relocate files, duplicate authoritative copies, discard versions or alter external permissions merely because the department field changed.

## 8. Product acceptance outcomes

V1.0 must demonstrate that:

1. An authorised sender can produce a consolidated action-item email with accurate assignees, dates, statuses and permitted links.
2. Recipient filtering excludes inactive memberships and prevents disclosure of restricted records.
3. A configured schedule sends under recorded project policy without authorising or changing the underlying work.
4. An output is filed under its owning department, project, issue year and primary report type, with a working registered link.
5. Participating departments and named contributors receive attribution without duplicate authoritative outputs or inflated organisation project totals.
6. A revised approved document preserves the previous version and approval history.
7. Failed filing or delivery is visible, with no false success claim.
8. An ownership transfer preserves history and identifies the disposition of the external folder.

These are required outcomes, not claims that the capability has been delivered or tested.

## 9. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 10. Accepted formats, authorities and external operations

### Accepted O03 — Launch integrations and configurable formats

Accepted launch services: OpenAI and Anthropic APIs; configurable email providers (Microsoft 365 initially supported); SharePoint document libraries and OneDrive storage initially, with Dropbox, Box and other cloud storage options addable later through supported approved connectors. These are supported launch options, not a permanent provider restriction. Multiple Enterprise Administrators may approve additional supported services and destinations. Delegated PM/Owner/Sponsor can add/change/remove project connections, with project credentials, usage attribution and spending controls. Unsupported protocols require a supported connector extension, not an arbitrary URL or API key. No plugin-loading capability is implied.

Accepted input formats: pasted text, TXT, Markdown, DOCX and selectable-text PDF. Generated outputs: Markdown, DOCX, PDF and CSV for permitted tabular reports. Projects can add/remove formats from the Administrator-approved supported catalogue. Removal blocks new import/generation, preserving old files and history; adding a format does not automatically convert old documents. New parsers/exporters require a supported extension. OCR remains outside V1.0. Actual authentication/permissions and service compatibility must be verified in integration contracts.

### Accepted O13 — External file operations

Record service file identity/version where available. Check on opening/filing, with optional scheduled checks and displayed last-check time. Distinguish Changed, Missing, Access denied and Unverified. Preserve approved-version references; changed content needs a new registered version/review, not inherited approval.

PM/Deputy reconciles moves/renames within approved destinations; outside destinations need Administrator approval. Preserve old/new references. Failed operations retain last confirmed location and incomplete status. Verify destination before declaring relocation complete and avoid duplicate authoritative copies.

Logical deletion of a register entry does not delete the external file. Links do not grant external permissions. On owning-department transfer, Administrator explicitly chooses approved relocation or retention at its existing approved location.

Members prepare drafts/submit existing documents; PM/Deputy manages register/filing; Owner/Sponsor approves output content, with additional review configurable. A document approval does not approve every commitment in its text. Primary output category identifies one authoritative location; additional categories are searchable metadata. Ordinary active members can read only the permitted output/register fields; external permissions also apply.

## 11. Accepted configurable email and storage choices

### Q06 — Launch catalogues and configurable services (Accepted)

MYR is the organisation's initial financial currency default; initially support MYR, SGD and USD. A financially tracked project selects one reporting currency. Other supported currencies may be enabled later. No automatic conversion. Resource units initially include hours, days, person-hours, person-days, items, seats and square metres; record usage period separately and do not assume conversions such as one day equalling eight hours.

OpenAI and Anthropic APIs remain AI launch options. Administrators enable tested models and nominate project primary/fallback choices. Model identifiers are configurable rather than frozen product requirements. No calls until project credentials, model selection and positive applicable spending allowances exist.

Email provider is configurable through supported Administrator-approved connections; Microsoft 365 is the initial supported option, not a mandatory sole provider. Use an approved organisational sender and retain the person/project event initiating each message. SharePoint document libraries and OneDrive are the initial storage options; SharePoint is the suggested default destination type, with each project selecting an approved destination. Dropbox, Box and other cloud storage providers may be added later as configurable options once supported connectors are implemented, verified and approved. Their future inclusion is not a claim of V1.0 launch implementation.

Connections receive only needed destinations/operations. Register requested permissions for Administrator approval; do not assume organisation-wide mailbox/file access. Removing a catalogue entry prevents new selection but preserves historical records; removing a connection stops new operations without erasing prior evidence.
