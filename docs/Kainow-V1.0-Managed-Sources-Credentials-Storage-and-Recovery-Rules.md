# Kainow V1.0 — Managed Sources, Credentials, Storage and Recovery Rules

**Version:** 1.0  
**Date:** 6 November 2026  
**Status:** Accepted product/runtime requirements A13–A19; implementation contracts and verification outstanding.  
**Scope:** Product data and operations, not development-workstation or agent execution controls.

## 1. Accepted decisions

| ID | Area | Accepted rule |
| --- | --- | --- |
| A13 | Managed sources | Imported original files, extracted text and preserved versions reside in a protected SharePoint/OneDrive area managed by Kainow; PostgreSQL stores source/version/permission/quote references. Exact approval evidence is not silently replaced by external edits. Source-area content is part of Kainow recovery, not only the database. |
| A14 | Direct source access | Ordinary users access managed sources through the Kainow front end. Only explicitly designated storage Administrators have direct storage access, alongside the authorised integration connection. Enterprise Administrator status alone does not grant direct access. |
| A15 | Credentials and recovery | Secrets entered via protected settings are encrypted at rest and never redisplayed after saving. Encryption keys remain separate from the database/backups they protect, with separately protected recovery copies maintained by designated Administrators. Record replacement/revocation/rotation without secret values. Use portable deployment-secret handling; supported cloud secret-manager integration may be configured. |
| A16 | Diagnostic retention | Routine technical diagnostics default to 30-day Administrator-configurable retention. Business/history/security-audit records and defined analytics events remain indefinitely retained under existing protections. Diagnostic expiry does not erase evidence; preserve relevant diagnostics for investigation before expiry. |
| A17 | Provisional storage | Application/images/PostgreSQL/queues/diagnostics: 20 GB minimum provisioning target, 50 GB recommended SSD, excluding host OS/base VM. Approximately 30 GB is expected footprint, not a ceiling; 20 GB only suits a smaller initial footprint and requires install/operation/update testing. Managed source quota 25 GB minimum/100 GB recommended initial allocation. Backups sized from retained daily/pre-update copies plus at least 20% headroom. These are estimates requiring verification, not tested guarantees. |
| A18 | Backup failure | Continue existing project work, alert Administrators and keep a persistent dashboard warning. Show last successful backup and whether the 24-hour recovery target is exceeded. Block updates until a fresh successful backup exists. Never report unresolved backup failure as healthy. |
| A19 | Critical storage | At the verified safe free-space threshold enter protective read-only mode: safe reads continue; pause new imports, AI jobs and other data-changing work; block updates and actions unable to reliably persist both change/history. Alert affected location/capacity. Never delete retained evidence automatically. After restored capacity and passing health checks, Administrator confirms resumption. |

## 2. Managed source storage and access

Administrator selects an approved SharePoint document library or OneDrive location. Kainow controls its protected source area and preserved versions, including originals and extracted text. Its ordinary users view/download permitted evidence through the managed front end; direct provider access is reserved to specifically designated storage Administrators and the authorised service connection. This source-area policy is distinct from ordinary project deliverables and their agreed external folder/access rules.

PostgreSQL retains stable source/file/version identifiers, actor/time, audience/permission references, extraction/version relationships and exact quote locations. Refer to the precise version used in approval. Missing or externally edited files are flagged rather than silently replacing evidence. Provider ACLs, application checks, direct-link handling and access revocation require concrete design and verification. Do not assume possession of a file URL grants access.

Storage-administration designation is an explicit privileged storage permission, separate from Enterprise Administrator status. It does not grant new application approval powers. Quarantine encryption and separately approved security grants still protect quarantined originals; direct storage administration must not silently become a quarantine-decryption grant. Provider-side administrator access and its audit coverage must be documented honestly; Kainow cannot claim to intercept every action outside its front end.

The backup/recovery procedure must cover the Kainow-managed source area, source versions/extracted text and their database associations, alongside records/configuration/protected credential recovery. A PostgreSQL-only backup is incomplete for this design. External deliverables require their own backup arrangement, as previously agreed.

## 3. Credential protection and recovery

Keys/connection secrets are entered through protected authorised settings. After saving, the interface shows connection status or non-secret identifiers, not saved secret values. Application/integration processes can use secrets through their protected execution path. No secret values in history, diagnostics, source text or analytics. Log only the actor, action, connection identity and non-secret outcomes.

Encrypt stored credentials with keys maintained separately from their database/encrypted backup. Designated Administrators retain separately protected key-recovery material. Support portable deployment-secret handling; supported cloud secret-manager integration may be configured without hardcoding the product to one cloud. Concrete encryption/key-management mechanism, designation authority, key rotation and recovery proof are still required technical/security contracts.

