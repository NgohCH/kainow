# Kainow V1.0 — Permission Matrix

**Version:** 1.0  
**Date:** 6 November 2026  
**Edition:** Product handover; accepted requirements consolidated, not evidence of implementation or delivery acceptance.  
**Scope:** Product only; development method and environment setup excluded.

## 1. Reading the matrix

This is the current default action catalogue, consolidating the role-specific documents and D01–D70/O01–O17. It does not create new permissions or replace their conditions. **A role not listed for an action has no default authority for that action.** Administrator-configured policy may change supported delegable choices, never the mandatory protections. A newly requested action not covered here requires clarification rather than an inferred management power.

Abbreviations: **EA** Enterprise Administrator; **PM** Project Manager; **DPM** Deputy PM; **O/S** Project Owner or Sponsor. “Participant” means a currently authorised active project participant, including management roles. “Own” is the named author/assignee/requester relationship, not a right over every project record. Audit/Oversight and leadership are additional scopes, not primary project roles. Combining roles gives the valid permissions of each, subject to separation and self-approval rules.

Every action also checks account, organisation/project, membership or independent grant, effective dates, record audience, project state, policy version and relevant record state. Default read access to shared project content does not include restricted sources or finance. Invitations, department affiliation, a link or an AI answer grant no authority. EA has no general source-read or proposal-approval override.

## 2. Organisation, roles and account access

| Action | Default authority | Conditions / reference |
| --- | --- | --- |
| Establish organisation; first project | EA | Controlled first-Administrator invitation closes after acceptance; O07. |
| Create later project | Eligible existing user | Becomes first PM, not automatically Owner/Sponsor; D01. |
| Manage Administrator appointments/recovery | Authorised active EA; controlled custodian recovery if no EA can authenticate | Named accounts; no public promotion; tested procedure before go-live; O07. |
| Establish eligible domains or approve eligibility exception | EA | Same organisation only; domain alone does not invite/admit. |
| Appoint/replace/remove/extend Owner | EA | Maximum one; preserve required accountability. |
| Appoint/replace/remove/extend Sponsor | EA or Owner | Multiple permitted. |
| Appoint/replace/remove/extend PM | EA or O/S | Exactly one; outgoing PM may transfer to eligible accepting replacement; D02. |
| Appoint/replace/remove/extend DPM or Member | PM or O/S | PM and required Member different; no agreed Deputy cap. |
| Invite for role or task allocation | Manager of the affected role | Same-organisation eligibility; no access before acceptance. |
| Accept/decline invitation | Named eligible invitee | Unexpired invitation, current dates/separation; not Deferred/Closed. |
| Revoke unaccepted task-allocation invitation | PM | Preserve records; reassign/amend task through proper approval. |
| Extend expired membership; restore On Hold | Manager of the affected role | Eligibility/investigation/date checks; restoration explicit. |
| Readmit Revoked membership | Role manager invites; person accepts | Fresh process; current RBAC, stable identity/history; D28–D30. |
| Disable/re-enable passwordless account | EA | Disable invalidates sessions/codes, blocks grants, places current memberships On Hold; re-enable alone does not restore project access. |
| Approve email address change | EA | Verify eligible new address, preserve identity/history, invalidate sessions/codes; D70. |
| Read own account/session state; sign out | Authenticated person | Current/all-session sign-out; no personal policy override. |
| Grant/extend/revoke Audit/Oversight | EA or O/S | Recorded request, scope, start/end; no self-approval; 30-day default/90-day default maximum. |
| Suspend/restore independent grant | EA or authorised grant manager | Reason, explicit restoration; expiry continues; O07. |
| Grant leadership summary scope | EA | Explicit project/organisation summary scope, start and optional expiry; D48. |
| Inspect investigation details | Explicitly authorised investigators/role managers | Separate restricted record, minimum disclosure; leadership excluded by default; O07. |
| Approve quarantined-original access | Enterprise Administrator other than requester | Separate security grant, 24-hour default, fresh approval for extension, scoped records/purpose/expiry; no independent approver means blocked; Q03. |
| Inspect quarantined originals | Current security-grant holder | Explicit reveal confirmation and inspection log; no bulk export, email or AI; ordinary Audit/Oversight insufficient; Q03. |

