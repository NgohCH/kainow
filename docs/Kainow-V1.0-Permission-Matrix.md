# Kainow V1.0 — Permission Matrix

**Version:** 1.0  
**Date:** 6 November 2026  
**Edition:** Product handover; accepted requirements consolidated, not evidence of implementation or delivery acceptance.  
**Scope:** Product only; development method and environment setup excluded.

## 1. Reading the matrix

This is the current default action catalogue, consolidating the role-specific documents and D01–D83/O01–O17. It does not create new permissions or replace their conditions. **A role not listed for an action has no default authority for that action.** Administrator-configured policy may change supported delegable choices, never the mandatory protections. A newly requested action not covered here requires clarification rather than an inferred management power.

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
| Grant leadership summary scope | EA | Explicit project/organisation summary scope, start and optional expiry; D48. Sub-project 7 sets the scopes: organisation, departments (owned projects now and later) or named projects; never to themselves; D89. |
| Inspect investigation details | Explicitly authorised investigators/role managers | Separate restricted record, minimum disclosure; leadership excluded by default; O07. |
| Designate/undesignate security reviewer | EA, never for themselves | Reason recorded in security-reviewer history; Organisation page; D82. |
| Request quarantined-original access | Designated security reviewer | Names cases by reference, project and item kind (never content), with a purpose and duration (default 24 hours); D82. |
| Approve/decline/extend quarantined-original access | Enterprise Administrator other than requester | Separate security grant, 24-hour default, fresh approval for extension, scoped records/purpose/expiry; no independent approver means blocked; Q03, D82. |
| Revoke quarantined-original access | Any EA | Ends the grant at once; reason recorded. |
| Inspect quarantined originals | Current security-grant holder | Explicit reveal confirmation and inspection log; no bulk export, email or AI; ordinary Audit/Oversight insufficient; Q03. |
| Release a quarantine case unchanged (false alarm) | Current security-grant holder naming the case | Reason; every original returns except a value changed since cleaning, which is listed and not overwritten; Administrators notified; D82. |
| See quarantine cases (no content) | EA | Case reference, project, item kind, state, waiting-for-key and known disclosures; never the marked text or the original. |

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
| Start Restricted meeting | PM, DPM or O/S | Audience shown before starting; the meeting and its published minutes share one audience (D75). |
| End meeting | Starter, PM, DPM or O/S | Triggers a final AI minutes draft (D74). |
| Edit draft minutes | Starter, PM, DPM or O/S | Once edited, automatic refreshes stop for that meeting (D74). |
| Publish draft minutes / submission | PM, DPM or O/S | A chosen draft version becomes a minutes source with its audience (D74). |
| Submit minutes for review | Participant | Reviewed by PM, DPM or O/S before publication. |
| Return submission | PM, DPM or O/S | Returned to the submitter with a reason. |
| Escalate AI feedback | PM or DPM | Provider/configuration issues to EA (see Review/close AI feedback). |
| Designate source Project-wide or Restricted; change audience | PM or O/S | Administrator bounds, confirmation and history; O09. |
| Review/publish wider summary from restricted source | PM or O/S | Explicit intended-audience approval; sanitised summary does not widen original. |
| Receive AI answer from restricted material | Requester with source permission | Separately permissioned result; shared reply only if whole intended audience can access. |
| Share AI answer into thread | Requester (a participant who can post in the thread) | Only when safe for the thread audience: every passage sent to the AI is readable by the whole audience; otherwise a new answer is built for that thread (D76). |
| Review shared AI answers and drafts | PM or DPM | Clear or withdraw an item hidden after material it used was hidden, deleted or restricted; private questions are never shown to them (D76, D77). |
| Request draft report | Participant | Labelled "AI draft — not approved"; private until shared; PM or DPM may also edit and share it; approval and filing belong to the outputs capability (D77). |
| Request shareable summary draft | PM, DPM or O/S in the source audience | Deputy may draft a summary but not approve it (D78). |
| Approve shareable summary | PM or O/S in the original's audience | One version for a stated audience, shown before confirming; original's audience never widens (D78). |
| Confirm/withdraw summary under review | PM or O/S | Applies when "Access review required" or hidden pending review (D78). |
| Review/close AI feedback | PM or DPM | Escalate provider/configuration issues to EA; no automatic configuration edits. |
| Inspect ordinary history | Person with current record access | Version retention does not bypass source restrictions. |
| Mark discussion message Deleted | Author, PM or DPM | Logical deletion with actor/time/reason; exclude ordinary use/future processing. |
| Mark imported source Deleted | PM or O/S in the source audience | Draft, Planned or Active only; reason (credential-checked); retain source/history and flag affected records; refused while held for a suspected credential. |
| Mark authorised record Deleted | O/S; PM under a current D83 delegation | Draft, Planned or Active only; must first reach appropriate cancellation/withdrawal/resolution disposition (the refusal names the state needed); subtasks deleted with their parent; no erasure of commitments. |
| Delegate/revoke record deletion and restoring | O/S | Per project, to the PM only (never a Deputy), with a reason; one delegation per project; revocable by any O/S; ends when the PM changes; O/S notified in-app of each deletion or restoration under it; D83. |
| Inspect Deleted content | Explicit Inspect Deleted Content Audit/Oversight scope | Chosen when the grant is requested; within the grant's project and audience rules; read-only and labelled; each opening recorded; no AI, search or export. Not automatic for creator/PM/EA; held items and quarantined originals excluded. |
| Restore discussion / source / authorised record | PM or DPM / PM or O/S / O/S, or PM under D83 | Any project state (narrow administrative exception while Deferred/Closed). Audience preview naming who regains visibility, current permissions, prior status/history, no automatic work/AI/email/access revival; a parent brings back only the subtasks deleted with it; Q04, D83. |
| See project History of deletions and reports | Participant or Active grant holder | Kind, actor, time and reason, never the title or text; titles only for Inspect Deleted Content holders; a credential report line names its reporter only to PM, O/S and EA. |
| Report a suspected secret | Anyone who can currently read the item, including Audit/Oversight grant holders | Any project state (protective); marks the exact text and gives a reason; the item is held at once and every copy cleaned; D80, D81. |
| Review, mark more and release a cleaned item | PM or O/S in the item's audience | Any project state (protective); sees the cleaned text only, never the original; reason on release; confirmed copies return with it; D81. |
| Confirm/dismiss possible copies | PM or DPM | Any project state (protective); kind, reference and date only, never the marked text; a dismissed place gets its original back; D80. |
| Export visible data | Person with current read access AND enabled export policy | Restricted read alone does not imply bulk export; recheck content/audience, deleted/quarantined exclusions; O14. |
| Export project records as CSV (tasks, decisions, questions, risks, output register) | Person who may read the project's content, while "Project exports allowed" is On, holding one of the project's export roles (default PM, Deputy, Owner, Sponsor; may include Member, Audit, Oversight) | Sub-project 9, D106: any project state; never Deleted content, uncleaned held items, source or message text, quotes, restricted material or private AI questions; each export recorded (`project.exported`). A saved output-register export holds only outputs every content reader may read (build ruling, 20–21 November 2026). Action `output.export`. |

