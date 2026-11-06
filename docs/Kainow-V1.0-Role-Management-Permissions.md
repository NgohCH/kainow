# Kainow V1.0 — Role-Management Permissions

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules  
**Scope:** Authority to appoint, replace, remove and extend project roles. This is the role-management section of the permission matrix, not the complete product permission matrix.

## 1. Purpose and relationship to the product summary

This document defines who may manage each project role in Kainow V1.0. It supplements **Kainow-V1.0-Product-Summary.md** and resolves that summary's open question about role appointment and expiry-extension authority.

It can be read independently for role-management decisions. Other permissions—such as editing tasks, authorising proposals, reading discussions and managing AI settings—are outside this document except where needed to distinguish them from role-management authority.

## 2. Accepted permission matrix

The authority in this table covers **appointment, replacement, removal and expiry extension**, subject to the safeguards and exceptions below.

| Role being managed | Who may manage it |
| --- | --- |
| Project Owner | Enterprise Administrator. |
| Project Sponsor | Enterprise Administrator or Project Owner. |
| Project Manager | Enterprise Administrator, Project Owner or Project Sponsor. The existing Project Manager may also transfer responsibility to an eligible replacement. |
| Deputy Project Manager | Project Manager, Project Owner or Project Sponsor. |
| Member | Project Manager, Project Owner or Project Sponsor. |
| Audit | Enterprise Administrator, Project Owner or Project Sponsor, following a recorded request and with an expiry date. |
| Oversight | Enterprise Administrator, Project Owner or Project Sponsor, following a recorded request and with an expiry date. |

### Enterprise Administrator as backup

The Enterprise Administrator can manage the Project Manager role as a backup to the Project Owner and Sponsors. This includes appointment, replacement, removal and expiry extension. It does not depend on the Administrator holding a project role.

This backup authority does not automatically grant access to underlying project discussions.

### Project Manager transfer

An existing Project Manager can transfer responsibility to an eligible replacement. This is a transfer permission, not unrestricted authority to manage other Project Manager appointments.

The transfer must preserve the project's required roles and applicable role-separation rules.

## 3. Project-creation exceptions

- The Enterprise Administrator creates the first project and establishes its initial role assignments consistently with this matrix.
- Subsequently, an eligible existing Kainow user who creates a new project becomes its first Project Manager.
- Becoming the first Project Manager does not automatically make that person Owner, Sponsor, Auditor or Oversight holder.
- Further role appointments follow this matrix and the small-team combination rules.

## 4. Required project roles

Required accountability at transition: Draft may be incomplete; Planned requires accepted appointments (including eligible Scheduled memberships); Active/resumption requires Active appointments and valid separation. The required set is:

- Exactly one accountable Project Manager.
- At least one Member who is a different person from the required Project Manager.
- At least one Project Owner or Project Sponsor.

A project may have:

- A maximum of one Project Owner.
- Multiple Project Sponsors.
- Both an Owner and Sponsors, although neither role is individually mandatory when the other exists.
- Optional Deputy Project Managers; no numerical cap has been agreed.
- Multiple Audit and Oversight appointments.

Role-management permission does not permit a change that violates these requirements. Plan replacements before controlled removal. Natural expiry removes access even without a replacement. Flag missing accountability, block new authorisations/substantive amendments, permit existing authorised work and authorised repairs, and block activation/resumption until required roles are valid. No silent access extension.

## 5. Small teams and role separation

- A small team has fewer than seven distinct active project participants: at most six people, including role holders.
- One person holding multiple roles counts as one person.
- In a small team, Project Manager, Owner and Sponsor responsibilities may be combined.
- The required Project Manager and Member must remain different people.
- At seven or more people, Project Manager, Owner and Sponsor responsibilities must be held by different people, where those roles exist.
- Conflicting combined assignments must be resolved before the seventh participant's membership becomes active.
- Previous approvals and history remain preserved when responsibilities are separated.
- A person may hold different roles in different projects. The accepted small-team combination is the exception to the general one-role-per-project rule.

## 6. Membership dates and expiry

