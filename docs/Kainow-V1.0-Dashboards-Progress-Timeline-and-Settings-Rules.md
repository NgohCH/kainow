# Kainow V1.0 — Dashboards, Progress, Timeline and Settings Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules and configurable presentation defaults  
**Scope:** Dashboard contents and access, task-completion measurement, timeline information, collapsible project lists, personalisation and settings authority. Detailed visual design and development methods are excluded.

## 1. Purpose and related documents

Kainow dashboards help users understand responsibilities, project progress and items needing attention without exposing information outside their permissions. The presentation should remain simple and understandable as the number of projects grows.

This document supplements the V1.0 Product Summary and the accepted role-management, project/task lifecycle, business-rule configuration, discussion-access, notification and AI-usage documents.

The rules below define information and behaviour. Specific layouts and visual design remain for a separate design document.

## 2. Dashboard and timeline views

| View | Default information |
| --- | --- |
| Personal dashboard | The user's projects, assigned tasks, upcoming deadlines, overdue work, questions needing their response and proposals awaiting their review. |
| Project dashboard | Project status, stage/substage, stage duration, task completion, blockers, pending invitations, decisions, questions, risks and resource/budget usage. |
| Leadership dashboard | Accessible project summaries: status, stage duration, progress, overdue/blocked work, significant risks and resource/budget indicators. |
| Project timeline | Stages, task deadlines, review dates and recorded lifecycle events. |

The timeline is not a Gantt chart. It must not infer task start dates, dependencies or resource bookings that were never recorded.

## 3. Access and privacy

- Dashboard information follows current permissions and project scope.
- The Enterprise Administrator explicitly assigns leadership-summary access.
- Leadership access is not automatically granted because of a senior-sounding role or title.
- Leadership-summary access does not automatically expose discussions or supporting quotes.
- Supporting quotes and sources follow their configured audiences. Active members read shared discussion and ordinary minutes; restricted minutes use their configured audience. Audit/Oversight extends only its explicit scope.
- Collapsed headers, attention flags, filters, previews and counts must not reveal restricted information.
- Personalisation and settings authority do not grant additional access.

## 4. Task-completion measurement

### Default calculation

**Task completion (%) = completed eligible leaf tasks ÷ all eligible leaf tasks × 100.**

- A leaf task has no subtasks.
- Eligible tasks are authorised actionable leaf tasks whose status is not Cancelled.
- Count leaf tasks only, avoiding double-counting parent and child tasks.
- Cancelled tasks are excluded from the percentage and shown separately.
- If no eligible tasks exist, show **“Progress not yet measurable”**, not 0% or 100%.
- Label the indicator **“Task completion”**. It measures completed work items, not successful delivery of the project's intended outcome.
- An overridden parent completion does not silently complete its unfinished children or remove them from the calculation.
- Project closure outcome remains distinct from task completion.

### Stage and data interpretation

- Show the current stage/substage and time in its current period separately from task completion.
- Preserve previous stage periods under the project lifecycle rules.
- Deferred projects retain their last task-completion position and clearly display Deferred status.
- Show a Last updated time.
- Distinguish human-entered figures from calculated values.
- Display missing budgets, dates or risk assessments as **“Not provided”**, rather than assuming zero or healthy.

No weighted progress formula or custom executable calculation is established by this document. Additional progress measures require explicit specification.

## 5. Collapsible project lists

These rules apply to personal and leadership project lists while retaining their different access scopes.

- When a view contains more than five projects, display each project as a collapsible section, collapsed by default.
- With five or fewer projects, details are expanded by default.
- A collapsed header retains the project name, status, stage, task-completion indicator and permitted key attention flags.
- Expanding a project reveals its permitted details without leaving the dashboard.
- Provide **Expand all** and **Collapse all** controls.
- Remember the user's project expansion/collapse choices.
- Collapsible controls must support keyboard navigation and screen readers.

The default behaviour applies when no saved preference is available. Detailed handling of changed filters, newly visible projects and the five-project boundary must be made consistent with saved user choices in the design specification.

## 6. Dashboard personalisation

V1.0 supports limited personalisation directly on the dashboard:

| Area | Personalisation |
| --- | --- |
| Colours | Accessible themes and accent colours. |
| Arrangement | Reorder permitted dashboard sections and project cards. |
| Optional information | Show or hide optional sections. |
| Navigation | Save project expansion/collapse preferences. |
| Reset | Restore the default layout/preferences. |

