# Kainow V1.0 — Application Architecture and Operations Design

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted direction and requirements; detailed contracts/verification outstanding.  
**Scope:** Product runtime and design only; development agents and workstation setup excluded.

## 1. Intent and status

Kainow turns project conversation into human-authorised accountable work. The architecture must support immutable evidence/history, current permissions across every surface, bounded API spending and a simple self-hosted installation. Initial capacity is modest; growth should preserve module boundaries and permit additional resources/workers without rewriting core business rules.

The decisions below were individually discussed and accepted. This records the accepted direction; it is not a frozen implementation contract or a claim that product code exists. The required schemas, transaction predicates, threat controls, exact dependency versions, restore procedure and measured acceptance evidence remain in the Remaining Design and Verification Register.

## 2. Accepted architecture decisions

| ID | Area | Accepted decision |
| --- | --- | --- |
| A01 | Hosting | Self-hosted V1.0, one organisation per installation. An organisation may run its instance in its own cloud environment. A service hosted by the developer is a future option. |
| A02 | Updates | Built-in update capability with explicit Enterprise Administrator approval for each release. Automatic checking/notification is permitted. An approved release may install immediately or at its approved maintenance window; no blanket approval for later releases. |
| A03 | Portability | OS-agnostic product goal through a documented portable deployment. Supported browsers access the product. Linux containers run on Linux hosts; Windows hosting uses a supported Linux VM/runtime. Native execution on every OS is not promised. |
| A04 | Initial capacity | 200 registered users and 10 simultaneously active users per installation, with a path to increased capacity through resources and testing. This is a verification target, not an automatic-scaling promise. |
| A05 | AI concurrency | Two simultaneous AI requests per installation by default, Administrator-configurable. The limit spans projects and all workers; additional requests wait visibly and recheck permissions/allowance at execution. |
| A06 | Application structure | A modular application with clear internal boundaries and separately runnable background workers, shipped as one coordinated release. |
| A07 | Backup/recovery | Daily encrypted backups to an approved location separate from the running installation; default 30-day backup retention, Administrator-configurable. Fresh successful backup before update. Maximum acceptable data loss 24 hours and restoration target 4 hours for the supported documented setup. Test restore before go-live and after material backup changes. |
| A08 | Database | PostgreSQL is the single supported primary database engine for V1.0, self-managed or a verified compatible managed service. Approval, authorised record and history must be saved atomically. Application access control and database-level protection are both required design areas. |
| A09 | Deployment packaging | Linux containers with Docker Compose for the initial supported deployment. App, workers, PostgreSQL or managed-database connection configuration, persistent storage and backup configuration form the installation package. |
| A10 | Application stack | TypeScript throughout application code: NestJS backend/workers, React with TypeScript browser interface, PostgreSQL. C#/.NET was considered but not selected for the product. Exact supported Node.js/framework/library versions must be pinned and verified in the technical baseline; that verification has not been performed here. |
| A11 | Background jobs | Durable PostgreSQL-backed queue using pg-boss. Separate AI/email/document-processing queues; jobs and attempt counts survive restarts. Recheck current permissions, source, project state and spending before execution/retry. Apply accepted retry limits without reset on restart. Reconcile uncertain external effects before repeating them. |
| A12 | Administrator analytics | Capture every defined business/operational event and measurements for analytics/reporting. Configurable dashboard with organisation→department→project→permitted record/person drill-down, trends/charts/filters and permitted exports. Default summary levels are organisation, department and project; named-person detail and source/record detail require their relevant permissions. |


## 3. Approaches considered and selection

| Choice | Selected | Other approach considered and trade-off |
| --- | --- | --- |
| Hosting | Organisation-managed self-hosted instance; cloud deployment allowed | Developer-operated hosted service remains a future product option. |
| Application structure | Modular application, coordinated release, separately runnable workers | Independently deployed microservices would add distributed deployment/communication handling; not selected for initial scale. |
| Stack | NestJS/TypeScript + React/TypeScript | ASP.NET Core/C# + React/TypeScript was offered; user selected TypeScript throughout. |
| Deployment | Linux containers, Docker Compose | OS-specific native installers would require separate installation/update paths; portable container path selected. |
| Job processing | pg-boss/PostgreSQL durable queue | In-memory-only work cannot satisfy restart persistence. Exact library options are technical-contract work, not permission to bypass product retry rules. |

## 4. Module responsibilities

