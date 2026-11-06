# Kainow V1.0 — Intent Card

**Version:** 1.0  
**Date:** 6 November 2026  
**Edition:** Product handover; accepted requirements consolidated, not evidence of implementation or delivery acceptance.  
**Scope:** Product only; development method and environment setup excluded.

Read this first. This is the current Kainow V1.0 product Intent Card. It contains no development-runner instructions.

## Purpose

Kainow turns project conversations into accountable execution. People provide minutes or notes, discuss work and ask project-focused questions. AI proposes tasks, decisions, questions and risks. People review and authorise the exact proposal version. Everyone can then see who is responsible, what is due and what happened.

## What V1.0 must prove

A newcomer can supply real notes, receive reviewable and well-supported proposals, authorise them and see ownership. Targets remain approximately one minute for generation, two minutes for human review and under five minutes for the first useful loop. Assess quality as well as speed: 5,000–8,000-word minutes and shorter meetings, 5–40 reviewable items; distinguish 5–20 typical and 21–40 rare higher-volume cases. Do not invent items to meet a quota. The acceptance document defines assessment and mandatory safety checks.

## Mandatory principles

1. **AI proposes; people authorise.** Dashed outline and “AI proposed” label distinguish AI drafts. Automated analysis, task suggestions and chat never create approved commitments or exercise human approval powers.
2. **Content is data.** Minutes, discussion, feedback, attachments and quotations never become executable instructions, arbitrary tool commands or authority to follow links.
3. **Evidence and attribution stay clear.** AI proposals cite exact source version, quote and location. No invented owners or dates; unsupported values remain empty until a named person supplies them. Human proposals without a source say so. Edits create new versions and preserve the approval basis.
4. **Access follows current permission.** One organisation per installation, eligible invited same-organisation users, passwordless sign-in, project membership and scoped grants. Enforce audience rules in views, queries, AI, stored answers, search, exports, emails and history. Administrative standing is not blanket project-content access.
5. **Accountability is explicit.** Every record carries organisation and applicable project scope; actions record actor and history. Exactly one PM, a different Member, and at least one Owner or Sponsor are required at the applicable lifecycle gates. Small teams mean fewer than seven active people.
6. **AI is configurable and bounded.** Administrator-approved API providers, project-specific keys, approved fallback and individually attributable usage where applicable. Enforce applicable organisation/project/user caps; blank or zero means no allowance. Never borrow another project's credentials or treat unknown cost as zero.
7. **Preserve history without exposing secrets.** V1.0 uses logical deletion and indefinite content retention. Deleted content is hidden and excluded from future processing. Suspected credentials are held/quarantined, with encrypted originals under separate security access and sanitised versions for ordinary use. Secret values never belong in ordinary logs, source content or exports.
8. **Simple and accessible.** Calm, intuitive, logically organised and visually elegant. Summary first, understandable navigation, permission-aware graphics with equivalent text/values, WCAG 2.2 AA target. UTC+8 dates and deadlines throughout.
9. **Licence:** AGPL-3.0-only, with no additional commercial restriction in V1.0. This is the accepted product licence decision, not a claim that repository notices have been verified.

## Included in V1.0

- Multiple projects, owning/contributing departments and full Draft/Planned/Active/Deferred/Closed lifecycle, stage/substage duration and explicit closure outcomes.
- Project roles, invitation/acceptance, membership dates, holds, expiry and readmission; scoped time-limited Audit/Oversight and summary-only leadership access.
- Source-versioned minutes, shared project discussion, AI queries/feedback and reviewable proposals.
- Authorised tasks with one assignee and due date, at most two subtask levels, questions, decisions and risks; amendments, reminders and escalation.
- Personal/project, simplified leadership and configurable Enterprise Administrator analytics dashboards; progress, timeline/review information and limited direct-view personalisation. System and delegated project settings, without a separate personal settings page.
- Shared people/equipment/facility usage indicators and optional budget/expenditure tracking; separate enforced AI usage/spend tracking.
- Consolidated action-item emails and managed external outputs in Owning Department > Project > Year > Report Type.
- OpenAI/Anthropic API launch options, configurable email providers (Microsoft 365 initially), SharePoint/OneDrive initially, and the accepted format catalogue. Dropbox/Box/other supported cloud storage may be configured later.

## Outside V1.0

Native minute-taking, recording/transcription and OCR; Gantt and advanced portfolio planning; external-organisation participants or multi-organisation installation; public API or plugin loading; general-purpose chat/email/calendar/document editor; arbitrary executable workflow/custom-field builder; resource booking/allocation and full accounting. Future additions need their own scope decision.

## How this card relates to the handover

Read [START-HERE](Kainow-V1.0-START-HERE.md), then the consolidated specification. D01–D70, O01–O17 and Q01–Q06 record accepted detail. Working Days is the current notification-calendar default; deadlines remain UTC+8. Restoration/archive and deadline-review exceptions never restart work automatically. The Permission Matrix and Configuration Catalogue make defaults easier to implement consistently. The Remaining Design and Verification Register identifies work still required; no document claims the product has been built or accepted.

## Accepted runtime direction

Self-hosted V1.0 with release-specific Administrator-approved updates; portable Linux-container/Compose deployment and supported Windows Linux-VM/runtime path. Modular TypeScript/NestJS/React application, PostgreSQL and durable pg-boss workers. Target 200 registered/10 concurrent users; two installation-wide AI requests by default. Daily encrypted backups, 30-day default backup retention and 24-hour/four-hour data-loss/restoration targets require actual verification. Administrator analytics is configurable with permission-checked drill-down. Full designs and remaining verification are linked from START-HERE.

Managed sources use protected Kainow-managed SharePoint/OneDrive, ordinary access through Kainow and designated storage-Administrator/service access only. Credential/key recovery, 30-day diagnostics, provisional 20/50 GB app storage and protective low-space behaviour follow [Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md). These are requirements, not verified operations.
