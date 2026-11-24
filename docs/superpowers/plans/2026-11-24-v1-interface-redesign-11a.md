# Sub-project 11a: Interface Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Kainow's web interface on a side-menu shell, boxes and tables, fixed state colours and selectable colour schemes, with a Settings hub, per-setting pages, binder tabs and in-place proposal correction (D128–D130), without changing any permission or rule.

**Architecture:** A small set of our own building blocks in `app/web/src/ui/` (pure logic in `.ts` files with `node --test` tests; React components in `.tsx`), then every screen moved onto them in waves. Server changes are few and narrow: migration 0036, colour-scheme preferences, organisation colour, proposal type/reason corrections, four new "Needs you" kinds, a Settings summary endpoint and a waiting-proposals count.

**Tech Stack:** React 19 + Vite 8 + TypeScript (no new web dependencies), NestJS + PostgreSQL 16 (`pg`), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-24-v1-interface-redesign-11a-design.md` (read it first; section numbers below refer to it).

## Global Constraints

- No new npm dependency in `app/web` or `app` (approach A).
- No change to any permission predicate, lifecycle rule or audience rule. Every existing route (`#/…` address) keeps working.
- No real organisation name or domain anywhere: dummy data uses "Example Organisation", `example.org`; the default scheme is named "Red".
- Next free numbers: decisions D127–D130, catalogue C111–C112, migration `0036_interface.sql`.
- Every colour lives in a token block in `app/web/src/styles.css`, mirrored in `app/web/src/prefs.ts` and contrast-checked in `prefs.test.ts`: text 4.5:1, edges/symbols/focus outline 3:1.
- State and attention colours never change with the scheme; every one is shown with its symbol and word (spec §5.1 table, copied into `ui/meanings.ts`).
- AI proposals keep the dashed outline and "AI proposed" label in every scheme and theme.
- Dates shown in UTC+8.
- Server tests: `cd app && npx tsc -p tsconfig.json && node --test --test-concurrency=1 dist/<path>.test.js` with `KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kainow_test_sp11` and `KAINOW_TEST_PG_DOCKER=kainow-testdb`. Never use another session's database.
- Web tests: `cd app/web && npm test` (runs `node --test src/*.test.ts`; new `ui/` tests are added to that glob in Task 7).
- Commit after each task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A person with no project and no admin role** (a fresh Member) sees an empty home: the Needs you queue says "Nothing needs you" and the project table says "You are not in any project yet", no empty Administration group, and no broken badge. Pinned in Task 9 (`sideMenuGroups` test) and Task 10 (`homeEmptyCopy` test).
2. **A saved organisation colour that later fails contrast** (e.g. the rules tighten, or a stored value is edited by hand) must never be applied: the client falls back to Red. Pinned in Task 3 (`deriveScheme rejects low contrast`) and Task 4 (`schemeFor falls back to red`).
3. **A long project name, department list or setting value at 375 px** wraps inside its box and never pushes the page sideways. Pinned in Task 20's audit (375 px states with the 120-character dummy project name the audit creates).
4. **Correcting a proposal while someone else authorises it** must be refused, not create a record of the old type. Pinned in Task 5 (`correction after authorise is refused`) and Task 5's concurrent test.
5. **A Settings box whose source read fails** (for example storage unreachable) shows "Could not check" in the Not-in-use grey with the reason, never "Set up". Pinned in Task 6 (`summary marks a failed read as unknown`).

---

## File map

| Area | Files |
|---|---|
| Migration | `app/migrations/0036_interface.sql`, `app/src/db/interface-schema.test.ts`, `app/src/db/migrate.test.ts` (REAL_FILES) |
| Colour schemes (server) | `app/src/dashboards/preferences.ts` (+test) |
| Organisation colour | `app/src/organisation/colour.ts` (+test), `organisation.service.ts`, `organisation.controller.ts`, `organisation.http.test.ts` |
| Proposal corrections | `app/src/extraction/extraction.service.ts`, `extraction.controller.ts`, `app/src/changes/changes.service.ts`, `app/src/quarantine/registry.ts`, `app/src/extraction/correct.http.test.ts` |
| Needs you kinds | `app/src/dashboards/personal.service.ts`, `personal.http.test.ts`, `leaks.http.test.ts` |
| Settings summary | `app/src/settings-summary/` (module, controller, service, rules, tests), `app/src/app.module.ts` |
| Waiting count | `app/src/dashboards/project-dashboard.service.ts` (+http test) |
| Web building blocks | `app/web/src/ui/*.ts(x)`, `app/web/src/styles.css`, `app/web/src/prefs.ts` |
| Web screens | `app/web/src/App.tsx`, `app/web/src/views/*.tsx`, new `views/MyTasks.tsx`, `views/Reviews.tsx`, `views/SettingsHub.tsx` |
| Checks and docs | `tests/a11y/audit.mjs`, `tests/browsers/smoke.mjs`, the Decision Register, Configuration Catalogue, Remaining Design and Verification Register (R18), `app/README.md` |

---

### Task 1: Migration 0036

**Files:**
- Create: `app/migrations/0036_interface.sql`, `app/src/db/interface-schema.test.ts`
- Modify: `app/src/db/migrate.test.ts` (add `'0036_interface.sql'` to `REAL_FILES`)

**Interfaces:**
- Produces: `organisation.colour text NULL CHECK (colour ~ '^#[0-9a-f]{6}$')`; `extraction_item_edits.kind text NULL CHECK (kind IN ('decision','action','question','risk'))`; `extraction_item_edits.reason text NULL CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500)`. Kind values must match `extraction_items.kind`'s existing CHECK (verify in `0005_extraction.sql` and use the same set). The append-only triggers on `extraction_item_edits` stay.

