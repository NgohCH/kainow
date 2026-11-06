# Kainow V1.0 — Proposal Review, Authorisation and Configurable Business Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules and configuration direction  
**Scope:** Proposal review and authorisation, configurable business policies, configuration authority and policy history. Development methods and environment setup are excluded.

## 1. Purpose

Kainow turns discussion into accountable execution. AI or people propose tasks, decisions, questions and risk flags. People review and authorise proposals before they become authoritative project records.

V1.0 includes business-rule configuration. The organisation can adjust permitted policies after go-live without requiring a code change for every policy adjustment. Configuration remains subject to mandatory protections and the supported product capabilities.

## 2. Relationship to other product documents

Read this document alongside:

- **Kainow-V1.0-Product-Summary.md** — product purpose, scope and accepted features.
- **Kainow-V1.0-Role-Management-Permissions.md** — accepted role-management permissions.
- **Kainow-V1.0-Project-Lifecycle-Rules.md** — accepted project transitions and lifecycle permissions.

The previously accepted business rules become the **default configuration**, rather than all being fixed product behaviour. This document supersedes any interpretation of those documents that would require code changes for every permitted policy adjustment. It does not discard their defaults or authorise automatic changes to existing records.

## 3. Mandatory protections

These protections cannot be disabled through configuration:

1. **People authorise.** AI cannot approve proposals, grant access or independently create authorised commitments.
2. **Explicit access.** Access must be explicitly granted through the relevant permissions. Policy changes must not silently grant access.
3. **Preserved history and attribution.** Earlier evidence, proposal versions, approvals, policy versions and actors remain traceable.
4. **No invented evidence, owners or dates.** AI must not fabricate source support or fill missing owners/dates without source support.
5. **Discussion is data.** Discussion content does not become executable instructions or configuration commands.
6. **Visible distinction.** AI proposals remain visibly distinct from authorised records and retain their AI attribution.

Policy configuration must also be validated against required project roles and the product's mandatory safeguards.

## 4. Proposal types and origin

Supported proposal types are:

- Task.
- Decision.
- Open question.
- Risk flag.

AI and human proposals follow the same authorisation requirement. Their origin remains clearly labelled as AI or the named person.

### Source-based proposals

- Retain the source version and supporting quote.
- Do not silently replace original source evidence when the discussion changes.
- Missing source-stated owners or dates remain empty in the AI proposal.

### Human proposals without a discussion source

A person may submit an original proposal without a discussion quote. Label it **“Human proposal — no discussion source”** and identify the person. Do not fabricate a quote or represent the proposal as extracted from discussion.

## 5. Default proposal statuses

| Status | Meaning |
| --- | --- |
| Pending Review | An item has been proposed; no authorised commitment exists. |
| Authorised | The exact reviewed version has received the required human authorisation and has a linked project record. |
| Rejected | An authorised reviewer declined the proposal; a reason is recorded. |
| Withdrawn | The human proposer or Project Manager removed it from consideration; a reason is recorded. |
| Superseded | A newer proposal version replaces it; both versions remain traceable. |

These status meanings distinguish proposals from authorised commitments. Configuration must not make an unapproved proposal authoritative merely by renaming or moving its status.

## 6. Default review and authorisation permissions

| Action | Default authority |
| --- | --- |
| Submit a proposal | Members may submit their own proposals; Project Managers, Owners and Sponsors may prepare proposals. AI may generate proposals without authorising them. |
| Prepare or revise proposals for review | Project Manager, Project Owner or Project Sponsor. |
| Authorise | Project Owner or Project Sponsor. |
| Reject | Project Owner or Project Sponsor; reason required. |
| Withdraw a pending proposal | Its human proposer or Project Manager; reason required. |

In an eligible small team, a Project Manager holding Owner or Sponsor responsibility may authorise in that capacity.

These are defaults. The Enterprise Administrator can configure eligible reviewing and approving roles, approval requirements and self-approval restrictions within the mandatory protections.

## 7. Authorisation and record creation

- Authorisation applies only to the proposal version actually reviewed.
- Revisions create new versions; previous versions and their history remain traceable.
- Replacing a pending version makes the earlier pending version Superseded; approval of an earlier version does not automatically approve its replacement.
- Task authorisation requires one assignee and a due date.
- Where AI left an owner/date empty, an authorised person supplies the missing information before the task becomes an actionable commitment.
- If the assignee's invitation is pending, show that condition clearly. Assignment or authorisation does not itself grant access.
- Authorisation creates one linked task, decision, question or risk record. Repeated clicks must not create duplicate records.
- Under the accepted default project lifecycle, proposal authorisation is unavailable while the project is Deferred or Closed.

## 8. Amendments after authorisation

The default rule is that changes to an authorised commitment's substance, assignee or due date require a new amendment proposal and Owner/Sponsor authorisation.

- Preserve the original authorised version, its evidence and approval history.
- A proposed amendment does not silently replace the existing commitment.
- Routine progress updates and task completion follow task permissions; they do not require fresh proposal authorisation.
- Editing the underlying discussion does not automatically change an authorised record or its original evidence.
- Which changes require reauthorisation is configurable, subject to explicit human authorisation and preserved accountability.

## 9. Configurable business-rule areas

