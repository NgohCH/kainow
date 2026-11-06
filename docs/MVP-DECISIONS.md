# Kainow MVP — Decisions Log

Date recorded: 7 November 2026 (UTC+8).
Scope: December 2026 MVP, a working vertical slice. It is not the full V1.0 release, and the deferrals below are not approved for release.

## Confirmed by Product Owner

| # | Topic | Decision |
|---|---|---|
| 1 | MVP scope | Accepted as proposed: sign-in, meeting notes (paste/upload), AI extraction with source links, review screen, monthly AI spend cap, local Compose install. Deferred to January: SharePoint/OneDrive, email, reminders, updater, full restore drill, full accessibility audit, newcomer test, 200-user load test, Safari/Firefox. |
| 2 | OpenAI model | "GPT 6.1 Luna" for now. Can switch to "Sol" later. **Pending check:** the exact API model ID must be confirmed against OpenAI's model list on the Product Owner's machine before pinning (R09). |
| 3 | AI spend cap | Applies to the finished product's runtime AI use only, not to development. Amount: $5. **Pending confirmation:** currency (USD assumed) and reset boundary (calendar month, UTC+8 assumed). |
| 4 | Sign-in | Passwordless. Named user for the Product Owner: ngoh.ch@help.edu.my. More users to be supplied. |
| 5 | Roles | Project Manager and his delegates. **Pending:** confirm whether an Enterprise Administrator role is needed for the MVP (the register defines one). |
| 6 | Data retention | As per the handover documents (R07): no purge feature, logical deletion only, history kept. |
| 7 | Languages | English and Bahasa Melayu, including mixed-language notes. |
| 8 | Quality thresholds | Accepted: 95% supported proposals, 90% expected items captured. |

## Execution decisions

- **Docker Hub:** the sandbox cannot reach Docker Hub. Container builds and the Compose package are built and tested on the Product Owner's computer. The sandbox handles code, unit and integration tests against native PostgreSQL 16.
- **OpenAI access:** the sandbox cannot reach `api.openai.com`. Real extraction tests run on the Product Owner's computer, using an environment variable for the key. The test runner skips cleanly without it.
- **Meeting notes:** provided by the Product Owner, produced by another note-taking tool. Format to be checked before the extraction tests are written.

## Proposed defaults for design items (NOT APPROVED)

These are proposals to be approved or changed. Per the handover rules, they do not count as product decisions until approved.

- **R01 Architecture:** single NestJS application plus a pg-boss worker process in one repository, one PostgreSQL database, one tenant per installation, row-level security on project-scoped tables.
- **R02 Data contracts:** UUIDv7 identifiers; timestamps stored in UTC and displayed in UTC+8; text stored as UTF-8 (NFC); source quotes located by character offset in normalised text, with repeated quotes disambiguated by offset plus occurrence index.
- **R03 Permissions:** default deny. MVP roles: Project Manager (full control of their project and its users) and Delegate (create meetings, review extractions). Each action in the MVP is tested for both allowed and denied cases.
- **R05 Sessions:** the accepted defaults: one-time codes valid 10 minutes, 5 attempts, 30-minute lockout, 12-hour sessions.
- **R07 Retention:** no purge in the MVP. Deleted items are hidden, not removed, and version history is kept.
- **R09 Provider data:** the provider model ID is pinned in configuration. Each call records input and output token counts. The system does not assume the provider can cancel or delete data.
- **R10 Spend enforcement:** a monthly cap. Each call reserves its estimated cost before it runs and stops when the cap would be exceeded. Charges that cannot be confirmed count against the cap until reconciled.

## Deferred (not in MVP)

R02–R20 remain open for the full V1.0 release, except where listed above. R14, R15, R16, R17 and R19 are deferred. R20 (repository notices) is checked before go-live, not for the MVP.

## Open items for the Product Owner

1. Confirm the spend cap currency and reset boundary (item 3).
2. Confirm the exact OpenAI model ID after checking the provider list.
3. Confirm whether an Enterprise Administrator role is needed for the MVP (item 5).
4. Approve or change each proposed default above.
