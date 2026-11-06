# Kainow V1.0 — Discussion, Evidence, Access and History Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules and default access policy  
**Scope:** Discussion sources, supporting quotes, source versions, attribution, access, record history and retention boundaries. Development methods and environment setup are excluded.

## 1. Purpose

Make authorised work reviewable while enforcing each source’s audience. Shared project discussion and ordinary project minutes are available to Active members by default. Restricted sources, Deleted content and security quarantine have separate access rules. A quote or source link is not a permission grant.

## 2. Related product documents

This document supplements:

- **Kainow-V1.0-Product-Summary.md**.
- **Kainow-V1.0-Role-Management-Permissions.md**.
- **Kainow-V1.0-Project-Lifecycle-Rules.md**.
- **Kainow-V1.0-Proposals-and-Configurable-Business-Rules.md**.
- **Kainow-V1.0-Task-and-Subtask-Lifecycle-Rules.md**.
- **Kainow-V1.0-Invitation-and-Membership-Lifecycle-Rules.md**.
- **Kainow-V1.0-Questions-Decisions-and-Risk-Lifecycle-Rules.md**.
- **Kainow-V1.0-Reminders-Notifications-and-Escalation-Rules.md**.

It clarifies the product's summary-first access model. It does not grant new access merely because a person holds a management or administrative role.

## 3. Default access matrix

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

## 4. Discussion sources and versions

- Preserve the original discussion source and subsequent source versions.
- Treat discussion content as information, never executable instructions, permission grants or configuration commands.
- Source edits create new versions rather than overwriting earlier evidence.
- A source edit does not silently modify existing proposals, supporting quotes or authorised records.
- Keep the source version supporting each proposal identifiable.
- Keep earlier authorised records linked to the evidence used when they were reviewed.

Kainow is not a general document repository. Source preservation serves accountability for project records.

## 5. Supporting quotes and proposal evidence

### Source-based proposals

- Every source-based proposal identifies its source version and exact supporting quote.
- AI must not invent quotations, source support, owners or dates.
- Missing source-stated owners or dates remain empty until an authorised person supplies required information through review.
- A quote proves that the words occur in the identified source; it does not by itself establish that a proposed assignment or commitment is semantically correct.
- Human review remains necessary before authorisation.

### Human-originated proposals

- A person may originate a proposal without a discussion source under the accepted proposal rules.
- Label it **“Human proposal — no discussion source”** and identify the named person.
- Do not fabricate a quote or imply that the proposal was extracted from discussion.

### Evidence visibility

- Supporting excerpts can be shown to authorised proposal reviewers without granting full discussion access.
- Supporting quotes can accompany authorised records for permitted viewers, subject to explicit evidence restrictions.
- Search, history and notification behaviour must preserve that distinction.
- A source link is a reference, not an access grant.

## 6. Attribution and amendments

- Label AI contributions as AI.
- Identify human contributions by the named person.
- Preserve attribution when a person edits AI-proposed content; do not make the contribution's origin disappear.
- Corrections to authorised information follow the amendment-and-authorisation process.
- Keep earlier proposal versions, source evidence and approvals traceable.
- Do not silently replace original evidence with a newer source version.

The exact presentation of mixed AI/human contributions can be settled in the design specification, provided their provenance remains clear.

## 7. History and accountability

History records:

- The actor.
- The action.
- The time.
- Previous and new values where applicable.
- The relevant policy version where applicable.

Additional rules:

- Every record remains associated with its organisation.
- History is not editable through ordinary product actions.
- Record access permits only history information within the user's permissions.
- Restricted source content must remain protected in history, including previous values and previews.
- Credentials must not be copied into ordinary history, even when connection settings are changed.
- Preserve earlier approvals under the policy version in effect when they were authorised.

## 8. Audit and Oversight access

Audit/Oversight is an additional scoped grant alongside the main role. Administrator/Owner/Sponsor grants, extends or revokes following a recorded request; no self-approval. Default thirty days, maximum ninety per grant/extension unless Administrator configures otherwise. It extends only its approved scope. Deleted-content inspection needs explicit scope; quarantine requires separate approved security access. Holds suspend project grants, revocation ends them and expiry continues. Membership restoration never automatically restores grants. Ordinary project discussion does not require these grants.

## 9. Protection across the product

Restricted information must not leak through:

- Search results or snippets.
- Personal or leadership dashboards.
- Notifications and email summaries.
- Record-history previews or previous-value displays.
- Source links or evidence navigation.

Any summary or excerpt must be filtered to the recipient's permissions. Leadership summary access is not discussion access. Notification delivery does not grant access to the linked content.

## 10. Configuration and authority

