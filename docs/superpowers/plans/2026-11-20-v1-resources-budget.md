# V1.0 Sub-project 8 — Shared Resources and Optional Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build:
- the organisation resource catalogue and its maintainers;
- resource lines with the overlap warning (D91);
- the People section;
- optional finance: settings (D94), spending, budget and adjustments through the existing approval process (D92), and warnings (D93);
- the resource and finance places on the project dashboard, timeline, Needs you, leadership summary and Administrator analytics;
- the project resources report and its CSV;
- the screens for all of the above.

**Architecture:**
- Two new Nest modules:
  - `resources`: catalogue, lines, overlap, people, report;
  - `finance`: settings, spending, figures, warnings, change handlers.
- Pure logic lives in plain modules with unit tests: `resources/overlap.ts`, `finance/money.ts`, `finance/figures.ts`.
- Budgets and adjustments are two new `change_requests` kinds with handlers registered on `ChangesService`.
- Figures are worked out live on each request, as in sub-project 7.
- One migration, `0030_resources_finance.sql`.

**Tech Stack:** TypeScript, NestJS 12, PostgreSQL 16 (plain SQL migrations with checksums), React + Vite with hash routing, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-20-v1-resources-budget-design.md` (approved 20 November 2026). Read it in full first; § numbers below refer to it. Also read:
- `app/src/changes/handlers.ts`, `changes.service.ts` (`listedRequestSql`, `submit`, `approve`, `views`) and `rules.ts`;
- `app/src/ai/limits.service.ts` (the delegated-settings and Administrator-path pattern);
- `app/src/organisation/access-settings.service.ts` (the one-row settings pattern);
- `app/src/projects/matrix.ts` and `access.service.ts`;
- `app/src/quarantine/registry.ts` (header comment);
- `app/src/analytics/catalogue.ts` and `panels.service.ts`;
- `app/src/dashboards/project-dashboard.service.ts`, `timeline.service.ts` and `personal.service.ts`.

## Global Constraints

**Migrations and data:**
- One migration, `app/migrations/0030_resources_finance.sql` (Task 1). Never edit `0001`–`0029`. Never take any number outside the reserved ranges: D91–D99 and C76–C84.
- `resource_line_events`, `resource_catalogue_events`, `resource_settings_changes`, `project_finance_changes`, `budget_versions`, `expenditures` and `expenditure_adjustments` are append-only, using `kainow_append_only()`.
- Nothing in this sub-project is ever deleted. A line is Cancelled; an entry is corrected.

**Money:**
- Amounts travel in the API as decimal strings matching `^\d{1,12}(\.\d{1,2})?$`, so the maximum is 999,999,999,999.99.
- Inside the server, amounts are `bigint` minor units. Never use floating point.
- Rates match `^\d{1,10}(\.\d{1,8})?$` and must be greater than 0.
- Currencies are `MYR`, `SGD` and `USD`, each with 2 decimals (`CURRENCIES` in `finance/money.ts`).
- The web form removes spaces and thousands commas before sending.

**Access:**
- `ProjectAccess.authorize` and `canReadContent` are not widened.
- The Administrator's finance-settings path is explicit in `FinanceSettingsService`, as in `ai/limits.service.ts` (§3.7).
- Financial detail is checked by `mayReadFinance(ctx, settings)` (Task 5) on every finance surface.

**Lists:** every listed order comes from a stable `ORDER BY` ending in a timestamp or a unique human key, never a uuid alone.

**Values from the spec:**
- D93 thresholds: whole numbers from 1 to 200, with first < second. The defaults are 80 and 100.
- The D94 delegation default is `projects_may_manage_finance = true`.
- Units:
  - keys: `hours`, `days`, `person_hours`, `person_days`, `items`, `seats`, `square_metres`;
  - labels: Hours, Days, Person-hours, Person-days, Items, Seats, Square metres.
- Statuses:
  - keys: `needed`, `arranged`, `in_use`, `finished`, `cancelled`;
  - labels: Needed, Arranged, In use, Finished, Cancelled.
- Line text limits:
  - one-off description 1–200 characters;
  - notes 0–2,000;
  - quantity > 0 with at most 2 decimals.
- Spending text limits: description 1–500 characters; reference 0–100.
- Catalogue text limits: reference 1–30, name 1–120, description 0–1,000, category name 1–80.
- Reasons are 1–1,000 characters after trim (`readReason`). All typed text runs `refuseSecretsIn`, or the existing credential check, with the D75 wording.

**Exact copy:**
- `Not provided`
- `Not required`
- `Period not provided`
- `Balance based on recorded expenditure`
- `Based on recorded entries.`
- `Over budget`
- `Not in totals`
- `Financial tracking: Not required`
- `Financial tracking is on; figures are visible to the project's finance readers.`
- `Financial tracking is not required for this project. Earlier entries are kept here for reference.`
- `Financial tracking is not required for this project, so finance changes cannot be approved.`
- `The reporting currency is fixed once figures exist.`
- Overlap: `Also recorded by {n} other project(s) in this period: {names} and {k} project(s) you can't see. This is not a booking. Arrange use with the resource's owner outside Kainow.` Leave out each clause whose count is 0. `{names}` is joined with commas and "and".
- `Resources past needed-by date: {n}`
- `Usage records, not bookings`
- Warning notices:
  - `{Project}: recorded spending reached {pct}% of the approved budget (advisory).`
  - `{Project}: recorded spending is over the approved budget (advisory).` This one is for Budget = 0.
- Turn-off preview: `Finance sections will be hidden. {e} entries, {b} budget versions and {p} pending approvals are kept. Finance readers can still open Finance history.`

**CSV:** follow sub-project 7's CSV rules:
- `#` header lines;
- `'` in front of a cell starting with `=`, `+`, `-` or `@`;
- missing values written as the words `Not provided` and `Not required`;
- an amount column always has a currency column beside it.