- [ ] **Step 1: Write the failing test** `interface-schema.test.ts`: after migrating, (a) `organisation.colour` accepts `'#b0182e'` and rejects `'#B0182E'`, `'red'`, `'#b0182'`; (b) an `extraction_item_edits` row with `kind = 'decision'` and a 500-character reason inserts, `kind = 'task'` is rejected, a 501-character or empty reason is rejected; (c) an UPDATE of the new row still raises `extraction_item_edits is append-only`.
- [ ] **Step 2: Run it, expect FAIL** (`column "colour" does not exist`).
- [ ] **Step 3: Write `0036_interface.sql`** (lower-case hex only; the server lower-cases before storing).
- [ ] **Step 4: Run `dist/db/interface-schema.test.js` and `dist/db/migrate.test.js`, expect PASS.**
- [ ] **Step 5: Commit** `feat(db): 0036 organisation colour and proposal correction columns`.

### Task 2: Colour-scheme preferences (server)

**Files:** Modify `app/src/dashboards/preferences.ts`, `app/src/dashboards/preferences.test.ts`, `preferences.http.test.ts`

**Interfaces:**
- Produces: `ACCENTS = ['red','teal','blue','plum','slate','organisation'] as const`; `Prefs.accent` of that type; `Prefs.accentChosen: boolean`; `DEFAULT_PREFS.accent = 'red'`, `DEFAULT_PREFS.accentChosen = false`.

- [ ] **Step 1: Tests** in `preferences.test.ts`: `normalisePrefs({})` gives `accent: 'red', accentChosen: false`; `normalisePrefs({accent:'teal'})` (an old stored document) gives `accent:'teal', accentChosen:false`; `{accent:'organisation', accentChosen:true}` is kept; `{accent:'green'}` falls back to `'red'`; `accentChosen:'yes'` gives `false`. HTTP: `PUT /me/preferences` with `{accent:'blue', accentChosen:true}` round-trips.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** in `normalisePrefs` with the existing `oneOf` and `bool` helpers.
- [ ] **Step 4: Run `dist/dashboards/preferences.test.js` and `dist/dashboards/preferences.http.test.js`, expect PASS.**
- [ ] **Step 5: Commit** `feat(prefs): red default, organisation scheme, accentChosen`.

### Task 3: Organisation colour (server)

**Files:**
- Create: `app/src/organisation/colour.ts`, `app/src/organisation/colour.test.ts`
- Modify: `organisation.service.ts`, `organisation.controller.ts`, `organisation.http.test.ts`

**Interfaces:**
- Produces (pure, no imports from NestJS, so the web copies it verbatim in Task 4): `contrastRatio(a: string, b: string): number` (WCAG relative luminance); `deriveScheme(hex: string): { ok: true; scheme: SchemeTokens } | { ok: false; reason: string }` where `SchemeTokens = { menu: string; menuInk: string; menuActive: string; accent: string; accentContrast: string; accentDeep: string; accentWash: string }`. Derivation: `accent` = the given colour; `menu` = accent darkened in HSL lightness to ≤ 18%; `menuActive` = accent; `accentDeep` = lightness −12; `accentWash` = lightness 93%; `accentContrast` and `menuInk` = `#ffffff`. `ok:false` when white on `accent` < 4.5, white on `menu` < 4.5, or `accent` on `#ffffff` < 3 (links and focus), with reason "This colour is too light for white text on buttons. Choose a darker shade."
- Produces: `PUT /organisation/colour` body `{ colour: string | null, reason: string }`, Enterprise Administrator only, same audit and previous/new recording as the organisation name change (follow its code); 400 with the reason above when `deriveScheme` refuses; colour lower-cased. `Branding` gains `colour: string | null`.

- [ ] **Step 1: Tests** `colour.test.ts`: `contrastRatio('#ffffff','#000000')` = 21 (±0.01); `deriveScheme('#b0182e').ok === true`; `deriveScheme('#ffd84a').ok === false` (**deriveScheme rejects low contrast**); `deriveScheme('#0C6A6E')` works (case-insensitive). HTTP: Administrator sets `#B0182E` with a reason → branding shows `#b0182e`; a Member gets 403; missing reason gets 400; `#ffd84a` gets 400 with the reason text; `null` clears; each change writes one audit row with previous and new values.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `dist/organisation/colour.test.js` and `dist/organisation/organisation.http.test.js`, expect PASS.**
- [ ] **Step 5: Commit** `feat(organisation): organisation colour with contrast check (C112)`.

### Task 4: Tokens, schemes and meanings (web)

**Files:**
- Modify: `app/web/src/styles.css` (token blocks only), `app/web/src/prefs.ts`, `app/web/src/prefs.test.ts`
- Create: `app/web/src/ui/colour.ts` (verbatim copy of `app/src/organisation/colour.ts`, with a header comment naming the server file), `app/web/src/ui/meanings.ts`, `app/web/src/ui/meanings.test.ts`

