# Kainow V1.0 — Sign-in, Access Requests and Account Lifecycle Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules and configurable settings  
**Scope:** Passwordless sign-in, account eligibility and disabling, project membership holds, restoration/readmission, and additional Audit/Oversight permissions. Development methods and environment setup are excluded.

## 1. Purpose and relationship to earlier documents

Kainow separates organisation-wide account eligibility from access to individual projects. An enabled account does not by itself grant project membership, and a project Manager cannot override an Administrator-disabled account.

This document supplements the V1.0 Product Summary and the accepted role-management, invitation/membership, project-lifecycle, configurable business-rule, discussion-access and core-record documents.

It resolves three earlier open matters:

- Audit/Oversight permissions coexist with a main project role as additional scoped grants.
- A membership On Hold can be restored after investigation without a fresh invitation, subject to current eligibility and permissions.
- A Revoked membership requires fresh invitation and acceptance; the former membership is not simply reactivated.

## 2. Passwordless sign-in and eligibility

- Passwordless sign-in only, using an approved method that verifies control of the invited email address.
- Do not create or store a Kainow account password.
- Eligibility requires the approved organisational domain rules and explicit invitation. Domain matching alone does not create access.
- Invitations remain limited to the same organisation under V1.0 eligibility rules.
- The Enterprise Administrator determines organisational eligibility and permitted exceptions within that boundary.
- Sign-in links/codes are single-use and have configurable validity.
- Account recovery must not introduce a password or silently bypass eligibility.

Disabling passwordless sign-in for an individual suspends their ability to access Kainow; it does not enable an alternative password-based route.

## 3. Separate account, membership and grant states

### Account states

| State | Meaning |
| --- | --- |
| Invited | The person has been invited but has not completed account admission. |
| Active | The organisation account is enabled and eligible to sign in, subject to verification and current policy. |
| Disabled | Organisation-wide sign-in and access are disabled. |

Account Active does not imply Active membership in any project.

### Project membership states

The invitation/membership document defines Scheduled, Active, Expired and Revoked membership. Add **On Hold**:

| State | Meaning |
| --- | --- |
| On Hold | Membership access is temporarily suspended pending investigation and an authorised restoration or revocation decision. Roles, assignments and history are preserved. |

Invitation status remains separate. On Hold is not the same as Declined, Expired or Revoked, and project Deferred status is not a membership hold.

### Additional access grants

Audit and Oversight are additional project-scoped permission grants, separate from the main project role. They do not require replacing that main role and do not permit otherwise prohibited management-role combinations.

## 4. Disabling an account and placing membership On Hold

When the Enterprise Administrator disables an individual's sign-in:

1. Block organisation-wide account access.
2. Invalidate active sessions and pending sign-in links/codes.
3. Place current project memberships On Hold and preserve their roles, assignments and history.
4. Alert each affected Project Manager for investigation.

Existing Expired or Revoked memberships must not be revived by this process. No project or additional grant can bypass the disabled account's access restriction.

### While On Hold

- No project access is granted through that membership.
- Tasks remain assigned and visibly flagged for Manager attention.
- Do not automatically reassign, complete or cancel tasks.
- Membership and time-limited grant expiry continue.
- Preserve historical contributions, approvals and activity.
- Clearing a hold cannot revive an expired or revoked appointment.

## 5. Investigation and restoration from On Hold

- The Project Manager investigates and records the finding and recommended restoration or revocation.
- Actions must remain within the accepted role-management permissions.
- Where the Manager lacks authority over the affected role, submit the finding to an authorised role manager.
- A Manager cannot independently restore organisation-wide sign-in when the Administrator has disabled it.

### On Hold → Active

An authorised role manager may restore membership to Active when:

- The account is enabled and organisational eligibility is valid.
- Membership dates remain valid and its start date has been reached.
- Current RBAC and role-separation requirements are satisfied.
- The investigation outcome and restoration reason are recorded.

**No new invitation is required for this On Hold restoration.**

If the appointment has expired, the authorised extension rules apply first. A future-dated appointment must not become Active before its start date; its Scheduled treatment must respect the membership rules.

Re-enabling the organisation account alone does not clear project holds. Each affected project requires its own authorised disposition.

## 6. Revocation and fresh readmission

If membership is Revoked, readmission follows the new-admission process:

1. An authorised person issues a fresh project invitation.
2. The recipient explicitly accepts it.
3. Current organisational eligibility, membership dates, RBAC and role-separation rules are checked.
4. The newly authorised membership takes effect under the applicable project-state restrictions.

### Identity, role and historical activities

- Link readmission to the same person's stable identity.
- Assign the role authorised in the new invitation. Do not automatically reinstate former privileges.
- Preserve and reconnect historical contributions, approvals and activity records.
- Current RBAC determines which historical information the readmitted person may view.
- Preserve the earlier revocation and new admission as separate history events.
- Do not automatically restore expired Audit/Oversight grants, completed/cancelled work or previous task access beyond the new permissions.

Past activities remain preserved. Readmission restores permitted access to them, not a rewritten history or blanket return of the old role.

## 7. Account restoration, email changes and sign-out

### Account restoration

- Restoring a Disabled account requires Enterprise Administrator action and fresh eligibility verification.
- Do not automatically restore expired/revoked project appointments or clear On Hold memberships.
- Membership restoration or readmission follows Sections 5 and 6.