- Preferences are saved per user and affect that user's presentation only.
- Filters, displayed sections, category selections and default sorting are configurable within permitted access.
- Personalisation does not alter underlying project data, assignments, deadlines or permissions.
- Personalisation must not disguise AI proposals as authorised records.
- Status and warning meaning must remain available through text/icons; colour alone is insufficient.
- Rearrangement must work using a keyboard, without requiring drag-and-drop.
- Detailed interaction choices and the available themes remain part of the separate design specification.

## 7. Settings locations and authority

**There is no separate User Settings page in V1.0.**

| Location | Who manages it | Scope |
| --- | --- | --- |
| System Settings | Enterprise Administrator | Organisation-wide configuration, defaults and delegation limits across configurable product areas. |
| Project Settings | Project Manager, Project Owner or Project Sponsor | Their own projects, within settings explicitly delegated by the Administrator. |
| Dashboard controls | Individual user | Personal colours, arrangement, optional sections, sorting/filter preferences and project expansion/collapse presentation. |

### System Settings

- Only the Enterprise Administrator has the organisation-wide settings page.
- It consolidates administration of configurable system policies and their defaults/delegation.
- It does not imply that every administrator may read restricted discussions or reveal secrets.
- Administrative credential controls must continue to protect secret values under the AI configuration rules.

### Project Settings

- Project Managers, Owners and Sponsors can manage explicitly delegated settings for their own projects.
- They cannot exceed organisation-level bounds or change non-delegated settings.
- Sponsor eligibility to manage delegated project settings is explicitly accepted here. This extends earlier wording that named only Owners/Managers.
- Being eligible for delegation does not automatically grant every configuration permission.

### Dashboard controls

- Users personalise directly on the dashboard; no central personal-settings page is required.
- These controls update the same saved user preferences wherever the corresponding presentation option is offered.
- Personal presentation choices do not become project-wide or organisation-wide policy changes.

## 8. Configuration safeguards and history

- Organisation/project policy changes retain actor, reason, previous/new settings, effective date/time and policy version under the configurable business-rule framework.
- Explicitly state how policy changes affect existing projects and pending work.
- Do not silently rewrite commitments, approvals or access grants through settings changes.
- Mandatory protections remain enforced: human authorisation, explicit access, evidence integrity and preserved attribution/history.
- Separate personal presentation preferences from business-policy configuration; changing a user's accent colour does not change approval policy.
- Dates and deadlines retain the product's UTC+8 convention.

## 9. Superseded wording

This document supersedes:

- The earlier proposal for a separate central User Settings page. That page is removed.
- Earlier general project-configuration delegation wording that omitted Sponsors. Managers, Owners and Sponsors are eligible for explicit project-level delegation.

It does not silently extend Sponsor access to credentials, detailed AI usage reports or any other capability governed by separate permissions.

## 10. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 11. Leadership summary, graphics and freshness

Leadership summaries include project name/scope, PM name, owning/participating departments, status/stage/substage/duration, task progress, known timeline/review events, overdue/blocked work, significant risks, permitted resource/finance summaries and last refresh. Leadership users add/hide/rearrange approved summary fields only within scope; no implicit raw source, financial-detail or management access.

Metrics based on visible records disclose partial coverage. Whole-project aggregates require separate permission. Show last refresh/staleness; filtering does not reset saved preferences. Newly visible projects use defaults where no saved choice exists.

Use helpful bar charts, meaningful pie/doughnut whole-parts, flowcharts and timelines alongside text/numbers. Identify measure/period, obey permissions and provide accessible equivalent values. Avoid colour-only meaning, decorative graphics and misleading project comparisons.

## 12. Accepted Administrator analytics dashboard

A12 adds a configurable Enterprise Administrator analytics/reporting dashboard. Capture all defined business/operational events with completeness verification. Provide organisation→department→project→permitted record/person drill-down, supported filters, trends, charts/tables and permitted exports. Show metric definitions, periods, refresh, uncertainty and partial coverage. Named-person/detail access follows its relevant permission; it does not widen raw minutes, finance, investigation or quarantine access. See [Administrator Analytics and Reporting Rules](Kainow-V1.0-Administrator-Analytics-and-Reporting-Rules.md). Personal/project/leadership dashboards retain their separate permissions and direct-view personalisation.