Required-role vacancy on an Active project flags accountability and blocks new approvals/substantive amendments. Existing authorised work and explicitly permitted repairs/protective actions can continue; no automatic access extension (D03). Draft may be incomplete; Planned needs accepted appointments and Active needs Active required memberships. Role separation must hold before the seventh participant activates.

## 3. Project lifecycle and work records

| Action | Default authority | Conditions / reference |
| --- | --- | --- |
| Draft → Planned; Planned → Active | PM or O/S | Mandatory information and role gates; project lifecycle document. |
| Fast-track Draft → Active | PM | All Active required roles/separation, mandatory data, recorded reason; no proposal auto-approval; O08. |
| Active → Deferred | PM or O/S | Reason; ordinary work/invitations locked. |
| Deferred → Active | EA, PM or O/S | Role validity; new authorised dates required before outstanding execution; D08/O10. |
| Active/Deferred → Closed | O/S | Explicit outcome and all required work/question/risk dispositions; D07/O11. |
| Planned → Closed (Abandoned) | O/S | Recorded reason. |
| Closed → Active | O/S | New stage period; deadline review, membership/role checks; no EA-only authority. |
| Manage stage/substage while Active | PM | No implied task completion, approval or status transition. |
| Archive/unarchive project | PM or O/S; configured automatic archive | Only Closed projects; default archive after12 months. Unarchive changes navigation only, stays Closed/read-only; Q04. |
| Draft/submit own proposal | Participant | Human or AI origin explicit; Draft permits drafts, Planned permits authorisation. |
| Prepare/manage proposal revisions | PM or O/S | Named human versions; eligible participant may prepare own draft; no silent overwrite. |
| Authorise/reject proposal or substantive amendment | O/S | Exact version, approval policy, valid project/roles; rejection reason; D04/D11–D15. |
| Withdraw pending proposal | Human proposer or PM | Reason; Withdrawn final, new linked submission for renewed work. |
| Start/block/resume/complete task | Task assignee, PM or DPM | Active project and valid assignee membership; note/reason as required, current authorised due date, child conditions. |
| Reopen completed task | PM or DPM | Reason; reopen completed ancestors in same action. |
| Override parent-completion dependency | PM or DPM | Reason; preserve unfinished children; cannot bypass Delivered requirements. |
| Change task scope, assignee or due date; cancel task | O/S authorises amendment/cancellation | PM/DPM may prepare batch date amendments; Cancelled final. Q05 permits only resume-review date amendments while Deferred/Closed; new dates differ and are not past on authorisation. |
| Supply/edit answer | Participant, editing own answer | Access; versions; competing answers separate. |
| Moderate answer | PM or DPM | Separate moderation history; does not impersonate original author. |
| Resolve/reopen question | Requester, PM or DPM | Reopen to Open, reason/history. |
| Withdraw question | Requester or PM | Reason; renewed work new linked record. |
| Replace/withdraw decision | O/S | Authorisation, affected-work review flags; no automatic downstream change. |
| Maintain risk mitigation | Risk Responsible Person, PM or DPM | Substantive commitments still need approval. |
| Accept exposure / approve risk resolution | O/S | Explanation, evidence where available; responsible person/review date for continuing exposure; O11 closure exception. |
| Reopen Resolved risk | Risk Responsible Person, PM or DPM | Reason, returns Open. |
| Reverse Accepted exposure | O/S | Explicit human authority; preserve acceptance history. |

Self-approval is allowed by default for an eligible O/S, including a valid combined small-team PM/O/S; stricter policy may be configured. Multiple approvals count distinct people, not roles. No person approves their own Audit/Oversight/security grant. AI cannot perform any human authorisation.

## 4. Sources, discussion, AI and history