### Email changes

- Verify control of the new address and confirm organisational eligibility.
- Preserve the person's stable identity and historical attribution.
- An email change must not silently create a duplicate identity or bypass current access restrictions.

### Sign-out and session duration

- Sign-out ends the current session.
- Provide a separate **Sign out all sessions** action.
- Configure inactivity and maximum-session durations centrally.
- Recheck permissions when protected information is accessed rather than relying only on permissions at sign-in.

## 8. Audit/Oversight access requests

### Request contents

Record:

- Requested project.
- Purpose.
- Requested scope.
- Start and end dates.

### Approval and access

- Enterprise Administrator, Project Owner or Project Sponsor may approve within their authority.
- Nobody approves their own request.
- Grant only the approved scope and period.
- Expiry or revocation removes that additional access automatically.
- A denied, expired or revoked grant does not remove unrelated valid project permissions.
- Restoring ordinary membership does not automatically restore expired grants.
- Administrator/leadership status is not blanket source access. Project members read shared discussion and ordinary minutes; management roles read restricted minutes only under the configured audience.
- A disabled account cannot exercise a grant, even if its grant period has not expired.

### History

Record access requests, approvals, extensions, revocations and protected discussion access. History and previews must continue to protect restricted information and secrets.

## 9. Role-management safeguards

- Apply the accepted role-management matrix to restoration, revocation and extensions.
- Enterprise Administrator is a backup authority for managing Project Managers, not an automatic reader of project discussions.
- Do not let role changes bypass required-role or small-team separation rules.
- Membership expiry must not silently extend access to preserve required project roles.
- Flag missing required accountability and block project activation/resumption until the required roles are restored, as defined by the membership rules.
- Prevent removal or disabling of the final active Enterprise Administrator without a replacement.

The last-Administrator safeguard applies to product administrative actions. This document does not promise continued access if an external identity or email service becomes unavailable.

## 10. Configuration and locations

- The Enterprise Administrator manages system-wide sign-in/session settings and permitted delegation through System Settings.
- Configure approved passwordless methods, sign-in-link/code validity, inactivity limits and maximum-session durations centrally.
- Project Managers, Owners and Sponsors manage only explicitly delegated project settings within their role authority.
- There is no separate User Settings page; this does not remove the accepted sign-out actions.
- Configuration cannot introduce passwords, bypass explicit invitation/eligibility, fabricate acceptance or remove access history.
- Changes preserve actor, reason, previous/new non-secret settings, effective date/time and policy version.
- Dates and presentation follow UTC+8.

## 11. Superseded interpretations

This document supersedes any earlier interpretation that:

- Audit/Oversight must replace a person's main project role.
- Revoked membership can be restored simply by changing its status or date.
- Re-enabling an account automatically restores every project membership.
- An On Hold membership always needs a new invitation before eligible authorised restoration.

Earlier historical records remain preserved. These clarifications do not authorise unrelated changes to existing appointments.

## 12. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 13. Accepted access defaults and recovery

### Accepted O07 — Administrators, recovery, investigation and grants

Two or more people can be designated Enterprise Administrators, each using a named account with individually attributed actions; no shared administrator account is required. Controlled initial setup uses a one-time invitation and closes after acceptance. Existing active Administrators can restore another eligible Administrator. If none can authenticate, a designated organisational system custodian operates the controlled recovery procedure; there is no public self-service promotion route. Nominate recovery custodian/address and verify the procedure before go-live. Recovery preserves identity/history and does not restore project access automatically.

Detailed investigation findings remain separate from ordinary discussion and limited to authorised investigators/role managers. Affected people receive the decision and appropriate explanation; leadership has no default findings access. If PM is affected, notify eligible Owner/Sponsor, then Administrator with minimal necessary details.

Account disablement blocks all grants. Administrator/authorised grant manager may suspend an independent grant with a reason without creating membership. Restoration is explicit and expiry continues. User-owned schedules pause on disablement; project-owned analysis/digests can continue only with valid authority/configuration, no impersonation and current audience checks.

Sign-in uses single-use emailed code: ten minutes validity and five incorrect attempts. Resend invalidates the old code. Sessions default thirty-minute inactivity/twelve-hour maximum, with warning and recoverable drafts. Administrator approves verified eligible email changes, preserving identity/history and invalidating sessions/codes. Grants default thirty days, maximum ninety per grant/extension unless Administrator changes the maximum; no self-approval/automatic renewal. Independent grants can be suspended directly without creating membership.

## 14. Accepted investigation and security-grant separation

### Q03 — Investigation and quarantined-original security grants (Accepted)

Project access/membership investigations follow existing role-management authority; findings are visible only to named investigators and authorised role managers. This is separate from permission to inspect quarantined originals that may contain secrets.

Inspecting quarantined originals needs a separate time-limited security grant approved by an Enterprise Administrator other than the requester. Project roles and ordinary Audit/Oversight do not suffice. Record purpose, specific records, requester, approver and expiry. Default duration is 24 hours; extension requires fresh approval. Require explicit confirmation before revealing sensitive content and record each inspection. No bulk export, email inclusion or AI processing of quarantined originals. If no independent Administrator is available, access remains blocked until another designated Administrator is available. No emergency self-grant is introduced. Sanitised information can remain available under ordinary permissions.