**Project rules:**
- No real organisation names. Test accounts only: `*@example.org|com|net` or `*@kainow.test`. Use dummy department, project and item names.
- **Tests:**
  - set `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:15432/kainow_test_sp8`. Never use `kainow_test` or `kainow_test_sp9`.
  - For a focused run, from `app/`: `npx tsc -p tsconfig.json && node --test --test-concurrency=1 dist/<path>.test.js`.
  - The full suite (`npm test`) takes more than 10 minutes, so run it in the background.
  - Web: `npm test` in `app/web`.
  - A test that waits on an `AbortSignal.timeout` keeps a `setInterval` alive around it (CI on Node 22 Linux).
- Never print or open `.env` files, API keys or the protected key file. Never use `git stash`.
- Commit after each task with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Completeness tests stay green after every task:**
  - `analytics/catalogue.db.test.ts`: add a catalogue entry in the same task that adds a `writeAudit` action or an event table/`kind`;
  - `quarantine/registry.db.test.ts`: register every new text or jsonb column in Task 1.

## Review Focus

1. **A refund equal to the whole counted amount.** It is accepted and leaves 0.00. A refund one minor unit above it is refused. After a re-conversion, the refund limit is the new converted amount.
   - Test: Task 2, `refund equal to counted leaves zero; above is refused; re-conversion resets the base`.
2. **A budget approved as 0.00, then spending.** The view shows `Over budget`, no percentage and a balance of −x. It never divides by zero.
   - Test: Task 2, `zero budget with spending is over budget without a percentage`.
3. **Period edges.**
   - Two lines on the same single day overlap.
   - A line ending 3 Dec and one starting 4 Dec do not overlap.
   - Two lines with no end date overlap whatever their starts.
   - A line with no end date and a later start overlaps a line whose period contains that start.
   - Test: Task 2, `inclusive day edges and open ends`.
4. **The reporting currency after a budget has only been proposed.** A pending `set_budget` request carries a currency, so a currency change is refused while one is pending, as well as once any budget version or spending entry exists.
   - Test: Task 5, `currency fixed while a budget request is pending`.
5. **Typed amounts such as `1,250.50`, `12.345`, `-5`, `0` and `1e3`.** The web helper turns `1,250.50` into `1250.50`. The server refuses the others with `Enter an amount with at most 2 decimal places.`, except `0`:
   - `0` is refused for spending and refunds (`Enter an amount above 0.`);
   - `0` is accepted for a budget and for a correction.
   - Tests: Task 2 (`parseAmount`), Task 15 (`normaliseAmountInput`).

---

### Task 1: Migration 0030, catalogue entries for the new tables, registry entries

**Files:**
- Create: `app/migrations/0030_resources_finance.sql`, `app/src/resources/migration.test.ts`
- Modify: `app/src/analytics/catalogue.ts`, `app/src/quarantine/registry.ts`

**Interfaces:**
- Produces: the tables in spec §10, exactly as sketched, plus:
  - an append-only trigger on each table named in Global Constraints;
  - `change_requests` CHECKs dropped and re-added with `kind` adding `set_budget` and `finance_adjustment`, and `target_kind` adding `project_budget` and `expenditure`;
  - `resource_settings` seeded with its one row.
- Catalogue entries for the CHECK values of `resource_line_events.kind` and `resource_catalogue_events.kind`, and table entries for `resource_settings_changes` and `project_finance_changes`. Areas: `resources` and `finance`.
- Registry entries:
  - project text with `projectSql`: `resource_lines.description`, `resource_lines.notes`, `resource_line_events.reason`, `resource_line_events.detail` (json), `expenditures.description`, `expenditures.reference`, `expenditure_adjustments.reason`, `project_finance_changes.reason`, `project_finance_changes.previous`, `project_finance_changes.next`;
  - `NO_USER_TEXT` with reasons: enum columns, `currency` columns, `resource_items.*` and `resource_categories.name` (ORG), `resource_catalogue_events.*` (ORG), `resource_settings*` (ORG or SETTING), `resource_catalogue_maintainers.reason` (ORG).

- [ ] **Step 1: Write the failing migration test.**
  - Check that the tables exist.
  - Insert a line with `quantity` but no `unit`: this fails.
  - Insert a line with both `item_id` and `one_off_kind`: this fails.
  - Insert a line with `ends_on < starts_on`: this fails.
  - Insert `change_requests` rows with each new kind and target kind: these succeed.
  - `UPDATE expenditures` raises the append-only error.
  - The `resource_settings` defaults are `true`, `MYR`, `{MYR,SGD,USD}`, `80` and `100`.
  - Inserting thresholds 100 and 80: this fails.
- [ ] **Step 2: Run it.** Expected: FAIL (no tables).
- [ ] **Step 3: Write the migration.** Then add the catalogue and registry entries.
- [ ] **Step 4: Run the migration test.** Then run `dist/analytics/catalogue.db.test.js` and `dist/quarantine/registry.db.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(db): 0030 resources and finance tables`.

### Task 2: Pure logic: money, figures, overlap, units

**Files:**
- Create:
  - `app/src/finance/money.ts`, `money.test.ts`;
  - `app/src/finance/figures.ts`, `figures.test.ts`;
  - `app/src/resources/overlap.ts`, `overlap.test.ts`;
  - `app/src/resources/vocabulary.ts`.

**Interfaces:**
- Produces, in `money.ts`:
  - `CURRENCIES = { MYR: { decimals: 2 }, SGD: { decimals: 2 }, USD: { decimals: 2 } } as const`;
  - `type Currency = keyof typeof CURRENCIES`;
  - `parseAmount(s: unknown, opts: { allowZero: boolean }): bigint`. It throws `BadRequestException` with the Review Focus 5 wording.
  - `parseRate(s: unknown): string`, which returns a normalised string;
  - `formatAmount(minor: bigint, c: Currency): string`, for example `"120,000.00"`;
  - `toDecimalString(minor: bigint): string`, for example `"120000.00"`, used in JSON and CSV.