| Action | Default authority | Conditions / reference |
| --- | --- | --- |
| Read ordinary project records/discussion/project-wide minutes | Participant | Current audience and state; newly admitted members inherit current policy. |
| Read restricted minutes/source | Configured source audience | Default PM/DPM/O/S; explicit Audit/Oversight may extend only scoped read access. |
| Post/reply in shared discussion; query AI; give feedback | Participant | Available permitted sources, current project state, approved AI/caps; feedback not model training. |
| Edit own message | Author | New immutable version and attribution. |
| Moderate shared discussion | PM or DPM | Recorded separately from original contribution. |
| Import/publish minutes | PM, DPM or O/S | Members may submit for review; audience shown before publication. |
| Designate source Project-wide or Restricted; change audience | PM or O/S | Administrator bounds, confirmation and history; O09. |
| Review/publish wider summary from restricted source | PM or O/S | Explicit intended-audience approval; sanitised summary does not widen original. |
| Receive AI answer from restricted material | Requester with source permission | Separately permissioned result; shared reply only if whole intended audience can access. |
| Review/close AI feedback | PM or DPM | Escalate provider/configuration issues to EA; no automatic configuration edits. |
| Inspect ordinary history | Person with current record access | Version retention does not bypass source restrictions. |
| Mark discussion message Deleted | Author, PM or DPM | Logical deletion with actor/time/reason; exclude ordinary use/future processing. |
| Mark imported source Deleted | PM or O/S | Retain source/history and flag affected records. |
| Mark authorised record Deleted | O/S | Must first reach appropriate cancellation/withdrawal/resolution disposition; no erasure of commitments. |
| Inspect Deleted content | Explicit Inspect Deleted Content Audit/Oversight scope | Not automatic for creator/PM/EA; quarantined originals excluded. |
| Restore discussion / source / authorised record | PM or DPM / PM or O/S / O/S approval respectively | Narrow administrative exception while Deferred/Closed. Audience preview, current permissions, prior status/history, no automatic work/AI/email/access revival; Q04. |
| Export visible data | Person with current read access AND enabled export policy | Restricted read alone does not imply bulk export; recheck content/audience, deleted/quarantined exclusions; O14. |

## 5. Resources, money, outputs and dashboards

| Action | Default authority | Conditions / reference |
| --- | --- | --- |
| Maintain organisation resource catalogue | EA or explicit delegate | Retire rather than rewrite historical reference. |
| Maintain project usage indication | PM, DPM or O/S | Usage only; no booking/allocation guarantee. |
| Establish/change budget | O/S approval | Financial Tracking enabled, supported reporting currency, missing not zero. |
| Record expenditure | PM or DPM | History; not proof of payment approval elsewhere. |
| Propose financial correction/manual currency conversion | PM or DPM | Linked original, reason, rate/date where conversion. |
| Approve financial correction/manual conversion | O/S | Approval before changed totals; no automatic FX. |
| Read financial detail | PM, DPM or O/S | Other roles require explicit policy; leadership summaries only. |
| Draft/submit output | Participant | Attribution, source permissions, supported format. |
| Register/file/move/rename output | PM or DPM | Approved external destination; O/S approval for approved version; failures preserve last confirmed reference. |
| Approve deliverable/report/spec version | O/S | Exact version; external edit cannot inherit approval. |
| Transfer owning department | EA | Reason, explicit relocate or retain-approved-location decision; no duplicate project counts. |
| Send manual action-item digest | PM or O/S | Enabled channels; recipient/content rechecked. |
| View personal/project dashboard; adjust own colour/layout/filter | Participant | Direct view controls, supported accessible options; no separate user-settings page. |
| View/configure own leadership summary layout | Explicit leadership grant | Approved summary fields only within granted scope; PM name, departments, scope and progress included by default. |
| View own AI usage | User | Does not disclose source or credentials. |
| View project/person AI usage | PM or O/S | Project scope; DPM not default merely by role. |
| View organisation AI usage | EA | No automatic raw source/secret access. |

## 6. Configuration and protected services

| Action | Default authority | Conditions / reference |
| --- | --- | --- |
| System-wide policy, role-permission definitions, approval/security rules, organisation limits and delegation | EA | Q01: project delegates cannot edit role-policy definitions or expand delegation; mandatory safeguards fixed. |
| Delegated project settings, AI enablement/limits/connections/formats | PM or O/S explicitly delegated | Within EA bounds; project credential control does not reveal saved values. |
| Configure stored API credentials | EA; explicitly delegated project connection manager | Protected write/replace/revoke path; no ordinary secret read/export. |
| Change export/channel/source policy | EA; delegated PM or O/S within bounds | Change is not retroactive approval, access grant or commitment amendment. |

