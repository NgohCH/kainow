# V1.0 Sub-project 6 — AI Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single installation OpenAI key and the single organisation cap with:
- an Administrator-approved catalogue of OpenAI and Anthropic models;
- per-project encrypted keys in an ordered primary/fallback list;
- outage-only fallback (D84);
- organisation and project caps, each with an optional per-person level (D85);
- usage views;
- bounded attempts, timeout and AI requests at once (D87).

**Architecture:**
- Extend the tested call path in place. `guardedAiCall` gains a project, a connection chooser, a database-held slot and a per-attempt client factory.
- `SpendService.reserve` gains three project scopes.
- A new `AnthropicModelClient` implements the existing three model interfaces, so every answer parser is shared.
- The four runners only pass the project, the kind of work and whether they carry restricted material. Their sweep-lock save code is untouched.
- One migration, `0028_ai_configuration.sql`.

**Tech Stack:** TypeScript, NestJS 12, PostgreSQL 16 (plain SQL migrations with checksums), pg-boss 12, `@anthropic-ai/sdk` (new dependency), React + Vite, `node:test`, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-11-18-v1-ai-configuration-design.md`. Read it in full first; § numbers below refer to it. Also read the sub-project 5 spec §7.3–§7.4 (protected key, text registry, sweep lock) and `app/src/ai/guarded-call.ts`, `app/src/spend/spend.service.ts` and `app/src/extraction/model.ts`.

## Global Constraints

**Migrations and data:**
- One migration, `app/migrations/0028_ai_configuration.sql` (Task 1). Never edit `0001`–`0027` (checksums). If PR #15 (sub-project 5) has merged by execution time, rebase onto `main` first.
- Nothing is deleted:
  - `ai_models`, `ai_connections`, `ai_connection_keys` and `ai_spend_entries` rows are never deleted (triggers);
  - the `*_events` tables are append-only;
  - `ai_connection_keys` may only have `superseded_at` set once.

**Values from the spec:**
- **Bounds (D87):**
  - `max_attempts` 1–5, default 3;
  - `timeout_seconds` 30–300, default 120;
  - `concurrency` 1–10, default 2.

  A project value may only be lower than or equal to the organisation value.
- **Blank or zero is no allowance at every level.** A project with no `project_ai_limits` row has no allowance (`spend_project_not_configured`).
- **Reasons, labels and data terms:**

  | Field | Length after trim |
  |---|---|
  | Reason | 1–1,000 |
  | Label | 1–100 |
  | Data terms | 1–4,000 |
  | Model identifier | 1–200 |

  Every one of these runs `refuseSecretsIn` with the existing D75 wording.
- **Key format:** after trim, 20–500 printable ASCII characters with no whitespace. Otherwise: `This does not look like an API key.`

**Keys:**
- A key value never appears in:
  - logs or error texts;
  - API responses;
  - `audit_events` or any `*_events` row;
  - notifications or `email_outbox`;
  - prompts.
- Only `app/src/ai/keys.ts` seals and opens AI keys. `openApiKey` is imported only by `app/src/ai/key-check.ts` and `app/src/ai/client-factory.ts` (test in Task 2).

**Behaviour that must not change:**
- The sweep-lock save code in the four runners (`sweepMarkSql`, `sweptSince`, `HELD_DURING_RUN`) is not edited apart from passing new arguments. The sub-project 5 C1 race tests must pass unchanged.
- Spend rules are unchanged:
  - reserve before sending;
  - an unknown outcome stays counted (`uncertain`);
  - a 4xx before any work is `reconcileNotCharged`;
  - a bad response is settled from its usage.

**Exact copy:**
- **Failure codes:**
  - `ai_not_set_up`
  - `no_eligible_connection`
  - `protected_key_missing`
  - `attempts_used`
  - `spend_project_not_configured`
  - `spend_project_no_allowance`
  - `spend_project_cap_would_be_exceeded`
  - `spend_project_daily_no_allowance`
  - `spend_project_daily_cap_would_be_exceeded`
  - `spend_project_user_no_allowance`
  - `spend_project_user_cap_would_be_exceeded`
  - the existing `spend_*` codes, unchanged.
- **Labels:**
  - `Ready`
  - `Unchecked`
  - `Key rejected`
  - `Disabled`
  - `Model withdrawn`
  - `Waiting for the protected key`
  - `Key unreadable — enter it again`
  - `Queued — waiting for a free AI place`
  - `Blocked — AI is not set up for this project`
  - `Confirmed`, `Uncertain`, `Reserved`
- **Key-rejected notice:** `The <provider> key for AI connection "<label>" in <project> was refused, or this key may not use the model. AI requests skip this connection until the key is replaced.`

**Project rules:**
- Dates and periods are UTC+8. Money is held as micro-units in `bigint`, using the existing `parseMicro` and `formatMicro`.
- No real organisation names. Test accounts only: `*@example.org|com|net` or `*@kainow.test`. Test keys are obviously fake strings such as `sk-test-` followed by 40 `x` characters, never a real key.
- **Tests:**
  - set `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:15432/kainow_test` (container `kainow-testdb`);
  - run DB tests through `npm test` (`--test-concurrency=1`);
  - check that no other session is running tests against the container before a full suite.
- Never print or open `.env` files, API keys or the protected key file. Never use `git stash`.
- Commit after each task with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A key rejected while another request is mid-fallback on the same connection.** Two requests running at once both get 401: the connection becomes `key_rejected` once, and each manager gets exactly one notice. Test: Task 10, `two concurrent 401s mark the connection once and notify once`.
2. **The Administrator lowers attempts from 3 to 1 while a request waits for its second attempt.** The next attempt ends `failed` / `attempts_used` with nothing reserved. Test: Task 10, `lowering attempts ends a pending request without sending`.
3. **A source's audience changes from project-wide to restricted while an extraction waits.** The next attempt skips a connection not approved for restricted material. Test: Task 11, `audience turned restricted between attempts skips the unapproved connection`.
4. **A delegate sets the project monthly limit, then the Administrator turns delegation off and lowers the ceiling below it.** The existing project value stays in force (§7.1), the delegate can no longer change it, and the organisation cap still governs. Test: Task 4, `ceiling lowered below an existing project limit keeps it; delegate cannot change it`.
5. **A worker crashes after taking a slot and before settling.** The slot frees itself when the lease ends, and the reservation becomes `uncertain` at the next attempt (existing `markStaleReservations`). Test: Task 9, `an expired lease is taken over; a live lease is not`.

---

## File Structure

| File | Responsibility |
|---|---|
| `app/migrations/0028_ai_configuration.sql` | All schema of §10 |
| `app/src/ai/keys.ts` | `sealApiKey` / `openApiKey` (AES-GCM with associated data) |
| `app/src/ai/models.service.ts`, `models.controller.ts` | Approved-model catalogue (EA) |
| `app/src/ai/policy.ts` | Effective attempts, timeout and concurrency; organisation AI settings (delegation, ceiling) |
| `app/src/ai/limits.service.ts`, `limits.controller.ts` | Project limits (limit managers) |
| `app/src/ai/connections.service.ts`, `connections.controller.ts` | Project connections and keys |
| `app/src/ai/key-check.ts` | Free model-listing check per provider |
| `app/src/ai/chooser.ts` | Eligible list and which connection an attempt uses (pure) plus its loader |
| `app/src/ai/slots.ts` | `ai_call_slots` lease |
| `app/src/ai/client-factory.ts` | Builds the provider client for one attempt |
| `app/src/ai/anthropic-model.ts` | `AnthropicModelClient` |
| `app/src/ai/usage.service.ts`, `usage.controller.ts` | The three usage views |
| `app/src/ai/ai.module.ts` | Nest wiring |
| `app/src/ai/guarded-call.ts` | Extended (gate, chooser, slot, reserve, factory) |
| `app/src/spend/*` | Prices move out of settings; reserve gains project scopes; cache-write cost |
| `app/src/extraction/model.ts` | `OpenAiModelClient` takes key, timeout and base URL per call; `ModelCallError` keeps `status` |
| Runners, `app/src/worker/ai-worker.ts`, `app/src/worker/main.ts`, queues | Attempt counting, resume, factory |
| `app/src/analysis/tick.ts` | Per-project readiness |
| `app/web/src/views/AiAdmin.tsx`, `ProjectAi.tsx`, `AiUsage.tsx`; `app/web/src/ai.ts` | Screens |

---

### Task 1: Migration 0028 and the text registry

**Files:**
- Create: `app/migrations/0028_ai_configuration.sql`
- Modify: `app/src/quarantine/registry.ts` (register or exempt the new text columns)
- Test: `app/src/ai/migration.test.ts`

**Interfaces:**
- Produces the tables and columns of spec §10, with these exact names:
  - **`ai_models`:** `id uuid`, `provider`, `model_id`, `display_name`, `input_usd_per_million_micro`, `cached_input_usd_per_million_micro`, `cache_write_usd_per_million_micro`, `output_usd_per_million_micro`, `data_terms`, `purposes text[]`, `restricted_ok`, `state`, `updated_at`, `updated_by`.
  - **`ai_model_events`.**
  - **`ai_connections`:** `id`, `project_id`, `model_ref`, `label`, `position`, `state`, `rejected_at`, `rejected_status`, `rejection_notified_at`, `last_used_at`, `created_at`, `created_by`.
  - **`ai_connection_keys`:** `id`, `connection_id`, `ciphertext bytea`, `nonce bytea`, `tag bytea`, `key_id`, `saved_at`, `saved_by`, `superseded_at`.
  - **`ai_connection_events`.**
  - **`project_ai_limits`:** `project_id` PK, `monthly_limit_micro_myr`, `daily_mode`, `daily_limit_micro_myr`, `user_monthly_mode`, `user_monthly_limit_micro_myr`, `max_attempts`, `timeout_seconds`, `updated_at`, `updated_by`.
  - **`project_ai_limit_events`.**
  - **`ai_spend_settings` gains:** `projects_may_set_limits`, `projects_may_manage_connections`, `project_ceiling_mode`, `project_ceiling_micro_myr`, `max_attempts`, `timeout_seconds`, `concurrency`. It drops `model_id` and the three prices.
  - **`ai_spend_entries` gains:** `project_id`, `connection_id`, `provider`, `cache_write_usd_per_million_micro`, `cache_write_tokens`, `ruled boolean NOT NULL DEFAULT true`. Existing rows are back-filled `false`, and `CHECK (NOT ruled OR project_id IS NOT NULL)`.
  - **`ai_call_slots`:** rows 1–10.
  - **`notifications.kind`** allows `ai_key_rejected`.

- [ ] **Step 1: Write the failing test.**
  - `migration.test.ts` (DB) runs migrations on a reset schema, then asserts:
    - `ai_spend_settings` no longer has `model_id`;
    - an `ai_models` row copied from a seeded pre-0028 settings row has `state = 'withdrawn'`, `purposes = '{}'`, `restricted_ok = false` and `data_terms = 'Recorded before sub-project 6 — review before approving'`;
    - `DELETE FROM ai_connections` raises;
    - a second current key row for one connection violates the partial unique index;
    - updating `ai_connection_keys.ciphertext` raises;
    - `max_attempts = 6` violates its CHECK;
    - inserting a `ruled` spend entry without `project_id` raises;
    - `SELECT count(*) FROM ai_call_slots` is 10.
  - Also run the existing `app/src/quarantine/registry.db.test.ts` completeness test.
- [ ] **Step 2:** Run `npm test` with the filter `dist/ai/migration.test.js` and `dist/quarantine/registry.db.test.js`. Expected: FAIL. The migration is missing and the registry finds unregistered columns.
- [ ] **Step 3:** Write the migration, copying the existing settings row into `ai_models` before dropping the columns. Register `ai_models.display_name`, `data_terms`, `ai_connections.label` and the `reason` and `detail` columns of the three event tables as user text (owned by the project row, or as item-less project rows for connections; organisation-level rows go in `NO_USER_TEXT` only if they hold no user text, with a reason). Exempt `model_id`, `provider` and `state` as identifiers in `NO_USER_TEXT`.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ai): migration 0028 for models, connections, keys, project limits and slots`.

### Task 2: Sealing and opening API keys

**Files:**
- Modify: `app/src/quarantine/protected-key.ts`
- Create: `app/src/ai/keys.ts`
- Test: `app/src/ai/keys.test.ts`, `app/src/ai/key-imports.test.ts`

**Interfaces:**
- Produces:
  - `ProtectedKey.encrypt(plain: Buffer, aad?: Buffer): Sealed`
  - `ProtectedKey.decrypt(v: Sealed, aad?: Buffer): Buffer`
  - In `ai/keys.ts`:

    ```ts
    export interface KeyBinding { connectionId: string; projectId: string; provider: Provider }
    export type Provider = 'openai' | 'anthropic';
    export function normaliseApiKey(raw: unknown): string            // throws BadRequestException('This does not look like an API key.')
    export function sealApiKey(key: ProtectedKey, apiKey: string, b: KeyBinding): Sealed & { keyId: string }
    export function openApiKey(key: ProtectedKey, sealed: Sealed & { keyId: string }, b: KeyBinding): string  // throws KeyUnreadableError
    export class KeyUnreadableError extends Error {}
    ```

  - The AAD is `utf8("kainow.ai-key:" + connectionId + ":" + projectId + ":" + provider)`.

- [ ] **Step 1: Write the failing tests:**
  - `round trip with the same binding`;
  - `another connection id fails with KeyUnreadableError`;
  - `another project id fails`;
  - `another provider fails`;
  - `another protected key id fails` (keyId mismatch throws before decrypting);
  - `existing quarantine callers without aad still round-trip`;
  - `normaliseApiKey refuses 19 characters, a space, a non-ASCII character and 501 characters, and accepts and trims a 40-character key`.
  - `key-imports.test.ts` reads every `.ts` under `app/src` (excluding tests) and asserts that the only importers of `openApiKey` are `ai/key-check.ts` and `ai/client-factory.ts`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Pass `aad` through `cipher.setAAD` and `decipher.setAAD` only when given.
- [ ] **Step 4:** Run, along with `dist/quarantine/protected-key.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ai): seal API keys with the protected key bound to project and connection`.

### Task 3: Approved-model catalogue

**Files:**
- Create: `app/src/ai/models.service.ts`, `app/src/ai/models.controller.ts`, `app/src/ai/ai.module.ts`
- Modify: `app/src/app.module.ts`
- Test: `app/src/ai/models.http.test.ts`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces:

  ```ts
  export const PURPOSES = ['extraction','discussion_analysis','minutes_draft','question_answer','report_draft','summary_draft'] as const; // same values as AiPurpose
  export interface ApprovedModel { id: string; provider: Provider; modelId: string; displayName: string; prices: Prices; purposes: AiPurpose[]; restrictedOk: boolean; dataTerms: string; state: 'approved'|'withdrawn' }
  ```

  - `ModelsService.list()`, `approve(input, reason, actor)`, `change(id, input, reason, actor)`, `withdraw(id, reason, actor)`.
  - Routes: `GET /ai/models`, `POST /ai/models`, `PUT /ai/models/:id`, `POST /ai/models/:id/withdraw`, all `@RequireAction('ai.settings.manage')`. `GET` is also allowed for `spend.view`, so project managers can pick a model.
  - `Prices` (in `spend/cost.ts`) gains `cacheWriteMicroUsdPerMillion: bigint`.

- [ ] **Step 1: Write the failing HTTP tests:**
  - a non-Administrator gets 403 on POST;
  - approving records an `ai_model_events` row with the reason and previous/new values;
  - a duplicate `(provider, modelId)` approved twice gives 409; re-approving a withdrawn one reuses its id;
  - `purposes` outside the six is refused with 400;
  - data terms containing a fake AWS-style key are refused with the D75 wording;
  - withdraw sets `state = 'withdrawn'` and needs a reason;
  - a price change leaves an existing `ai_spend_entries` row's snapshot unchanged.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, reusing `parseMicro` for prices and `refuseSecretsIn` for terms and reason.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ai): Administrator-approved model catalogue`.

### Task 4: Organisation AI policy and project limits

**Files:**
- Modify: `app/src/spend/spend.settings.ts` (remove model and prices; add delegation, ceiling and policy numbers), `app/src/spend/spend.controller.ts`, `app/src/spend/mvp-settings.ts` and `apply-mvp-settings-cli.ts` (limits and rate only; the model goes through Task 3), `app/src/projects/matrix.ts`
- Create: `app/src/ai/policy.ts`, `app/src/ai/limits.service.ts`, `app/src/ai/limits.controller.ts`
- Test: `app/src/ai/limits.http.test.ts`, `app/src/ai/policy.test.ts`

**Interfaces:**
- Produces:

  ```ts
  // spend.settings.ts
  export interface SpendSettingsInput { prices: { myrPerUsdMicro: bigint }; monthlyLimitMicroMyr: bigint|null; daily: DailyRule; userMonthly?: UserRule;
    projectsMaySetLimits: boolean; projectsMayManageConnections: boolean; projectCeiling: { mode:'not_applied' } | { mode:'limit'; limitMicroMyr: bigint };
    maxAttempts: number; timeoutSeconds: number; concurrency: number }
  // policy.ts
  export interface EffectivePolicy { maxAttempts: number; timeoutMs: number; concurrency: number; source: { maxAttempts: 'organisation'|'project'; timeoutSeconds: 'organisation'|'project' } }
  export async function effectivePolicy(db: Db, projectId: string): Promise<EffectivePolicy>
  export const POLICY_BOUNDS = { maxAttempts: [1, 5], timeoutSeconds: [30, 300], concurrency: [1, 10] } as const;
  // limits.service.ts
  export interface ProjectLimits { monthlyLimitMicroMyr: bigint|null; daily: DailyRule; userMonthly: UserRule; maxAttempts: number|null; timeoutSeconds: number|null }
  export async function readProjectLimits(db: Db, projectId: string): Promise<ProjectLimits|null>
  ```

  - `LimitsService.get(projectId, user)` returns `{ project, organisation, ceiling, editable, sources }`.
  - `LimitsService.set(projectId, input, reason, user)`.
  - Routes: `GET` and `PUT /projects/:id/ai/limits`.
  - New matrix actions:
    - `ai.limits.manage`: roles `pm`, `owner`, `sponsor`; states draft, planned, active; refusal `Only the Project Manager, the Owner or a Sponsor can change the project's AI limits, and only when the Administrator allows it.`
    - `ai.connections.manage`: same roles and states, with the matching wording.
    - `ai.connections.view`: roles `pm`, `deputy_pm`, `owner`, `sponsor`; all states.

    The delegation switch is checked in the service, as `analysis/settings.service.ts` does with `projectsMayChange`. An Enterprise Administrator passes without project roles.

- [ ] **Step 1: Write the failing tests:**
  - `PUT /ai/spend-settings` without `maxAttempts` is 400; `maxAttempts: 6` is 400; `timeoutSeconds: 29` is 400; `concurrency: 11` is 400;
  - a PM with delegation off gets 403 on `PUT /projects/:id/ai/limits`; with it on, saves, and a `project_ai_limit_events` row records the reason and previous/new values;
  - a Deputy gets 403;
  - a delegate's monthly limit above the ceiling is refused with `The Administrator's ceiling for a project's monthly AI limit is MYR 50.000000.`;
  - a delegate's `maxAttempts` above the organisation's is refused; an Administrator may set any value within the bounds;
  - editing is refused when Deferred (403);
  - `effectivePolicy` returns the project value when lower and the organisation value otherwise;
  - Review Focus 4: `ceiling lowered below an existing project limit keeps it; delegate cannot change it`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. `readSettings` still returns null when there is no row (all AI blocked, `not_configured`).
- [ ] **Step 4:** Run, plus the existing `dist/spend/*.test.js`, updated for the removed model and price fields. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ai): organisation AI policy, delegation switches and project limits`.

### Task 5: Cost with cache writes, and reservation with project scopes

**Files:**
- Modify: `app/src/spend/cost.ts`, `app/src/spend/spend.service.ts`
- Test: `app/src/spend/cost.test.ts`, `app/src/spend/spend.service.test.ts`, `app/src/spend/project-scopes.test.ts`

**Interfaces:**
- Produces:

  ```ts
  export interface Usage { inputTokens: number; cachedInputTokens: number; cacheWriteTokens?: number; outputTokens: number } // cacheWrite ⊆ input, cached+cacheWrite ≤ input
  export type Scope = 'monthly'|'daily'|'user_monthly'|'project_monthly'|'project_daily'|'project_user_monthly';
  export type BlockReason = 'not_configured'|'no_allowance'|'cap_would_be_exceeded'|'project_not_configured';
  export interface ReserveInput { requestId; attemptNo; estimateMicroMyr; purpose; actorUserId?; projectId: string; connectionId: string; provider: Provider; modelId: string; prices: Prices }
  ```

  - `reserve` checks the six scopes in the order of spec §7.3, under the existing `SPEND_LOCK_KEY`.
  - `SpendService.summary(forUserId?, projectId?)` adds `project`, `projectDaily` and `projectMine` to `SpendSummary`.
  - `costMicroMyr` prices `cacheWriteTokens` at `cacheWriteMicroUsdPerMillion`.
  - `estimateMaxCostMicroMyr` uses the highest of the input, cached and cache-write prices.

- [ ] **Step 1: Write the failing tests:**
  - **Cost:** `cache writes priced at the cache-write price`; `cached plus cache-write above input throws`; `estimate uses the highest of three input prices`.
  - **Scopes:** each of the six scopes blocks alone with its own scope and reason; `no project row blocks as project_not_configured`; blank and zero project monthly each block with `no_allowance`; the tightest wins (organisation remaining 5, project remaining 3, estimate 4 → `project_monthly`); an automatic request (no actor) skips both per-person scopes; entries from before projects (`ruled = false`) count for the organisation and not for any project; a reservation writes `project_id`, `connection_id`, `provider`, `model_id` and the price snapshot from the input; `ai.request_blocked` audit detail includes `projectId` and `scope`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. `totals(db, period, actor?, projectId?)` filters on `project_id` when given, using the new indexes.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(spend): project scopes, per-person-in-project limit and cache-write cost`.

### Task 6: Provider clients

**Files:**
- Modify: `app/src/extraction/model.ts`, `app/package.json` (add `@anthropic-ai/sdk`, exact pinned version)
- Create: `app/src/ai/anthropic-model.ts`, `app/src/ai/client-factory.ts`
- Test: `app/src/ai/anthropic-model.test.ts`, `app/src/extraction/model.test.ts` (extend)

**Interfaces:**
- Produces:

  ```ts
  export interface ProviderClient extends ModelClient, MinutesModel, JsonSchemaModel {}
  export interface ModelClientFactory { forAttempt(c: { provider: Provider; apiKey: string; timeoutMs: number }): ProviderClient }
  export class AnthropicModelClient implements ProviderClient { constructor(apiKey: string, timeoutMs: number, sdk?: Pick<Anthropic, 'messages'>) }
  export const realClientFactory: ModelClientFactory;
  ```

  - `ModelRequest.timeoutMs` stays. `OpenAiModelClient` keeps its constructor `(apiKey, baseUrl?, fetchImpl?)`, so the probes keep working.
  - `ModelCallError` keeps `status`. A 401 or 403 sets `keyRejected = true` (a new readonly field).

- [ ] **Step 1: Write the failing tests** with an injected fake SDK:
  - `sends system, one user message, max_tokens and output_config.format json_schema`;
  - `maxRetries 0 and timeout from the attempt`;
  - **usage mapping:** `input_tokens 100, cache_read 20, cache_creation 5, output 50 → inputTokens 125, cachedInputTokens 20, cacheWriteTokens 5, outputTokens 50`;
  - `stop_reason max_tokens → ModelBadResponse with usage`;
  - `stop_reason refusal → ModelBadResponse`;
  - `APIConnectionTimeoutError → ModelCallError unknown retryable`;
  - `529/500 → unknown retryable`;
  - `429 → rejected retryable`;
  - `401 → rejected not retryable keyRejected`;
  - `400 → rejected not retryable`;
  - `a 200 without usage → unknown retryable`;
  - `no error message contains the request body or the key` (the key string is `sk-ant-test-` followed by 40 `x` characters).
  - **OpenAI:** `401 sets keyRejected`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Use the SDK's typed error classes, not message matching. Parse `content[0].text` as the JSON the parsers expect.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ai): Anthropic model client and per-attempt client factory`.

### Task 7: Project connections, keys and the key check

**Files:**
- Create: `app/src/ai/connections.service.ts`, `app/src/ai/connections.controller.ts`, `app/src/ai/key-check.ts`
- Test: `app/src/ai/connections.http.test.ts`, `app/src/ai/key-check.test.ts`, `app/src/ai/key-leak.http.test.ts`

**Interfaces:**
- Consumes: Task 2 (`sealApiKey`, `openApiKey`), Task 3 (`ApprovedModel`), Task 4 (matrix actions, delegation).
- Produces:

  ```ts
  export type ConnectionState = 'ready'|'unchecked'|'key_rejected'|'disabled';
  export type KeyCheck = { outcome: 'ok' } | { outcome: 'refused'; status: 401|403 } | { outcome: 'no_model' } | { outcome: 'unreachable' };
  export async function checkKey(provider: Provider, apiKey: string, modelId: string, timeoutMs?: number, fetchImpl?: typeof fetch): Promise<KeyCheck>
  ```

  - Display states shown to clients add `model_withdrawn`, `waiting_for_key` and `key_unreadable`.
  - Routes, each with a reason except GET:
    - `GET /projects/:id/ai/connections` (view);
    - `POST /projects/:id/ai/connections` (`{modelRef, label, apiKey, reason}`);
    - `PUT /projects/:id/ai/connections/:cid/key` (`{apiKey, reason}`);
    - `POST …/:cid/check`;
    - `POST …/:cid/disable`;
    - `POST …/:cid/enable`;
    - `PUT /projects/:id/ai/connections/order` (`{ids: string[], reason}`, in one transaction, using the DEFERRABLE unique).

- [ ] **Step 1: Write the failing tests:**
  - **Check outcomes:** `checkKey 200 → ok; 401 → refused; 404 → no_model; timeout → unreachable` (fake fetch for OpenAI `GET /v1/models/{id}`, fake SDK `models.retrieve` for Anthropic).
  - **Saving:** add with a check returning `refused` gives 400 `The provider refused this key` and stores nothing; `no_model` gives 400 `This key cannot use <model>`; `unreachable` saves the connection as `unchecked`.
  - **Replacing:** adds a new key row and sets `superseded_at` on the old one; a `key_replaced` event holds no key.
  - **Order:** reordering three connections swaps positions atomically.
  - **Permissions and state:** a Deputy sees connections and gets 403 on changes; a delegate with the switch off gets 403; changes are refused while Deferred, but disable is allowed while Deferred.
  - **Model and key states:** a withdrawn model's connection lists as `model_withdrawn`; with no protected key, add is refused with `AI keys cannot be saved until the protected key is installed. See INSTALL.md.` and the list shows `waiting_for_key`; a key sealed under another key id lists as `key_unreadable`; the GET response never has a field holding the key or its ciphertext.
  - **Leak test 1** (`key-leak.http.test.ts`): post a key to add and to replace, then assert the key string appears in no captured log line, no `audit_events`, `ai_connection_events` or `notifications` row, no `email_outbox` row and no response body.
  - **Leak test 2:** copy one connection's key row onto another connection; its list state is `key_unreadable`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. The controller's body DTO is never logged. Use an exception filter test to show a validation error does not echo `apiKey`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ai): project AI connections with protected keys and a free key check`.

### Task 8: The connection chooser

**Files:**
- Create: `app/src/ai/chooser.ts`
- Test: `app/src/ai/chooser.test.ts`, `app/src/ai/chooser.db.test.ts`

**Interfaces:**
- Produces:

  ```ts
  export interface CandidateConnection { id: string; position: number; provider: Provider; modelId: string; modelRef: string; prices: Prices; eligible: boolean }
  export type PreviousOutcome = { connectionId: string; moveOn: boolean } | null; // moveOn: outage, 429 or bad response
  export function chooseConnection(all: CandidateConnection[], previous: PreviousOutcome): CandidateConnection | null
  export async function loadCandidates(db: Db, projectId: string, purpose: AiPurpose, carriesRestricted: boolean, keyId: string|null): Promise<{ list: CandidateConnection[]; reason?: 'ai_not_set_up'|'no_eligible_connection'|'protected_key_missing' }>
  export async function previousOutcome(db: Db, requestId: string, attemptNo: number): Promise<PreviousOutcome>
  ```

  `previousOutcome` reads the spend entry with the highest `attempt_no < attemptNo`. `moveOn` is true when its status is `uncertain`, when the note records a 429, or when it is `confirmed` with its run having failed `bad_response`. Record that last fact as `note = 'bad_response'` in Task 10, so the chooser reads only the spend entry.

- [ ] **Step 1: Write the failing tests** (pure):
  - `first attempt uses the first eligible`;
  - `outage moves to the next eligible and wraps`;
  - `previous no longer eligible → first eligible after its old position, wrapping`;
  - `no previous entry → first eligible`;
  - `one eligible → always it`;
  - `none eligible → null`.

  DB tests (`loadCandidates`):
  - `skips disabled, key_rejected, withdrawn model, purpose not approved, restricted not approved when carriesRestricted, key unreadable`;
  - `no connections → ai_not_set_up`;
  - `connections but none eligible → no_eligible_connection`;
  - `keyId null → protected_key_missing`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ai): connection chooser for fallback (D84)`.

### Task 9: Slots for AI requests at once

**Files:**
- Create: `app/src/ai/slots.ts`
- Test: `app/src/ai/slots.db.test.ts`

**Interfaces:**
- Produces:

  ```ts
  export async function takeSlot(pool: Pool, holder: string, limit: number, leaseMs: number): Promise<number | null>
  export async function waitForSlot(pool: Pool, holder: string, limit: () => Promise<number>, leaseMs: number, opts?: { maxWaitMs?: number /* 120_000 */; pollMs?: number /* 1_000 */; sleep?: (ms) => Promise<void> }): Promise<number | null>
  export async function releaseSlot(pool: Pool, slot: number, holder: string): Promise<void>
  ```

  The holder is `${requestId}:${attemptNo}`. `releaseSlot` only clears a slot held by that holder.

- [ ] **Step 1: Write the failing tests:**
  - `limit 1: a second holder gets null until the first releases`;
  - `limit 2 with 10 rows uses only slots 1-2`;
  - Review Focus 5: `an expired lease is taken over; a live lease is not`;
  - `release by another holder changes nothing`;
  - `waitForSlot returns null after maxWaitMs with a fake sleep`;
  - `two pools racing for one slot: exactly one wins` (SKIP LOCKED).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ai): database-held slots for AI requests at once (A05, D87)`.

