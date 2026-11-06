# Kainow V1.0 — Questions, Decisions and Risk Lifecycle Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules; configurable defaults within mandatory safeguards  
**Scope:** Authorised questions, decisions and risks, their statuses, responsibilities and history. Development methods and environment setup are excluded.

## 1. Purpose and related documents

Kainow supports questions needing resolution, decisions needing an accountable record, and risks needing review or mitigation. This document defines their accepted default lifecycles after authorisation.

Related documents:

- **Kainow-V1.0-Product-Summary.md** — product purpose and scope.
- **Kainow-V1.0-Role-Management-Permissions.md** — role-management authority.
- **Kainow-V1.0-Project-Lifecycle-Rules.md** — project status and restrictions.
- **Kainow-V1.0-Proposals-and-Configurable-Business-Rules.md** — proposal authorisation, amendments, configurable policy and history.
- **Kainow-V1.0-Task-and-Subtask-Lifecycle-Rules.md** — separately authorised mitigation tasks and their execution.
- **Kainow-V1.0-Invitation-and-Membership-Lifecycle-Rules.md** — membership and access eligibility.

## 2. Shared rules

- The statuses in this document apply to authorised project records. Unauthorised items remain proposals.
- AI may propose information but cannot authorise a record, accept a risk or independently exercise human lifecycle authority.
- Source-based records retain source quotes and versions. Human-originated proposals without discussion sources retain their explicit human-origin label.
- AI and human contributions remain distinguishable; human contributions identify the named person.
- Every status change retains its actor and history.
- Edits create traceable versions rather than erasing earlier evidence.
- Ordinary changes are unavailable while the project is Deferred or Closed under the default project lifecycle.
- Holding a role does not bypass membership, project scope or discussion-access restrictions.
- Dates and deadlines use UTC+8.

## 3. Questions

### Statuses

| Status | Meaning |
| --- | --- |
| Open | An authorised question needs an answer. |
| Answered | An answer is recorded, but resolution has not yet been confirmed. |
| Resolved | An authorised person confirmed that the question has been addressed. |
| Withdrawn | The question was explicitly removed from consideration; the reason and history remain. |

### Default authority and actions

| Action | Who may perform it | Conditions |
| --- | --- | --- |
| Supply an answer | Project participants with the relevant access | Preserve the named contributor and answer history. |
| Resolve | Requester, Project Manager or Deputy Project Manager | Confirm that the answer addresses the question. |
| Reopen a Resolved question | Requester, Project Manager or Deputy Project Manager | Reason required; preserve previous answer and resolution. |
| Withdraw | Requester or Project Manager | Reason required. |

### Resolution boundary

- **Answered does not mean Resolved.** Recording an answer does not automatically confirm its adequacy.
- Resolving a question does not authorise a related decision or task.
- If an answer implies a new commitment, that commitment follows the separate proposal-authorisation process.
- Reopening does not delete the earlier answer or resolution.

Reopening returns the question to Open, retaining earlier answers under current access. Withdrawn is final; a renewed question is a linked new record. Participants revise their own answers with versions; PM/Deputy moderation is recorded separately from original authorship.

## 4. Decisions

### Statuses

| Status | Meaning |
| --- | --- |
| Active | The authorised decision is currently in force. |
| Superseded | A newly authorised decision version replaces it; the earlier version remains traceable. |
| Withdrawn | An authorised withdrawal ends the decision's current applicability without deleting its history. |

### Default authority and actions

| Action | Who may perform it | Conditions |
| --- | --- | --- |
| Authorise the initial decision | Project Owner or Project Sponsor | Follow proposal review and authorisation rules. |
| Authorise a substantive replacement | Project Owner or Project Sponsor | Create a newly authorised version linked to its predecessor. |
| Authorise withdrawal | Project Owner or Project Sponsor | Follow the proposal/amendment authorisation process; preserve the withdrawal and prior decision history. |

### Decision continuity

- A proposed replacement does not silently change the current authorised decision.
- Replacing a decision creates an explicit link between the previous and new authorised versions.
- Preserve the earlier decision, source evidence, authorising person and applicable policy version.
- Do not rewrite historical decisions to make them appear as if the later wording was originally authorised.
- A substantive replacement or withdrawal requires human authorisation, not an ordinary progress update.

Owner/Sponsor identifies affected records when authorising decision replacement/withdrawal. Flag review without automatically cancelling, reassigning or completing related work.

## 5. Risks

### Statuses

| Status | Meaning |
| --- | --- |
| Open | An authorised risk has been identified and needs attention. |
| Mitigating | Mitigation activity is being pursued. |
| Resolved | Resolution has been approved by an authorised person. |
| Accepted | An authorised person acknowledged the remaining exposure; the risk has not necessarily disappeared. |

### Responsibility and information