- Produces, in `figures.ts`:
  - `type Adj = { kind: 'correction' | 'refund' | 'conversion'; amount: bigint; approvedAt: Date }`
  - `countedAmount(entry: { amount: bigint; currency: Currency }, reporting: Currency, adjs: Adj[]): bigint | null`
    - `null` means a foreign entry that is not yet converted.
    - Adjustments apply in `approvedAt` order: a conversion or correction sets the counted amount, a refund subtracts.
  - `refundLimit(...)`, which returns the current counted amount;
  - `type Figures = { budget: bigint | null; spent: bigint; balance: bigint | null; percentUsed: number | null; overBudget: boolean; level: 0 | 1 | 2; notInTotals: { currency: Currency; amount: bigint }[] }`
  - `figures(input: { budget: bigint | null; entries: {...}[]; reporting: Currency; warn: [number, number] }): Figures`
    - `percentUsed` is `Number(spent * 100n / budget)`, floored, and only when `budget > 0`.
    - The level is 2 when `percentUsed >= second` (or `overBudget` when `budget = 0` and `spent > 0`), 1 when `>= first`, else 0.
- Produces, in `overlap.ts`:
  - `type Span = { start: string | null; end: string | null }` (ISO dates)
  - `spansOverlap(a: Span, b: Span): boolean`. It is false if either start is null; ends are inclusive; a null end runs forever.
- Produces, in `vocabulary.ts`:
  - `UNITS` and `LINE_STATUSES`, each a key→label record, with the exact labels from Global Constraints;
  - `ONE_OFF_KINDS = ['equipment', 'facility', 'other']`;
  - `ITEM_KINDS = ['equipment', 'facility']`.

- [ ] **Step 1: Write the failing tests.**
  - The three Review Focus tests named above (1, 2 and 3).
  - `parseAmount` covers Review Focus 5 (the server side).
  - `formatAmount(12000000n, 'MYR') === '120,000.00'`.
  - A foreign entry before conversion is `null` and appears in `notInTotals`.
  - Order of adjustments: a correction then a conversion gives the conversion value.
  - Thresholds: exactly 80% is level 1 and exactly 100% is level 2. 199/200 of the budget is 99%, not 100%.
  - With no budget, `balance` and `percentUsed` are `null` and the level is 0.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the functions.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(finance): money, figures and overlap logic`.

### Task 3: Organisation settings, maintainers and organisation permissions

**Files:**
- Create:
  - `app/src/resources/settings.service.ts`, `settings.controller.ts`, `resources.module.ts`;
  - `app/src/resources/settings.http.test.ts`.
- Modify: `app/src/auth/permissions.ts`, `app/src/app.module.ts`, `app/src/analytics/catalogue.ts`.

**Interfaces:**
- Produces:
  - organisation actions `resources.catalogue.manage` and `resources.settings.manage`, both given to `enterprise_administrator`;
  - `type ResourceSettings = { projectsMayManageFinance: boolean; defaultCurrency: Currency; enabledCurrencies: Currency[]; warnFirstPct: number; warnSecondPct: number }`;
  - `loadResourceSettings(db): Promise<ResourceSettings>`;
  - `ResourceSettingsService.get()` returns `{ settings, changes }`, newest change first;
  - `ResourceSettingsService.update(user, next, reason)` validates and then writes the row, a `resource_settings_changes` row and the audit event `resources.settings_changed`. Validation:
    - at least one enabled currency;
    - the default is enabled;
    - thresholds follow D93;
    - only known currencies.
  - `isCatalogueMaintainer(db, userId): Promise<boolean>`, which is true for the Administrator or a listed maintainer;
  - `MaintainersService.list()`, `add(user, userId, reason)` and `remove(user, userId, reason)`. Each writes a `resource_catalogue_events` row (`maintainer_added` or `maintainer_removed`). Refuse adding an Administrator (`Administrators can already maintain the catalogue.`) and a user who is not Active.
- **Endpoints:**
  - `GET/PUT /admin/resources/settings` (`resources.settings.manage`);
  - `GET/POST/DELETE /admin/resources/maintainers`, with DELETE taking the user id and a reason in the body (`resources.settings.manage`).

- [ ] **Step 1: Write the failing http tests:**
  - a non-EA gets 403;
  - reason required;
  - thresholds 90/90 is a 400 naming the thresholds;
  - default USD while only MYR is enabled is a 400;
  - the history row holds previous and next;
  - maintainers can be added and removed, with events and ordering by `added_at`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement**, following `access-settings.service.ts`.
- [ ] **Step 4: Run them.** Expected: PASS, with `catalogue.db.test` green.
- [ ] **Step 5: Commit** with the message `feat(resources): organisation finance settings and catalogue maintainers`.

### Task 4: Catalogue items and categories

**Files:**
- Create: `app/src/resources/catalogue.service.ts`, `catalogue.controller.ts`, `catalogue.http.test.ts`

**Interfaces:**
- Produces:
  - `CatalogueService.list(user, { all })`:
    - active items and categories for any signed-in user;
    - `all` (retired included) only for maintainers;
    - ordered by kind, then `lower(reference)`, then `created_at`.
  - for maintainers only, each item carries `projectsWithLines: number`: the projects with current or future non-cancelled lines on it (spec §3.3), with no project names;
  - `addItem`, `editItem` (fields; a name or reference change is recorded as `renamed`, other edits as `edited`, with `detail {previous, next}`) and `retireItem(user, id, reason)`;
  - `addCategory`, `renameCategory` and `retireCategory`.
- Errors:
  - `A current item already uses this reference.` (409; unique among active items);
  - `Choose an active category.`;
  - `This item is retired.` (409, when editing a retired item).
- `catalogue.manage` is checked through `isCatalogueMaintainer`. Others get 403.
- **Endpoints:** as spec §11 (`/resources/catalogue/...`), `@AnySignedInUser` with the service check.

- [ ] **Step 1: Write the failing http tests:**
  - a member who is not a maintainer is refused 403 on writes but can list active items;
  - a maintainer adds, renames and retires;
  - a retired item is absent from the default list and present with `all=1`;
  - a reference can be reused after its item is retired;
  - events record actor and detail;
  - credential check: a description holding a dummy secret pattern from `refuseSecretsIn` tests is refused.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the service and controller.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(resources): organisation resource catalogue`.