### Task 10: The extended guarded call

**Files:**
- Modify: `app/src/ai/guarded-call.ts`
- Test: `app/src/ai/guarded-call.test.ts` (extend), `app/src/ai/fallback.db.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6, 8 and 9.
- Produces:

  ```ts
  export interface GuardedCallInput<T> { requestId; attemptNo; purpose: AiPurpose; actorUserId: string|null; projectId: string; carriesRestricted: boolean;
    promptBytes; maxOutputTokens; call: (client: ProviderClient, modelId: string, timeoutMs: number) => Promise<T & { usage: Usage }> }
  export type GuardedOutcome<T> = { kind:'ok'; value:T; modelId:string; connectionId:string; provider:Provider } | { kind:'blocked'|'failed'; code:string; detail:string } | { kind:'retry' } | { kind:'wait' };
  export interface GuardedDeps { pool; spend; clock; log?; key: ProtectedKey|null; factory: ModelClientFactory; notify?: (n: KeyRejectedNotice) => Promise<void> }
  ```

  - `isLastAttempt` and `modelConfigured` are removed from the input and deps. "Last" is `attemptNo >= effectivePolicy.maxAttempts`.
  - `{kind:'wait'}` means no slot was free after 120 s. Nothing was reserved.

- [ ] **Step 1: Write the failing tests** (fake factory, DB):
  - **Order of the gate:**
    - `attemptNo above effective attempts → failed attempts_used, nothing reserved` (Review Focus 2: `lowering attempts ends a pending request without sending`);
    - `no connections → blocked ai_not_set_up`;
    - `protected key null → blocked protected_key_missing`;
    - `reserve blocked releases the slot`;
    - `no slot within the wait → wait, no spend entry`.
  - **Fallback:** `timeout on primary then success on fallback: entry 1 uncertain on connection A, entry 2 confirmed on connection B, outcome connectionId B`.
  - **Rejected key:**
    - `401 → failed model_rejected, entry released, connection key_rejected with rejected_status 401, one ai_key_rejected notification per EA and per current connection manager, ai_connection_events key_rejected`;
    - Review Focus 1: `two concurrent 401s mark the connection once and notify once` (`UPDATE … WHERE state <> 'key_rejected' RETURNING`, notifying only when a row returned).
  - **Other outcomes:**
    - `429 then 5xx then success across three connections in order`;
    - `bad response settles and moves on`, with the spend entry note `bad_response`;
    - `success on unchecked marks ready and sets last_used_at`;
    - `the decrypted key is passed to the factory and never appears in a log line or outcome detail`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement in the order of spec §6.1:
  1. stale reservations;
  2. policy;
  3. choose;
  4. slot;
  5. reserve;
  6. open the key and build the client;
  7. send with the effective timeout;
  8. settle, mark or release;
  9. mark rejected or ready (a rejected key also writes a line in the project's History, in the form History already uses for project events, naming the connection label and never the key);
  10. release the slot in `finally`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ai): guarded call chooses the connection, waits for a slot and reserves per project`.

