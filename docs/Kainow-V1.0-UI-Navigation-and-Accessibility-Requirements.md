# Kainow V1.0 — UI, Navigation and Accessibility Requirements

**Version:** 1.0 — reconciled handover edition  
**Status:** Agreed product requirements, including design principles; exact visual choices remain open  
**Date:** 6 November 2026  
**Scope:** User interface behaviour, navigation and accessibility

## 1. Purpose and design boundary

Kainow should feel calm, content-first and consistent. Users must be able to understand the project, find their responsibilities, inspect evidence and make informed decisions without learning technical terminology.

This document defines required interface outcomes. Colours, typography, exact layouts, component choices and branding remain for a separate design document. Named destinations below describe capabilities that must be discoverable; they do not require a separate page or navigation tab for every capability.

These requirements apply alongside the V1.0 role, lifecycle, evidence, discussion, AI, dashboard and acceptance rules. The interface must reflect those rules and cannot grant permissions through a display setting.

### 1.1 Required design principles

The visual design must be intuitive, easy to navigate, logically organised and elegant in presentation. These are requirements for the eventual design, not optional styling preferences.

| Principle | Required effect |
| --- | --- |
| Intuitive | Use familiar controls, plain labels and clear next actions so users can understand what to do without technical knowledge. |
| Easy to navigate | Keep navigation consistent, make project context visible and provide straightforward routes between related information. |
| Logically organised | Group information by user purpose, present summaries first and reveal supporting detail progressively. |
| Visually elegant | Use balanced spacing, readable typography, restrained colours and a clear visual hierarchy. |
| Calm and consistent | Avoid clutter, unnecessary animation and competing visual elements; apply consistent patterns across screens. |

Elegance must support comprehension and accessibility. Personalisation must preserve these principles. The exact layout, typography, palette and visual style remain open for the separate design document.

## 2. Main navigation and project context

Provide clear access to:

- **My Projects:** projects the user is permitted to see.
- **My Tasks:** the user’s assigned work, with project context.
- **Reviews:** items the user is authorised to review or approve.
- **Leadership views:** permissioned organisation summaries, where granted.

Always identify the current project when the user is working within one. Navigation between projects must not leave an ambiguous project context for a query, assignment, approval or configuration change.

Use consistent names and navigation behaviour across screens. Show relevant destinations and actions according to the user’s permissions. Missing authority must not be presented as an empty project or a successful action.

## 3. Project workspace

Provide consistent routes to the following project capabilities:

| Capability | What users should be able to understand or do |
| --- | --- |
| Overview | Understand project status, stage, stage duration, progress and matters needing attention. |
| Discussion and AI | Discuss project work, query AI, provide feedback and request permitted drafts or analysis. |
| Minutes | Find supplied meeting notes/minutes, their versions and permitted audience. |
| Proposals | Inspect proposed tasks, decisions, questions and risks before authorisation. |
| Tasks | Find assignments, due dates, status, subtasks and blockers. |
| Questions, decisions and risks | Distinguish unresolved questions, authorised decisions and current risk records. |
| Timeline | View known stages, due dates and review events without implying a Gantt or resource-booking feature. |
| Resources | View recorded resource usage and optional financial tracking. |
| Outputs | Find registered external deliverables, their versions, status, attribution and links. |
| Project settings | Manage delegated settings, only where the user has authority. |

Show the owning department and distinguish participating departments and contributors where relevant. Participation does not imply ownership or access to every record.

## 4. Information hierarchy and context

Present useful summaries first, with expandable detail. Users should not have to read an entire discussion to understand a task’s status or next action.

Preserve context when moving between a proposal or authorised record and its supporting evidence. Make the relevant source version and return route clear. Full discussion or minutes remain subject to their configured permissions.

Keep project status, stage, task status, overdue indicators and approval status distinct. Use plain labels consistently across summaries, detailed records, emails and outputs.