- Archive timing and permitted access settings are configurable within mandatory safeguards. Stored content remains indefinitely retained under logical deletion; configurable archive timing is not a physical-purge policy.
- The Enterprise Administrator controls organisation-wide rules and permitted delegation.
- Project Managers, Owners and Sponsors may adjust only explicitly delegated operational settings; role-permission definitions, approval policy, security policy and delegation remain Administrator-controlled.
- Configuration authority does not grant access to restricted discussion content or credentials by itself.
- Configuration changes retain actor, reason, previous/new settings, effective date/time and policy version.
- State the effect on existing records and pending proposals explicitly.
- Preserve human authorisation, explicit access, attribution and evidence integrity.

Mandatory protections cannot be disabled by changing a role label or access setting. Configuration must not silently grant permissions or erase supporting evidence.

## 11. Retention, logical deletion and security quarantine

### Accepted O01 — Security quarantine

Preserve the no-permanent-deletion rule. Hold suspected credentials before publication or AI transmission for review; detection is best-effort. When discovered after storage, quarantine affected content and identifiable copies, excluding ordinary access, search, export, notifications and future AI processing. Retain originals encrypted under separately approved security access; ordinary Audit/Oversight does not disclose them. Publish a sanitised version with a visible credential-removal marker and preserved original reference. Notify the Administrator and credential holder to revoke/rotate the credential. Record known prior disclosures; never imply that an email or provider copy was recalled. Sanitised content can return through authorised review, but the secret cannot return to ordinary content. Intentionally configured API credentials remain in separate protected credential storage.

### Accepted O02 — Archiving, Deleted-content access and restoration

Archive only Closed projects, by default twelve months after closure, configurable by Administrator. Authorised PM/Owner/Sponsor may archive earlier and may unarchive into ordinary navigation without changing Closed status. Archive changes navigation and visibility, not lifecycle status, valid permissions or stored history. Provide an Archive filter and include permitted historical reporting.

Retain stored records indefinitely under logical deletion. Inspecting Deleted content needs an explicit Inspect Deleted Content scope in a time-limited Audit/Oversight grant. Quarantined originals remain separately protected. PM/Deputy restores discussion messages; PM/Owner/Sponsor restores imported sources; Owner/Sponsor approval is required for deleted authorised records. Current permissions and project-state restrictions apply. Restoration preserves history and does not restart analysis, resend emails, revive grants or alter task dates/status.

Deletion preserves history, blocks future processing including queued analysis, and flags linked authorised records rather than silently rewriting them. Ordinary records are retained indefinitely; archival periods change visibility rather than erase content.

## 12. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 13. Accepted security and restoration procedure

### Q03 — Investigation and quarantined-original security grants (Accepted)

Project access/membership investigations follow existing role-management authority; findings are visible only to named investigators and authorised role managers. This is separate from permission to inspect quarantined originals that may contain secrets.

Inspecting quarantined originals needs a separate time-limited security grant approved by an Enterprise Administrator other than the requester. Project roles and ordinary Audit/Oversight do not suffice. Record purpose, specific records, requester, approver and expiry. Default duration is 24 hours; extension requires fresh approval. Require explicit confirmation before revealing sensitive content and record each inspection. No bulk export, email inclusion or AI processing of quarantined originals. If no independent Administrator is available, access remains blocked until another designated Administrator is available. No emergency self-grant is introduced. Sanitised information can remain available under ordinary permissions.

### Q04 — Archive, unarchive and restoration (Accepted)

Only Closed projects may be archived. Default archive timing is twelve months after closure, Administrator-configurable; PM/Owner/Sponsor may archive earlier. PM/Owner/Sponsor may unarchive into ordinary navigation, but the project stays Closed/read-only until a separately authorised reopening.

PM/Deputy may restore Deleted discussion messages with a reason/history; PM/Owner/Sponsor may restore Deleted imported sources after reviewing their intended audience; restoring a Deleted authorised record requires Owner/Sponsor approval, retaining its previous lifecycle status and approval history. These are narrowly permitted administrative actions even while Deferred/Closed; they do not reactivate work or reopen the project.

Preview who will regain visibility. Current account, membership, audience and grant restrictions still apply. Restoration never automatically triggers AI, emails, invitations, deadlines or task execution. Quarantined originals cannot return through ordinary restoration; security review must produce a sanitised version. Record actor, time and reason for archive, unarchive and restore.

## 14. Accepted managed-source storage and direct-access exception

A13/A14: imported originals, extracted text and versions reside in Kainow-managed SharePoint/OneDrive; PostgreSQL retains metadata/quotes/version associations. Ordinary source access uses the Kainow front end; only designated storage Administrators and the authorised integration connection access storage directly. Quarantine/security grants and app approval permissions remain separate. Sources belong to recoverable backup scope. [Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md)
