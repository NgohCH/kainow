# V1.0 sub-project 6: AI configuration — providers, project keys, fallback and spending caps — design

**Date:** 18 November 2026
**Status:** Approved by the Product Owner on 18 November 2026, after section-by-section agreement in conversation and a builder check.
**Builds on:** branch `TheLord/design-ai-config-b6a1dc`, cut from the sub-project 5 branch `TheLord/dreamy-perlman-c11354` (PR #15, not yet merged). Rebase onto `main` once #15 merges. Next migration: `0028_ai_configuration.sql`.
**Authority:**
- Intent Card principle 6.
- Product Summary §13 and §18 (Q01, Q06).
- Consolidated Specification:
  - §8 and §13;
  - D19, D41–D44 and D76;
  - O03, O04, O14, Q01 and Q06;
  - A05, A11, A15 and A19.
- AI Configuration, Data Handling and Usage Rules §2–§11, §14 and §15.
- Managed Sources, Credentials, Storage and Recovery Rules §3.
- Permission Matrix rows 141–143 and 150–151, and row 188.
- Configuration Catalogue C38–C46, C63 and C69.
- Remaining Design and Verification Register R09 and R10.
- The sub-project 5 design (`2026-11-16-v1-history-deletion-design.md` §7.3, §7.4), whose protected key and text registry this design reuses.
- The new decisions D84–D87 below.

## 1. Purpose and the why

Intent Card principle 6 says: "Administrator-approved API providers, project-specific keys, approved fallback and individually attributable usage where applicable. Enforce applicable organisation/project/user caps; blank or zero means no allowance. Never borrow another project's credentials or treat unknown cost as zero."

Today Kainow has one OpenAI key for the whole installation, in `.env` (`OPENAI_API_KEY`, read only by the worker). It has one model and one organisation-wide spending cap in MYR: monthly, with an optional daily cap and an optional per-person cap. Spend entries do not record a project. The reservation, settlement and uncertain-cost rules in `guardedAiCall` and `SpendService` are sound, and all four job runners share them.

Sub-project 6 makes AI configurable and bounded as the rules require:

1. **An approved-model catalogue:**
   - OpenAI and Anthropic models the Administrator has approved;
   - their prices;
   - the provider's data terms;
   - the kinds of work and data each model may receive.
2. **Project connections:** each project has its own encrypted API keys, a primary connection and an ordered fallback list. They are managed by the Administrator, or by the PM, Owner or Sponsor where the Administrator has delegated it.
3. **Fallback:** a provider outage moves the next attempt to the next connection. A rejected key stops the request and takes that connection out of use until the key is fixed (D84).
4. **Caps at every level:**
   - organisation (monthly, optional daily, optional per-person);
   - project (monthly, optional daily, optional per-person-in-project).
   Every attempt reserves against every limit that applies, and the tightest wins (D85).
5. **Usage by project and person**, shown to the people the matrix allows, and never showing content or keys.
6. **Bounded operational numbers:** attempts per request, timeout per attempt, and AI requests at once (D87).

### Goals

- No AI request is sent unless the project has a usable connection approved for that kind of work and data, a positive project allowance and a positive organisation allowance, plus a positive personal allowance where one applies (Q06).
- A request uses only its own project's keys and budget, through every retry and fallback.
- Every attempt records the project, connection, provider, model, prices, tokens, and cost as estimated, reserved, uncertain or confirmed.
- Keys are encrypted with a key kept apart from the database and its backups, and are never shown again, logged, emailed or put in history.
- The existing guarantees still hold:
  - every cost is reserved before sending;
  - an unknown outcome stays counted;
  - a 4xx answer before any work is released as not charged;
  - the sub-project 5 sweep-lock and staleness check stay intact.

### Non-goals (6)

- Providers other than OpenAI and Anthropic, cloud-platform variants of them (Bedrock, Vertex, Azure, Foundry) and arbitrary endpoint URLs (C38: "no arbitrary endpoint/plugin loading").
- Rotating the protected key, and cloud secret-manager integration. Each encrypted key row records its key id, as in sub-project 5, so rotation can be added later (sub-project 10).
- Reconciling provider bills, and price lookups. The Administrator types prices in, and a later bill is not matched automatically (R10 remains partly open: see §12).
- Provider-side features Kainow does not use: batch APIs, prompt caching, server-side model fallback, fast or priority tiers.
- Department-level caps, and AI spend in project finance (D33 keeps the two apart).
- Pausing AI during critical storage protection (A19). That belongs to operations (sub-project 10), and the gate added here is where it will plug in.

### Anti-goals (failure even if it works)

- A request that uses another project's key, or whose cost lands in another project's allowance.
- A key value in any log, error message, API response, audit or event row, notification, email, backup-readable plain column or AI prompt.
- A fallback that sends restricted material, or a kind of work, to a connection not approved for it.
- Any blank or zero limit, or a missing project setup, that lets a request through.
- A rejected key that keeps being tried on every request, or that silently pushes all traffic to the fallback without anyone being told.
- A configuration change that silently reprocesses content, cancels or rewrites existing proposals, or rewrites the cost of an earlier attempt.

## 2. Decisions taken with the Product Owner

| Question | Decision |
|---|---|
| What should fallback do when the primary fails? | **Outages only (A).** A timeout, connection failure, 5xx or 429 moves the next attempt to the next connection in the project's order, wrapping back to the primary. A rejected key (401/403) or a refused request (other 4xx) ends the request without retry. A rejected key also marks the connection *Key rejected*, alerts its managers, and makes later requests skip it until the key is replaced. (PO, 18 Nov 2026) |
| An unusable answer (malformed, cut off, declined, bad citations) | Retried as today, on the next connection in the order: a different model may do better. *(Claude's call, shown to the PO, not objected to.)* |
| What does the per-person cap mean? | **Both levels (A).** The organisation's per-person monthly limit (Administrator) stays, and an optional per-person monthly limit inside each project is added (project limit managers). The tightest applicable limit wins. (PO, 18 Nov 2026) |
| Project caps | Monthly is required (blank = no allowance), daily optional, per-person-in-project optional. Set by the Administrator, or by PM/Owner/Sponsor when the Administrator lets projects set AI limits. The Administrator may set a ceiling a delegate cannot go above. The organisation cap always governs. *(Claude's proposal, shown, not objected to.)* |
| What makes a connection "approved for the data and operation"? | **Per kind of work, plus restricted material (A).** Each approved model records the provider's retention and training terms as text, six kind-of-work boxes (extraction, discussion analysis, minutes drafts, answers, report drafts, summaries) and a "may receive restricted sources" box. A request only goes to connections approved for its kind of work, and for restricted material where it carries any. (PO, 18 Nov 2026) |
| Keys | Encrypted with sub-project 5's protected key and decrypted only for a call or a key check. Never shown again, not even in part. A free "Check key" calls the provider's model listing. Managing connections is a separate delegation switch from setting limits. `OPENAI_API_KEY` leaves the worker; the probe scripts keep reading keys from the environment. *(Claude's proposals, shown, not objected to.)* |
| Bounds of the three configurable numbers | Attempts per request 1–5 (default 3); timeout per attempt 30–300 s (default 120 s). For both, the Administrator sets the organisation value and a project may only lower it. AI requests at once 1–10 (default 2), Administrator only, enforced across all workers. (PO accepted, 18 Nov 2026) |
| How to build it | Extend `guardedAiCall`, `SpendService` and the model clients in place, with one migration. A separate AI gateway that replaces the tested call path was rejected. (PO, 18 Nov 2026) |

### 2.1 New Decision Register entries

These are added to Consolidated Specification §14 in this branch.

- **D84 — Provider fallback (18 November 2026).** A project's AI connections are tried in its order (primary, then fallbacks), skipping any not approved for the request's kind of work or, where the request carries restricted material, not approved for restricted sources. Each attempt of a request (default three in all) goes to the next eligible connection after a timeout, lost connection, provider server error or rate limit, wrapping back to the first. A rejected key or refused request ends the request without retry. A rejected key also marks the connection *Key rejected*, notifies the Administrators and the project's connection managers (never with the key), and keeps later requests off that connection until its key is replaced. An unusable answer is retried on the next eligible connection. Every attempt reserves and settles separately and records the connection, provider and model it used. A request never uses another project's key or allowance.
- **D85 — Spending limits at every level (18 November 2026).** Each attempt must fit within every applicable limit:
  - the organisation's monthly limit, and its daily limit when one applies;
  - the organisation's per-person monthly limit when one applies and a person made the request;
  - the project's monthly limit, and its daily limit when one applies;
  - the project's per-person monthly limit when one applies and a person made the request.

  Blank or zero is no allowance, wherever it appears. A project with no limits set has no allowance. Project limits are set by an Enterprise Administrator, or by the PM, Owner or Sponsor when the Administrator allows projects to set AI limits, never above a ceiling the Administrator sets. Automatic requests are system-initiated and charged to the project. Daily and monthly periods start at 00:00 UTC+8.
- **D86 — Approved models and project connections (18 November 2026).** An Enterprise Administrator approves each OpenAI or Anthropic model before use. The approval records:
  - the model identifier (configurable, not built in);
  - its prices in USD per million tokens;
  - the provider's retention and training terms;
  - the kinds of AI work it may do;
  - whether it may receive restricted sources.

  A project connection pairs an approved model with that project's own API key. Keys are entered through a protected form, encrypted with the protected key, and never shown again. Connections are managed by an Enterprise Administrator, or by the PM, Owner or Sponsor when the Administrator allows projects to manage AI connections. They are read-only while the project is Deferred or Closed. Withdrawing a model's approval or disabling a connection stops new requests through it, and leaves past usage and records as they were.
- **D87 — Bounded AI operation settings (18 November 2026).**
  - Attempts per request, including fallback: 1–5, default 3.
  - Timeout per attempt: 30–300 seconds, default 120.
  - Both are set by the Enterprise Administrator, and a project may only lower them.
  - AI requests at once across the installation: 1–10, default 2, set by the Enterprise Administrator only and enforced across all workers.
  - A change applies from a request's next attempt. A request waiting for a free place does not use up an attempt.

### 2.2 Open questions from earlier sub-projects this touches

- *4b: a request removed while its AI call is running is still charged; bad-citation retries are each charged.* Unchanged. Each fallback attempt is charged the same way.
- *Sub-project 5 NB4: any report in a project moves the sweep marker.* Unchanged. Fallback does not touch the save-time check.

## 3. Concepts

- **Provider:** `openai` or `anthropic`, a fixed list in the code. Adding one is a supported extension, not a setting.
- **Approved model:** a catalogue entry made by an Enterprise Administrator, holding:
  - provider and model identifier;
  - display name;
  - prices;
  - data terms;
  - approved kinds of work;
  - restricted-sources approval;
  - state: `approved` or `withdrawn`.

  A model may be withdrawn, but an entry is never deleted.
- **Kind of work** (`AiPurpose`, existing): `extraction`, `discussion_analysis`, `minutes_draft`, `question_answer`, `report_draft`, `summary_draft`.
- **Project connection:** a project's use of one approved model with one of that project's keys, holding:
  - a label;
  - a position in the project's order (1 = primary);
  - state: `ready`, `unchecked`, `key_rejected` or `disabled`;
  - its key history.

  One project may have several connections to the same provider, for example two models on one key.
- **Eligible connection** for a request: in the request's project; state `ready` or `unchecked`; its model `approved` and approved for the request's kind of work; approved for restricted sources when the request carries restricted material; and it has a current key.
- **Restricted material:** a request carries restricted material when any text it would send comes from a restricted-audience source (O09) or a Restricted meeting (D75). Summary drafts always do (D78). The runner works this out from what it sends (§6.3).
- **Connection manager:** for a project, an Enterprise Administrator, or the PM, Owner or Sponsor while "projects may manage AI connections" is on.
- **Limit manager:** for a project, an Enterprise Administrator, or the PM, Owner or Sponsor while "projects may set AI limits" is on.

## 4. Approved models (Administrator)

- **Fields:**
  - provider;
  - model identifier: 1–200 characters, sent to the provider as typed;
  - display name;
  - input, cached-input, cache-write and output prices: micro-USD per million tokens, the existing six-decimal parsing. A cache write is 0 for OpenAI, and Kainow does not ask for cache writes, but the price bounds an estimate if a provider reports one;
  - data terms: free text, 1–4,000 characters, credential-checked like every reason box;
  - the six kind-of-work boxes;
  - "may receive restricted sources".
- **Approving and changing** require a reason (1–1,000 characters, credential-checked). Each change is recorded with the actor, the reason and the previous and new non-secret values (Q01).
  - A price change applies to attempts reserved after it. Entries already reserved keep their snapshot, as today.
  - Narrowing the kinds of work or removing restricted approval applies at the next attempt of any pending request. That attempt may then find no eligible connection (§6.2).
- **Withdrawing** stops new attempts through every connection using the model. Connections show "Model withdrawn" and pending requests move on to other eligible connections. Withdrawing needs a reason. An approval can be given again later.
- **Uniqueness:** one approved entry per provider and model identifier. Re-approving a withdrawn entry reuses it.
- **The exchange rate** stays on the organisation's AI settings, as one MYR-per-USD rate (existing `myr_per_usd_micro`). Entries snapshot it as today.
- **Migration from today's settings:** `0028` moves `ai_spend_settings.model_id` and its prices into one catalogue entry for provider `openai`, with its kinds of work and restricted approval all **off**, data terms `Recorded before sub-project 6 — review before approving`, and state `withdrawn`. The Administrator must review and approve it before it can be used. Go-live starts from an empty database (`golive-init`), so this only affects development and demo data.

## 5. Project connections and keys

### 5.1 Managing connections

- A connection manager may:
  - add a connection: choose an approved model, give a label (1–100 characters) and paste a key;
  - replace a connection's key;
  - reorder connections;
  - disable or re-enable a connection;
  - run "Check key".

  Each change needs a reason, credential-checked, and records the actor, reason, time and previous and new non-secret values. History says "Key replaced" and never mentions the key.
- Connections are read-only while the project is Deferred or Closed (D21, D22). Disabling during those states is still allowed as a protective action (Q01). Nothing is ever deleted.
- **Pending requests:**
  - a reorder applies from a request's next attempt;
  - a newly added connection joins the order for later attempts;
  - a disabled connection is skipped from the next attempt.

  Changing connections never re-runs or cancels finished work (AI rules §3).

### 5.2 Storing a key

- The key is trimmed and must be 20–500 printable ASCII characters with no spaces. Otherwise it is refused with "This does not look like an API key."
- It is encrypted with the protected key: AES-256-GCM, a fresh nonce, the tag stored. **The associated data is the connection id, the project id and the provider**, so a sealed key copied onto another connection or project fails to decrypt. That is the cryptographic enforcement of "never borrow another project's credentials". `ProtectedKey.encrypt`/`decrypt` gain an optional associated-data argument. Existing callers pass none, which is unchanged behaviour.
- Key rows are append-only: `ai_connection_keys (id, connection_id, ciphertext, nonce, tag, key_id, saved_at, saved_by, superseded_at)`. Replacing a key adds a row and sets `superseded_at` on the old one. The old ciphertext stays for history, and only the current row is ever decrypted.
- **Without the protected key** (unset, missing or invalid):
  - adding a connection or replacing a key is refused with "AI keys cannot be saved until the protected key is installed. See INSTALL.md.";
  - every connection shows *Waiting for the protected key*;
  - every request ends `blocked` with code `protected_key_missing`, sending and charging nothing;
  - the Administrator dashboard's existing protected-key warning also names AI.

  A row encrypted under another key id cannot be decrypted. Its connection shows *Key unreadable — enter it again*, and requests skip it as not eligible.
- The key passes through the API process in memory only. It is never in logs, error texts, audit details, event rows, notifications or emails. The request body of the add and replace endpoints is never logged or echoed: the validation pipe and exception filter must not include it. A test posts a key and greps every log line, audit row and response for it.
- **Text registry (sub-project 5 §7.4):** `0028` adds plain-text columns (labels, reasons, data terms, notes). Each is registered with the quarantine text registry, or listed with a reason as holding no user text, so that the completeness test against `information_schema` still passes. Ciphertext columns are `bytea` and not user text.

### 5.3 Checking a key

- "Check key" and every save call the provider's model listing for that model:
  - OpenAI: `GET /v1/models/{model}`;
  - Anthropic: `models.retrieve(model)` in the official SDK.

  Both are free: no spend is reserved and no attempt is counted.
- Outcomes:
  - 200: the connection becomes `ready` ("Key works and can use this model").
  - 401 or 403: refused at save ("The provider refused this key"), or becomes `key_rejected` on a later check.
  - 404: refused at save ("This key cannot use <model>").
  - Timeout, connection failure or 5xx: the key is saved as `unchecked` ("Could not reach <provider> to check the key. It will be checked on first use."). An unchecked connection is eligible, and its first successful call makes it `ready`.
- The check decrypts the key in the API process. Calls decrypt it in the worker (§6.4). AI keys are sealed and opened only through a dedicated helper, `app/src/ai/keys.ts` (`sealApiKey`, `openApiKey`), which wraps `ProtectedKey` with the associated data. A test enforces that `openApiKey` is imported only by the key-check service and the model-client factory. The quarantine code's own use of `ProtectedKey.decrypt` is outside that test.

### 5.4 Rejected keys

- When a call gets 401 or 403, the attempt ends as today: `model_rejected`, released as not charged, no retry. Then, in the same transaction:
  - the connection becomes `key_rejected`, with the time and the status code;
  - an in-app notice goes to every Enterprise Administrator and every current connection manager of the project: "The <provider> key for AI connection "<label>" in <project> was refused. AI requests skip this connection until the key is replaced.";
  - a project History line is written.
- The notice never contains the key. Notices for one connection are sent at most once until the key is replaced.
- Requests then skip the connection. Replacing the key and passing the check returns it to `ready`. A passing "Check key" with the same key does not: a 401/403 seen on a real call outranks a model-list check, so the key must be replaced.
- When a 403 is a model permission rather than a bad key, the result is the same. The notice wording covers both ("refused this key, or this key may not use the model").

## 6. Running a request

### 6.1 The gate (before any attempt)

`guardedAiCall` keeps its order and adds the project. For each attempt:

1. Mark the request's stale reservations uncertain (unchanged).
2. **Effective policy:** attempts and timeout for this project, meaning the organisation value or the project's lower value (D87). If `attemptNo` is above the effective attempts, end the request `failed` with code `attempts_used` and detail "No attempts are left for this request." Nothing is sent.
3. **Choose the connection** (§6.2). If none is eligible, end `blocked`:
   - `ai_not_set_up`: the project has no connections. Detail: "AI is not set up for this project."
   - `no_eligible_connection`: there are connections, but none is approved for this work or data or usable now. Detail: "No AI connection in this project is approved for <kind of work>[ with restricted material] and usable now."
   - `protected_key_missing`: §5.2.
4. **Wait for a free place** (§6.5). Nothing is reserved while waiting.
5. **Reserve** (§7) with the chosen model's prices and the project. If blocked, release the place and end `blocked` with the existing `spend_*` codes, extended with project scopes (§7.3). Reserving right before sending is also the cap recheck at execution that A11 asks for.
6. Decrypt the key, build the provider client, and send with the effective timeout.
7. Settle, mark uncertain or release, as today. Then:
   - 401/403: mark the connection rejected (§5.4).
   - Success on an `unchecked` connection: mark it `ready`.
8. The outcome now also carries `connectionId`, `provider` and `modelId`, so runners save the model actually used, as they already save `model_id`.

A blocked request never retries: blocked is not retryable, as today. A request stays blocked until a person asks again, or, for automatic analysis, until the next eligible tick (O04).

**Automatic analysis readiness.** Today the analysis tick (`analysis/tick.ts`, `readiness()`) checks only the organisation summary before starting automatic runs. It becomes per project. A project is ready when:
- it has an eligible connection for `discussion_analysis` (ignoring restriction, which each run checks itself);
- its project monthly allowance is positive and not used up, and so is the organisation's.

A project that is not ready gets no new automatic run. Its discussion status shows *Blocked* with the reason (for example *AI not set up*, *No allowance left this month*), as the organisation-level block does today. No run row and no `ai.request_blocked` audit row is written on each tick. The check is one query for all projects the tick considers, like `effectiveAnalysisSettingsMany`. *(Claude's call after the builder check.)*

### 6.2 Choosing the connection (D84)

- Take the project's connections in order and keep the eligible ones (§3). Call this list `E`.
- **Attempt 1** uses `E[0]`.
- **A later attempt** looks at what ended the previous attempt of the same request. The request's earlier spend entries already record their connection and outcome.
  - Previous attempt failed with an **outage** (`model_unavailable`: timeout, lost connection, 5xx, missing usage; or `model_rejected` with status 429) or a **bad response**: use the eligible connection after the previous one in `E`, wrapping to `E[0]`. If the previous connection is no longer eligible, use the first eligible connection after its old position, wrapping.
  - Any other end (a refused request, a rejected key) has already ended the request with no retry, so there is no later attempt.
  - Previous attempt left **no spend entry** (it ended before sending, for example a sweep clash or a check at job start): use `E[0]` again. *(Claude's call after the builder check.)*
- With one eligible connection, every attempt uses it. That is today's behaviour.
- The choice is made at the attempt, from the current state, so a change made while a request waits takes effect (D87). The chosen connection is recorded on the spend entry before anything is sent.

### 6.3 What each runner passes

The four runners pass the project id and `carriesRestricted` into `guardedAiCall`. The sweep-lock and save code is not touched (sub-project 5 §7.4, C1): the marker is still read with the text, and the save still takes the shared lock and checks `sweptSince`.

| Runner | Kind of work | Restricted material when |
|---|---|---|
| Extraction (`extraction/runner.ts`) | `extraction`, or `discussion_analysis` for a discussion transcript | Its source's audience is `restricted` (`audience_id` or `intended_mode`), or the transcript's thread, discussion or meeting, has a `restricted` audience. |
| Minutes (`analysis/minutes-runner.ts`) | `minutes_draft` | The meeting's audience is `restricted`. |
| Assist (`assist/assist-runner.ts`) | `question_answer`, `report_draft`, `summary_draft` | Any material row sent comes from a source or thread with a `restricted` audience. A summary draft always does. |
| Analysis (`analysis/analysis-runner.ts`) | Delegates to the extraction or minutes runner | As those. |

"Restricted" means any audience in mode `restricted`, on sources and on threads of either kind. It is worked out again at every attempt, in the same read as the text to send, because an audience can change while a request waits. When in doubt the runner treats material as restricted: wrongly refusing a connection only costs a blocked request, while wrongly allowing one breaks D86. *(Claude's call after the builder check.)*

**Which row counts the attempts:** the row whose id is the spend `request_id`. For discussion analysis that is the delegated `extraction_runs` row; for minutes it is `analysis_runs`; for assist it is `ai_requests`. An attempt that ends without sending, such as a sweep clash at save time or a held source at start, still uses an attempt, as today.

The worker no longer builds one `OpenAiModelClient` at start. `RunnerDeps.model` is replaced by a `ModelClientFactory` that builds the client for the chosen connection's provider with its decrypted key, for that attempt only. The decrypted key is held in a local variable and never stored on an object that outlives the attempt. Tests inject a fake factory, as they inject a fake model today.

### 6.4 Provider clients

- **OpenAI:** `OpenAiModelClient` is unchanged except for the key, timeout and base URL passed per call. It keeps raw `fetch`, the strict `json_schema` response format, `max_completion_tokens`, the status mapping and usage parsing.
- **Anthropic:** a new `AnthropicModelClient` implements the same three interfaces (`ModelClient`, `MinutesModel`, `JsonSchemaModel`), so all answer parsing (`parseAnswer`, `parseMinutes`, the assist parsers) is shared.
  - It uses the official `@anthropic-ai/sdk` with `maxRetries: 0`, because Kainow counts every attempt itself, and `timeout` set to the attempt's effective timeout.
  - The request sends the system prompt as `system`, the user text as one user message, `max_tokens` set to the runner's maximum output, and structured output through `output_config.format` with the same JSON schema.
  - It does not set `cache_control`, sampling parameters or an assistant prefill.
  - **Usage mapping:** `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `cachedInputTokens = cache_read_input_tokens`, and a new `cacheWriteTokens = cache_creation_input_tokens`. Anthropic's `input_tokens` excludes cached tokens, unlike OpenAI's `prompt_tokens`, and the mapping keeps `Usage.inputTokens` meaning "all input". `costMicroMyr` prices cache writes at the cache-write price. For OpenAI, `cacheWriteTokens` is always 0.
  - **Thinking:** current Anthropic models count their thinking as output within `max_tokens`. The reservation, which assumes all `max_tokens` are used, therefore still bounds the cost.
  - **Stop reasons:** `stop_reason` `max_tokens` is a bad response ("The answer was cut off at the output limit"). `refusal` is a bad response ("The model declined to answer"). Both are charged, as today.
  - **Errors:**

    | Error | Result |
    |---|---|
    | `APIConnectionTimeoutError`, `APIConnectionError`, 5xx, a 200 without usage | `ModelCallError` unknown, retryable |
    | 429 | Rejected, retryable |
    | 401/403 | Rejected, not retryable, key rejected |
    | Other 4xx | Rejected, not retryable |

    Only the status goes into messages, as today: error bodies can echo input.
- **The estimate:** `estimateMaxCostMicroMyr` prices every input token at the highest of the input, cached-input and cache-write prices. A token is still at least one byte for both providers' tokenisers, so the byte bound holds.

### 6.5 AI requests at once (A05, D87)

- The limit is held in the database, so it holds across every worker process. The table `ai_call_slots (slot smallint PRIMARY KEY, holder uuid, leased_until timestamptz)` has as many usable rows as the setting.
- An attempt takes a slot after choosing its connection and before reserving, with `UPDATE … WHERE slot <= <limit> AND (holder IS NULL OR leased_until < now()) … FOR UPDATE SKIP LOCKED LIMIT 1`. This sets the holder to the request id and attempt number. The lease lasts the effective timeout plus 60 s, and the slot is released after settling, or straight away if reserving is blocked.
- **Waiting** happens before reserving, so nothing is held against any allowance and no spend entry exists while an attempt waits.
  - The worker polls about every second. The request shows *Queued — waiting for a free AI place* (the existing Queued state, O04).
  - Waiting **does not use an attempt**.
  - **Timing:** the worker waits at most 120 s in one job. 120 s of waiting, plus a timeout of at most 300 s, plus 60 s of margin for the work before and after the call, stays under the job's 600 s expiry (`JOB_OPTIONS.expireInSeconds`, unchanged). So a live call is never taken over by a second worker. *(Claude's call after the builder check.)*
  - If no slot is free after 120 s, the job is sent again to the queue with `resume: <attemptNo>` in its data and a 30 s start delay, and this job completes. The runner's claim statement does not add to `attempts` when the job carries `resume` equal to the current value. Since no spend entry was written, `UNIQUE (request_id, attempt_no)` and the stale-reservation logic are unaffected.
- pg-boss `localConcurrency` stays at the setting's maximum as an upper bound per process. The slots are the real limit.
- Lowering the setting takes effect for new slot claims. Calls already running finish.

### 6.6 Counting attempts

- Today a job's attempt number is pg-boss `retryCount + 1`, and the last attempt is `MAX_ATTEMPTS` (3, a constant). Both change:
  - the request row's existing `attempts` column (`extraction_runs`, `analysis_runs`, `ai_requests`; today set from `retryCount + 1`) becomes the counter;
  - each attempt sets `attempts = attempts + 1` in the same statement that sets the run to `running`, and uses the returned value as `attemptNo`;
  - `isLastAttempt` is `attemptNo >= effective attempts` at that moment.
- Jobs are enqueued with pg-boss `retryLimit` set to the maximum bound minus one (4). The runner, not pg-boss, ends the request when the effective attempts are used up. Raising the organisation's attempts therefore never needs re-enqueueing, and lowering them ends a pending request at its next attempt with `attempts_used`.
- The existing stale-reservation and stall-sweep code keys on the request's attempt numbers and keeps working. `MAX_ATTEMPTS` remains only as the default value of the setting.

## 7. Spending (D85)

### 7.1 Settings

- **Organisation** (`ai_spend_settings`, the existing single row, Enterprise Administrator):
  - exchange rate;
  - monthly limit (blank = none);
  - daily limit or "not applied";
  - per-person monthly limit or "not applied";
  - "projects may set AI limits" (default off);
  - "projects may manage AI connections" (default off);
  - optional ceiling on a project's monthly limit (`not_applied` or an amount);
  - attempts and timeout (§2);
  - AI requests at once.

  `model_id` and the three prices move to the catalogue (§4).
- **Project** (`project_ai_limits`, one row per project, limit managers):
  - monthly limit (blank = none);
  - daily limit or "not applied";
  - per-person monthly limit or "not applied";
  - optional lower attempts and timeout (null = the organisation value).

  No row means nothing is set: no allowance, and the project shows *Blocked — AI not set up*.
  - A delegate cannot set a monthly limit above the ceiling: "The Administrator's ceiling for a project's monthly AI limit is MYR <x>."
  - A delegate cannot set attempts or a timeout above the organisation's values. The Administrator may set any value within the bounds.
- **Changes** need a reason and are recorded with previous and new values (Q01). They apply to reservations made after the change. Entries already reserved keep their figures. Lowering a limit below what is already used makes the remaining allowance zero. It never cancels a running request.
- **Delegation switches** turning off does not clear project values set while on. They stay in force, but only an Administrator can then change them. The Settings screen shows each value, its source (organisation or project) and who may edit it (Q01, D61).

### 7.2 Spend entries

`ai_spend_entries` gains:
- `project_id uuid`: nullable for rows from before 0028, otherwise required. A CHECK requires it on rows created after the migration, through a `created_at` cut-off column default.
- `connection_id uuid`.
- `provider text`.
- `cache_write_usd_per_million_micro bigint`.
- `cache_write_tokens bigint`.

The existing `model_id` and the price snapshot are filled from the chosen catalogue entry. New indexes: `(project_id, created_at) WHERE status <> 'released'` and `(project_id, actor_user_id, created_at)`.

Entries from before 0028 have no project. They count against organisation limits only (they are inside the organisation totals), and project usage views show them nowhere.

### 7.3 Reserving

`SpendService.reserve` takes `projectId` and the chosen model's prices. Under the existing global advisory lock, it checks in this order, stopping at the first that refuses:

| Scope | Limit | Applies when |
|---|---|---|
| `monthly` | Organisation monthly | Always (blank = none) |
| `daily` | Organisation daily | Mode `limit` |
| `user_monthly` | Organisation per-person | Mode `limit` and a person made the request |
| `project_monthly` | Project monthly | Always (no row or blank = none) |
| `project_daily` | Project daily | Mode `limit` |
| `project_user_monthly` | Project per-person | Mode `limit` and a person made the request |

- "Fits" is unchanged: the estimate is at most the remaining allowance.
- Block reasons are unchanged (`not_configured`, `no_allowance`, `cap_would_be_exceeded`), with the scope added to the failure code. Examples are `spend_project_no_allowance` and `spend_project_user_cap_would_be_exceeded`.
- Each refusal writes the existing `ai.request_blocked` audit row with the project and scope.
- Failure details name the level: "This request could cost more than the project's monthly AI allowance that is left."

`settle`, `markUncertain`, `releaseUnsent` and `reconcileNotCharged` are unchanged apart from the cache-write tokens.

### 7.4 Usage views (O14, AI rules §9)

| Viewer | Sees | Route |
|---|---|---|
| Any person | Their own usage by project and month: requests, attempts, confirmed, uncertain and reserved amounts, and their remaining personal allowance at each level that applies | `GET /ai/usage/mine` |
| PM, Owner, Sponsor of the project (not Deputy, not by Administrator standing alone) | The project's totals for the current day and month against its limits; a per-person breakdown; system-initiated usage by kind of work; attempts by connection, provider and model, with failures, fallbacks and charged failures | `GET /projects/:id/ai/usage` |
| Enterprise Administrator | Organisation totals against organisation limits; a breakdown by project and by person; the same attempt figures; entries from before projects | `GET /ai/usage` |

- Amounts are labelled as **Confirmed** (from reported usage), **Uncertain** (estimate kept because the outcome is unknown) or **Reserved** (estimate for a running request). Totals say "includes MYR x uncertain" and never present an estimate as actual spend (AI rules §10).
- No view shows a prompt, question, source title, answer text or key. Per-person rows show the person's display name.
- The existing header spend meter becomes the viewer's own remaining allowance in the current project. In a project the viewer manages, it shows the project's monthly remaining.

## 8. Permissions (additions to the matrix)

| Action | Who | Notes |
|---|---|---|
| Approve, change or withdraw an AI model | Enterprise Administrator | Reason; terms recorded; never deletes |
| Set organisation AI limits, policy numbers and delegation switches | Enterprise Administrator | Reason; bounds of D87 |
| Add, replace key, reorder, disable or enable, check a project AI connection | EA; PM/Owner/Sponsor while "projects may manage AI connections" is on | Reason; Draft, Planned or Active only (disable also when Deferred or Closed); key never shown |
| Set project AI limits | EA; PM/Owner/Sponsor while "projects may set AI limits" is on | Reason; ceiling; Draft, Planned or Active only |
| See a project's AI connections (labels, models, states, last used; never keys) | PM, Deputy, Owner, Sponsor; EA | Deputies see but cannot change |
| View own, project or organisation AI usage | As §7.4 | Unchanged rows 141–143 |

The existing `ai.settings.manage` action covers the Administrator rows. New project actions are `ai.connections.manage`, `ai.limits.manage` and `ai.connections.view`, decided in `projects/matrix.ts` with the delegation switch passed in, as `analysis.settings` already does.

## 9. Screens

- **Administrator: System Settings › AI** (new tab):
  - **Models:** a table with provider, model, prices, kinds of work as chips, a restricted badge and state, plus an Approve / Change / Withdraw form with a reason. The data-terms box carries the hint "What the provider keeps, for how long, and whether it trains on it".
  - **Limits and policy:** the organisation limits, exchange rate, ceiling, attempts, timeout and requests at once, each showing its bounds, plus the two delegation switches.
  - **Usage:** organisation figures with project and person drill-down.
  - A persistent banner when the protected key is missing.
- **Project: Settings › AI** (new tab, visible to PM, Deputy, Owner, Sponsor and EA):
  - **Connections:** an ordered list. Each row shows the label, provider and model, state badge (*Ready*, *Unchecked*, *Key rejected*, *Disabled*, *Model withdrawn*, *Waiting for the protected key*), last used, and up and down buttons (no dragging, for accessibility).
  - **Add connection:** model picker, label, a key field (`type=password`, `autocomplete=off`, cleared after submit) and a reason.
  - **Row actions:** Replace key, Check key, Disable/Enable.
  - **Limits:** the project's limits beside the organisation's, with their sources and the ceiling.
  - **Usage:** for PM, Owner and Sponsor.
- **AI status everywhere** (discussion status line, extraction, Ask panel, drafts): the existing Blocked state gains the new reasons in plain words, for example "Blocked — AI is not set up for this project" or "Blocked — no AI connection approved for restricted material". A connection manager also gets a link to Settings › AI.
- **Go-live checklist** (existing): a new informational item, "AI: at least one approved model; projects need their own connection and limits before AI runs". It does not block go-live.
- Desktop and 375 px; WCAG 2.2 AA; keyboard only; the existing design system.

## 10. Data model (migration `0028_ai_configuration.sql`)

- **`ai_models`:**
  - `id`, `provider` (CHECK in `openai`, `anthropic`), `model_id`, `display_name`;
  - the four price columns;
  - `data_terms`, `purposes text[]` (CHECK subset of the six), `restricted_ok boolean`;
  - `state` (`approved`, `withdrawn`), `updated_at`, `updated_by`;
  - UNIQUE (`provider`, `model_id`).
- **`ai_model_events`** (append-only): action, actor, reason and previous/new values as JSON. No secrets are possible here.
- **`ai_connections`:**
  - `id`, `project_id`, `model_ref` (FK to `ai_models`), `label`, `position`;
  - `state` (`ready`, `unchecked`, `key_rejected`, `disabled`);
  - `rejected_at`, `rejected_status`, `last_used_at`, `created_at`, `created_by`;
  - UNIQUE (`project_id`, `position`) DEFERRABLE, for reordering in one transaction.
- **`ai_connection_keys`:** §5.2. Append-only apart from `superseded_at`, at most one current row per connection (partial unique index), no deletes (trigger).
- **`ai_connection_events`** (append-only): added, key_saved, key_replaced, checked (with outcome), reordered, disabled, enabled, key_rejected, with actor (null for Kainow), reason, and previous/new non-secret values.
- **`project_ai_limits`:** §7.1, plus `updated_at`, `updated_by` and `project_ai_limit_events` (append-only).
- **`ai_spend_settings`:**
  - drops `model_id` and the three price columns after copying them into `ai_models`;
  - adds the delegation switches, the ceiling (mode and amount), `max_attempts` (CHECK 1–5, default 3), `timeout_seconds` (CHECK 30–300, default 120) and `concurrency` (CHECK 1–10, default 2);
  - its existing audit on change stays.
- **`ai_spend_entries`:** §7.2.
- **`ai_call_slots`:** 10 rows created by the migration. The setting decides how many are used.
- **`extraction_runs`, `analysis_runs`, `ai_requests`:** no new column; the existing `attempts` becomes the counter (§6.6).
- **Text registry:** the new text columns, registered or exempted (§5.2).

## 11. Testing and measured aims

**Every rule gets a test at the level it lives:** unit tests for the chooser, cost and parsing; DB tests for reservation and the triggers; HTTP tests for permissions and screens' APIs; runner tests with a fake client factory.

**Leak tests:**
1. A key posted to add or replace appears in no log line, audit row, event row, notification, email row or response.
2. A sealed key copied to another connection or project fails to decrypt, and that connection is skipped, not used.
3. A Deputy, plain member, Audit or Oversight holder, or Administrator without project membership calling the project usage route gets 403 or 404 as the matrix says, and usage responses contain no content field.

**Fallback tests:**
- Primary times out, then the fallback succeeds: two entries, the first uncertain and the second confirmed, each with its own connection, and the runner saves the fallback's model.
- Primary 401: the request ends `failed` and the connection becomes `key_rejected`, with one notice per manager. The next request starts on the fallback.
- A 429 then a 5xx then success, across three connections in order.
- A restricted request skips a connection not approved for restricted material.
- No eligible connection gives `no_eligible_connection` with nothing reserved.

**Cap tests:** each of the six scopes blocks alone; the tightest wins; blank and zero each block at both levels; a delegate above the ceiling is refused; entries from before projects count at organisation level only.

**Concurrency test:** with the setting at 1, two workers (two boss instances on the test database) never hold two slots at once. A waiting job uses no attempt.

**Sweep-lock regression:** the sub-project 5 C1 race tests pass unchanged, including one with a fallback attempt in the middle.

**Real-model probe:** `npm run probe-ai`, `probe-minutes` and `probe-assist` gain `--provider openai|anthropic`. They read `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` from the environment of the PO's own shell, never from the database. Their reports record provider and model. They are not run in the sandbox. The PO runs them with a test project's key. An Anthropic run should confirm that 8,000 output tokens are enough with the model's thinking. If not, the per-kind maximum output becomes a catalogue field (§12).

**Measured aim:** a reservation with all six scopes applying, on the sub-project 5 bench data plus 200,000 seeded spend entries over 50 projects and 400 people, takes under 25 ms at p95 over 500 reservations, measured as sub-project 5 measured its aims. Without the new indexes the six sums would scan the month's entries.

### Measured aims as found

**18 November 2026 — reservation with all six scopes applying: aim missed.**

- **Command:** `npm run bench-ai` (`app/src/ai/bench-cli.ts`) on a freshly created and migrated `kainow_bench` database (PostgreSQL 16.15 in a Docker container, reached over 127.0.0.1).
- **Data:** 200,000 spend entries (spread over the last 45 days; mostly confirmed, with released and uncertain ones) over 50 projects and 400 people, one connection per project. The organisation has its monthly, daily and per-person limits and every project has its monthly, daily and per-person limits, so all six scopes are checked on every call. Limits are set high enough that nothing is refused during the run. The bench seeds its own 400 people and 50 projects (the same shapes as the sub-project 5 bench) and not that bench's discussion data, which the six sums never read.
- **Method:** 20 warm-up reservations, then 500 timed calls of `SpendService.reserve`, each by a different person in a different project in turn, percentiles by nearest rank, as the analysis bench computes them.
- **Result:** p50 29.12 ms, p95 **36.45 ms**, max 65.36 ms. The aim was p95 under 25 ms, so **the aim is missed** by about 11 ms. It has not been tuned.
- **Machine:** 11th Gen Intel Core i7-1185G7 at 3.00 GHz, 8 logical processors, 32 GiB memory, Windows 11, Node 24.22.1, one run, the database in a Docker Desktop container on the same computer. A plain `SELECT 1` over the same connection takes about 0.45 ms at the median, so the time is not the network.
- **Where the time goes (one extra measurement, nothing changed):** a bare monthly sum over the current month's entries on this data takes about 22 ms at the median. A reservation runs that kind of sum at organisation level (monthly) and the project, daily and per-person sums over smaller sets, so the organisation monthly sum is most of the time. Whether the new indexes help enough is for the Product Owner and the builder to decide; this record does not choose a remedy.
- **For the Product Owner:** decide whether to accept the measured p95 as the aim for V1.0 (a reservation holds the global lock for its whole run, so at 36 ms the installation reserves at most about 25 to 30 requests a second, far above the two requests at once Kainow allows by default), or to ask for the organisation sums to be made cheaper.

## 12. Left to the builder, and open items

- **Builder's choices:**
  - The exact shape of the `ModelClientFactory`.
  - Where the effective-policy reader lives (beside `spend.settings.ts`).
  - Whether the chooser takes the previous outcome from the spend entry or from the run row.
  - Polling intervals for slots, within §6.5.
- **Visual layout** within §9 and the existing design system.
- **Anthropic effort setting:** Kainow sends none, so the model's default applies. If the probe shows answers cut off or slow, the PO decides on a catalogue field for effort and maximum output. It is not added speculatively.
- **R10, partly open:** reconciling against provider bills (an uncertain entry stays uncertain until someone reconciles it by hand with evidence, as today) and a currency other than MYR for AI caps. Neither is in sub-project 6.

## 13. Documents updated in this branch

- Consolidated Specification §14: D84–D87.
- Permission Matrix: the rows of §8.
- Configuration Catalogue:
  - C39, C44, C45, C46 and C63 point to D84–D87 and state the bounds;
  - C69 says API keys use the protected key, with associated data.
- INSTALL.md: `OPENAI_API_KEY` is removed from the worker; the protected key is required before any AI key can be saved; setting up the first model and project connection; the probe scripts' environment keys.
- `compose.yaml`: `OPENAI_API_KEY` is removed from the worker's environment.
- README feature list.

## 14. Outside 6

- Other providers and cloud-platform variants.
- Protected-key rotation and secret managers (10).
- Bill reconciliation.
- Prompt caching and batch use.
- Department caps.
- A19 pausing (10).
- Dashboards of AI usage beyond §7.4 (7).
- Per-kind model choice within a project (a project's order applies to every kind of work it is approved for).