| Module | Responsibility and boundary |
| --- | --- |
| Identity and access | Passwordless sessions, account lifecycle, organisation eligibility, effective membership/roles/grants and policy evaluation. No administrative blanket source access. |
| Projects and membership | Owning/contributing departments, lifecycle/stages, invitations, transfers, expiry/holds and required-role gates. |
| Discussion and evidence | Shared threads, imported minutes, versions, exact references, audiences, logical deletion, sanitisation/quarantine and authorised restoration. |
| Proposals and approval | Human/AI origin, review versions, multiple distinct approvals, rejection, substantive amendments and linked authoritative records. |
| Work tracking | Task hierarchy, due dates, progress, questions, decisions, risks, review dates and resume/closure gates. |
| AI assistance | Supported provider adapters, per-project keys, permission-filtered input/output, request lifecycle, reservations/usage, fallback and limits. |
| Notifications and output services | Working-calendar scheduling, relevant recipient delivery, digests, approved external filing/version checks and uncertain-outcome reconciliation. |
| Resources and optional finance | Usage indication, financial tracking when enabled, one reporting currency, authorised adjustments and permitted summaries; no booking/accounting scope. |
| Reporting and analytics | Defined event catalogue, auditable metrics, permitted summaries/drill-down, history-aware reporting and export checks. |
| Administration and operations | System/delegated configuration, approved updates, backups/restore status, queue health and safe operational diagnostics. |

These are internal responsibilities. They are not a public API, plugin loader or separate microservice commitment. Module interfaces must be explicit; detailed package names are left to the technical design.

## 5. Runtime and data boundaries

The browser calls the application; application modules enforce business permissions and transactions. Background workers execute durable jobs from PostgreSQL. Calls to AI/email/storage go through their approved configured adapters with current permissions and provenance.

PostgreSQL holds authoritative project records, policy/approval/history associations and durable job data. A13 selects a protected Kainow-managed SharePoint/OneDrive area for imported originals, extracted text and versions; exact provider paths, file limits and permission contracts remain to be designed. Registered deliverables remain in approved external storage under the existing output rules. Analytics must refer to record/source identities without copying restricted bodies or secret values into ordinary events.

Keep persistent data and backup state separate from replaceable application containers. Backups cover records/history/configuration and protected credential recovery; keys needed to decrypt a backup must themselves be recoverable through an approved protected procedure. External project deliverables require their own backup arrangements. The Kainow-managed SharePoint/OneDrive source area, including originals, extracted text and preserved versions, is included in Kainow backup/recovery under A13. Exact recoverable dataset and integration consistency checks must be specified and tested.

## 6. Background work and cost boundaries

Use separate queue names/classes for AI, email and document processing. Two AI slots means at most two simultaneously executing requests across the installation, including multiple workers/replicas. Waiting jobs must not consume a running slot. Retries/fallback remain inside the accepted total-attempt and cost rules; the queue library's defaults cannot override them.

Jobs retain stable association to project, requesting person or configured event, source version and policy. Re-evaluate source availability, current audience/permissions, project lifecycle and allowance immediately before executing. Safely obsolete work is cancelled/held rather than processing a Deleted source, disabled access or a stale approval.

A worker crash can leave an uncertain external outcome. A queue completion/lease mechanism does not prove an email, external file write or chargeable AI request occurred exactly once. Preserve attempt identity, usage reservation and available receipts; reconcile uncertainty before repetition. The exact failure-state contract remains to be designed. No local timeout or process exit proves provider cancellation.

## 7. Updates and recovery

Every release installation requires explicit Enterprise Administrator approval. A release-specific scheduled installation is allowed; future releases are not implicitly authorised. Release integrity/authenticity checks, compatibility validation, maintenance/quiescence, backup verification, migration handling and post-update health checks require a concrete design before enabling updates. Database rollback cannot be assumed safe merely because an older application image exists.

The accepted defaults are daily encrypted backups, 30-day backup retention and 24-hour/4-hour recovery targets. These are to be verified on documented supported infrastructure, not guaranteed by choosing containers or PostgreSQL. A successful backup must contain the recoverable records and have a verified integrity/completion outcome. Restore testing, including actual protected-credential recovery and external-reference consistency, is required.

Backup expiry does not purge indefinitely retained product history from the live authoritative dataset. The no-permanent-deletion product rule remains intact. Backup expiry is rotation of recovery copies under the accepted 30-day policy.

## 8. Capacity, scaling and boundaries