| Area | Configurable options |
| --- | --- |
| Authorisation | Eligible approving roles; whether one approval or multiple approvals are required; self-approval restrictions. |
| Proposal review | Who may submit, revise, reject or withdraw; which amendments require reauthorisation. |
| Role management | Appointment and extension permissions; permitted role combinations; small-team threshold. |
| Project lifecycle | Roles permitted to perform supported transitions and the information required. |
| Membership | Default expiry, maximum appointment duration and extension permissions. |
| Reminders and escalation | Timing, recipients and escalation sequence. |
| Categories and stages | Available labels, stages and optional substages. |

Supported policy choices are Administrator-controlled; only identified operational settings may be delegated. Configuration changes supported choices. It does not provide arbitrary scripts, plugin loading, new executable actions or unlimited new workflow types.

The default values remain those already accepted, including the fewer-than-seven-person small-team definition, configurable membership expiry, seven-day and one-day reminders, and escalation at three days overdue. They remain in force until an authorised configuration change takes effect.

## 10. Configuration authority and delegation

### Enterprise Administrator

- Controls organisation-wide business-rule configuration.
- Determines which project settings may be adjusted locally.
- Defines the permitted bounds of that delegation.

### Project Managers, Owners and Sponsors

- May adjust only operational settings explicitly delegated to them; role-permission definitions, approval/security policy and delegation remain Administrator-controlled.
- Must remain within organisation-level rules and delegated bounds.
- Do not gain configuration authority merely because they hold a project role.

No configuration-management authority automatically grants access to project discussions, proposal-authorisation power or other permissions. Those permissions must be explicitly held or granted under the applicable rules.

## 11. Policy versions and changes after go-live

Each configuration change must:

1. Be made by an authorised person.
2. Be validated against mandatory protections and required project roles.
3. Record its actor and reason.
4. Preserve previous and new settings.
5. Record an effective date/time.
6. Create a new policy version.
7. Explicitly state its effect on pending proposals and existing projects.

Dates and times must be presented consistently with the product's UTC+8 convention.

### Existing approvals and commitments

- Preserve the policy version under which each approval was authorised.
- Do not silently rewrite earlier approvals, commitments or source evidence.
- Do not automatically reassign tasks, change deadlines or grant access because a policy was edited.
- Any migration affecting existing records requires an explicit decision identifying the affected records and treatment.

### Pending proposals

Pending proposals retain their existing approval policy by default. Applying a new policy requires an explicit impact-reviewed choice and restarts approval for affected pending proposals. Existing authorisations and prior policy references remain unchanged.

## 12. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 13. Review counting and concurrency

One eligible human approval is the default. Self-approval is allowed with valid Owner/Sponsor capacity unless configured more strictly. Multiple approvals count distinct people on the same version, in any order; combined roles do not count twice. A rejection ends that review. Any proposal edit creates a new version and resets the pending count, preserving old approvals. Reject stale concurrent submissions rather than silently overwriting accepted content. Withdrawn versions remain final; resubmission creates a linked new proposal with fresh review.

An Awaiting Membership task can be authorised with one assignee and due date but cannot start/complete until membership is Active. Draft-project tasks remain drafts; Planned tasks can be authorised but cannot start/complete until Active. Missing required accountability blocks new authorisations/substantive amendments until repaired.

Routine progress notes, additional evidence and permitted lifecycle actions use their ordinary authority. Scope, assignee and deadline amendments require approval by default. Evidence updates do not rewrite the original approval basis. Deleted/hidden evidence remains historically linked and flags review; it is excluded from future AI processing.

## 12. Accepted policy authority and resume-review exception

### Q01 — Configuration authority and delegation (Accepted)

Mandatory protections cannot be disabled: human authorisation, evidence/history, access checks, project credential separation and spending enforcement. Enterprise Administrators control supported role-permission definitions, approval rules, security settings, organisation limits and delegation. PM/Owner/Sponsor may adjust explicitly delegated operational settings: reminders, calendars, categories, stages, permitted minutes audiences, optional finance, approved connections/formats and project AI allowances within organisation bounds. Project delegates cannot edit role-permission definitions or expand their own delegation. Role appointments still follow the existing role-management matrix.

Show each setting's effective value, inheritance and editing authority. Record actor, reason, previous/new values and effective time. Preview impact on access, pending approvals and existing projects. Never silently rewrite existing commitments or approvals. Exact keys, types and any unagreed numerical bounds remain bounded design work; this decision does not invent new ranges.

### Q05 — Deadline review before resume/reopen (Accepted)

A resume review may run while the project remains Deferred or Closed. PM/Deputy lists every outstanding task and subtask and proposes replacement due dates, showing previous dates, statuses and assignees. Owner/Sponsor approves amendments under project approval policy as a narrow exception to read-only restrictions, not a general reopening of approvals.

The actor with existing lifecycle authority then resumes/reopens after required roles and memberships are valid. Only tasks with approved replacement dates may start, resume or complete after activation; others show Deadline review required. Every outstanding task/subtask needs its own replacement date, different from its previous date and not already past when authorised. Partial approvals are allowed; approved tasks proceed independently, subject to parent conditions. Status/assignee remain unchanged unless separately amended. Flag child dates later than parents without automatic adjustment.

For work actually completed during the pause, use the accepted reconciliation exception: actual completion date, explanation/evidence and Owner/Sponsor approval; do not fabricate a future deadline. Reopening does not resend invitations, restore expired access or replay missed notifications.