**Interfaces:**
- Produces in `prefs.ts`: `ACCENT_KEYS = ['red','teal','blue','plum','slate','organisation']`; `Prefs.accentChosen`; `ACCENTS: Record<Exclude<AccentKey,'organisation'>, Record<Theme, SchemeTokens>>`; `schemeFor(prefs: Prefs, orgColour: string | null): { key: AccentKey; tokens: SchemeTokens }` (rule: if `!accentChosen` use `organisation` when `orgColour` derives ok, else `red`; if `accentChosen` and key is `organisation` but the colour is null or fails, `red`); `applyAppearance(prefs, orgColour)` sets `data-theme` and the scheme's CSS variables on `<html>`.
- Produces in `meanings.ts`: `type Meaning = 'draft'|'planned'|'active'|'deferred'|'closed'|'overdue'|'review'|'blocked'|'dueSoon'|'ok'|'attention'|'failing'|'off'`; `MEANINGS: Record<Meaning, { symbol: string; word: string; strong: Record<Theme,string>; wash: Record<Theme,string> }>` with spec §5.1 values and words ("Draft", "Planned", "Active", "Deferred", "Closed", "Overdue", "Needs review", "Blocked", "Due soon", "Set up", "Needs attention", "Failing", "Not in use"); `projectMeaning(status: ProjectStatus): Meaning`.
- CSS variables (names the components use): `--menu`, `--menu-ink`, `--menu-active`, `--accent`, `--accent-contrast`, `--accent-deep`, `--accent-wash`, and per meaning `--m-<meaning>` and `--m-<meaning>-wash`.

- [ ] **Step 1: Tests** `prefs.test.ts`: for every scheme × theme, `accentContrast` on `accent` ≥ 4.5, `menuInk` on `menu` ≥ 4.5, `accent` on the theme's surface ≥ 3; the CSS token blocks equal `ACCENTS` (extend the existing file-parsing check); `schemeFor({...DEFAULT_PREFS}, null).key === 'red'`; `schemeFor({...DEFAULT_PREFS}, '#1f55a8').key === 'organisation'`; `schemeFor({...DEFAULT_PREFS, accent:'teal', accentChosen:true}, '#1f55a8').key === 'teal'`; **`schemeFor falls back to red`** for `{accent:'organisation', accentChosen:true}` with `null` and with `'#ffd84a'`. `meanings.test.ts`: every meaning's `strong` on its `wash` ≥ 4.5 and on the surface ≥ 4.5 in both themes; every meaning has a non-empty symbol and word; the Red scheme's `menu` and the `overdue` wash differ in luminance by a contrast ≥ 3 (so they never look alike).
- [ ] **Step 2: Run `cd app/web && npm test`, expect FAIL.**
- [ ] **Step 3: Implement** (Red light: accent `#b0182e`, menu ≤ `#4a0912`; Teal keeps today's values; dark pairs chosen to pass).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(web): colour schemes, red default and fixed meaning colours`.

### Task 5: Correcting a proposal's type, with a reason (server)

**Files:**
- Modify: `app/src/extraction/extraction.service.ts`, `extraction.controller.ts`, `app/src/changes/changes.service.ts:42`, `app/src/quarantine/registry.ts` (register `extraction_item_edits.reason` as user text, like `text`), `app/src/analytics/catalogue.ts` only if its tests require the new columns listed
- Create: `app/src/extraction/correct.http.test.ts`

**Interfaces:**
- `LATEST_EDIT` selects `kind` too. One constant `KIND_IN_FORCE = 'COALESCE(e.kind, i.kind)'` replaces `i.kind` wherever an extraction item's kind is read for review, authorisation, change requests and the review view (`extraction.service.ts` lines ~231, ~423, ~500; `changes.service.ts:42` joins the latest edit the same way).
- `POST extractions/:runId/items/:itemId/edit` body gains `kind?: 'decision'|'action'|'question'|'risk'` and `reason?: string`. Every new edit row stores the kind in force after the edit (never null). `reason` is required (400 "Give a reason for changing the type.") when `kind` differs from the kind in force; trimmed, 1–500 characters when given. A kind change counts as a change for "Nothing was changed". All other rules unchanged (refused once authorised; returns the item to pending; sets aside pending approvals).
- `GET extractions/:runId` items gain `corrections: { at: string; by: string; role: string | null; changed: ('type'|'text'|'owner'|'due')[]; from: { kind: string }; to: { kind: string }; reason: string | null }[]` (newest first; `by` is the editor's display name, `role` their project role label at the time of reading, or null) and `original: { kind, text, owner, due, model: string | null }` (`model` from the run's recorded model id).
- Audit: one `proposal.corrected` row per edit with `{ fields: [...] }` detail, no wording.

- [ ] **Step 1: Tests** in `correct.http.test.ts` (copy the set-up of `edit.http.test.ts`): type change Task(action)→decision with reason saves and the review view shows kind `decision`, `corrections[0].changed` includes `'type'`, `by` the editor's name, `reason` as sent; type change without reason → 400; reason of 501 chars → 400; wording-only edit without reason → 200 with `reason: null`; authorising a corrected item creates a **decision** record, not a task; **correction after authorise is refused** (409, as today's edit); a concurrent authorise and correction (two clients, `Promise.allSettled`) never leave a record whose kind differs from the item's kind in force; a change request listed in `changes.service` shows the corrected kind; the `original` block keeps the model's kind and wording.
- [ ] **Step 2: Run `dist/extraction/correct.http.test.js`, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `correct.http.test.js`, `edit.http.test.js`, `review.http.test.js`, `extraction.http.test.js`, `dist/changes/*.test.js`, `dist/quarantine/registry.db.test.js`, expect PASS.**
- [ ] **Step 5: Commit** `feat(extraction): correct a proposal's type with a reason, named history (D130)`.

### Task 6: Settings summary endpoint

**Files:**
- Create: `app/src/settings-summary/settings-summary.module.ts`, `settings-summary.controller.ts`, `settings-summary.service.ts`, `rules.ts`, `rules.test.ts`, `settings-summary.http.test.ts`
- Modify: `app/src/app.module.ts`