### Task 11: Runners, attempt counting and the worker

**Files:**
- Modify:
  - `app/src/extraction/runner.ts`
  - `app/src/analysis/minutes-runner.ts`
  - `app/src/analysis/analysis-runner.ts`
  - `app/src/assist/assist-runner.ts`
  - `app/src/worker/ai-worker.ts`
  - `app/src/worker/main.ts`
  - `app/src/extraction/queue.ts`, `app/src/analysis/queue.ts`, `app/src/assist/queue.ts`
  - `app/src/config.ts` (remove `openAiApiKey`)
  - `compose.yaml` (remove `OPENAI_API_KEY` from the worker)
- Test: the existing runner tests, updated; `app/src/ai/restricted.db.test.ts`; `app/src/worker/ai-worker.test.ts` (extend)

**Interfaces:**
- Consumes: Task 10.
- Produces:
  - `RunnerDeps.model` is replaced by `factory: ModelClientFactory` and `key: ProtectedKey | null`, for all three runner deps.
  - `process(id: string, job: { resume?: number }): Promise<RunOutcome | 'wait'>`.
  - The job data types gain `resume?: number`.
  - `JOB_OPTIONS.retryLimit = POLICY_BOUNDS.maxAttempts[1] - 1`.
  - Each runner's claim statement is `UPDATE … SET status='running', attempts = CASE WHEN $resume::int = attempts THEN attempts ELSE attempts + 1 END … RETURNING attempts`.
  - On `wait`, the worker sends `{…data, resume: attemptNo}` with `startAfter: 30` and the same `singletonKey`, and completes the job (no throw). The run stays `queued`, with a detail matching the label `Queued — waiting for a free AI place`.
  - The counting row is the spend `request_id` row: `extraction_runs` for discussion analysis, `analysis_runs` for minutes, `ai_requests` for assist (spec §6.3).
  - `carriesRestricted` is computed in the same SELECT that reads the text (spec §6.3 table): any `audiences.mode = 'restricted'` on the source (`audience_id` or `intended_mode`) or on the thread. Every summary draft is `true`.