### Task 5: Matrix actions, finance readers and project finance settings

**Files:**
- Create:
  - `app/src/finance/finance-settings.service.ts`, `finance-settings.controller.ts`, `finance.module.ts`;
  - `app/src/finance/finance-settings.http.test.ts`, `app/src/finance/readers.ts`, `readers.test.ts`.
- Modify: `app/src/projects/matrix.ts`, `app/src/app.module.ts`, `app/src/analytics/catalogue.ts`.

**Interfaces:**
- Matrix rows (spec §9):
  - `resource.view`: participant, ALL. Add it to `GRANT_ACTIONS`.
  - `resource.edit`: pm, deputy_pm, owner, sponsor; OPEN.
  - `finance.record`: pm, deputy_pm; OPEN.
  - `finance.propose`: pm, deputy_pm, owner, sponsor; OPEN. The service narrows adjustments to pm and deputy_pm.
  - `finance.settings`: pm, owner, sponsor; OPEN.
  - Refusal texts in the style of the neighbouring rows.
- `finance.view` is not a matrix row, because it depends on settings. Instead, `readers.ts` exports:
  - `type ProjectFinanceSettings = { tracking: 'not_required' | 'enabled'; currency: Currency | null; warnFirstPct: number | null; warnSecondPct: number | null; membersRead: boolean; grantsRead: boolean }`;
  - `mayReadFinance(ctx: ProjectContext, s: ProjectFinanceSettings): boolean`:
    - true for pm, deputy_pm, owner and sponsor;
    - true for a member when `membersRead`;
    - true for a grant holder (`ctx.grantKinds` not empty, no role) when `grantsRead`;
    - false otherwise, including for an Administrator with no role.
  - `loadProjectFinanceSettings(db, projectId): Promise<ProjectFinanceSettings>`, which returns the defaults when there is no row;
  - `effectiveThresholds(s, org): [number, number]`.
- `FinanceSettingsService`:
  - `get(user, projectId)` returns `{ settings, effective: { thresholds, inherited: boolean }, editable: boolean, delegated: boolean, currencyFixed: boolean, changes }`.
    - A participant, a grant holder or an Administrator may read it.
    - `editable` is true when the state is OPEN and (Administrator, or `finance.settings` allowed and delegation on).
  - `set(user, projectId, next, reason)`: one transaction with the project locked:
    - refuse `Your organisation's Administrator manages finance settings for projects.` when not delegated;
    - check the state;
    - validate: currency enabled, required when enabling; thresholds D93 or both null;
    - currency fixed when any `budget_versions`, `expenditures` or pending `set_budget` request exists (Review Focus 4);
    - upsert, then write `project_finance_changes`;
    - on enabling tracking or changing thresholds, call `FinanceWarnings.evaluate` (Task 10). Until Task 10, leave a no-op hook that Task 10 fills.
  - `preview(user, projectId)` returns `{ entries, budgetVersions, pending }` counts for the turn-off wording.
- **Endpoints:** `GET/PUT /projects/:id/settings/finance` and `GET /projects/:id/settings/finance/preview`, all `@AnySignedInUser` with the checks in the service.

- [ ] **Step 1: Write the failing tests.**
  - Unit tests for `mayReadFinance`, covering every role and policy combination.
  - HTTP tests:
    - a delegated PM enables tracking with MYR;
    - with delegation off, the PM gets 403 with the wording and a non-participant Administrator succeeds;
    - a Deputy reads it but `editable` is false;
    - a Member (participant) reads it with `editable` false;
    - Deferred refuses changes;
    - enabling without a currency, or with a disabled currency, is a 400;
    - inherit versus own thresholds;
    - Review Focus 4: `currency fixed while a budget request is pending` (insert the pending request directly);
    - the preview returns counts only.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. Run `projects/matrix.test.ts` too, and update its expected list if it lists every action.
- [ ] **Step 5: Commit** with the message `feat(finance): project finance settings, readers and matrix actions`.

### Task 6: Resource lines, overlap and people

**Files:**
- Create: `app/src/resources/lines.service.ts`, `lines.controller.ts`, `lines.http.test.ts`, `overlap.db.test.ts`

**Interfaces:**
- Produces:
  - `type LineView = { id; item: { id; kind; reference; name; category: string | null; retired: boolean } | null; oneOffKind: string | null; description: string; quantity: string | null; unit: string | null; startsOn: string | null; endsOn: string | null; neededBy: string | null; notes: string; status: LineStatus; neededByPassed: boolean; overlap: { named: { projectId: string; name: string }[]; others: number } | null; createdAt; updatedAt }`.
    - `overlap` is `null` for one-off lines or lines with no start.
  - `LinesService.list(user, projectId)`:
    - requires `resource.view`;
    - returns `{ lines: LineView[], counts: Record<LineStatus, number>, people: PersonRow[], computedAt }`;
    - orders lines by `needed_by NULLS LAST, starts_on NULLS LAST, coalesce(reference, description), created_at`.
  - `overlapsFor(db, user, lines)`:
    - one query finds the other projects' non-cancelled lines on the same items with overlapping spans (the SQL mirrors `spansOverlap`);
    - each project's visibility is decided with `ProjectAccess.context` (cache per request);
    - each project counts once.
  - `type PersonRow = { userId; name; department: string | null; roles: string[]; openTasks: number; overdue: number }`:
    - Active memberships only;
    - open tasks are Not Started, In Progress or Blocked, live (`liveRecordSql`) and assigned to the person;
    - overdue uses `due_on < todayUtc8()`;
    - ordered by name, then user `created_at`.
  - `create(user, projectId, body)`, `edit(user, projectId, lineId, body)`, `setStatus(user, projectId, lineId, status)` and `cancel(user, projectId, lineId, reason)`:
    - require `resource.edit`;
    - write `resource_line_events` with `detail {previous, next}`;
    - check credentials on the text;
    - refuse `Choose an active catalogue item.` for a retired item on create, or on changing the item;
    - `This line is cancelled.` (409) for a change to a Cancelled line;
    - a status of `cancelled` through `setStatus` is refused: use `cancel`.
  - `history(user, projectId, lineId)` returns events by `at`, then `id`.
  - `neededByPassed` is true when status is `needed` and `needed_by < todayUtc8()`.