**Interfaces:**
- `GET /admin/settings/summary` (Enterprise Administrator only, like the other admin routes) → `{ settings: SettingSummary[]; computedAt: string }` with `SettingSummary = { key: SettingKey; state: 'ok'|'attention'|'failing'|'off'|'unknown'; stateWord: string; values: { label: string; value: string }[] /* at most 3 */ ; note?: string }` and `SettingKey = 'organisation'|'administrators'|'departments'|'domains'|'leadership'|'approvals'|'reminders'|'access'|'resources'|'reportTypes'|'ai'|'emailDelivery'|'storage'|'operations'|'goLive'|'escalatedFeedback'|'securityReview'`.
- `rules.ts` holds one pure function per key from plain inputs to `SettingSummary` (tested without a database); the service gathers the inputs by calling the services the setting pages already use (inject them; no new SQL where a service already answers). Each gather runs in its own try/catch: a failure gives `state:'unknown', stateWord:'Could not check'` and `note` the plain reason.
- Rules pinned by the spec: AI `values` lists approved models as `"<model id> (<Provider>)"` and the fallback; Email delivery is `failing` when any email failed in the last 24 h; Leadership access is `attention` when requests wait; Storage is `off` when no destination is approved; Operations takes the Operations page's status; Escalated feedback is `attention` when any is open; Go-live is `ok` when closed. The rest: the implementer picks two or three values each page already shows at its top, and `ok` unless the page itself shows a warning.
- No value may contain project content (titles, wording); counts and configuration only.

- [ ] **Step 1: Tests** `rules.test.ts`: one test per rule above, including **summary marks a failed read as unknown**; `settings-summary.http.test.ts`: Administrator gets 17 entries with distinct keys in the hub order of spec §7.8; a Member and a Project Manager get 403; the AI entry names a seeded approved model; no entry's values contain a seeded project's name (leak check).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both test files, expect PASS.**
- [ ] **Step 5: Commit** `feat(settings): settings summary for the hub (D128)`.

### Task 7: "Needs you" kinds, the waiting-proposals count and the project proposals list

**Files:** Modify `app/src/dashboards/personal.service.ts`, `personal.http.test.ts`, `leaks.http.test.ts`, `project-dashboard.service.ts`, `project-dashboard.http.test.ts`, `app/src/extraction/extraction.controller.ts`, `extraction.service.ts`; Create `app/src/extraction/project-proposals.http.test.ts`

**Interfaces:**
- `NeedsYouKind` gains `'overdue' | 'blocked' | 'due_soon' | 'risk_review'` (spec §7.1 rules: own overdue tasks; own Blocked tasks plus Blocked tasks in projects where the viewer is PM or Deputy PM; own tasks due within 7 days by the project calendar, UTC+8; risk reviews due within 7 days for risks the viewer owns). Each item's `label` is the task title or risk description under the existing dashboard text rule (held records show their label), `link` to the record, `since` the due date as an ISO instant at 00:00 UTC+8.
- `ProjectDashboard.proposals: { waiting: number }`: extraction items pending review plus human proposals pending, readable by the viewer: only from sources whose audience the viewer is in (the same filter `GET projects/:projectId/notes` applies), zero when the viewer may not read project content.
- New `GET /projects/:projectId/proposals` (in `app/src/extraction/extraction.controller.ts`, same permission and source-audience filter as `GET projects/:projectId/notes`) → `{ runs: { runId: string; sourceId: string; sourceTitle: string; versionNo: number; finishedAt: string; waiting: number; total: number }[] }`, succeeded runs with at least one item, newest first; held sources show their held label as title, as the notes list does.

- [ ] **Step 1: Tests**: each new kind appears for the right person and not for others; a held task shows its held label; an On Hold member gets none of the new kinds for that project; leaks test covers the new kinds (a removed member, an Audit grant holder with summary-only access); `proposals.waiting` counts 3 waiting items, 0 after deciding them, 0 for a viewer without content access; a run from a Restricted note is counted and listed for its audience and **neither counted nor listed** for a project member outside it; `GET /projects/:id/proposals` lists runs newest first with `waiting`/`total`, and 403 for a non-member.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (reuse the queries behind `myTasks` and the risk review notices where possible).
- [ ] **Step 4: Run `dist/dashboards/*.test.js`, expect PASS.**
- [ ] **Step 5: Commit** `feat(dashboards): overdue, blocked, due-soon and risk-review in Needs you; waiting proposals count`.

### Task 8: Building blocks

**Files:**
- Create in `app/web/src/ui/`: `StatusLabel.tsx`, `Box.tsx`, `StatTile.tsx`, `DataTable.tsx`, `table.ts`, `table.test.ts`, `AttentionQueue.tsx`, `attention.ts`, `attention.test.ts`, `BinderTabs.tsx`, `PageHeader.tsx`, `SettingBox.tsx`, `SettingsPage.tsx`, `StageFlow.tsx`, `StackedBar.tsx`, `graphics.ts`, `graphics.test.ts`
- Modify: `app/web/package.json` test script to `node --test src/*.test.ts src/ui/*.test.ts`; `styles.css` (one section per block)