## 5. Resources, money, outputs and dashboards

| Action | Default authority | Conditions / reference |
| --- | --- | --- |
| Maintain organisation resource catalogue (items and categories) | EA or a named catalogue maintainer | Retire rather than rewrite historical reference; reason on each change; designed in sub-project 8 (`docs/superpowers/specs/2026-11-20-v1-resources-budget-design.md`, section 8). |
| Name or remove catalogue maintainers | EA | Reason; a maintainer manages the catalogue only and gains no other authority; C76. |
| View project resources (lines, people, overlap warning) | Participant and Audit/Oversight grant holders | Never shows another project's quantity, notes or status; leadership holders see summary fields only; any project state; D91. |
| Maintain project resource lines (replaces the earlier usage indication) | PM, DPM or O/S | Open projects; create, edit, change status, cancel; usage only, no booking or allocation guarantee; D91. |
| Propose budget | PM, DPM or O/S | Financial Tracking Enabled, Open project; goes through the project approval policy; D92. |
| Approve budget | O/S | Financial Tracking Enabled; approval policy count and distinct people apply; D03 block; until approved the budget reads Not provided; D92. |
| Record expenditure | PM or DPM | Financial Tracking Enabled, Open project; history; not proof of payment approval elsewhere; D92. |
| Propose financial correction, refund or manual currency conversion | PM or DPM | Linked original, reason, rate/date where conversion; refund must reference a recorded entry; D92. |
| Approve financial correction, refund or manual conversion | O/S | Approval before changed totals; no automatic FX; approval policy and D03 apply; D92. |
| Read financial detail | PM, DPM or O/S | Project policy may add Members and/or Audit/Oversight holders (C80); Administrator standing alone is not finance access; leadership summaries only; any project state; D94. |
| Change project finance settings (tracking, reporting currency, warning thresholds, financial-detail readers) | PM, O/S when delegated; EA always | Reason; recorded with previous and new values; currency fixed once any budget or spending exists; Open project; Deputies read-only; D93, D94. |
| Change organisation finance settings (delegation switch, default and enabled currencies, default thresholds) | EA | Reason; history kept; D94, C78, C79. |
| Draft/submit output | Participant | Attribution, source permissions, supported format. |
| Register/file/move/rename output | PM or DPM | Approved external destination; O/S approval for approved version; failures preserve last confirmed reference. |
| Submit an output (draft, upload, link, saved export) | Active PM, DPM, O/S or Member | Sub-project 9, D100: project not Deferred or Closed; format allowed; credential check. Action `output.submit`. |
| Register, decline, set type/categories/issue date/contributors, add versions, accept a submission into a registered output, file, withdraw, delete and restore register entries | PM or DPM | Sub-project 9, D100/D103: project not Deferred or Closed, except delete/restore (sub-project 5 rules); each contributor's department is chosen at registration and never rewritten. Action `output.manage`. |
| Request approval of an output version | PM or DPM | Sub-project 9: filed (or checked link), last check not Changed/Missing/Access denied; a Draft version cannot be approved once a later version is approved. Action `output.approve_request`. |
| Approve an output version | O/S under the project approval policy | Sub-project 9: `approve_output` change request; not while Deferred or Closed; approval approves the content, not the commitments in it. |
| Set or change an output's audience; clear or withdraw "Access review required" | PM or O/S who can read the project and the remaining material | Sub-project 9, D101: widening previews the names who gain access; audience membership not required (build ruling, 20–21 November 2026). Action `output.audience`. |
| Read outputs and open filed files | Output readers (content readers, limited to a Restricted audience and the review rule) | Sub-project 9: leadership grants never; opening goes through Kainow's check before redirecting. |
| Relink a moved or renamed file within approved destinations; register a changed file as a new version | PM or DPM | Sub-project 9, D107: only files Kainow filed can be registered as a new version. |
| Approve a new place as a destination so a file moved there can be relinked | EA | Sub-project 9, D107: through destination approval; no separate flow. |
| Project output settings (destination, formats, export roles) | PM or O/S when delegated; otherwise EA | Sub-project 9: reason; versioned. Action `outputs.settings`. |
| Change (transfer) owning department (move or keep the filed folder) | EA | Sub-project 9, D108: reason and an explicit folder choice (move the filed folder, or keep it at its approved location); refused while an earlier move has failed and not been retried; no duplicate project counts. |
| Report a suspected secret in an output | Any output reader | Sub-project 9, D80: a held output file is withheld from storage. |
| Approve deliverable/report/spec version | O/S | Exact version; external edit cannot inherit approval. |
| Send manual action-item digest | PM or O/S | Enabled channels; recipient/content rechecked. |
| View personal dashboard | Any signed-in Active account | Only own items and projects visible today; D88. |
| View project dashboard and timeline | `project.view` (participants and Audit/Oversight holders) | Pending invitation names shown to PM, Deputy, Owner and Sponsor; D88. |
| Change own display preferences (theme, accent, layout, filters) | Any signed-in user | Presentation only; no reason, no audit row; cannot change rights, metric meaning or hidden warnings. |
| Grant, change or revoke leadership access | EA, never to themselves | Reason, start date, optional end date and scope (whole organisation, departments now and later, or named projects); gives no matrix action and no project access; revoking ends access at once; D89. |
| View/configure own leadership summary layout | Holder of an Active leadership grant | Approved summary fields only within granted scope, never project content, discussions, minutes, quotes or management actions; PM name, departments, scope and progress included by default; D89. |
| View own AI usage | User | Does not disclose source or credentials. |
| View project/person AI usage | PM or O/S | Project scope; DPM not default merely by role. |
| View organisation AI usage | EA | No automatic raw source/secret access. |

