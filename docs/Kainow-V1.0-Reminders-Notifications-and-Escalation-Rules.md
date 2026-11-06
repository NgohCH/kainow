# Kainow V1.0 — Reminders, Notifications and Escalation Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product defaults, configurable within mandatory safeguards  
**Scope:** Task reminders, overdue and parent-deadline escalation, deferral/resumption, risk-review notifications, delivery channels and configuration. Development methods and environment setup are excluded.

## 1. Purpose and related documents

Notifications help people act on authorised work without creating duplicate messages, exposing restricted information or changing commitments automatically.

This document supplements:

- **Kainow-V1.0-Product-Summary.md**.
- **Kainow-V1.0-Role-Management-Permissions.md**.
- **Kainow-V1.0-Project-Lifecycle-Rules.md**.
- **Kainow-V1.0-Proposals-and-Configurable-Business-Rules.md**.
- **Kainow-V1.0-Task-and-Subtask-Lifecycle-Rules.md**.
- **Kainow-V1.0-Invitation-and-Membership-Lifecycle-Rules.md**.
- **Kainow-V1.0-Questions-Decisions-and-Risk-Lifecycle-Rules.md**.

The defaults below resolve earlier open questions about task-notification pausing during deferral, missed reminders on resumption, and date-only task deadlines. They do not change invitation or membership expiry rules.

## 2. Accepted default notification behaviour

| Event or condition | Default behaviour |
| --- | --- |
| Task approaching its deadline | Remind the assignee seven days and one day before the deadline. |
| Task three days overdue | Escalate once using the role-based routing in Section 4. |
| Unfinished subtask passes its parent's deadline | Escalate immediately to the Project Manager, independently of the subtask's own deadline. |
| Task completed or cancelled | Stop future task reminders and overdue escalations. |
| Task blocked | Continue reminders and escalation; blocking does not extend the deadline. |
| Project deferred | Pause task reminders and escalations. Invitation and membership expiry continue. |
| Project reopened | Recalculate notifications using current authorised deadlines; do not replay every missed reminder. |
| Overdue work exists on project reopening | Send one consolidated overdue summary to the Manager and affected assignees; route an escalation already due once. Each recipient receives only permitted information. |
| Authorised due-date change | Replace future notification scheduling; preserve previous notification history. |
| Accepted risk reaches its review date | Notify the Risk Responsible Person and Project Manager; do not automatically change risk status. |
| Completed task reopened | Recalculate reminders using the existing authorised deadline; reopening does not itself change that deadline. |

## 3. Time and deadline interpretation

- Use working days by default, initially Monday–Friday, with configurable weekdays/holidays; projects may select calendar days.
- Use UTC+8 for deadline and notification calculations and presentation.
- A date-only task deadline means **23:59:59 UTC+8** on that date.
- An explicitly supplied time takes precedence over the date-only default.
- Do not send a pre-deadline reminder whose scheduled time had already passed when the task was authorised.
- Reminder scheduling does not authorise changing an assignee or due date.

Reminder timing and the default cutoff for date-only tasks may be configured under the organisation policy. UTC+8 remains the V1.0 time convention. Working-day mode and the project weekday/holiday calendar are included under O12; configurable time zones are not.

## 4. Escalation routing and repetition

### Default routing

| Task assignee | Escalation recipient |
| --- | --- |
| Member | Project Manager. |
| Deputy Project Manager | Project Manager. |
| Project Manager | Project Owner and/or Sponsors. |
| Project Owner or Sponsor | Other available accountable role holders; never only the same person. |

- Default escalation frequency is **once per overdue episode**, not repeated daily messages.
- Further escalation frequency, recipients and sequence are configurable.
- A parent-deadline escalation is a separate trigger from the task's three-day overdue escalation.
- Avoid duplicate notifications for the same event and recipient.
- If combined roles leave no independent recipient, display **“No independent escalation recipient”** on the project dashboard.
- Do not invent a recipient or automatically disclose project information to the Enterprise Administrator.

Escalate once per overdue episode. A newly authorised due date establishes a new notification schedule. Reopening an already-past-due task produces one applicable event, not a repeated daily escalation; preserve prior events and suppress duplicates (D64).

## 5. Deferral and reopening

### During deferral