- [ ] **Step 1: Write the failing tests:**
  - `extraction of a restricted source passes carriesRestricted true`;
  - `transcript of a restricted discussion thread passes true`;
  - `summary draft always passes true`;
  - Review Focus 3: `audience turned restricted between attempts skips the unapproved connection`;
  - `a resumed job keeps its attempt number and writes no second spend entry for it`;
  - `a sweep clash still uses an attempt and the next attempt starts on the first eligible connection`;
  - `the runner saves model_id of the fallback that answered`;
  - `worker main builds no client at start and logs no OPENAI_API_KEY warning`.
  - Also run every existing C1 race test (`grep -l "sweptSince\|HELD_DURING_RUN" dist/**/*.test.js`) unchanged.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Leave the save transactions as they are.
- [ ] **Step 4:** Run the full server suite (check first that no other session is using the container). Expected: all PASS, including the sub-project 5 race tests.
- [ ] **Step 5:** Commit: `feat(ai): runners pass project and restricted material; attempts counted on the request`.

### Task 12: Automatic analysis readiness per project

**Files:**
- Modify: `app/src/analysis/tick.ts`, `app/src/analysis/state.ts`
- Test: `app/src/analysis/tick.test.ts` (extend)

**Interfaces:**
- Produces: `readinessMany(db: Db, projectIds: string[], at: Date): Promise<Map<string, Readiness>>`. `Readiness.blockedReason` gains `ai_not_set_up`, `no_eligible_connection`, `protected_key_missing`, `project_no_allowance` and `project_allowance_used`.