## 6. Configuration and protected services

| Action | Default authority | Conditions / reference |
| --- | --- | --- |
| System-wide policy, role-permission definitions, approval/security rules, organisation limits and delegation | EA | Q01: project delegates cannot edit role-policy definitions or expand delegation; mandatory safeguards fixed. |
| Delegated project settings, AI enablement/limits/connections/formats | PM or O/S explicitly delegated | Within EA bounds; project credential control does not reveal saved values. |
| Configure stored API credentials | EA; explicitly delegated project connection manager | Protected write/replace/revoke path; no ordinary secret read/export. AI connection rows: section 10. |
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
| Export analytics/report | Current permitted reader with enabled export policy | Recheck at job execution and retrieval; preserve period/filters/definitions/coverage. Sub-project 7: Enterprise Administrator while "Analytics export allowed" is On; each export recorded. |
| Save own analytics views; read the event definitions | Enterprise Administrator (`analytics.view`) | Counts only below project level unless also a participant; saved views never expand rights. |
| Change access settings (archive delay, Audit/Oversight grant lengths, invitation validity, analytics export) | Enterprise Administrator (`organisation.manage`) | Reason; bounds of D90; applies to invitations sent and grants requested or extended afterwards. |
| Storage connection, destinations, directory lookup, scheduled checks, approved formats, delegation switches, source-area move, storage manifest | Enterprise Administrator (`storage.manage`) | Sub-project 9, D102/D104: reason; the client secret is entered through a protected form and never shown again. |
| Report types (add, rename, retire) | Enterprise Administrator (`organisation.manage`) | Sub-project 9, R14: retiring keeps history and blocks new selection. |
| Designate or end a storage Administrator | Enterprise Administrator, never for themselves | Sub-project 9, D104: reason; Kainow grants and revokes direct write on the source area's recorded `projects` folder. |
| Project exports allowed | Enterprise Administrator (`organisation.manage`) | Sub-project 9, D106: reason; Access and records page; Off by default. |
| Approve/install or schedule a release update | Enterprise Administrator | Explicit approval for each release; pre-update backup/compatibility and integrity checks require verified design. |
| Configure installation-wide AI concurrency | Enterprise Administrator | Default two across all projects and workers; 1 to 10, held in the database so it holds across every worker process; changed with a reason, recorded with the previous and new values. |
| Configure automatic backups/retention and initiate protected restore | Enterprise Administrator under approved operational procedure | Daily encrypted/30-day default; restore authority never grants ordinary access to credential values or restricted sources. |

