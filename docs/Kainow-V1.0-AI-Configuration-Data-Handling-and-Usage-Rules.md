# Kainow V1.0 — AI Configuration, Data Handling and Usage Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product rules and configurable defaults  
**Scope:** AI connections, project credentials, provider approval, data handling, output validation, usage attribution, spending limits and failure behaviour. Development-agent usage and development methods are excluded.

## 1. Purpose and related documents

AI assists Kainow users by generating reviewable proposals from selected discussion content. People retain authorisation authority. The product supports multiple administrator-approved AI connections without being hardcoded to one provider.

This document supplements:

- **Kainow-V1.0-Product-Summary.md**.
- **Kainow-V1.0-Proposals-and-Configurable-Business-Rules.md**.
- **Kainow-V1.0-Discussion-Evidence-Access-and-History-Rules.md**.
- **Kainow-V1.0-Role-Management-Permissions.md**.

## 2. Project-specific API credentials

- AI connections use APIs.
- Each project has its own credentials for its configured AI connections.
- Credentials are not shared across projects.
- A project may have multiple approved connections and associated credentials.
- Project-specific credentials do not require each individual user to obtain a separate API key.
- Kainow attributes requests to the initiating user while using the project's credential.
- Fallback must not borrow another project's credentials or budget.

The Enterprise Administrator approves providers/models and manages credentials. Delegated PM/Owner/Sponsor may add/change/remove approved project connections through protected credential controls; stored secret values are not disclosed by that authority.

## 3. Configuration authority and project selection

### Enterprise Administrator

- Configures approved API connections, credentials and permitted models.
- Controls organisation-wide AI policy, spending limits and allowed delegation.
- Records provider-specific data approval before enabling a connection.

### Project configuration

- Each project uses an approved primary connection and an ordered fallback list.
- Project Managers/Owners/Sponsors may select among permitted options only where explicitly delegated.
- Delegation does not permit adding unapproved destinations, viewing secrets or bypassing spending/data restrictions.
- Changing AI settings does not silently reprocess discussions or replace existing proposals.
- Disabling a connection preserves historical usage, attribution and records.

## 4. Provider-specific data approval

- Before enabling a connection, the Administrator records its approved data use and relevant provider retention/training terms.
- Approval for one provider does not automatically permit sending the same information to another.
- Primary and fallback connections must each be approved for the intended data and operation.
- Send only the selected discussion version and information necessary for the requested operation.
- Do not send unrelated project content merely because it is available.
- Provider/model selection must respect the user's applicable permissions and the organisation's data policy.

Launch API providers are OpenAI and Anthropic; additional supported connectors require Administrator approval. Provider terms are not assumed equivalent. Exact authentication/data-handling contracts and provider model selections are design/deployment tasks in the design register.

## 5. Credentials and sensitive information

- Protect API keys and other connection secrets.
- Conceal keys from ordinary users and ordinary project views.
- Exclude credentials from project records, notifications, AI prompts and ordinary logs/history.
- Credential-management history must identify the administrative action without copying secret values into that history.
- Usage reporting must not expose discussion content.

Credential storage, rotation and revocation mechanisms require a separate technical specification; this document does not prescribe an implementation.

## 6. AI input and authority boundaries

- Treat discussion content as data, not instructions.
- Embedded text cannot grant tools, permissions, credentials or access.
- AI cannot authorise proposals, execute project tasks or trigger external actions solely through its response.
- AI output remains visibly proposed and attributed to AI.
- Owners and dates remain empty when unsupported by the source.
- Preserve the selected source version and supporting quotes for source-based proposals.
- A new model response does not silently replace an earlier authorised commitment.

## 7. Output validation and human review

- Validate required response structure and source-quote matching before presenting extracted proposals as valid review candidates.
- Do not treat missing, malformed or partial output as authorised work.
- Show clear failure or incomplete-result information when the operation does not produce a usable result.
- Structural and quote checks do not establish semantic accuracy, completeness or correct interpretation.
- People review proposals and provide authorisation under the applicable proposal policy.