- **Endpoints:** spec §11 line routes.

- [ ] **Step 1: Write the failing DB overlap tests** (`overlap.db.test.ts`), using two to four seeded projects:
  - a Cancelled line is excluded and a Finished line is included;
  - a Closed project's line counts;
  - one project with two lines counts once;
  - the viewer is a participant in A only: B is named, C is counted;
  - a grant holder in C sees C named;
  - an Administrator sees all named;
  - the result never contains quantity, notes or status of another project (assert the object keys).
- [ ] **Step 2: Write the failing HTTP tests** (`lines.http.test.ts`):
  - a Member can list but gets 403 on create;
  - a PM creates, edits, sets status and cancels with a reason;
  - every change writes an event;
  - Deferred is read-only;
  - quantity without a unit is a 400;
  - `ends_on` before `starts_on` is a 400;
  - `neededByPassed` flips at the UTC+8 day boundary (`FakeClock`);
  - People rows count only open live tasks, and an Active membership only.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run them.** Expected: PASS.
- [ ] **Step 6: Commit** with the message `feat(resources): resource lines, overlap warning and people`.

### Task 7: Spending entries and the finance read view

**Files:**
- Create: `app/src/finance/finance.service.ts`, `finance.controller.ts`, `spending.http.test.ts`
- Modify: `app/src/analytics/catalogue.ts`

**Interfaces:**
- Produces:
  - `FinanceService.read(user, projectId)`:
    - requires `mayReadFinance`, else 404 for an outsider (as `authorize` does) and 403 `Only the project's finance readers can see financial detail.` for a participant;
    - returns `{ tracking, currency, figures: FiguresView, budgetVersions[], entries: EntryView[], pending: PendingView[], historyOnly: boolean, aiSpendThisMonth?: {...} }`.
    - When tracking is `not_required`, it returns the same data with `historyOnly: true` and the history wording.
    - `aiSpendThisMonth` is present only when the viewer has `ai.usage.view`. Reuse the sub-project 6 usage query for the project for the current UTC+8 month, keeping its confirmed and reserved labels.
  - `FiguresView`: the `Figures` values as decimal strings, plus `warnThresholds`.
  - `EntryView = { id; spentOn; amount; currency; description; reference; recordedBy; recordedAt; counted: string | null; adjustments: AdjView[]; pending: PendingView | null }`, ordered by `spent_on, recorded_at`.
  - `loadFigures(db, projectId): Promise<Figures & { currency } | null>`, which returns `null` when tracking is off. It is used by the dashboard, leadership, analytics and report (Tasks 11–14).
  - `FinanceService.record(user, projectId, body)`:
    - requires `finance.record`, tracking Enabled (`Financial tracking is not required for this project.` 409) and an enabled currency;
    - inserts an expenditure and writes the audit event `finance.spending_recorded` (detail: entry id only);
    - then calls `FinanceWarnings.evaluate` (no-op until Task 10).
- **Endpoints:** `GET /projects/:id/finance` and `POST /projects/:id/finance/spending`.

- [ ] **Step 1: Write the failing HTTP tests:**
  - a PM records MYR 100.00 and the spent total is `100.00`;
  - a USD entry on an MYR project is in `notInTotals`;
  - a Member without the policy gets 403;
  - a Member with `membersRead` reads it;
  - a grant holder with `grantsRead` reads it, and without it gets 403;
  - an Owner cannot record (403);
  - tracking off refuses recording;
  - tracking off still lets a reader see `historyOnly: true` with the entries;
  - a non-participant Administrator gets 404;
  - `aiSpendThisMonth` is absent for a Deputy who lacks `ai.usage.view`. Check the sub-project 6 matrix row to set the expectation.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(finance): spending entries and finance view`.

### Task 8: Budget and adjustment change handlers

**Files:**
- Create: `app/src/finance/handlers.ts`, `budget.http.test.ts`, `adjustments.http.test.ts`
- Modify:
  - `app/src/changes/rules.ts` (`ChangeKind` and `kindAllowedIn`: both new kinds allowed in draft, planned and active for both phases);
  - `app/src/changes/changes.service.ts` (`TargetKind`, `TARGET_KINDS`, `NOUN`, `TARGET_SQL`: `project_budget` loads and locks the `projects` row; `expenditure` loads and locks the `expenditures` row);
  - `app/src/finance/finance.module.ts` (registers the handlers on `ChangesService`, as `RecordsService` does);
  - `finance.controller.ts`;
  - `app/src/analytics/catalogue.ts`.

**Interfaces:**
- `setBudgetHandler: ChangeHandler`:
  - `kind: 'set_budget'`, `targetKind: 'project_budget'`;
  - terms `{ amount: string, currency, reason }`. `validate` parses the amount with `allowZero: true` and sets `currency` to the project's reporting currency;
  - `mayPropose`: the person has `finance.propose`;
  - `readyToApprove`: tracking is Enabled (the §3.6 wording);
  - `apply` inserts a `budget_versions` row, then calls `FinanceWarnings.evaluate`.
- `financeAdjustmentHandler: ChangeHandler`:
  - `kind: 'finance_adjustment'`, `targetKind: 'expenditure'`;
  - terms `{ type: 'correction' | 'refund' | 'conversion', amount, rate?, rateOn?, refundOn?, reason }`;
  - `validate` checks the §3.5 and §3.6 rules:
    - before conversion only a conversion is allowed (`Convert this entry before correcting or refunding it.`);
    - a conversion is only for a foreign entry (`Only an entry in another currency can be converted.`);
    - a refund is at most `refundLimit` (`A refund cannot be more than the entry's counted amount ({amount}).`);
    - a conversion needs a rate and `rateOn`;
    - a refund needs `refundOn`;
  - `mayPropose`: pm or deputy_pm with `finance.propose`;
  - `readyToApprove`: tracking is Enabled;
  - `apply` inserts an `expenditure_adjustments` row, then calls `FinanceWarnings.evaluate`.
  - Tracking off: `readyToApprove` fails, so approval is refused through `approvalBlocked`. Check that the refusal surfaces with the exact wording.