- [ ] **Step 1: Write the failing tests:**
  - `a project without connections gets no run and shows Blocked — AI is not set up for this project`;
  - `a project whose monthly allowance is used gets no run`;
  - `a ready project gets its run while an unready one in the same tick does not`;
  - `no ai.request_blocked audit rows are written by the tick`;
  - `readinessMany uses at most three queries for 50 projects` (count queries with a wrapped pool).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(analysis): automatic analysis checks each project's AI readiness`.

### Task 13: Usage views

**Files:**
- Create: `app/src/ai/usage.service.ts`, `app/src/ai/usage.controller.ts`
- Modify: `app/src/spend/spend.controller.ts` (`GET /ai/spend` becomes the header meter for the current project: `?projectId=`)
- Test: `app/src/ai/usage.http.test.ts`

**Interfaces:**
- Produces:
  - `GET /ai/usage/mine` → `{ projects: [{ projectId, name, month: Period, requests, attempts, confirmedMyr, uncertainMyr, reservedMyr, remaining: { organisationPersonal?, projectPersonal? } }] }`
  - `GET /projects/:id/ai/usage` → `{ day, month, byPerson: [{ userId, name, confirmedMyr, uncertainMyr, reservedMyr, attempts }], system: [{ purpose, … }], byConnection: [{ connectionId, label, provider, modelId, attempts, failures, fallbacks, chargedFailures, confirmedMyr, uncertainMyr }] }`
  - `GET /ai/usage` (EA) → organisation totals, `byProject` and `byPerson`, plus `beforeProjects`.

  Amounts use `formatMicro`. Every amount object carries `confirmedMyr`, `uncertainMyr` and `reservedMyr` separately.