**Interfaces (props):**
- `StatusLabel({ meaning: Meaning, word?: string, filled?: boolean })`
- `Box({ title?: string, headingLevel?: 2|3|4, meaning?: Meaning, edge?: 'left'|'top', children })`
- `StatTile({ label: string, value: string, note?: string, meter?: { value: number, max: number, text: string }, meaning?: Meaning, href?: string })`
- `DataTable<T>({ caption: string, columns: { key: string, header: string, cell: (row: T) => ReactNode, sortValue?: (row: T) => string|number }[], rows: T[], rowKey: (row: T) => string, empty: string, loading?: boolean, initialSort?: { key: string, dir: 'asc'|'desc' } })`; pure `sortRows(rows, column, dir)` in `table.ts`. Sorting is by a button in the header with `aria-sort`; below 700 px rows stack as labelled pairs (CSS with `data-label` on each cell).
- `AttentionQueue({ items: NeedsYouItem[], empty: string })`; pure `groupAttention(items): { group: 'overdue'|'review'|'blocked'|'dueSoon', meaning: Meaning, heading: string, items: NeedsYouItem[] }[]` in `attention.ts` (order Overdue, Review and decisions, Blocked, Due soon; empty groups dropped; kind mapping from spec §7.1 and Task 7).
- `BinderTabs({ label: string, tabs: { key: string, href: string, text: string, badge?: { count: number, meaning: Meaning } }[], current: string })` (links, `aria-current="page"`).
- `PageHeader({ crumbs?: { text: string, href: string }[], title: string, intro?: string, action?: ReactNode })` (one `h1`).
- `SettingBox({ summary: SettingSummary, title: string, purpose: string, href: string })` (whole box is one link; state from `meaning` map `ok→ok, attention→attention, failing→failing, off|unknown→off`).
- `SettingsPage({ header: PageHeader props, glance: ReactNode, settings: { key: string, title: string, current: ReactNode, form: (close: () => void) => ReactNode }[] })` (each setting box has a "Change…" button with `aria-expanded` that opens its form in place; focus moves into the form and back to the button on close, using the existing `useReturnFocus`).
- `StageFlow({ stages: { name: string, state: 'done'|'current'|'todo', days?: number }[] })` and `StackedBar({ parts: { meaning: Meaning, label: string, count: number }[] })`; pure `stageFlowText` and `stackedBarText` in `graphics.ts` give the screen-reader text ("Stage 3 of 5: Build, 34 days. Done: Initiation, Design.") and the legend in words.

- [ ] **Step 1: Tests**: `table.test.ts` (sort ascending/descending, stable on ties, empty list); `attention.test.ts` (each kind lands in its group, order, empty groups dropped, the 10 kinds all mapped); `graphics.test.ts` (texts above, zero counts omitted from the legend, percentages round to whole numbers and sum shown as counts).
- [ ] **Step 2: Run `npm test`, expect FAIL.**
- [ ] **Step 3: Implement the blocks and their CSS** (spec §5.1 shape rules; no decorative shadows).
- [ ] **Step 4: Run `npm test` and `npm run build`, expect PASS.**
- [ ] **Step 5: Commit** `feat(web): interface building blocks`.

### Task 9: App shell, side menu, top bar and person menu

**Files:**
- Create: `app/web/src/ui/AppShell.tsx`, `ui/SideMenu.tsx`, `ui/TopBar.tsx`, `ui/PersonMenu.tsx`, `ui/menu.ts`, `ui/menu.test.ts`
- Modify: `app/web/src/App.tsx` (header replaced by the shell; routing unchanged except the new routes `#/my-tasks`, `#/reviews`, `#/settings` rendering placeholders filled by Tasks 10–11), `views/Customise.tsx` (moves into the person menu; colour scheme radio group lists Red, Teal, Blue, Plum, Slate and Organisation when set; picking sets `accentChosen: true`), `views/OpsBanner.tsx` (inside the shell)

**Interfaces:**
- `sideMenuGroups(ctx: { isAdmin: boolean, hasGrant: boolean, maintainer: boolean, reviewer: boolean, reviewCount: number }): { heading: 'Work'|'Organisation'|'Administration', items: { href: string, text: string, badge?: number }[] }[]` in `menu.ts` (spec §6.1 table; groups with no item dropped).
- `currentMenuHref(hash: string): string` (settings addresses from spec §7.8 → `#/settings`; project addresses → `#/projects`; `#/runs/…` → `#/projects`).
- The shell reads the review count from `/dashboard/me` once per navigation to Home or Reviews and on load.

- [ ] **Step 1: Tests** `menu.test.ts`: a plain Member gets Work (4 items) and Organisation (My AI use only) and no Administration (**Review Focus 1**); an Administrator gets Settings and Operations; a reviewer gets Security review; `currentMenuHref('#/deliveries') === '#/settings'`, `('#/projects/<uuid>/work') === '#/projects'`, `('#/runs/<uuid>') === '#/projects'`, `('#/my-ai-usage') === '#/my-ai-usage'`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (side menu collapses below 900 px into a Menu disclosure button; at 375 px the top bar shows Menu, logo, a search icon button, bell and the person button only; the person menu is a disclosure with `aria-expanded`, closes on Escape and returns focus).
- [ ] **Step 4: Run `npm test` and `npm run build`; start the demo API (see Task 20 Step 1) and check at 375 px in the browser that the top bar does not overflow (`document.documentElement.scrollWidth <= 375`).**
- [ ] **Step 5: Commit** `feat(web): side menu shell and person menu (D128, D129)`.

### Task 10: Home, My tasks, Reviews and Projects

**Files:** Modify `views/Home.tsx`, `views/Projects.tsx`; Create `views/MyTasks.tsx`, `views/Reviews.tsx`, `ui/home.ts`, `ui/home.test.ts`; Modify `App.tsx` routes

**Interfaces:**
- `homeEmptyCopy(d: PersonalDashboard): { needsYou: string|null, projects: string|null }` ("Nothing needs you." / "You are not in any project yet. A Project Manager adds you when a project needs you.").
- `reviewItems(needsYou: NeedsYouItem[]): NeedsYouItem[]` (the "review" group of `groupAttention`), used by Reviews and the menu badge.
- Home keeps today's personalisation (order, hide, reset, show completed, include archived, expansion choices) and the "Needs you never moves or hides" rule.

