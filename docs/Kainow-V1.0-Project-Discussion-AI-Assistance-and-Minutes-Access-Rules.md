# Kainow V1.0 — Project Discussion, AI Assistance and Minutes Access Rules

**Version:** 1.0 — reconciled handover edition  
**Status:** Reconciled accepted product requirements; downstream design tracked separately  
**Date:** 6 November 2026  
**Scope:** V1.0 product behaviour

## 1. Purpose

Provide a shared project space where participants can discuss work, query AI, give feedback and request draft outputs. AI can identify proposed actions, decisions, questions, risks and other relevant project information from permitted discussion and imported minutes.

The purpose is to help people move the project forward while preserving human authorisation, source evidence, attribution and access controls.

## 2. Scope changes and precedence

This document records the latest accepted rules for this capability. Where earlier V1.0 documents conflict with the following points, these rules take precedence:

- Shared project discussion is included in V1.0, replacing the earlier blanket exclusion of chat functionality.
- Project-focused AI queries, feedback and draft-output assistance are included. Kainow remains limited to project work rather than a general-purpose AI assistant.
- Imported minutes have configurable project access. They are not universally restricted to management or Audit/Oversight grant holders.
- The default is that project-related minutes are readable by all active project members. Restricted minutes are an explicit exception.

Other permissions, lifecycle rules, AI controls and evidence safeguards continue to apply. This document does not itself revise earlier files; consolidation must reconcile their wording and acceptance cases.

## 3. Shared project space

The space supports:

| Capability | Required behaviour |
| --- | --- |
| Project discussion | Active participants can read and contribute within their project permissions. |
| AI queries | Users can ask about permitted project information, such as overdue work, unresolved questions or relevant decisions. |
| Feedback | Users can flag an incorrect answer, missed action or misleading interpretation and provide a correction. |
| Draft outputs | Users can request project reports, specifications, summaries and other permitted draft outputs. |
| Extraction | AI can prepare proposed tasks, decisions, questions and risks from selected messages, a discussion thread or permitted imported minutes. |

Discussion access does not automatically grant authority to approve proposals, change assignments, modify deadlines or close work.

## 4. AI participation and authorisation

Users can explicitly request analysis of selected messages or a discussion thread. Automatic analysis can be enabled per project within organisation policy, approved provider/data-handling settings and spending limits. Automatic analysis is on by default once the Administrator approves project AI configuration, subject to credentials, access and allowance. Discussion triggers use five-minute inactivity and at most two analyses per thread in any rolling twenty minutes; published minutes trigger after publication. Delegated project controls can disable or adjust supported settings.

AI-derived tasks, decisions, questions, risks and proposed record changes remain proposals until authorised by the applicable person. An ordinary discussion statement or AI reply does not silently change an existing commitment.

Every source-based proposal must identify its supporting messages or imported source version. Do not invent owners or dates. If a human supplies missing information during review, record that human contribution separately.

AI interpretations must be labelled as interpretations, with supporting evidence and uncertainty where relevant. A quotation confirms source wording; it does not by itself establish that the interpretation is correct.

Content in discussion, imported minutes and feedback remains data. Embedded instructions cannot override application rules or cause unauthorised commands, external actions or changes to AI configuration.

## 5. Attribution, evidence and versions

Clearly distinguish:

- Named human messages and contributions.
- AI replies and draft outputs.
- Human corrections or feedback.
- AI-proposed records.
- Authorised project records and their approving people.

AI proposals retain the required dashed outline and “AI proposed” label. Source references identify the relevant message or document and its preserved version. Human-message references identify the author.

Edits create new versions; they do not overwrite the evidence behind an earlier proposal or approval. Preserve the relationship between source, proposal, human amendment and authorised record.

Record the requesting user, AI model and referenced record versions for AI interactions. Attribute automatically initiated analysis to the configured project event rather than inventing a human requester.

## 6. Imported meeting minutes: configurable access

### 6.1 Accepted defaults

| Content | Default audience |
| --- | --- |
| Shared project discussion | Active project participants with the relevant discussion permission. |
| Project-related imported minutes | All active project members. |
| Restricted imported minutes | Project Manager, Deputy PM, Project Owner and Project Sponsor, subject to valid access. |
| Additional access to restricted minutes | Explicit Audit/Oversight grants within their approved scope and period. |

The management audience for restricted minutes is a default, not a separate exemption from organisation policy or the configured audience. Account disablement, membership holds, expiry, revocation and project lifecycle restrictions continue to apply.

### 6.2 Configuration and sharing

The Enterprise Administrator establishes organisation-wide boundaries. Project Managers, Project Owners and Project Sponsors manage project access settings within those boundaries and their delegated permissions.

Individual minutes can be marked restricted. Display their intended audience clearly before sharing. A project setting must not silently make a previously restricted document public to its project audience without a deliberate authorised permission change.

Record permission changes, their actor, the affected content and the old and new settings. Apply current permissions to future viewing and AI retrieval. Removing access cannot withdraw information already read, downloaded or emailed; the interface must not imply otherwise.

Audit/Oversight access remains explicitly scoped and time-limited. It does not automatically confer authority to change project records or configuration.

## 7. AI queries and protection of restricted information