Assess 200 registered/10 concurrently active users with reading, discussion, task updates, approvals and dashboards, plus separate queued AI activity. Report latency, errors, queue wait/execution times and database behaviour. The detailed workload mix, duration and thresholds beyond existing first-use targets require an assessment specification; do not invent a hardware guarantee.

Increasing capacity may use more resources or worker replicas with shared authoritative data. Global AI limits, cost reservations, job ownership, scheduled work and permission checks must continue to work across replicas. Single-host Docker Compose does not itself establish high availability or automatic scaling. Support for a later developer-hosted service remains a separate decision; one organisation per installation still applies.

## 9. What is left to the technical design

- Pin supported Node.js, NestJS, React, PostgreSQL and pg-boss versions, image/CPU/runtime matrix and applicable dependency notices.
- Define exact data contracts, database/RLS roles and policies, transactions, source/file storage, encryption and credential/key recovery.
- Specify internal module interfaces, permissions/event IDs, job failure/reconciliation contracts and distributed concurrency enforcement.
- Design the approved updater's trust boundary, migration/maintenance/recovery procedure, backup completeness validation and actual cloud/runtime configuration.
- Define workload/latency expectations, the analytics metric catalogue, interface layouts and verification evidence.

These are required downstream work, not permission to reopen accepted requirements. No product code, deployment, backup/restore, load or security tests were executed to prepare this document. See the [Remaining Design and Verification Register](Kainow-V1.0-Remaining-Design-and-Verification-Register.md).

## 10. Reference rationale

The following primary references informed the proposals; exact version-specific compatibility remains to be verified:

- [Docker Compose production deployment](https://docs.docker.com/compose/how-tos/production/).
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) and [backup/restore](https://www.postgresql.org/docs/current/backup.html).
- [NestJS modules](https://docs.nestjs.com/modules).
- [pg-boss](https://github.com/timgit/pg-boss).

Reference availability is not evidence that the designed Kainow integration has passed testing.

## 11. Accepted source/storage/security refinements A13–A19

| ID | Area | Accepted rule |
| --- | --- | --- |
| A13 | Managed sources | Imported original files, extracted text and preserved versions reside in a protected SharePoint/OneDrive area managed by Kainow; PostgreSQL stores source/version/permission/quote references. Exact approval evidence is not silently replaced by external edits. Source-area content is part of Kainow recovery, not only the database. |
| A14 | Direct source access | Ordinary users access managed sources through the Kainow front end. Only explicitly designated storage Administrators have direct storage access, alongside the authorised integration connection. Enterprise Administrator status alone does not grant direct access. |
| A15 | Credentials and recovery | Secrets entered via protected settings are encrypted at rest and never redisplayed after saving. Encryption keys remain separate from the database/backups they protect, with separately protected recovery copies maintained by designated Administrators. Record replacement/revocation/rotation without secret values. Use portable deployment-secret handling; supported cloud secret-manager integration may be configured. |
| A16 | Diagnostic retention | Routine technical diagnostics default to 30-day Administrator-configurable retention. Business/history/security-audit records and defined analytics events remain indefinitely retained under existing protections. Diagnostic expiry does not erase evidence; preserve relevant diagnostics for investigation before expiry. |
| A17 | Provisional storage | Application/images/PostgreSQL/queues/diagnostics: 20 GB minimum provisioning target, 50 GB recommended SSD, excluding host OS/base VM. Approximately 30 GB is expected footprint, not a ceiling; 20 GB only suits a smaller initial footprint and requires install/operation/update testing. Managed source quota 25 GB minimum/100 GB recommended initial allocation. Backups sized from retained daily/pre-update copies plus at least 20% headroom. These are estimates requiring verification, not tested guarantees. |
| A18 | Backup failure | Continue existing project work, alert Administrators and keep a persistent dashboard warning. Show last successful backup and whether the 24-hour recovery target is exceeded. Block updates until a fresh successful backup exists. Never report unresolved backup failure as healthy. |
| A19 | Critical storage | At the verified safe free-space threshold enter protective read-only mode: safe reads continue; pause new imports, AI jobs and other data-changing work; block updates and actions unable to reliably persist both change/history. Alert affected location/capacity. Never delete retained evidence automatically. After restored capacity and passing health checks, Administrator confirms resumption. |

[Managed-Sources-Credentials-Storage-and-Recovery-Rules](Kainow-V1.0-Managed-Sources-Credentials-Storage-and-Recovery-Rules.md) records the accepted refinements. Managed sources now explicitly use SharePoint/OneDrive under Kainow control. Database backup alone is insufficient. No implementation or measurement is claimed.