- [ ] **Step 1: Tests** `home.test.ts`: `homeEmptyCopy` for an empty dashboard (**Review Focus 1**) and a full one (both null); `reviewItems` keeps approval, question, deadline_review, minutes and drops overdue, blocked, due_soon.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (spec §7.1–§7.4: Home with greeting, `AttentionQueue`, projects `DataTable` with columns Project, State, Stage, Progress, Needs attention, the existing collapse/expand and Expand all / Collapse all; My tasks table with status and project filters, overdue first; Reviews table; Projects with five state `StatTile`s acting as filters and the projects table).
- [ ] **Step 4: Run `npm test`, `npm run build`; existing `dashboard.test.ts` and `projects.test.ts` still pass.**
- [ ] **Step 5: Commit** `feat(web): home, my tasks, reviews and projects on boxes and tables`.

### Task 11: Settings hub and the Organisation and people pages

**Files:** Create `views/SettingsHub.tsx`, `ui/settings.ts`, `ui/settings.test.ts`; Modify `views/OrganisationProfile.tsx` (adds the organisation colour control: colour input with hex text field, live preview of the derived scheme, reason, Save and Clear, error from the server shown at the field), `views/People.tsx` (Administrators), `views/Organisation.tsx` (Departments, Domains), `views/LeadershipGrants.tsx`

**Interfaces:**
- `SETTINGS_CATALOGUE: { key: SettingKey, group: 'Organisation and people'|'Work rules'|'Connections'|'Running Kainow', title: string, purpose: string, href: string, reviewerOnly?: true }[]` (spec §7.8 table, in order); `filterSettings(catalogue, query): typeof catalogue` (case-insensitive over title and purpose); `summaryCounts(summaries): { ok: number, attention: number, failing: number, off: number }` (`unknown` counts as `off`).
- Each page uses `SettingsPage`: Organisation (glance: name, logos, colour, custodian; settings: name, logos, colour, custodian); Administrators (glance: Active / Disabled / custodian tiles and the people table; settings: invite); Departments and Domains (table with actions); Leadership access (glance: active grants, waiting requests table; settings: the grant forms).

- [ ] **Step 1: Tests** `settings.test.ts`: catalogue has 17 entries, unique keys and hrefs, matches spec §7.8 order; `filterSettings(…, 'remind')` returns Reminders and email; `summaryCounts` counts `unknown` as off.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (hub: header, counts line, search, four groups of `SettingBox`; a hub load failure shows the boxes without state and a plain error line).
- [ ] **Step 4: Run `npm test`, `npm run build`.**
- [ ] **Step 5: Commit** `feat(web): settings hub and organisation and people pages`.

### Task 12: Work rules pages

**Files:** Modify `views/ApprovalSettings.tsx`, `views/NotificationSettings.tsx` (+ `views/Holidays.tsx` as one of its setting boxes), `views/AccessSettings.tsx`, `views/ResourceAdmin.tsx`, `views/ReportTypes.tsx`

**Interfaces:** Consumes `SettingsPage`, `DataTable`, `StatTile`. Each page: glance first (current values and the main table, e.g. holidays this year, report types in use), then each changeable setting in its own box with its existing form, reason field, preview and consequences unchanged.

- [ ] **Step 1: Run the web tests that cover these screens' logic** (`settings.test.ts`, `calendar.test.ts`, `resources.test.ts`, `outputs.test.ts`) to record the baseline (PASS).
- [ ] **Step 2: Rebuild the five pages on `SettingsPage`.**
- [ ] **Step 3: Run `npm test` and `npm run build`, expect PASS; open each page on the demo installation and confirm every form from before is still reachable and saves (one change each, then undo).**
- [ ] **Step 4: Commit** `feat(web): work rules setting pages`.

### Task 13: Connections pages

**Files:** Modify `views/AiAdmin.tsx` (+ its usage tab), `views/Deliveries.tsx`, `views/StorageSettings.tsx`, `views/StorageConnection.tsx`

**Interfaces:** AI glance: status tile, spend this month with meter, requests today, needs-attention tile, "Models in use" table (Model, Provider, Role, Projects using it, This month, Status), "Projects nearest their limit" table; settings: Approved models, Spending limits, AI places at once, Data handling policy (existing forms). Email delivery glance: last 24 h sent/failed tiles and the deliveries table with failures first. Storage glance: destination status and checks table.

- [ ] **Step 1: Baseline** `ai.test.ts`, `storage.test.ts` PASS.
- [ ] **Step 2: Rebuild the pages.** Where a glance figure is not in an existing response (for example projects per model), take it from the responses the page already loads; do not add server routes beyond Tasks 5–7. If a figure is truly unavailable, leave it out.
- [ ] **Step 3: `npm test`, `npm run build`; check each page on the demo installation.**
- [ ] **Step 4: Commit** `feat(web): AI, email delivery and storage setting pages`.

### Task 14: Running Kainow pages

**Files:** Modify `views/Operations.tsx`, `views/GoLive.tsx`, `views/EscalatedFeedback.tsx`, `views/SecurityReview.tsx`, `views/HeldReview.tsx`

**Interfaces:** Operations glance: status strip as `StatTile`s (last backup, last drill, disk, update), then its existing sections as boxes and tables; Go-live: the 11 steps as boxes with state labels; Escalated feedback and Security review: tables first, actions in boxes.