- Pause task reminders and overdue/parent-deadline escalation under the default policy.
- Do not change task deadlines or statuses as a side effect of pausing notifications.
- Invitation and membership expiry continue; notifications do not extend access or invitation validity.
- Preserve existing notification and escalation history.

### On reopening

- Recalculate schedules from current authorised task deadlines and statuses.
- Do not replay each reminder missed during deferral.
- Send one consolidated summary of overdue work to the Manager and affected assignees, filtered to each recipient's access.
- Route escalation already due once, with duplicate suppression.
- Reopening does not automatically restore membership, resend invitations, reassign work or amend task deadlines.

Deferred and Closed projects pause ordinary task/risk-review reminders and digests. Expiry, security/access and relevant failure notices continue. Resume with new authorised outstanding-task deadlines, one consolidated work summary and overdue risk-review flags (D21–D24, O10).

## 6. Completion, cancellation and amendments

- Completed and Cancelled tasks no longer generate future task reminders and overdue escalations.
- A blocked task keeps its deadline; reminders continue unless project deferral or another authorised configured rule pauses them.
- An authorised deadline amendment replaces future scheduling while retaining the old notification history.
- A pending amendment does not alter scheduling for the current authorised commitment.
- Reopening a completed task recalculates reminders but does not grant a new deadline.
- Related risk status does not change merely because a task reminder was delivered or a mitigation task completed.

## 7. Channels, privacy and delivery

- Default channels are **in-app notifications and email**.
- Organisation channel settings and delegated project options are configurable.
- Every recipient must be entitled to the information disclosed in the notification.
- Email contains minimal summary information and a permission-checked link.
- A link does not grant access by itself.
- Leadership or administrative standing does not automatically permit discussion content in notifications.
- Avoid duplicate messages for the same event, channel and recipient. Providing the same event through the selected in-app and email channels is not itself an unintended duplicate.

### Delivery outcomes

- Delivery failure does not change task or project status.
- Delivery does not count as acknowledgement or human approval.
- Failed delivery must not be represented as acknowledged work.
- Notification history must distinguish the event and the available delivery outcome without claiming that a recipient read or accepted a message unless that action is actually recorded.

Temporary email failure permits an initial attempt plus three retries, at 5 minutes, 30 minutes and 2 hours from the initial failure. Recheck current access and relevance; cancel obsolete notices. Confirmed delivery is not resent. Permanent failures require correction; distinguish service delivery from reading (O04, O12).

## 8. Configurable settings in V1.0

The accepted behaviour is the default configuration. Supported settings include:

| Setting area | Configurable options | Default |
| --- | --- | --- |
| Task reminders | Lead times and schedule | Seven days and one day before the deadline. |
| Overdue escalation | Delay, eligible recipients, sequence and repetition | Three days overdue; once per episode. |
| Parent-deadline escalation | Eligible recipients and supported routing | Immediate escalation to the Project Manager. |
| Task notifications during deferral | Pause/resumption policy | Pause; recalculate on reopening. |
| Reopening summary | Supported summary recipients and consolidation behaviour | One overdue summary to Manager and affected assignees, access-filtered. |
| Risk-review notification | Eligible recipients and supported notification settings | Risk Responsible Person and Manager at the review date. |
| Channels | Organisation settings and delegated project channel options | In-app and email. |
| Date-only task cutoff | Default time within the specified deadline date | 23:59:59 UTC+8. |

The Configuration Catalogue records accepted defaults and authorities; remaining validation bounds must be settled in the configuration contract before the affected setting is editable. Configuration is bounded product behaviour, not arbitrary executable workflow or plugin loading.

### Configuration authority

- The Enterprise Administrator manages organisation-wide rules and permitted delegation.
- Project Managers, Owners and Sponsors may adjust only explicitly delegated project settings, within organisation-level bounds.
- No personal opt-out policy overriding required organisational notifications is established by this document.

### Mandatory protections

Configuration must not:

- Give recipients access they do not hold.
- Fabricate acknowledgements or human approvals.
- Allow AI to authorise commitments.
- Silently change task dates, assignments, statuses or membership validity.
- Remove attribution, source evidence or earlier notification/policy history.

## 9. Policy changes and history