- **Endpoints:**
  - `POST /projects/:id/finance/budget` takes `{ amount, reason }` and calls `ChangesService.submit(..., { approveNow: true })`, so an Owner or Sponsor submitting counts as the first approver.
  - `POST /projects/:id/finance/spending/:entryId/adjust` submits a `finance_adjustment` request.
  - Approve, reject, withdraw and revise use the existing change-request routes.

- [ ] **Step 1: Write the failing HTTP tests:**
  - a PM proposes 120,000.00: the budget stays `Not provided` until an Owner approves, then it is `120000.00`;
  - an Owner proposing alone with a policy of 1 is authorised at once;
  - with a policy of 2, an Owner and a Sponsor are needed, and the same person twice does not count;
  - D03: a vacant required role in an Active project blocks approval;
  - reject, withdraw and revise behave as for other kinds;
  - a correction to 0 voids the entry: totals unchanged until approved, then reduced;
  - a refund, a conversion, and a re-conversion that replaces earlier corrections;
  - each `validate` error with its wording;
  - an Owner proposing an adjustment gets 403;
  - tracking off: approval is refused with the exact wording, and withdraw works;
  - Deferred: submit and approve are both refused.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Then run the existing `changes/*.http.test.js` files. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(finance): budget and adjustment approvals through change requests`.

### Task 9: Finance requests hidden from non-readers on every change-request surface

**Files:**
- Modify:
  - `app/src/changes/changes.service.ts` (`list`, `views`, `listedRequestSql`, or a new `financeVisibleSql(userParam, todayParam)` joined in);
  - `app/src/dashboards/personal.service.ts` (pending approvals);
  - whichever change-request notice and activity code the implementer finds. Search for `change_requests` and notification kinds about requests.
- Create: `app/src/finance/request-visibility.http.test.ts`

**Interfaces:**
- Produces `financeRequestVisibleSql(projectAlias: string, userParam: string, todayParam: string): string`. It is SQL true when the request kind is not a finance kind, or when the user may read that project's finance, mirroring `mayReadFinance` in SQL. It is used by the list, the personal dashboard and the notice fan-out.

- [ ] **Step 1: Write the failing tests**, with a project where `membersRead` is false and a pending budget request and adjustment exist:
  - a Member's request list, Reviews and personal dashboard show neither the requests nor a count of them;
  - no notice about them reaches the Member;
  - the project activity and history views show nothing about them to the Member;
  - with `membersRead` true they appear for the Member;
  - Owner and PM always see them.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Then run the `changes` and `dashboards` suites. Expected: PASS.
- [ ] **Step 5: Commit** with the message `fix(finance): finance requests visible to finance readers only`.

### Task 10: Budget warning notices (D93)

**Files:**
- Create: `app/src/finance/warnings.ts`, `warnings.http.test.ts`
- Modify: the no-op hooks from Tasks 5, 7 and 8; `app/src/analytics/catalogue.ts` if a new notification kind needs listing.

**Interfaces:**
- Produces `FinanceWarnings.evaluate(c: PoolClient, projectId: string, at: Date): Promise<void>`. It runs inside the caller's transaction:
  - lock `project_finance_state` (upsert);
  - compute the level with `loadFigures`;
  - if the level is above `notified_level`, insert one `notifications` row per current PM, Deputy, Owner and Sponsor who `mayReadFinance`, with `kind 'budget_warning'`, `email_off true` and a link to `#/projects/:id/resources`, using the exact notice wording;
  - set `notified_level` to the current level, so it also drops when the level falls;
  - do nothing when tracking is off.

- [ ] **Step 1: Write the failing tests:**
  - 79% gives no notice;
  - recording to 80% gives one notice to each reader;
  - another entry still at 85% gives none;
  - reaching 100% gives the second notice;
  - an approved correction down to 50% then another entry back to 80% notifies again;
  - a lower approved budget can cross a threshold;
  - changing thresholds evaluates;
  - a zero budget with spending gives the over-budget wording;
  - a Member without the policy gets nothing.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement**, and replace the no-op hooks.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(finance): budget warning notices`.

### Task 11: Project dashboard, timeline and Needs you

**Files:**
- Modify:
  - `app/src/dashboards/project-dashboard.service.ts`;
  - `timeline.service.ts` and `timeline.ts` (new kind `resource_needed_by`);
  - `personal.service.ts`;
  - `app/src/dashboards/preferences.ts` (timeline kinds list).
- Test: extend `project-dashboard.http.test.ts`, `timeline.http.test.ts` and `personal.http.test.ts`.

**Interfaces:**
- `ProjectDashboard` gains:
  - `resources: { byStatus: Record<LineStatus, number>; neededByPassed: number; overlapping: number }`;
  - `finance: { tracking } | { tracking: 'enabled'; currency; figures: FiguresView; pendingAdjustments: number; notInTotals: {...}[] }`. The full form goes only to readers.
- Timeline lines `{ day: neededBy, kind: 'resource_needed_by', label: 'Needed by: ' + (reference + ' ' + name | description) }`:
  - Cancelled lines are excluded;
  - the line is hideable through the existing timeline preferences.
- Needs you: an item `Resources past needed-by date: n` for each project where the user is PM or Deputy and the count is above 0. It links to `#/projects/:id/resources`.