- Every membership has a start date.
- A start or restored membership date cannot precede project creation.
- Membership expiry is configurable; there is no mandatory six-month default.
- A project may start without a planned end date. Membership dates do not depend on having a project end date.
- Audit and Oversight appointments must have an expiry date and remain time-limited.
- Expiry extensions follow the authority in Section 2.
- Extending an appointment does not grant additional roles or permissions.

## 7. Content access and additional grants

Shared project discussions and ordinary project minutes are readable by active participants within project policy. Restricted minutes use the configured audience, default PM/Deputy/Owner/Sponsor. Audit/Oversight are additional scoped grants alongside main roles, not an automatic requirement for all discussion access. Grant default is thirty days, maximum ninety days per grant/extension unless Administrator changes that maximum. Nobody approves their own grant. Deleted-content inspection needs its own scope; security-quarantined originals require separate security access. Leadership access remains summary-only.

## 8. History and attribution

Every role appointment, replacement, transfer, removal and extension must record its actor and history. Expiry changes retain the previous and new dates. Earlier role assignments and approvals must remain traceable.

Role-management authority does not itself confer proposal-authorisation authority, AI-setting authority or other capabilities assigned to a different role. A person must hold the relevant permission separately.

## 9. Complete permissions reference

This file covers role management. The complete action catalogue is [Permission Matrix](Kainow-V1.0-Permission-Matrix.md). Administrator backup PM management does not grant general source access or Owner/Sponsor approval powers. Two or more named Enterprise Administrators are supported; no shared account is required.


## 10. Accepted operational detail

### Accepted O07 — Administrators, recovery, investigation and grants

Two or more people can be designated Enterprise Administrators, each using a named account with individually attributed actions; no shared administrator account is required. Controlled initial setup uses a one-time invitation and closes after acceptance. Existing active Administrators can restore another eligible Administrator. If none can authenticate, a designated organisational system custodian operates the controlled recovery procedure; there is no public self-service promotion route. Nominate recovery custodian/address and verify the procedure before go-live. Recovery preserves identity/history and does not restore project access automatically.

Detailed investigation findings remain separate from ordinary discussion and limited to authorised investigators/role managers. Affected people receive the decision and appropriate explanation; leadership has no default findings access. If PM is affected, notify eligible Owner/Sponsor, then Administrator with minimal necessary details.

Account disablement blocks all grants. Administrator/authorised grant manager may suspend an independent grant with a reason without creating membership. Restoration is explicit and expiry continues. User-owned schedules pause on disablement; project-owned analysis/digests can continue only with valid authority/configuration, no impersonation and current audience checks.

## 11. Accepted policy and investigation boundaries

### Q01 — Configuration authority and delegation (Accepted)

Mandatory protections cannot be disabled: human authorisation, evidence/history, access checks, project credential separation and spending enforcement. Enterprise Administrators control supported role-permission definitions, approval rules, security settings, organisation limits and delegation. PM/Owner/Sponsor may adjust explicitly delegated operational settings: reminders, calendars, categories, stages, permitted minutes audiences, optional finance, approved connections/formats and project AI allowances within organisation bounds. Project delegates cannot edit role-permission definitions or expand their own delegation. Role appointments still follow the existing role-management matrix.

Show each setting's effective value, inheritance and editing authority. Record actor, reason, previous/new values and effective time. Preview impact on access, pending approvals and existing projects. Never silently rewrite existing commitments or approvals. Exact keys, types and any unagreed numerical bounds remain bounded design work; this decision does not invent new ranges.

### Q03 — Investigation and quarantined-original security grants (Accepted)

Project access/membership investigations follow existing role-management authority; findings are visible only to named investigators and authorised role managers. This is separate from permission to inspect quarantined originals that may contain secrets.

Inspecting quarantined originals needs a separate time-limited security grant approved by an Enterprise Administrator other than the requester. Project roles and ordinary Audit/Oversight do not suffice. Record purpose, specific records, requester, approver and expiry. Default duration is 24 hours; extension requires fresh approval. Require explicit confirmation before revealing sensitive content and record each inspection. No bulk export, email inclusion or AI processing of quarantined originals. If no independent Administrator is available, access remains blocked until another designated Administrator is available. No emergency self-grant is introduced. Sanitised information can remain available under ordinary permissions.