Configuration must not make unsupported actions available by silently interpreting a label. See the [Configuration Catalogue](Kainow-V1.0-Configuration-Catalogue.md) for defaults and [Design Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for contracts still required.

## 7. Accepted state and security clarifications

### Q03 — Investigation and quarantined-original security grants (Accepted)

Project access/membership investigations follow existing role-management authority; findings are visible only to named investigators and authorised role managers. This is separate from permission to inspect quarantined originals that may contain secrets.

Inspecting quarantined originals needs a separate time-limited security grant approved by an Enterprise Administrator other than the requester. Project roles and ordinary Audit/Oversight do not suffice. Record purpose, specific records, requester, approver and expiry. Default duration is 24 hours; extension requires fresh approval. Require explicit confirmation before revealing sensitive content and record each inspection. No bulk export, email inclusion or AI processing of quarantined originals. If no independent Administrator is available, access remains blocked until another designated Administrator is available. No emergency self-grant is introduced. Sanitised information can remain available under ordinary permissions.

### Q04 — Archive, unarchive and restoration (Accepted)

Only Closed projects may be archived. Default archive timing is twelve months after closure, Administrator-configurable; PM/Owner/Sponsor may archive earlier. PM/Owner/Sponsor may unarchive into ordinary navigation, but the project stays Closed/read-only until a separately authorised reopening.

PM/Deputy may restore Deleted discussion messages with a reason/history; PM/Owner/Sponsor may restore Deleted imported sources after reviewing their intended audience; restoring a Deleted authorised record requires Owner/Sponsor approval, retaining its previous lifecycle status and approval history. These are narrowly permitted administrative actions even while Deferred/Closed; they do not reactivate work or reopen the project.

Preview who will regain visibility. Current account, membership, audience and grant restrictions still apply. Restoration never automatically triggers AI, emails, invitations, deadlines or task execution. Quarantined originals cannot return through ordinary restoration; security review must produce a sanitised version. Record actor, time and reason for archive, unarchive and restore.

### Q05 — Deadline review before resume/reopen (Accepted)

A resume review may run while the project remains Deferred or Closed. PM/Deputy lists every outstanding task and subtask and proposes replacement due dates, showing previous dates, statuses and assignees. Owner/Sponsor approves amendments under project approval policy as a narrow exception to read-only restrictions, not a general reopening of approvals.

The actor with existing lifecycle authority then resumes/reopens after required roles and memberships are valid. Only tasks with approved replacement dates may start, resume or complete after activation; others show Deadline review required. Every outstanding task/subtask needs its own replacement date, different from its previous date and not already past when authorised. Partial approvals are allowed; approved tasks proceed independently, subject to parent conditions. Status/assignee remain unchanged unless separately amended. Flag child dates later than parents without automatic adjustment.

For work actually completed during the pause, use the accepted reconciliation exception: actual completion date, explanation/evidence and Owner/Sponsor approval; do not fabricate a future deadline. Reopening does not resend invitations, restore expired access or replay missed notifications.

## 8. Accepted Administrator analytics and operations A02/A05/A07/A12

| Action | Authority | Boundary |
| --- | --- | --- |
| Open Administrator analytics; configure system analytics/report definitions | Enterprise Administrator | Supported event/metric catalogue, organisation/department/project permitted aggregates; no blanket source read. |
| Drill into named person, record/source, finance or investigation detail | Person with the relevant current additional permission | Analytics scope alone is insufficient; recheck every level, cached result and export. |
| Export analytics/report | Current permitted reader with enabled export policy | Recheck at job execution and retrieval; preserve period/filters/definitions/coverage. |
| Approve/install or schedule a release update | Enterprise Administrator | Explicit approval for each release; pre-update backup/compatibility and integrity checks require verified design. |
| Configure installation-wide AI concurrency | Enterprise Administrator | Default two across all projects/workers; supported limits still require exact contract. |
| Configure automatic backups/retention and initiate protected restore | Enterprise Administrator under approved operational procedure | Daily encrypted/30-day default; restore authority never grants ordinary access to credential values or restricted sources. |

[Administrator analytics rules](Kainow-V1.0-Administrator-Analytics-and-Reporting-Rules.md) and [architecture](Kainow-V1.0-Application-Architecture-and-Operations-Design.md) contain the accepted detail.

## 9. Accepted direct-storage and recovery boundaries

Ordinary users access managed source files only through Kainow. Direct SharePoint/OneDrive source-area access is reserved to explicitly designated storage Administrators and the authorised integration identity; EA status alone grants no direct access. Designation authority and provider ACL mechanics require a concrete security contract. Direct storage access does not itself authorise quarantine decryption or project approvals.

Administrator confirmation restores normal writable operation from protective read-only mode only after capacity restoration and successful health checks. Recovery must preserve current access/revocation boundaries; credentials remain protected. [Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md)