[Administrator analytics rules](Kainow-V1.0-Administrator-Analytics-and-Reporting-Rules.md) and [architecture](Kainow-V1.0-Application-Architecture-and-Operations-Design.md) contain the accepted detail.

## 9. Accepted direct-storage and recovery boundaries

Ordinary users access managed source files only through Kainow. Direct SharePoint/OneDrive source-area access is reserved to explicitly designated storage Administrators and the authorised integration identity; EA status alone grants no direct access. Designation authority and provider ACL mechanics require a concrete security contract. Direct storage access does not itself authorise quarantine decryption or project approvals.

Administrator confirmation restores normal writable operation from protective read-only mode only after capacity restoration and successful health checks. Recovery must preserve current access/revocation boundaries; credentials remain protected. [Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md)

## 10. Accepted AI configuration (V1.0 sub-project 6, D84–D87)

| Action | Authority | Boundary |
| --- | --- | --- |
| Approve, change or withdraw an AI model | Enterprise Administrator | Reason; provider terms recorded; never deletes. |
| Set organisation AI limits, policy numbers and delegation switches | Enterprise Administrator | Reason; bounds of D87 (attempts 1–5, timeout 30–300 seconds, requests at once 1–10). |
| Add, replace the key of, reorder, disable or enable, or check a project AI connection | Enterprise Administrator; PM, Owner or Sponsor while "projects may manage AI connections" is on | Reason; Draft, Planned or Active projects only (disable also when Deferred or Closed); the key is never shown. |
| Set project AI limits | Enterprise Administrator; PM, Owner or Sponsor while "projects may set AI limits" is on | Reason; never above the Administrator's ceiling; Draft, Planned or Active projects only. |
| See a project's AI connections (labels, models, states, last used; never keys) | PM, Deputy PM, Owner, Sponsor; Enterprise Administrator | Deputies see but cannot change. |
| View own, project or organisation AI usage | As the usage rows of section 5 | Unchanged. |

The Administrator rows are the action `ai.settings.manage`; the project rows are `ai.connections.manage`, `ai.limits.manage` and `ai.connections.view`, decided with the delegation switch passed in. Turning delegation off or lowering the ceiling leaves an existing project value in force; the delegate can no longer change it.