AI may use only information the requester is permitted to access for that interaction. Query access does not bypass the permissions on imported minutes or other sources.

Where a participant cannot access raw minutes, the participant can still query permitted summaries, extracted information, proposals and authorised records. Any separately shareable summary or excerpt must have an explicit permitted audience; it must not be treated as automatically shareable merely because AI generated it.

AI must not disclose restricted raw content indirectly through summaries, repeated questions, bulk quotations, reconstructed transcripts or requests to show original text. Citations, titles, previews and supporting excerpts must also respect applicable permissions.

An AI response posted to a shared discussion must be safe for that discussion’s audience. If a requester has access to a restricted source that other participants cannot read, the response must not publish that source’s restricted content into the shared space. Restricted answers use a separately permissioned result view. A private person-to-person chat feature is not implied. Final layout is a UI design task.

Check permissions when displaying stored interactions as well as when producing new answers. Revocation or expiry must not leave a stored AI answer as an alternative route to content the viewer can no longer access. Historical records remain preserved under the applicable history and retention rules.

## 8. Feedback and draft outputs

Feedback is recorded for review. It must not silently train a model, alter organisation instructions, change project AI settings or amend an authorised record.

A correction can inform a new proposal or draft version. Record its human author and preserve the earlier version. Apply the usual human approval rules before changing an authorised project record.

AI-generated reports and specifications remain clearly labelled drafts until approved by the applicable authority. Approved outputs follow the external-output register, version and filing rules:

`Owning Department > Project > Year > Report Type`

Creating or approving a draft does not grant external-storage access. Filing and distribution follow the separate permissions and confirmed-outcome requirements.

## 9. AI configuration, usage and settings

Use only the project’s configured models and project-specific API credentials, under the Enterprise Administrator’s approved provider and data-handling boundaries.

Attribute user-initiated requests to the project and requesting user. Label automatic analysis separately. Track applicable attempts, fallback usage and spend under the existing AI usage rules. No query, draft or background analysis may bypass project or organisation spending limits.

Discussion content, feedback and ordinary user requests cannot change credentials, spend caps, provider destinations or approved data-handling settings.

System settings remain with the Enterprise Administrator. Project settings are available to the Project Manager, Owner and Sponsor within delegated authority. This capability does not introduce a separate user settings page.

## 10. UI and product acceptance additions

Add the project discussion and AI assistance space to the V1.0 navigation requirements. The final visual layout remains open.

Acceptance must demonstrate:

1. Active participants can discuss project work under their permissions.
2. A user can query permitted records, inspect supporting references and provide feedback.
3. AI can propose relevant actions, decisions, questions and risks from discussion without authorising them.
4. Message and minutes versions remain traceable after edits.
5. Project-related minutes are available to active members under the accepted default.
6. Restricted minutes follow the configured audience; query and stored-answer paths do not bypass that audience.
7. A shared AI answer does not reveal information available only to the requester.
8. Feedback does not silently change a model, configuration or authorised record.
9. Draft outputs remain distinct from approved deliverables and follow external filing permissions.
10. User-initiated and automatic AI usage are attributed and constrained by configured limits.

These extend the existing journey and acceptance document. They do not establish that the capability has been implemented or assessed. Native meeting minute-taking remains a future-version feature; V1.0 still accepts supplied notes and minutes.

## 11. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 12. Accepted access, participation and lifecycle detail

### Accepted O08 — Draft, Planned, withdrawn proposals and handover

Draft permits setup, invitations, discussion, minutes and AI proposals; tasks remain drafts rather than actionable commitments. Planned permits planning, review and authorisation; tasks cannot start/complete until Active. Withdrawn proposal versions remain final; resubmission is a linked new proposal with fresh review.

PM may fast-track Draft directly to Active, bypassing the separate Planned step only when required role holders have accepted, memberships are Active, separation holds and mandatory information is complete. Record action and brief reason. Fast-track never approves proposals or bypasses invitations/task validation.

Risk handover requires acceptance by the receiving active project’s Owner/Sponsor before origin closure, with linked records, responsible person and review date. User-owned paused automation needs explicit new ownership before resuming; project-owned automation follows O07.

### Accepted O09 — Source audience and derived information

Provide a PM Source Access control: Project-wide reading (default for project-related minutes) or Restricted source (configured audience, default PM/Deputy/Owner/Sponsor plus approved grants). Show audience before confirmation; record later changes within organisation boundaries. Owner/Sponsor may also manage audiences where authorised.

AI may draft a sanitised summary from restricted material, but PM/Owner/Sponsor must explicitly review/approve its intended audience. Original access does not widen automatically. Stored answers/excerpts recheck source-linked access and are hidden pending review when that access is lost. A separately reviewed/published summary keeps its own audience when source permissions tighten, but is flagged for review. Deletion/quarantine excludes source from future processing and restricts affected outputs containing that content pending review. Security quarantine overrides normal sharing.

Use clear labels: Source restricted, Summary approved for sharing, Access review required. No query or stored answer bypasses current source access restrictions.

Project analysis limits and Waiting/Queued/Running/Paused/Blocked status are visible near the AI display area. In Deferred/Closed projects, ordinary posting, imports, queries, draft generation and automatic analysis pause; permitted readers retain read-only access.