- [ ] **Step 1: Baseline** `operations.test.ts`, `golive.test.ts`, `quarantine.test.ts` PASS.
- [ ] **Step 2: Rebuild the pages.**
- [ ] **Step 3: `npm test`, `npm run build`; check on the demo installation.**
- [ ] **Step 4: Commit** `feat(web): operations, go-live, feedback and security review pages`.

### Task 15: Project header, binder tabs and the Discussion / Notes / Proposals split

**Files:** Modify `views/ProjectPage.tsx`, `App.tsx` (project route accepts `discussion` and `proposals`; `#/runs/:id` renders `Review` inside the project shell with Proposals current, the project id taken from the run response), `views/Discussion.tsx`, `views/Intake.tsx`, `views/HumanProposals.tsx`; Create `views/ProjectProposals.tsx`, `ui/projectTabs.ts`, `ui/projectTabs.test.ts`

**Interfaces:**
- `projectTabs(ctx: { roles: string[], isAdmin: boolean, contentAllowed: boolean, inspectDeleted: boolean, status: ProjectStatus, closingNeeded: boolean, deadlineReview: boolean, mayViewAi: boolean, waiting: number, overdue: number }): { key: string, text: string, badge?: { count: number, meaning: Meaning } }[]` giving spec §6.3's order and exactly today's visibility for each existing section; `tabForHash(tab: string | undefined): string` maps the old `notes` address to `notes`, the run page to `proposals`.
- `ProjectProposals({ projectId })`: table of the project's extraction runs from Task 7's `GET /projects/:projectId/proposals` (Source and version, Finished, Waiting of total, link to `#/runs/:id`; runs with nothing waiting shown below under "Reviewed"), then the human proposals list (existing `HumanProposals`).
- Project header: name, `StatusLabel` of the state, owning and participating departments, Project Manager, the existing warnings (On Hold member, missing roles, escalation flags) always shown, "Ask about this project" and "Add notes" actions where permitted.