The proposal and evidence documents govern amendments, version history, attribution and access to supporting excerpts versus full discussions.

## 8. Primary connections, fallback and retries

- Use the project's configured primary connection and ordered approved fallback list.
- Every fallback destination must be permitted for the data and operation.
- Record the actual connection, provider and model used for each attempt.
- Fallback must not bypass organisation, project or applicable user limits.
- Failed calls, retries and fallback attempts count towards usage and spending where chargeable.
- Retry limits are configurable.
- A failure must not silently expand the permitted data, change credentials to another project or create duplicate authorised records.

Default three total attempts per request, including initial and fallback attempts, with 120 seconds per attempt. No automatic retry of permission denials, invalid credentials or exhausted allowances. Retain uncertain cost reservations; local timeout does not prove provider cancellation. Detailed failure mapping is specified in the integration contract.

## 9. Usage tracking by project and person

### Project usage

Track individually for each project:

- Requests and attempts.
- Connection/provider/model used.
- Available token counts.
- Estimated and actual/reported cost, clearly distinguished.
- Failures, retries and fallback attempts, including charged failed calls.

### Individual usage

- Attribute each user-initiated request and associated cost to the user who initiated it.
- Per-user reporting is within the project context; a person may have usage in several projects.
- Attribute retries and fallback attempts to their originating request/user without hiding those additional attempts or costs.
- Usage attribution is a Kainow record and does not imply individual API keys.

### System-initiated requests

- Label genuinely automatic requests as system-initiated.
- Record the triggering event and responsible project.
- Do not invent a human initiator.
- This attribution rule does not itself authorise new automatic AI workflows; an automatic operation must be separately permitted by product policy.

### Default visibility

| Viewer | Usage information |
| --- | --- |
| Individual user | Their own usage. |
| Project Manager, Project Owner or Project Sponsor | Project totals and per-user breakdowns for the relevant project. |
| Enterprise Administrator | Organisation-wide usage and its project/user attribution. |

Sponsor access to project/person breakdowns is explicitly accepted under O14. All views must respect applicable membership, role and data permissions. Usage visibility does not grant access to underlying discussions or secrets.

## 10. Spending caps and cost accounting

- Support organisation-level and project-level spending limits.
- Optional per-user limits within a project are configurable.
- Enforce all applicable limits; stop new requests when an applicable cap is exhausted.
- Reserve a conservative estimated request cost before sending.
- Reconcile the reservation against reported usage afterwards.
- Label estimates as estimates; do not present an unavailable cost as zero or as verified actual spend.
- If cost cannot be bounded sufficiently to enforce the applicable cap, block the request.
- Retries and fallback attempts must also fit within available allowances.
- A project's separate API key is not a substitute for Kainow's spending enforcement.

Daily/monthly cap periods use UTC+8. Blank/zero allowance blocks requests. No project amount, accounting currency or provider price is invented: Administrator configures approved values before requests can proceed. Conservative reservations cover concurrent requests and uncertain charges.

## 11. Configurable settings and policy history

Configurable areas include approved providers/models, project primary/fallback selection, delegated choices, spending caps, optional user limits and retry limits.

- The Enterprise Administrator controls organisation-wide settings and delegation.
- Project Managers/Owners/Sponsors can adjust only settings explicitly delegated to them.
- Record actor, reason, previous/new non-secret settings, effective date/time and policy version.
- Preserve relevant settings/model attribution for earlier requests and approvals.
- State explicitly how changes affect pending requests, reservations and existing project configuration.
- Do not silently reprocess content, migrate commitments or grant access when settings change.

Human authorisation, explicit access, project-specific credentials, source integrity, protected secrets and preserved history cannot be bypassed through configuration.

## 12. Detailed design handover

