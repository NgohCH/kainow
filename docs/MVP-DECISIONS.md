# Kainow MVP — Decisions Log

Date recorded: 7 November 2026 (UTC+8).
Scope: December 2026 MVP, a working vertical slice. It is not the full V1.0 release, and the deferrals below are not approved for release.

## Confirmed by Product Owner

| # | Topic | Decision |
|---|---|---|
| 1 | MVP scope | Accepted as proposed: sign-in, meeting notes (paste/upload), AI extraction with source links, review screen, monthly AI spend cap, local Compose install. Deferred to January: SharePoint/OneDrive, email, reminders, updater, full restore drill, full accessibility audit, newcomer test, 200-user load test, Safari/Firefox. |
| 2 | OpenAI model | **Changed 7 November 2026:** `gpt-6.1-sol` is the model. `gpt-6-luna` is dropped and there is no alternate for now. See "Updates of 7 November 2026" below. |
| 3 | AI spend cap | Applies to the finished product's runtime AI use only, not to development. Amount: MYR 20 per month. Reset boundary: calendar month, UTC+8 (assumed; confirm if different). |
| 4 | Sign-in | Passwordless. Named user for the Product Owner: ngoh.ch@help.edu.my. More users to be supplied. |
| 5 | Roles | Enterprise Administrator for the MVP. Project Manager and delegates as described in the handover (to be mapped to the register's role matrix under R03). |
| 6 | Data retention | As per the handover documents (R07): no purge feature, logical deletion only, history kept. |
| 7 | Languages | English and Bahasa Melayu, including mixed-language notes. |
| 8 | Quality thresholds | Accepted: 95% supported proposals, 90% expected items captured. |

## Execution decisions

- **Docker Hub:** the sandbox cannot reach Docker Hub. Container builds and the Compose package are built and tested on the Product Owner's computer. The sandbox handles code, unit and integration tests against native PostgreSQL 16.
- **OpenAI access:** the sandbox cannot reach `api.openai.com`. Real extraction tests run on the Product Owner's computer, using an environment variable for the key. The test runner skips cleanly without it.
- **Meeting notes:** provided by the Product Owner, produced by another note-taking tool. Format to be checked before the extraction tests are written.

## Design defaults (Product Owner answers recorded)

The Product Owner answered these proposed defaults. Items marked with a note were changed from the original proposal.

- **R01 Architecture:** single NestJS application plus a pg-boss worker process in one repository, one PostgreSQL database, one tenant per installation, row-level security on project-scoped tables.
- **R02 Data contracts:** UUIDv7 identifiers; timestamps stored in UTC and displayed in UTC+8; text stored as UTF-8 (NFC); source quotes located by character offset in normalised text, with repeated quotes disambiguated by offset plus occurrence index.
- **R03 Permissions:** default deny. MVP role: Enterprise Administrator with full control of the application. Each action in the MVP is tested for both allowed and denied cases. Project Manager and delegate roles are not part of the MVP.
- **R05 Sessions:** the accepted defaults: one-time codes valid 10 minutes, 5 attempts, 30-minute lockout, 12-hour sessions.
- **R07 Retention:** MVP test data may be purged. In the deployed product, deletion is logical only: items are hidden, not removed, and version history is kept. The product must not include a purge feature, per the handover register.
- **R09 Provider data:** the provider model ID is pinned in configuration and can be changed by the Enterprise Administrator. Each call records input and output token counts. The system does not assume the provider can cancel or delete data.
- **R10 Spend enforcement:** a monthly cap of MYR 20. Each call reserves its estimated cost before it runs and stops when the cap would be exceeded. Charges that cannot be confirmed count against the cap until reconciled.

## Decisions on O01–O07 conflicts (Product Owner, 7 November 2026)

1. **Input and output formats:** accept all formats in O03. Input: pasted text, TXT, Markdown, DOCX, selectable-text PDF. Output: Markdown, DOCX, PDF, CSV for tabular reports. This replaces the earlier text-and-DOCX-only scope.
2. **Spend cap:** the monthly cap of MYR 20 is sufficient. No separate daily cap for the MVP. **Note:** O04 requires daily and monthly periods with a blank limit meaning no allowance. Confirm the implementation treats the daily period as unlimited when no daily cap is set, rather than blocking all calls.
3. **Administrators and recovery:** one Enterprise Administrator for the MVP, who is also the recovery custodian. **Risk:** with one administrator, a lockout has no second person to restore access. O07 expects two or more named administrators and a separate custodian before go-live. This is acceptable for the MVP only, and must be fixed before production.
4. **Credential detection (O01):** accepted. A basic pattern check runs before AI transmission. Detection is best-effort, as O01 states.

## Deferred (not in MVP)

R02–R20 remain open for the full V1.0 release, except where listed above. R14, R15, R16, R17 and R19 are deferred. R20 (repository notices) is checked before go-live, not for the MVP.

## Updates of 7 November 2026 (Product Owner, later the same day)

1. **Sign-in code delivery:** the proposal was accepted. The code is sent by a small email sender used only for sign-in codes. Other email stays deferred to January.
2. **Model and prices:** the model is `gpt-6.1-sol`. Conversion rate: 1 USD = 4.1 MYR. Prices quoted in USD at Standard processing rates for normal-length requests:

   | Token type | `gpt-6.1-sol` |
   | --- | --- |
   | Input | $2.00 |
   | Cached input | $0.10 |
   | Output | $10.00 |

   The Product Owner also quoted Batch/Flex rates for `gpt-6.1-sol` ($1 input and $5 output per million tokens). The MVP is built on the Standard rates above, which cost more, so the cap errs on the safe side.
3. **Originals:** the MVP stores the original file and its extracted text in PostgreSQL. SharePoint/OneDrive storage stays deferred.

### Confirmed later on 7 November 2026

- **Prices are per 1 million tokens.** The Product Owner's pricing screenshot is headed "API pricing (USD per 1 million tokens)".
- **Price column:** the `gpt-6.1-sol` column is used (cached input $0.10). The screenshot also has a "GPT-6 Sol" column at $0.20 cached input, which is not used because the model chosen is `gpt-6.1-sol`.
- **`gpt-6-luna` is dropped.** "Drop gpt-6.1-luna" was read as `gpt-6-luna`, and the Product Owner confirmed.
- **The monthly cap resets at the start of the calendar month in UTC+8.** Confirmed.
- **A 4xx answer from the AI provider counts as not charged.** An error answer (bad key, bad request, "slow down") before any work is treated as proof of no charge, and the reservation is given back. A timeout, lost connection, 5xx answer or an answer without usage is an unknown outcome and the full estimate stays counted. Confirmed by the Product Owner.

### How "no daily cap" is represented

The product rules say a blank spending limit means zero allowance and that no setting silently means unlimited. The Product Owner decided there is no daily cap in the MVP. Both hold if "no daily cap" is an explicit, recorded setting and not a blank:

- Daily mode `not_applied` means no daily limit is enforced. It is set deliberately and recorded in the audit trail.
- Daily mode `limit` with a blank or zero amount blocks every request, as the product rules require.
- A monthly limit that is blank or zero blocks every request.

### Spend cap figures (for reference)

At 1 USD = 4.1 MYR, MYR 20 a month is about USD 4.88. At the Standard rates above, a meeting extraction of 10,000 input tokens and 2,000 output tokens (the example in the Product Owner's screenshot) costs about USD 0.04, or MYR 0.164, so the cap allows roughly 120 such extractions a month. Longer notes cost more. Reservations are deliberately larger than the likely cost (see `app/README.md`).

## Open items for the Product Owner

1. Approve or change each proposed default above.