- [ ] **Step 1: Write the failing tests:**
  - **Leak test 3:**
    - a Deputy, plain member, Audit holder and an Administrator who is not a member each get 403 (or 404 for an outsider) on the project route;
    - responses contain no key named `question`, `text`, `title`, `prompt`, `body` or `apiKey`, checked recursively.
  - **Figures:**
    - `uncertain amounts are reported separately and included in totals`;
    - `fallbacks count attempts after the first on a different connection`;
    - `pre-project entries appear only in the Administrator view as beforeProjects`;
    - `mine shows remaining personal allowance at both levels when both apply`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ai): usage views for people, projects and the Administrator`.

### Task 14: Web screens

**Files:**
- Create: `app/web/src/ai.ts` (+ `ai.test.ts`), `app/web/src/views/AiAdmin.tsx`, `ProjectAi.tsx`, `AiUsage.tsx`
- Modify:
  - `app/web/src/App.tsx` (`SpendMeter` per project; new tabs);
  - `app/web/src/views/AnalysisStatus.tsx` and the extraction, Ask and Drafts status lines (new Blocked reasons);
  - `app/src/golive/checklist.ts` and `app/web/src/views/GoLive.tsx` (informational item).

**Interfaces:**
- Consumes the routes of Tasks 3, 4, 7 and 13.
- Produces: `ai.ts` pure helpers:
  - `connectionBadge(state): string`, giving the exact labels of the Global Constraints;
  - `blockedText(code): string`;
  - `amountLabel(kind): 'Confirmed'|'Uncertain'|'Reserved'`.

- [ ] **Step 1: Write the failing web tests** (`ai.test.ts`):
  - every connection state maps to its exact label;
  - `blockedText('ai_not_set_up') === 'Blocked — AI is not set up for this project'`;
  - every `spend_project_*` code has wording naming the project level;
  - the key input element is `type="password"` with `autocomplete="off"` and is cleared after submit (component test in the existing style).
- [ ] **Step 2:** Run `npm --prefix web test`. Expected: FAIL.
- [ ] **Step 3:** Implement the screens of spec §9:
  - reordering uses up and down buttons, not dragging;
  - delegation, ceiling and bounds are shown beside each field, with their source;
  - a protected-key banner;
  - the go-live checklist item `AI: at least one approved model; projects need their own connection and limits before AI runs`, informational (does not block).
- [ ] **Step 4:** Run the web tests and `npm run build:web`. Then check in the browser, at desktop width and 375 px, on a scratch database with a fake key and a check that is unreachable (`unchecked`): Admin AI tab, Project AI tab, connections list, limits, usage. Expected: PASS, and no horizontal scroll at 375 px.
- [ ] **Step 5:** Commit: `feat(web): AI settings for Administrators and projects, usage and Blocked reasons`.

### Task 15: Probes, measured aim and documents

**Files:**
- Modify:
  - `app/src/extraction/probe-cli.ts`, `app/src/analysis/probe-minutes-cli.ts`, `app/src/assist/probe-assist-cli.ts` (`--provider openai|anthropic`; read `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` from the environment; record provider and model in the report);
  - `INSTALL.md`, `README.md`;
  - `docs/Kainow-V1.0-Permission-Matrix.md`, `docs/Kainow-V1.0-Configuration-Catalogue.md`;
  - the spec §11 (results).
- Create: `app/src/ai/bench-cli.ts` (`npm run bench-ai`)
- Test: `app/src/ai/bench.test.ts`, the probe tests (`--provider` parsing, missing key fails cleanly naming the variable and never printing a value)

**Interfaces:**
- Consumes: the sub-project 5 bench seed (`seedBench`), which refuses any database not ending in `_bench`.

- [ ] **Step 1: Write the failing tests:**
  - `probe --provider anthropic without ANTHROPIC_API_KEY exits 2 with "ANTHROPIC_API_KEY is not set"`;
  - `bench refuses a database not ending in _bench`;
  - `bench seeds 200,000 entries over 50 projects and 400 people`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. The bench times 500 `reserve` calls with all six scopes applying, after 20 warm-ups, and reports p50, p95 and max (nearest rank).
- [ ] **Step 4:** Run the tests. Then run the bench once on a freshly created `kainow_bench`, after checking that no other process uses the container. Record the result in spec §11 as "Measured aims as found". Aim: p95 under 25 ms. A miss goes to the PO and is not tuned silently.
- [ ] **Step 5: Update the documents:**
  - **Permission Matrix:** the rows of spec §8.
  - **Catalogue:** C39, C44, C45, C46 and C63 cite D84–D87 with the bounds; C69 notes that API keys use the protected key with associated data.
  - **INSTALL.md:**
    - the worker no longer takes `OPENAI_API_KEY`;
    - the protected key is required before saving AI keys;
    - first setup: approve a model (Administrator › AI), set the organisation limits and rate, then in each project add a connection and set limits;
    - the probes read `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` from your own shell only.
  - **README feature list.**
- [ ] **Step 6:** Run the full server suite, the web suite and the web build. Expected: all PASS.
- [ ] **Step 7:** Commit: `docs(ai): probes per provider, measured reservation aim, install and matrix updates`.

---

## Execution notes

- Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15. Tasks 6, 8 and 9 depend only on 1–5 and may be built in any order among themselves. Task 10 needs all of them.
- After Task 15, run a whole-branch review on the most capable model, with the Review Focus list and the leak tests as its checklist.
- The real-model probe (spec §11) needs the PO's own test-project keys. It is run by the PO, not by a subagent.