A recovery rehearsal must actually recover usable protected credentials or safely re-provision them under approved authority. Never claim that a copied encrypted database alone proves recovery. Restoring data must not reinstate revoked grants, expose secrets or automatically replay uncertain external requests.

## 4. Diagnostic retention and evidence

Routine debug traces/performance diagnostics default to 30 days, Administrator-configurable. Business records, versions, approvals, business history, security/access audit and defined analytics events retain the accepted indefinite logical-retention protection. Operational diagnostics and durable evidence must be clearly classified; mandatory evidence cannot be relabelled diagnostic to expire it.

Analytics derives from defined retained events and measurements, not solely from expiring debug logs. Sanitise diagnostics and preserve relevant material for an authorised investigation before scheduled expiry. Investigation access remains restricted. Short-lived diagnostic rotation is an explicitly accepted distinction; it does not authorise permanent deletion of user messages or accountable records.

## 5. Provisional storage and capacity monitoring

| Component | Minimum initial provisioning target | Recommended initial allocation |
| --- | ---: | ---: |
| App/images/PostgreSQL/jobs/diagnostics, excluding host OS/base VM | 20 GB SSD | 50 GB SSD |
| Kainow-managed SharePoint/OneDrive source area | 25 GB available quota | 100 GB available quota |
| Separate encrypted backups | Calculated from actual retained backup copies | Add growth and pre-update copies plus at least 20% headroom |

Approximately 30 GB is the Owner's expected operating footprint, not a measured bound or lifetime maximum. 20 GB cannot support a 30 GB live footprint. The 20 GB target is accepted only provisionally for a smaller initial installation and must be tested for installation, ordinary operation and updates with required safety margin. 50 GB is the recommended starting allocation. If measured requirements exceed these targets, report the conflict before release rather than claiming a pass or deleting history.

For daily full backups, capacity is at least 1.2 × (total retained daily-backup bytes + total retained pre-update-backup bytes), with forecast growth separately allowed. Example: thirty 2 GB daily copies plus one 2 GB pre-update copy need 74.4 GB, rounded to approximately 75 GB. This is an illustrative calculation, not a fixed backup quota or an assumed compression/deduplication ratio. An alternative verified backup method must still cover the accepted recovery/retention requirements.

Show local/application, database, managed-source and backup storage usage/growth on the Administrator dashboard where observable. Unknown provider quota is Unavailable, never zero. Accepted alert defaults are 80% warning and 90% critical, configurable. Expand capacity without deleting retained product history. Installation/updates check available capacity, including temporary/update-image and recoverable-backup requirements. Alert percentages are separate from the verified safe free-space threshold for protective mode.

## 6. Failure behaviour

Backup failure: existing work continues, Administrator alert and persistent warning, last-success time and 24-hour recovery-target breach visible; no update before a fresh successful backup. Preserve failure evidence and distinguish stale backups from a healthy current backup.

Critically low storage: use a tested safe threshold, not an invented fixed percentage. Safe information access remains; pause imports/AI/background work and actions that cannot persist reliable changes/history, block updates and alert affected location/capacity. Existing queued jobs and uncertain receipts stay preserved. Resumption requires restored capacity, successful health checks and explicit Administrator confirmation. Backups/recovery operations themselves need capacity-aware checks; do not assume safe read-only state means a backup can always be written.

No automatic deletion of retained records/evidence to free space. An approved routine-diagnostic retention policy remains distinct; low-space handling cannot override it to erase protected history. Exact detection/resume thresholds and failure atomicity remain release-tested contracts.

## 7. Required verification and remaining detail

- Verify protected SharePoint/OneDrive source/version access through Kainow, designated direct access and service identity; test ordinary users, raw links, audience/grant changes, quarantine and provider access loss.
- Verify immutable approval references after external changes, missing versions, deletion/quarantine, restored files and mismatched metadata/content.
- Restore database plus managed sources/versions and protected credentials consistently within the accepted recovery targets; verify keys are recoverable and access does not silently revive.
- Verify secret non-disclosure, masking, authorised rotation/revocation and separation of encryption keys from encrypted recovery copies.
- Verify diagnostic rotation/preservation without deletion of retained analytics/history/security evidence.
- Measure disk use on the 20 GB minimum/50 GB recommended profiles, including updates, backups/staging, logs, temporary work and database overhead. Retention/growth modelling is required; capacity is not proven by user count alone.
- Inject backup failure, stale backup, insufficient source quota/local capacity and uncertain persistence. Check warnings, update blocks, protective read-only behaviour and explicit safe resumption.

Exact storage layout/provider IDs, provider permissions and version-retention protection, key-recovery/designation authority, security predicates, file/schema limits, backup method and tested thresholds remain technical design work. These decisions do not claim implementation, production enforcement or completed tests.