- A risk may have one **Risk Responsible Person**, a severity category, mitigation notes and a next review date.
- Use the label Risk Responsible Person rather than Risk Owner, to avoid confusion with Project Owner.
- AI leaves responsibility and dates empty unless supported by the source.
- People may supply missing information through the authorised review process.
- Severity defaults Low, Medium, High and Critical, describing increasing potential harm/disruption. Administrator controls organisation definitions; permitted project refinements retain comparable meanings.

### Default authority and actions

| Action | Who may perform it | Conditions |
| --- | --- | --- |
| Update mitigation information | Risk Responsible Person, Project Manager or Deputy Project Manager | Preserve contribution attribution and history; substantive commitments still require authorisation. |
| Accept remaining exposure | Project Owner or Project Sponsor | Acceptance reason, responsible person and next review date required for continuing exposure; O11 permits closure-only final acceptance with a reason and explicit No further review required. |
| Approve resolution | Project Owner or Project Sponsor | Explicit human approval; do not infer resolution from task completion alone. |
| Reopen a Resolved risk | Risk Responsible Person, Project Manager or Deputy Project Manager | Circumstances changed; reason required; preserve prior resolution. |

### Acceptance and mitigation

- **Accepted does not mean eliminated.** The record continues to describe the remaining exposure and its review date.
- Accepting a risk is distinct from accepting an AI proposal that creates the risk record.
- Mitigation actions become separately authorised tasks, with their own assignees and due dates.
- Do not hide unapproved commitments within mitigation notes.
- Completing mitigation tasks does not automatically resolve the risk. The default Owner/Sponsor resolution approval is still required.
- Reopening retains the previous acceptance or resolution history; it does not erase the earlier judgement.

A review date triggers notification, not an automatic risk-status transition. Reopening returns Open under the recorded authority; reversal of Accepted exposure requires Owner/Sponsor authority. Notify the responsible person and PM at the review date under O12.

## 6. Project and membership restrictions

- Deferred or Closed projects prevent ordinary question, decision and risk changes under the default lifecycle.
- Reopening a project does not automatically resolve questions, activate withdrawn decisions or accept/resolve risks.
- Membership expiry or revocation does not delete contributions or earlier approvals.
- Any ongoing action requires the actor to retain the relevant current permissions.
- Read access remains subject to the product's summary/discussion-access rules.

## 7. Configuration in V1.0

These are accepted defaults, configurable within the business-rule framework and mandatory safeguards.

| Area | Configurable policy |
| --- | --- |
| Questions | Eligible answering, resolving, reopening and withdrawing roles; required transition information. |
| Decisions | Eligible human approving roles and approval requirements for initial authorisation, replacement and withdrawal. |
| Risks | Eligible mitigation, acceptance, resolution and reopening roles; required acceptance/review information. |
| Categories and labels | Controlled severity categories and presentation labels within supported lifecycle meanings. |

### Authority

- The Enterprise Administrator controls organisation-wide policy and delegated settings.
- Project Managers, Owners and Sponsors may adjust only explicitly delegated operational settings, within organisation-level bounds. Role-permission definitions, approval policy, security policy and delegation remain Administrator-controlled.
- Configuration authority does not itself grant discussion access or record-authorisation authority.

### Mandatory safeguards and policy history

- AI cannot become a human approver through configuration.
- Explicit access, attribution, source integrity and history remain enforced.
- Policy changes retain actor, reason, previous/new settings, effective date/time and version.
- Preserve the policy version used for earlier approvals.
- State explicitly how a change affects pending proposals and existing records; do not silently migrate commitments.
- Configuration of labels does not invent arbitrary workflow states or executable actions.

## 8. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 9. Accepted risk transitions and closure

Open → Mitigating: Risk Responsible Person/PM/Deputy records mitigation detail. Owner/Sponsor accepts exposure with a reason and review date or resolves with explanation and evidence where available. Reopening Resolved returns Open with reason; reversing Accepted exposure requires Owner/Sponsor and returns Open. Completion of mitigation tasks never silently resolves a risk.

### Accepted O11 — Closure outcome detail

Delivered requires Owner/Sponsor confirmation that agreed objectives were met and no outstanding tasks. A completion percentage alone is insufficient. Overridden parents never hide unfinished children. Explicitly complete, cancel or retain each unfinished child.

Unresolved questions require reasons or accepted handover; those affecting delivery acceptance prevent Delivered. Risks requiring ongoing review move to an accepting active project. Where no further review is necessary, Owner/Sponsor may record final risk acceptance with reason and explicit No further review required. This closure-only exception removes the next-review-date requirement for that disposition.

Cancellation cannot disguise unmet objectives. Receiving projects accept handed-over work through linked records; origin outcome reflects actual delivery. Partially Delivered and Abandoned remain available with reasons.