Display dates and deadlines clearly as UTC+8. Distinguish missing information, information not required and an explicit zero. Do not present unavailable or stale information as a healthy or completed state.

## 5. Shared discussion and AI assistance

Clearly distinguish named human messages, AI answers, feedback, drafts, AI-proposed actions and authorised project records. AI wording or formatting must not imply approval.

Before analysis, show the project context and the selected messages, thread or other source scope the AI will use. Where automatic analysis is enabled, make that setting and its scope discoverable.

Answers must identify supporting records where applicable and clearly indicate uncertainty or missing information. Feedback controls must let users identify incorrect answers or missed information without implying that feedback automatically changes an authorised record or trains a model.

When an answer cannot safely be shared with the discussion audience, the interface must not publish restricted content. The detailed presentation for such responses remains subject to the discussion and minutes-access specification.

Show AI failure, unavailability or a reached usage limit clearly. A failed request must not appear as a complete analysis or an empty set of project commitments.

## 6. Minutes and evidence access

Show the intended audience before minutes are shared. Clearly label restricted minutes and provide a discoverable indication of the applicable audience to authorised users.

The accepted default is that project-related minutes are available to active project members. Restricted minutes follow their configured audience within organisation policy. AI queries, previews, excerpts and stored answers must not provide an alternative route around source restrictions.

A supporting quote must identify its source and version without exposing content beyond the viewer’s permission. If evidence is unavailable to the user, communicate that limit clearly rather than presenting an unsupported claim as verified.

An external-output link must be recognisable as opening external storage. Its existence does not imply that external access has been granted or that the file is currently available.

## 7. Proposal review and authorisation

Present the proposal, supporting evidence, attribution and missing fields together so that the reviewer can assess meaning and completeness.

AI proposals retain both a **dashed outline** and an **“AI proposed”** label. Colour alone is insufficient. Authorised records must remain visibly distinguishable from drafts and proposals after personalisation.

Before submission, clearly identify:

- The items selected for the action.
- The proposed amendments and any human-supplied fields.
- The action being taken and its consequences.
- Any missing requirements or permission conditions preventing completion.

Viewing, selecting or editing an item never constitutes authorisation. Use explicit action labels appropriate to the lifecycle, such as Authorise, Reject, Complete or Reopen; do not blur these into a generic success action.

For multiple-item actions, make the selected scope and item-specific errors clear. Do not imply that all items succeeded if some remain unresolved or failed. Detailed selection and approval layouts remain open.

## 8. Larger project lists and personalisation

When more than five projects are displayed, provide collapsible project sections, remembered user choices and Expand All/Collapse All controls. The summary remains understandable when a section is collapsed. Follow the dashboard specification for default expansion behaviour and visible indicators.

Provide dashboard controls for permitted personal colour choices and rearrangement, with a reset option. Rearrangement must be possible without dragging. Personal choices must preserve readable contrast, meaningful labels and the visual distinction between AI proposals and authorised records.

There is **no separate user settings page**. Personal dashboard controls affect the individual’s presentation only. System settings belong to the Enterprise Administrator; project settings belong to authorised Project Managers, Owners and Sponsors within delegated boundaries.

Do not allow personal hiding or rearrangement to conceal essential warnings, approval consequences or the current project context.

## 9. Forms, validation and action feedback

Use controlled dropdowns for categories and other agreed structured fields. Keep labels, required-field indicators and terminology consistent. Make configurable project requirements visible to the person entering the data.

Explain validation errors in plain language, identify the affected field or action and indicate what the user can do next. Preserve entered information after recoverable errors where continued access permits it.

Clearly distinguish these states:

| State | Required communication |
| --- | --- |
| Loading or processing | Work is still in progress; do not imply completion. |
| Saving | A change has been submitted but is not yet confirmed. |
| Saved or completed | The operation has a confirmed successful outcome. |
| Failed | The requested outcome was not confirmed; explain the available next step. |
| Empty | No permitted matching content is available, without implying successful extraction when processing failed. |
| Unavailable | Content or service cannot currently be reached. |
| Access denied | The user lacks the required current access; do not expose restricted details. |