- [ ] **Step 1: Write the failing tests:**
  - the counts;
  - a Member sees `finance: { tracking: 'enabled' }` only;
  - a PM sees the figures;
  - the timeline line appears, Cancelled is excluded, and the preference hides it;
  - Needs you shows for the PM and not for a Member.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Then run `dashboards/consistency.http.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(dashboards): resource and finance figures, needed-by timeline and Needs you`.

### Task 12: Leadership fields

**Files:**
- Modify: `app/src/leadership/leadership-fields.ts`, `summary.service.ts`
- Test: extend `app/src/leadership/summary.http.test.ts` (or the existing leadership test file)

**Interfaces:**
- Add the fields `{ key: 'resources', label: 'Resources' }` and `{ key: 'budget', label: 'Budget' }`. They go after `significantRisks` and are hideable.
- Card values:
  - `resources: { needed; arranged; inUse; neededByPassed }`;
  - `budget: { tracking: 'not_required' } | { tracking: 'enabled'; currency; budget: string | null; spent; percentUsed: number | null; level; overBudget }`.
- No entries, references, notes or item names.

- [ ] **Step 1: Write the failing tests:**
  - field values for an Enabled project with no budget (`budget: null`, which the web shows as Not provided);
  - a project with tracking not required;
  - a project at 82%;
  - the leadership holder still gets 404 on `GET /projects/:id/resources` and `/finance`;
  - preferences accept the new keys.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(leadership): resource and budget summary fields`.

### Task 13: Administrator analytics: resources and finance panel

**Files:**
- Modify:
  - `app/src/analytics/analytics.controller.ts` (`panelOf` adds `resources`);
  - `panels.service.ts` (or a new `resources-panel.ts`);
  - the drill-down and export paths;
  - `definitions`.
- Test: `app/src/analytics/resources-panel.http.test.ts`

**Interfaces:**
- Produces the type `ResourcesPanel`:

  ```
  ResourcesPanel = {
    lines: { organisation: Row; departments: Row[]; projects: Row[] };
    sharedItems: { itemId; reference; name; projects: number; earliestOverlap: string }[];
    finance: {
      currency;
      projectsTracking; budgetNotProvided;
      totalBudget; totalSpent;
      atFirst; atSecond;
      projects: {...}[];
    }[];
    notRequired: number;
    computedAt;
  }
  ```

  - `Row = { needed; arranged; inUse; finishedInPeriod; neededByPassed; overlapping }`.
  - Finance groups are ordered by currency code. Projects are ordered by name, then `created_at`.
  - Drill-down follows sub-project 7 §7.3: line detail only where the Administrator is a participant, otherwise counts.
- CSV: one export per table (`panel=resources&table=lines|sharedItems|finance`).
- Definitions entries for the new measures.

- [ ] **Step 1: Write the failing tests:**
  - filters by department and status;
  - finance is grouped per currency and never mixed;
  - not-required projects are counted separately;
  - the CSV has headers and escaping, and is recorded;
  - drill-down for a non-participant Administrator returns counts only;
  - `analytics.view` is required.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(analytics): resources and finance panel`.

### Task 14: Project resources report and CSV

**Files:**
- Create: `app/src/resources/report.service.ts`, `report.http.test.ts`
- Modify: `lines.controller.ts` (route), `app/src/analytics/catalogue.ts` (`resources.report_exported`)

**Interfaces:**
- Produces:
  - `ResourcesReportService.build(user, projectId): Promise<ResourcesReport>`, where `ResourcesReport = { header: { project; owningDepartment; generatedAt; note: 'Usage records, not bookings' }; lines: LineView[]; neededByPassed: LineView[]; people: PersonRow[]; finance?: FinanceView }`:
    - `finance` is present only for readers;
    - `LineView.overlap` keeps its viewer-relative named and counted values.
    - This is a service, not a controller method, so sub-project 9 can reuse it.
  - `toCsv(report): string`, which writes sections `lines`, `people` and `finance` (readers only), each after `#` lines.
- **Endpoint:** `GET /projects/:id/resources/report[?format=csv]`:
  - requires `resource.view`;
  - CSV writes the audit event `resources.report_exported` with `{projectId, sections}`.

- [ ] **Step 1: Write the failing tests:**
  - JSON for a Member has no `finance`;
  - JSON for a PM has it;
  - the CSV header lines;
  - `Not provided` and `Not required` are written as words;
  - a cell `=SUM(A1)` in notes comes out as `'=SUM(A1)`;
  - a currency column sits beside every amount;
  - the audit event holds no data.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(resources): project resources report and CSV`.

### Task 15: Web helpers

**Files:**
- Create: `app/web/src/resources.ts`, `resources.test.ts`, `finance.ts`, `finance.test.ts`

**Interfaces:**
- `resources.ts`:
  - types mirroring `LineView`, `PersonRow` and the report;
  - `overlapText(o): string | null`, with the exact wording and clauses left out when their count is 0;
  - `lineDefaultFilter(status)`, which hides Finished and Cancelled by default;
  - `unitLabel` and `statusLabel`;
  - `validateLineForm(form)`, with the same messages as the server.
- `finance.ts`:
  - `normaliseAmountInput(s)` (Review Focus 5: strips spaces and commas);
  - `money(amount: string | null, currency, opts)`, which returns `Not provided` for `null` (budget) and keeps `0.00` as `0.00`;
  - `figuresLines(f)`: the label strings, including the balance label, `Over budget`, `percentUsed` and the warning text, and nothing when the budget is missing;
  - `adjustmentLabel` and `pendingLabel`.

- [ ] **Step 1: Write the failing tests** for each function with the exact copy from Global Constraints. The Review Focus 5 test is `normaliseAmountInput('1,250.50') === '1250.50'`.
- [ ] **Step 2: Run** `npm test` in `app/web`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(web): resources and finance helpers`.