- Changes record actor, reason, previous/new settings, effective date/time and policy version.
- Explicitly state their effect on existing projects, pending work and future notification scheduling.
- Preserve earlier approvals and their policy associations.
- Preserve notification history when schedules change; do not recreate the past under new policy values.
- Applying a new reminder policy does not silently migrate the underlying commitments or access grants.

## 10. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 11. Accepted calendar and scheduling detail

### Accepted O04 — Configuration defaults and visible analysis limits

| Setting | Accepted default |
| --- | --- |
| Ordinary membership | No expiry; projects may set expiry and authorised role managers extend it. |
| Audit/Oversight grants | Thirty-day default; ninety-day maximum per grant or extension, Administrator-configurable. No automatic renewal. |
| Discussion analysis | After 300 seconds without a new message; at most two automatic analyses per thread in any rolling twenty-minute period. |
| Rate-limited discussion | Wait until eligible, then process latest unprocessed content together. |
| Explicit AI requests | Available subject to permissions and spending limits. |
| Published minutes | Trigger analysis after successful publication, subject to applicable configured limits. |
| AI retry/fallback | Three total attempts per request, including initial and fallback attempts. No automatic retry of permission denial, invalid credentials or exhausted allowance. |
| AI timeout | 120 seconds per attempt; local timeout does not prove provider cancellation or zero charge. |
| Spending periods | Daily and monthly, UTC+8 boundaries. Most restrictive applicable remaining allowance governs; blank/zero means no allowance. |
| Email retry | Initial attempt plus three temporary-failure retries, at five minutes, thirty minutes and two hours after initial failure. |

Every AI attempt consumes applicable reservation/usage allowance. Show effective batching limits near the discussion’s AI status area: “Automatic analysis: after 5 minutes without new messages; maximum 2 analyses per thread in any rolling 20 minutes.” Display Waiting, Queued, Running, Paused or Blocked, with the next eligible time when rate-limited. Reflect configured changes immediately in that explanation.

### Accepted O12 — Notification day counting and timing

Projects select working days (default) or calendar days for reminder/escalation intervals. Working-day mode uses project working weekdays/holidays within Administrator-approved settings. Show effective mode near reminder settings and deadline detail. Calendar changes preview/recalculate future notifications with history, never silently change authorised deadlines. Invitation validity, membership/grant expiry, security timeouts and retry intervals remain elapsed-time based.

Date-only task reminders default to 09:00 UTC+8 on the applicable seven-day/one-day reminder dates. Specific-time deadlines use the configured interval before that time. Risk review-due notice defaults 09:00 on the review date; overdue follows date end, with one next-morning missed-review notice. Notification timing follows the configured calendar mode where applicable; exact scheduler implementation belongs to its contract.

Authorised changes into the past show overdue immediately and notify assignee/PM once; already-three-day-overdue work escalates without another three-day delay. Consolidate overlapping alerts for the same task/recipient, preserving each trigger in history. Retry only relevant permitted notices at the accepted elapsed-time points; cancel obsolete reminders. Project pause/closure/resumption rules still govern.

No business-day calculation changes authorised deadlines silently. Working Days is the current default; Calendar Days is an explicit project choice. Recheck content/recipient eligibility on every delivery/retry. Parent-deadline and task-overdue triggers retain separate history even when delivery is consolidated.

## 12. Accepted working-day default, holidays and recovery

### Q02 — Working-day default and notification recovery (Accepted)

Working Days is the default, initially Monday–Friday, with configurable weekdays and holidays. Calendar Days remains selectable. This explicitly replaces the earlier Calendar Days default. Keep an authorised deadline on a non-working day unchanged and show a warning when it is selected. Count reminder intervals using the selected project calendar.

In Working Days mode, a reminder landing on a non-working day is sent on the preceding working day, normally at 09:00 UTC+8. Never escalate early: after the configured overdue interval has passed, deliver at the next eligible notification time. A risk-review date on a non-working day receives its advance notice on the preceding working day; retain its actual review date and overdue calculation.

After system unavailability, send one consolidated still-relevant notification per recipient; skip obsolete reminders and avoid duplicate deliveries. Calendar changes preview/recalculate future notifications, preserving deadlines and delivery history. Invitation validity, membership/grant expiry, security timeouts and retry intervals remain elapsed-time based. Urgent security notices do not wait for working days.