Do not show successful filing, delivery or authorisation before confirmation. Preserve clear attribution and history when an action changes a project record or setting.

## 10. Accessibility and responsive use

The accessibility target is **WCAG 2.2 AA**. The final implementation must be assessed against the applicable criteria; this document does not itself establish conformance.

Essential journeys must support:

- Keyboard operation with visible focus and understandable navigation order.
- Screen-reader labels, meaningful controls and clear structure.
- Sufficient contrast and status meanings that do not depend on colour alone.
- Accessible alternatives to dragging and pointer-only interactions.
- Expandable sections whose state is available to assistive technology.
- Usable forms, error feedback and confirmation messages.

Keep essential journeys usable on smaller screens and when zoomed. Critical evidence, approval details and action consequences must remain accessible even when the layout changes. Responsive behaviour must not silently remove a required field or make authorisation possible without the relevant review information.

## 11. Product acceptance outcomes

Assess the actual interface with representative roles and configurations. Verify that users can:

1. Identify their current project and navigate to their work, reviews and permitted summaries.
2. Distinguish human discussion, AI answers, proposals, drafts and authorised records.
3. Inspect a proposal alongside its source evidence and required corrections.
4. Understand the scope and consequences of an authorisation action before submitting it.
5. Recognise minutes audiences and restrictions without exposing restricted content.
6. Navigate more than five projects using accessible collapse/expand controls and remembered choices.
7. Personalise the dashboard and reset it without changing project policy or weakening accessibility.
8. Recover from a permitted, recoverable form error without unnecessary re-entry.
9. Distinguish pending, successful, failed, empty and unavailable states.
10. Complete essential journeys using keyboard and assistive technology, on smaller screens and when zoomed.
11. Find related information and identify the next action through a logically organised interface with readable hierarchy, balanced spacing and consistent controls. Assess intuitive navigation with newcomers rather than relying on visual appearance alone.

Use the real-user and timing assessment rules in the User Journeys and Product Acceptance Criteria document. Attractive screens or automated accessibility results alone do not prove that newcomers understand the workflow.

## 12. Decisions reserved for the design document

The following remain open:

- Final navigation grouping, page structure and component layouts.
- Typography, colour palette, spacing, branding and permitted personal themes.
- Detailed proposal-review and multiple-item action presentation.
- Discussion/AI layout, source-scope selection and restricted-response presentation.
- Responsive layouts and supported device/browser assessment matrix.
- Detailed accessibility verification coverage and assistive technologies.

These choices must satisfy the accepted behaviours above and must not introduce new permissions or alter product lifecycle rules.

## 13. Accepted platform, charts and analysis-status presentation

### Accepted O15 — Visual and interaction boundaries

Responsive web for desktop/tablet/mobile; no native app required. Assess current and previous major Edge, Chrome, Firefox and Safari releases at product release, with a documented matrix. Keep proposal/evidence/approval context accessible together, using linked views where small screens require them.

Final layouts/type/palette/components are reviewed through separate mockups. Preserve intuitive, logical, calm, elegant design and WCAG 2.2 AA target with manual accessibility checks.

Use helpful graphics alongside text/numbers: bars for comparisons, pie/doughnut only for a small meaningful whole, flowcharts for stages/approval routes/relationships, timelines for known dates. Graphics respect permissions, identify measure/period, supply accessible text/tabular values and never depend only on colour. Avoid decoration and misleading comparisons.

Near the AI display, show effective five-minute inactivity and two-per-thread/rolling-twenty-minute defaults, current Waiting/Queued/Running/Paused/Blocked state and next eligible analysis time when rate-limited. Show calendar/working-day mode near reminder/deadline controls and audience before source publication.