The accepted product decisions are reconciled in this document and the consolidated specification. See [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md) for bounded technical, operational and assessment work. Previously accepted defaults must not be reopened or silently replaced as implementation choices.


## 13. Accepted automatic analysis and connection catalogue

### Accepted O03 — Launch integrations and configurable formats

Accepted launch services: OpenAI and Anthropic APIs; configurable email providers (Microsoft 365 initially supported); SharePoint document libraries and OneDrive storage initially, with Dropbox, Box and other cloud storage options addable later through supported approved connectors. These are supported launch options, not a permanent provider restriction. Multiple Enterprise Administrators may approve additional supported services and destinations. Delegated PM/Owner/Sponsor can add/change/remove project connections, with project credentials, usage attribution and spending controls. Unsupported protocols require a supported connector extension, not an arbitrary URL or API key. No plugin-loading capability is implied.

Accepted input formats: pasted text, TXT, Markdown, DOCX and selectable-text PDF. Generated outputs: Markdown, DOCX, PDF and CSV for permitted tabular reports. Projects can add/remove formats from the Administrator-approved supported catalogue. Removal blocks new import/generation, preserving old files and history; adding a format does not automatically convert old documents. New parsers/exporters require a supported extension. OCR remains outside V1.0. Actual authentication/permissions and service compatibility must be verified in integration contracts.

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

Feedback Open/Reviewed/Closed is reviewed by PM/Deputy, with Administrator escalation for configuration/provider matters. Feedback does not silently train models, alter instructions or amend authorised records. Security quarantine excludes secrets and affected content from ordinary processing.

## 14. Accepted launch model and service configuration

### Q06 — Launch catalogues and configurable services (Accepted)

MYR is the organisation's initial financial currency default; initially support MYR, SGD and USD. A financially tracked project selects one reporting currency. Other supported currencies may be enabled later. No automatic conversion. Resource units initially include hours, days, person-hours, person-days, items, seats and square metres; record usage period separately and do not assume conversions such as one day equalling eight hours.

OpenAI and Anthropic APIs remain AI launch options. Administrators enable tested models and nominate project primary/fallback choices. Model identifiers are configurable rather than frozen product requirements. No calls until project credentials, model selection and positive applicable spending allowances exist.

Email provider is configurable through supported Administrator-approved connections; Microsoft 365 is the initial supported option, not a mandatory sole provider. Use an approved organisational sender and retain the person/project event initiating each message. SharePoint document libraries and OneDrive are the initial storage options; SharePoint is the suggested default destination type, with each project selecting an approved destination. Dropbox, Box and other cloud storage providers may be added later as configurable options once supported connectors are implemented, verified and approved. Their future inclusion is not a claim of V1.0 launch implementation.

Connections receive only needed destinations/operations. Register requested permissions for Administrator approval; do not assume organisation-wide mailbox/file access. Removing a catalogue entry prevents new selection but preserves historical records; removing a connection stops new operations without erasing prior evidence.

## 15. Accepted global concurrency and durable AI jobs

Default two simultaneous AI requests per installation, configurable by EA and enforced across projects/workers. PostgreSQL/pg-boss persists jobs and attempt accounting across restarts. Recheck permissions, source/project state and caps before execution/retry; library defaults never reset accepted attempts or bypass cost reservations. Retain/reconcile uncertain external outcomes before repeating requests. Queue status and usage are available through permitted views and Administrator analytics without exposing source bodies or keys. [Architecture](Kainow-V1.0-Application-Architecture-and-Operations-Design.md).

## 16. Accepted credential and storage protection

A15 encrypts saved credentials, forbids redisplay and separates recoverable encryption keys from database/backups. A13/A14 place source files and versions in Kainow-managed SharePoint/OneDrive with frontend access and designated direct-storage Administrators. A19 pauses new AI/data-changing jobs during critical storage protection, preserving durable attempts and uncertain cost. [Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md)