- [ ] **Step 1: Tests** `projectTabs.test.ts`: for a Member with content access, the tabs and order of spec §6.3 without Settings-only or AI tabs they cannot see today; for a summary-only viewer, no content tabs (same as today's `contentAllowed` rule); Closing appears only when `closingNeeded`; badge on Proposals when `waiting > 0`; `tabForHash('notes') === 'notes'`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Compare against today's `tabs` array in `ProjectPage.tsx` to confirm no section lost its condition.
- [ ] **Step 4: `npm test`, `npm run build`; on the demo installation open each tab for a PM (load-001) and a Member (load-050) and an old `#/projects/<id>/notes` link.**
- [ ] **Step 5: Commit** `feat(web): project header, binder tabs, discussion/notes/proposals tabs`.

### Task 16: Project overview, Work and Timeline tabs

**Files:** Modify `views/ProjectPage.tsx` (Overview), `views/ProjectFigures.tsx`, `views/Work.tsx`, `views/Timeline.tsx`, `views/ChangeForms.tsx`, `views/ChangeRequest.tsx`, `views/AuthoriseForm.tsx`

**Interfaces:** Overview per spec §7.5 (left `AttentionQueue` filtered to this project from `/dashboard/me`; right `StageFlow`, `StackedBar` of task statuses, "Due in the next 14 days" `DataTable`, then today's figures and resources/finance summary in boxes). Work: tasks, decisions, questions, risks as `DataTable`s with state labels; forms in boxes. Timeline: keeps its chart and its list as a table.

- [ ] **Step 1: Baseline** `records.test.ts`, `changes.test.ts`, `dashboard.test.ts`, `due.test.ts` PASS.
- [ ] **Step 2: Rebuild.**
- [ ] **Step 3: `npm test`, `npm run build`; on the demo installation: start, block, complete and reopen one task as the PM, and authorise one proposal; the 2b change-request forms still open.**
- [ ] **Step 4: Commit** `feat(web): project overview, work and timeline on boxes and tables`.

### Task 17: The remaining project tabs

**Files:** Modify `views/People.tsx` (project people), `views/ProjectAccessPanels.tsx`, `views/Resources.tsx`, `views/ResourcesReport.tsx`, `views/Finance.tsx`, `views/ResourceLineForm.tsx`, `views/ProjectOutputs.tsx`, `views/OutputPage.tsx`, `views/ProjectOutputSettings.tsx`, `views/ProjectFinanceSettings.tsx`, `views/ProjectCalendar.tsx`, `views/AnalysisSettings.tsx`, `views/ProjectAi.tsx`, `views/Drafts.tsx`, `views/DraftView.tsx`, `views/AssistReview.tsx`, `views/Feedback.tsx`, `views/Closing.tsx`, `views/DeadlineReview.tsx`, `views/DeletedItems.tsx`, `views/DeleteRestore.tsx`

**Interfaces:** Each tab: tables for lists, boxes for forms and figures, `StatusLabel` for every state shown; project Settings tab uses `SettingsPage` (glance: effective values with inheritance; settings: the delegated forms). Finance keeps Not Required / Not Provided / explicit zero distinct.

- [ ] **Step 1: Baseline** `finance.test.ts`, `resources.test.ts`, `resourceScreens.test.ts`, `outputs.test.ts`, `assist.test.ts`, `history.test.ts` PASS.
- [ ] **Step 2: Rebuild.**
- [ ] **Step 3: `npm test`, `npm run build`; open each tab on the demo installation as the PM.**
- [ ] **Step 4: Commit** `feat(web): people, resources, outputs, settings and other project tabs`.

### Task 18: Review screen with correction and change history (web)

**Files:** Modify `views/Review.tsx`, `views/PreviewList.tsx`; Create `ui/corrections.ts`, `ui/corrections.test.ts`

**Interfaces:**
- Consumes Task 5's `corrections` and `original` fields and the `kind`/`reason` edit body.
- `correctionLine(c: Correction): string` ("24 Nov 2026 10:12 · Daniel Tan (Project Manager) changed type Task → Decision, wording, owner") and `originalLine(o): string` ("21 Nov 2026 16:40 · AI (gpt-6.1-sol) proposed: Task, "…", owner not stated, due 5 Dec 2026"); dates UTC+8; kind words Task/Decision/Question/Risk (`action` → "Task").
- `needsReason(from: Kind, to: Kind): boolean`.
- Layout per spec §7.7: two columns ≥ 900 px (proposals left, source right with the quote marked), linked source view with a return link below; each proposal keeps dashed outline, "AI proposed", type label and "n of N"; "Correct…" opens the panel (Type select, Wording, Owner, Due with the existing due forms, Reason, required when the type changes); a warning line before saving when the item is approved or has approvals ("Saving sends this proposal back to review and sets aside 1 approval."); after saving, the "✎ Changed by a person" label and the Change history (corrections newest first, then the original).

- [ ] **Step 1: Tests** `corrections.test.ts`: both lines for a type change with reason, a wording-only change, a null role, the model unknown ("AI proposed"); `needsReason('action','decision') === true`, `('action','action') === false`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `npm test`, `npm run build`; on the demo installation as an Owner: correct one proposal Task → Decision with a reason, see the history, authorise it, find the decision on the Work tab.**
- [ ] **Step 5: Commit** `feat(web): correct proposals in place with change history (D130)`.

### Task 19: The remaining screens

**Files:** Modify `App.tsx` (`SignIn`), `views/Onboarding.tsx`, `views/Setup.tsx`, `views/Invitation.tsx`, `views/NoteDetail.tsx`, `views/Thread.tsx`, `views/Meeting.tsx`, `views/MinutesPanel.tsx`, `views/AskPanel.tsx`, `views/AiAnswer.tsx`, `views/SummaryView.tsx`, `views/Search.tsx`, `views/Notifications.tsx`, `views/NotificationSettings.tsx` (personal part), `views/Leadership.tsx`, `views/Analytics.tsx`, `views/analytics/*`, `views/Definitions.tsx`, `views/AiUsage.tsx`, `views/ResourceCatalogue.tsx`, `views/DeletedItems.tsx` (item page), `views/OpsBanner.tsx`, `views/Letterhead.tsx`

**Interfaces:** Sign-in, setup link and invitations stay outside the shell and use the installation default scheme from branding (`colour`, Task 3). Discussion keeps human messages, AI answers, drafts and proposals visibly different. Analytics charts keep their tables of values.

- [ ] **Step 1: Baseline** all web tests PASS.
- [ ] **Step 2: Rebuild.**
- [ ] **Step 3: `npm test`, `npm run build`; walk each screen on the demo installation.**
- [ ] **Step 4: Commit** `feat(web): remaining screens on the new layout`.

### Task 20: Accessibility pass, browser smoke, walkthrough and documents

**Files:** Modify `tests/a11y/audit.mjs`, `tests/a11y/README.md`, `tests/browsers/smoke.mjs`, `tests/browsers/README.md`, `docs/Kainow-V1.0-Consolidated-Product-Specification-and-Decision-Register.md` (D127–D130 rows from spec §12), `docs/Kainow-V1.0-Configuration-Catalogue.md` (C111, C112), `docs/Kainow-V1.0-Remaining-Design-and-Verification-Register.md` (R18 row: designed in 11a; the Presentation row: 375 px header overflow fixed), `app/README.md`, `CHANGELOG.md` (`## Unreleased`)

- [ ] **Step 1: Demo installation for checks**: database `kainow_demo_sp11` on `kainow-testdb`, migrate, `npm run load-test -- --seed`, API on port 3410 with `LOG_SIGN_IN_CODES=true` (as in `docs/operations/load-test.md` steps 1–4). Rename one seeded project to a 120-character dummy name for the overflow check.
- [ ] **Step 2: Extend `audit.mjs`** with: Settings hub; each of the 17 setting pages; My tasks; Reviews; the person menu open; the side menu collapsed and opened at 375 px; a project's binder tabs; Discussion, Notes and Proposals tabs; the review screen with the correction panel open and a Change history; the organisation colour form with a refused colour; each of Red, Teal and Dark on Home. Each state at 1200 px and 375 px. Assert `document.documentElement.scrollWidth <= innerWidth` at 375 px on every state (**Review Focus 3**).
- [ ] **Step 3: Run the audit; expect 0 violations.** Fix any violation in the owning view, re-run until clean; record the state count and date in `tests/a11y/README.md`.
- [ ] **Step 4: Update `smoke.mjs`** for the new navigation (side menu, person menu sign-out) and run it in Chrome, Edge, Firefox and WebKit at desktop, tablet and phone sizes; record results in `tests/browsers/results/` as before.
- [ ] **Step 5: Screenshots** of Home, Projects, a project Overview, the review screen with a correction, Settings hub, the AI page and the Administrators page, in Red, Teal and Dark at 1280 px and in Red at 375 px, saved under `docs/superpowers/screenshots/11a/` (dummy data only) for the PR.
- [ ] **Step 6: Documents**: add D127–D130, C111–C112 and the register updates with today's date; `CHANGELOG.md` Unreleased entry for the redesign.
- [ ] **Step 7: Full suites**: web `npm test` and `npm run build`; the full server suite in the background (about 40 minutes); expect all PASS.
- [ ] **Step 8: Commit** `docs: 11a decisions, catalogue and checks; accessibility and browser runs`.