### Task 16: Resources tab screen

**Files:**
- Create: `app/web/src/views/Resources.tsx`, `ResourceLineForm.tsx`, `Finance.tsx` (finance section, spending list, propose forms, history view)
- Modify: `app/web/src/views/ProjectPage.tsx` (`Tab` adds `resources`, labelled "Resources", shown to everyone with `project.view`), `app/web/src/App.tsx` (the project route regex adds `resources` and `resources/report`)

**Interfaces:**
- Consumes the endpoints from Tasks 6–8 and 14, and the helpers from Task 15.
- Layout as spec §4: status chips, lines, line detail with history, People, Finance, Report links.
- Approve and reject buttons on pending finance requests use the existing change-request calls. They show only when the server's request view says the viewer may approve.
- Deferred and Closed hide edit buttons and show the standard read-only sentence.

- [ ] **Step 1: Build the screen**, keyboard operable, with labelled forms and `aria-live` for saved and failed.
- [ ] **Step 2: Run** `npm test` and `npm run build` in `app/web`. Expected: PASS.
- [ ] **Step 3: Commit** with the message `feat(web): project Resources tab`.

### Task 17: Settings, catalogue, report and dashboard screens

**Files:**
- Create:
  - `app/web/src/views/ResourceAdmin.tsx` (System Settings › Resources and finance: catalogue, maintainers, finance settings);
  - `ResourceCatalogue.tsx` (catalogue page, also reachable by maintainers through the "Resource catalogue" menu item);
  - `ProjectFinanceSettings.tsx`;
  - `ResourcesReport.tsx`.
- Modify:
  - `NotificationSettings.tsx` (`ProjectSettings` adds the finance section);
  - `App.tsx` (admin route and menu items; the menu item for maintainers comes from a `GET /resources/catalogue/me` flag. Add that small route to Task 4's controller if it is missing.);
  - `ProjectFigures.tsx` (the dashboard resources and finance block);
  - the timeline view (new line kind label);
  - `Leadership.tsx` (the two fields);
  - `views/analytics/Panels.tsx` and `Analytics.tsx` (the panel, with a chart and table equivalent for finance per currency as CSS bars).

- [ ] **Step 1: Build the screens.** The turn-off preview must be shown and confirmed before saving tracking off. Settings show effective value, inheritance and editing authority (Q01).
- [ ] **Step 2: Run** `npm test` and `npm run build` in `app/web`. Expected: PASS.
- [ ] **Step 3: Commit** with the message `feat(web): resources settings, catalogue, report and dashboard screens`.

### Task 18: Cross-surface leak suite

**Files:**
- Create: `app/src/resources/leaks.http.test.ts`

- [ ] **Step 1: Write the tests (spec §13, one per surface).**
  - **Setup:**
    - project A tracks finance, with Member M (no policy), grant holder G (no policy) and leadership holder L (organisation scope);
    - project B shares a catalogue item with A, and M is not in B.
  - **Surfaces:** Resources tab, report JSON and CSV, finance read, project dashboard, timeline, change-request list and personal dashboard, leadership card, analytics panel and drill-down.
  - **Assertions:**
    - M and G get no amounts, entries, references or adjustment reasons. Search each JSON body for the seeded amount strings and the description text.
    - L gets only the leadership budget fields, and 404 on the Resources tab and finance.
    - M sees B only as a count in overlap, never B's name, quantity or notes.
    - A non-participant Administrator sees counts only on drill-down and 404 on finance read.
- [ ] **Step 2: Run them.** Expected: PASS. A failure here is a bug in the owning task's code: fix it in this task and name the fix in the commit message.
- [ ] **Step 3: Commit** with the message `test(resources): cross-surface leak suite`.

### Task 19: Bench

**Files:**
- Create: `app/src/resources/bench-cli.ts`
- Modify: `app/package.json` (`"bench-resources": "node dist/resources/bench-cli.js"`), spec §13 (results)

- [ ] **Step 1: Seed the bench.** Reuse the sub-project 7 bench seed (`dashboards/bench-cli.ts`) in its own database `kainow_bench_sp8`, created if missing in `kainow-testdb`, plus the spec §13 extra data.
- [ ] **Step 2: Time the requests.** Use 5 warm-up and then 50 counted requests through the real HTTP app. Report p50, p95 (nearest rank) and max for the four aimed requests.
- [ ] **Step 3: Record the results.** Add the table to spec §13, met or missed, in the sub-project 7 style. Add indexes only when an aim is missed, in `0030` (the branch is unmerged).
- [ ] **Step 4: Commit** with the message `perf(resources): bench and results`.

### Task 20: Documents

**Files:**
- Modify:
  - `docs/Kainow-V1.0-Consolidated-Product-Specification-and-Decision-Register.md` (§14: D91–D94, copied from spec §2.1);
  - `docs/Kainow-V1.0-Permission-Matrix.md` (§5 rows, spec §9);
  - `docs/Kainow-V1.0-Configuration-Catalogue.md` (C51–C55 and C60 point to this design; add C76–C80 as spec §15);
  - `docs/Kainow-V1.0-Remaining-Design-and-Verification-Register.md` (R14, R16 and the R17 resource and finance part marked designed);
  - `app/README.md` (Resources tab, settings, catalogue, bench).

- [ ] **Step 1: Make the edits.** Expect row-level conflicts with sub-project 9 at merge, and keep both sides.
- [ ] **Step 2: Run the full server suite in the background, then the web tests.** Expected: all PASS. Record the counts.
- [ ] **Step 3: Commit** with the message `docs: sub-project 8 decisions, matrix, catalogue, register and README`.
