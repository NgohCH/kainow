# V1.0 sub-project 8: shared resources and optional budget — design

**Date:** 20 November 2026
**Status:** Draft for Product Owner approval. Scope, the overlap warning, project-wide spending, the three report forms and approach A were agreed in conversation on 20 November 2026.
**Builds on:** `main` at 3df1dc1 (sub-projects 1–7 merged). Branch `TheLord/subproject-8-resources-budget-bb7e1a`. Next migration: `0030_resources_finance.sql`. Reserved numbers: D91–D99, C76–C84. Sub-project 9 (external outputs) is built at the same time and edits the same shared documents.
**Authority:**
- Intent Card: "Included in V1.0" (shared people/equipment/facility usage indicators, optional budget/expenditure tracking, separate AI spend) and "Outside V1.0" (resource booking/allocation, full accounting).
- Product Summary §6 (O14: financial adjustment, leadership summaries), §11, §12, §18 (Q01, Q06).
- Consolidated Specification §10, §11, §13, D33–D35, D49, D51–D54, D61, D63, O05, O06, O14, O15, Q01, Q06.
- Shared Resources and Optional Budget Tracking Rules (all sections).
- Permission Matrix §5 (resources and money rows).
- Configuration Catalogue C22, C51–C55, C60.
- Dashboards rules §2 and §4 ("Not provided"); Administrator Analytics rules (resources/finance row, currency grouping); UI rules §3 (Resources capability).
- Core Records rules (resource usage fields, Financial Tracking).
- Remaining Design and Verification Register R14 (resource/unit/currency catalogues) and R16 (optional finance); the open part of R17 (resource and finance figures).
- The sub-project 7 design (`2026-11-18-v1-dashboards-design.md` §6.3 and §7.2), which leaves places for this work.
- The new decisions D91–D94 below.

## 1. Purpose and the why

The Product Owner wants a PM and a leader to find out, for each project: **which resources it needs and their status, whether the same shared item is also recorded by other projects in the same period, what is due and when, the money position, and a general resources report.**

Today Kainow records people and their work but nothing about equipment, facilities or money. Sub-project 8 adds:

1. **An organisation resource catalogue** of shared equipment and facilities.
2. **Resource lines** on a new project **Resources** tab: what the project needs, how much, for when, needed by when, and its status from Needed to Finished.
3. **An overlap warning**: a shared item recorded by other projects for an overlapping period is flagged. This is information, never a booking.
4. **People**: each participant's roles and open assigned tasks, with no free or busy figure.
5. **Optional finance**: Financial Tracking (default Not Required), one reporting currency, an Owner/Sponsor-approved budget, recorded spending, approved corrections, refunds and currency conversions, a balance "based on recorded expenditure" and advisory 80% / 100% warnings.
6. **Reports**: a project resources report with CSV download, resource and finance fields in the leadership summary, and a resources and finance panel in Administrator analytics.

### Goals

- A usage line or a spending entry never claims a booking, an allocation, a payment or an accounting balance. The wording says so where it could be misread.
- Missing is never zero. "Not provided" (tracking on, value missing), "Not required" (tracking off) and an explicit 0 stay distinct everywhere, including CSV.
- No figure mixes currencies or adds AI spending into project expenditure.
- Every change keeps actor, time and, where it changes meaning, a reason. Originals are never overwritten.
- Each view shows only what its viewer may see. Financial detail stays with PM, Deputy, Owner and Sponsor unless the project's policy widens it.

### Non-goals (8)

- Booking, reserving or allocating resources; capacity or quantity owned per item; utilisation percentages; conflict resolution.
- Any free/busy or workload figure for people.
- Spending linked to individual resource lines, per-line or per-category budgets (the Product Owner chose project-wide spending, 20 November 2026).
- Bank, purchasing, payment or accounting integration; automatic exchange rates.
- DOCX/PDF report generation and filing reports in external storage (sub-project 9).
- AI spending views (sub-project 6 built them; this work links to them).
- Reminders or emails for "needed by" dates. The dashboard flags passed dates; no new notification schedule.

### Anti-goals (failure even if it works)

- An overlap warning that names a project, or shows any detail (quantity, notes, status) of a line in a project, that the viewer cannot already see.
- A balance shown when the budget is missing, or computed across currencies, or including an unconverted foreign entry.
- A Member, an Audit/Oversight holder or a leadership grant holder seeing spending entries without explicit project policy.
- A correction, refund or conversion changing totals before an Owner or Sponsor approves it.
- Turning Financial Tracking off losing or altering any entry.
- A warning colour or "healthy" state standing in for missing figures.

## 2. Decisions taken with the Product Owner

| Topic | Decision (20 November 2026) |
|---|---|
| What the area answers | Resources required and their status, availability, utilisation, due dates, financials and a general resources report. |
| Availability | **A: overlap warning** (D91). Not B (no availability) and not C (Administrator-set quantities and utilisation %, which is allocation and outside V1.0). |
| Utilisation | Shown as recorded use (quantity, unit and period per line, and counts), never as a percentage of capacity. |
| People | Roles and open assigned work only; no free/busy. |
| Spending | One project-wide list, not linked to resource lines. |
| Report | Project report with CSV; leadership summary fields; Administrator analytics panel. |
| Approach | A: reuse the existing approval process (`change_requests`) for budgets, corrections, refunds and conversions; new tables for catalogue, lines and spending; delegated settings in the sub-project 6 pattern; every figure worked out live, as in sub-project 7. Not B (a separate finance approval flow: duplicated approver rules that drift) and not C (splitting into 8a and 8b: two shared-document merges with sub-project 9 for little saving). |

### 2.1 New Decision Register entries

| ID | Decision |
|---|---|
| D91 | **Resource lines and the overlap warning** (20 November 2026). A project records each resource it needs as a resource line: a catalogue item or a one-off description; optional quantity with a unit (missing is Not provided, never zero); optional period; optional needed-by date; notes; and a status Needed, Arranged (outside Kainow), In use, Finished or Cancelled. A PM, Deputy, Owner or Sponsor maintains lines; every participant reads them. When a catalogue item's line has a period, Kainow shows how many other projects' lines of the same item have an overlapping period, naming only projects the viewer can already open and counting the rest. The warning reads "Also recorded by n other project(s) in this period — this is not a booking". It never shows another project's quantity, notes or status. Kainow does not hold quantities owned, availability or utilisation percentages. |
| D92 | **Recorded spending and approved adjustments** (20 November 2026). With Financial Tracking Enabled, a PM or Deputy records spending (date, amount, currency, description, optional reference); an entry in the reporting currency counts at once. An entry in another currency is kept and excluded from totals until a conversion (rate, rate date and converted amount) is approved. Corrections (a replacement amount, which may be zero) and refunds (an amount returned against a recorded entry) are proposed by a PM or Deputy and approved by an Owner or Sponsor under the project's approval policy before totals change; the original entry is never altered. A refund must reference a recorded entry. The budget is proposed by a PM, Deputy, Owner or Sponsor and approved by an Owner or Sponsor; until approved it reads Not provided. |
| D93 | **Budget warnings** (20 November 2026). Two advisory thresholds, default 80% and 100% of the approved budget, each a whole percentage 1–200, the first below the second. The organisation sets defaults; a project may set its own where delegated. When recorded expenditure first reaches a threshold, the PM, Deputies, Owner and Sponsors receive one in-app notice; falling below and rising again notifies again. Warnings never block work and never authorise spending. *(Bounds proposed by this design; Product Owner approval requested.)* |
| D94 | **Finance settings and delegation** (20 November 2026). The Enterprise Administrator chooses whether projects may manage their own finance settings (default: allowed, as Q01 lists optional finance among delegable settings), the organisation's default currency (MYR) and which supported currencies are enabled (MYR, SGD, USD at launch, two decimal places). Where allowed, a PM, Owner or Sponsor turns Financial Tracking on or off, chooses the reporting currency (fixed once any budget or spending exists), sets warning thresholds within D93, and may widen financial-detail reading to Members and/or Audit/Oversight holders. The Administrator can always change a project's finance settings. Every change needs a reason and is recorded with previous and new values. |

## 3. Concepts

### 3.1 Catalogue

- **Resource item**: kind (Equipment or Facility), reference (short code, unique among active items, e.g. "P-04"), name, category, optional description, status Active or Retired.
- **Resource category**: an Administrator-maintained controlled list (name, status Active or Retired). Seeded empty; the Administrator adds categories. *Design call:* categories are organisation-wide only; project-local categories (C22) are not built here.
- **Units** (C55): a fixed list in code: hours, days, person-hours, person-days, items, seats, square metres. No conversion between units. *Design call:* adding units needs a release; the list is in code, like the leadership field catalogue.
- **Currencies** (C52, Q06): a fixed supported list in code (MYR, SGD, USD, each 2 decimal places). The Administrator enables a subset (at least one) and picks the default from the enabled ones. Disabling a currency prevents new selection and keeps existing entries.
- Retiring an item or category keeps every past line showing it, with "(retired)", and prevents new selection. Names can be corrected (rename keeps history).
- **Catalogue maintainers**: the Administrator, plus people the Administrator names (D35 "may delegate maintenance"), recorded with a reason, removable at any time.

### 3.2 Resource lines

| Field | Rule |
|---|---|
| Item | A catalogue item (Active when chosen) or, for a one-off, a kind (Equipment, Facility or Other) and a description (1–200 characters). |
| Quantity and unit | Both or neither. Quantity > 0, up to 2 decimal places. Missing shows "Not provided". |
| Period | Start date and optional end date (end ≥ start). A line with no period shows "Period not provided" and takes part in no overlap. A start date with no end overlaps from its start onward. |
| Needed by | Optional date. |
| Notes | 0–2,000 characters. |
| Status | Needed, Arranged, In use, Finished, Cancelled. |

- Status moves freely among Needed, Arranged, In use and Finished in either direction (a correction is a status change, recorded). Cancelled needs a reason and is final; renewed need is a new line.
- Every create, edit and status change writes `resource_line_events` with the previous and new values. Edits of quantity, unit, period or item need no reason; Cancel does.
- **Needed-by passed**: a line still Needed whose needed-by date is before today (UTC+8). Shown with a flag on the line, counted on the project dashboard, the leadership field and the analytics panel, and listed in the PM's and Deputies' "Needs you" ("Resources past needed-by date: n").
- Text fields (description, notes, cancel reason) go through the credential check at entry (D75/D79 wording); a suspected secret is refused.
- No deletion. A mistaken line is Cancelled with a reason. Lines are not AI material and are not sent to AI.

### 3.3 Overlap (D91)

- Two lines overlap when they name the same catalogue item, neither is Cancelled, both have a start date, and their date ranges intersect (inclusive; an open end runs forever).
- Lines in any project status count (a Closed project's recorded use is still recorded use). Finished lines count. One-off lines never overlap.
- For each line, the server returns `overlap: { named: [{projectId, name}], others: n }` where `named` lists the other projects the viewer can open (`ProjectAccess.context` succeeds: participant, grant holder or Administrator) and `others` counts the rest. Each project counts once however many lines it has.
- The Resources tab shows the warning on the line; the catalogue page (for maintainers) shows, per item, the number of projects with current or future lines, without names it cannot otherwise show.
- Wording: "Also recorded by 2 other projects in this period: Project Alpha and 1 project you can't see. This is not a booking. Arrange use with the resource's owner outside Kainow."

### 3.4 People

- A section listing each current participant (Active memberships), their project roles, department, and the count of their open assigned tasks (Not Started, In Progress, Blocked; live and unheld; leaf and parent tasks alike), with overdue among them. Each name links to the Work tab filtered to that person where that filter exists; otherwise to the Work tab.
- No availability, capacity, workload score or cross-project figures.

### 3.5 Finance

- **Financial Tracking**: Not Required (default) or Enabled. Enabling needs a reporting currency (default the organisation default). Not Required hides the finance sections, and excludes the project from "budget not provided" counts.
- **Budget**: a series of approved versions. Current budget = the latest approved version. Explicit 0 is allowed and shown as 0.00. None approved = "Not provided".
- **Spending entry**: spent on (date), amount (> 0, currency precision), currency (an enabled currency), description (1–500), optional reference (0–100, e.g. invoice number), recorded by/at. Immutable once recorded.
- **Adjustments** (approved through `change_requests`, kind `finance_adjustment`, target the spending entry):
  - Correction: a replacement counted amount (≥ 0) with a reason. A correction to 0 voids the entry.
  - Refund: an amount (> 0, not above the entry's current counted amount) with a reason and a date.
  - Conversion (foreign entries only): rate, rate date and converted amount in the reporting currency. Kainow shows amount × rate beside the converted amount for checking but stores what the person enters.
  - One pending adjustment per entry at a time (the existing one-open index).
- **Counted amount** of an entry: for a reporting-currency entry, its amount, replaced by its latest approved correction, minus approved refunds after that correction; for a foreign entry, nothing until a conversion is approved, then the converted amount, adjusted the same way afterwards (a correction to a converted entry is in the reporting currency).
- **Figures**: Spent = sum of counted amounts. Balance = Budget − Spent, labelled "Balance based on recorded expenditure", shown only when a budget is approved. Percentage used = Spent ÷ Budget, shown only when Budget > 0. With Budget = 0 and Spent > 0 the warning shows "Over budget" with no percentage. Foreign entries awaiting conversion are listed as "Not in totals" with their own currency. Every total carries "Based on recorded entries".
- **Warning level**: none, first threshold, second threshold (D93). In-app notices on crossing go to the PM, Deputies, Owner and Sponsors, but only to those who may read financial detail (all four do by default). `project_finance_state.notified_level` stops repeats; a fall below resets it.
- **AI spending** for the current month (sub-project 6 confirmed + reserved, its own labels) is shown beside the finance section, separately titled, to people who may view project AI usage (`ai.usage.view`), with a link to the AI usage view. Never added in.
- **Turning tracking off**: hides the finance sections; a "Finance history" link remains for financial-detail readers, labelled "Financial tracking is not required for this project. Earlier entries are kept here for reference." Pending adjustments and a pending budget stay pending; they cannot be approved while tracking is off (the approve refusal says so) and can be withdrawn.
- Locked while Deferred or Closed (the matrix `OPEN` states): no settings, entries, budgets or adjustments, submitted or approved. Pending ones remain pending.

### 3.6 Finance approvals in the existing process (design calls)

- **Approval rules.** `set_budget` and `finance_adjustment` follow the project's effective approval count (1–3, `PolicyService.effectiveFor`), distinct approvers, the D03 missing-role block and today's self-approval rule (an Owner or Sponsor submitting a budget counts as its first approval). The submitter may revise or withdraw, as today; the PM may withdraw. This is the "budget approval requirements" setting of the rules §10, through the existing policy.
- **Tracking check.** `kindAllowedIn` keeps checking project status only (Draft, Planned, Active for both phases). The handlers' `mayPropose` and `readyToApprove` add "Financial Tracking is Enabled" and, for adjustments, the kind rules in §3.5, so `approvalBlocked` refuses with "Financial tracking is not required for this project, so finance changes cannot be approved."
- **Who sees finance requests.** Finance change requests are financial detail. Every surface that shows change requests filters `set_budget` and `finance_adjustment` to people with `finance.view` on that project: the change-request list (`listedRequestSql` / `views()`), the Reviews list, the personal dashboard's pending-approvals item, submit/approve/reject notices (recipients filtered at send time), project activity and history views. Others see neither the request nor a count of it. Leak tests cover each surface.
- **Foreign entries.** Before conversion only a conversion may be proposed. A later conversion may replace an earlier one (to fix a rate). The counted amount applies approved adjustments in approval order: a conversion or a correction sets the counted amount, a refund subtracts from it. So a re-conversion replaces corrections approved before it, and the entry's adjustment list shows this ("replaced by conversion of 12 Dec").
- **Warning checks.** The warning level is worked out live for every view. Notices are decided after each project-level change that can move it: spending recorded, an adjustment or budget approved, project thresholds changed, tracking turned on. `notified_level` is then set to the current level (notifying only when it rises). An organisation default change sends no notices; the next project-level change evaluates against it.

### 3.7 The Administrator (design calls)

Administrator standing is not finance access (O14). A non-participant Administrator:
- may open and change a project's finance **settings** (`GET/PUT /projects/:id/settings/finance`, D94), through an explicit Administrator path in the finance settings service as `ai/limits.service.ts` does, not by widening `ProjectAccess.authorize`;
- sees in the turn-off preview only counts (entries, budget versions, pending approvals), never amounts;
- does not see budget, spending or adjustments, and is not a finance approver;
- sees the summary figures in Administrator analytics (§7), as for other measures.
An Administrator who is also a PM, Deputy, Owner or Sponsor reads finance through that role.

## 4. Project Resources tab

A new tab "Resources" for everyone with `project.view` (participants and grant holders). Sections, in order:

```
Resources                                         [+ Add resource]
Needed (2) · Arranged (1) · In use (3) · Finished (5) · Cancelled (1)
───────────────────────────────────────────────────────────────────
Projector P-04 (Equipment · AV)  2 items  3–14 Dec 2026  needed by 1 Dec   Needed  ⚑ past needed-by
  ⚠ Also recorded by 2 other projects in this period: Project Alpha and 1 project you can't see.
    This is not a booking.
Meeting room B (Facility)        Not provided  Period not provided          In use
Survey drone (one-off, Other)    1 items  from 5 Jan 2027                   Arranged
───────────────────────────────────────────────────────────────────
People
  Aisha Rahman   PM, Owner     Operations   4 open tasks (1 overdue)
  Ben Tan        Member        Finance      7 open tasks
───────────────────────────────────────────────────────────────────
Finance (MYR)                                       Updated 10:42 UTC+8
  Budget   120,000.00   approved 3 Nov 2026 by Owner   [Propose change]
  Spent     98,400.00   82% of budget   ⚠ Reached 80% warning (advisory)
  Balance based on recorded expenditure: 21,600.00
  Not in totals: USD 1,250.00 awaiting conversion
  Awaiting approval: 1 correction
  [+ Record spending]   [Spending list]   Based on recorded entries.
  AI spending this month (separate, not included): MYR 312.40 →
───────────────────────────────────────────────────────────────────
Report  [View report]  [Download CSV]
```

- Lines filter by status (default: all except Cancelled and Finished; "Show finished and cancelled"). Sorted by needed-by date (no date last), then start date, then reference/description, then created time (a stable order; never by id alone).
- Add/edit opens an inline form. Item picker searches active catalogue items by reference and name.
- Line detail shows its history (events, actor, time, previous → new).
- The Finance section shows only to financial-detail readers and only when tracking is Enabled; otherwise it shows "Financial tracking: Not required" to everyone (or nothing to non-readers when Enabled, except the line "Financial tracking is on; figures are visible to the project's finance readers").
- **Spending list**: entries in date order (spent on, then recorded at), each with counted amount, adjustments, pending adjustment and actions (Propose correction / refund / conversion for PM/Deputy). Owner/Sponsor approve or reject in the existing Reviews flow and from the entry.
- **Report** (`#/projects/:id/resources/report`): a printable page: header (project, owning department, generated at UTC+8, "Usage records, not bookings"), lines by status with periods, quantities and overlap counts (named projects only as the viewer can see), needed-by passed, people summary, and finance (readers only) with all labels. CSV download has one section per table with `#` header lines (as sub-project 7's export), formula-injection escaping, "Not provided" and "Not required" written as words, amounts with their currency. Download is recorded as `resources.report_exported` (project, sections; no data).
- Deferred/Closed: everything read-only; buttons hidden with the standard "not while Deferred or Closed" explanation.

## 5. Project dashboard, timeline and Needs you

- **Overview** (`GET /projects/:id/dashboard`) gains `resources: { byStatus, neededByPassed, overlapping }` for everyone with `project.view`, and `finance` only for financial-detail readers: `{ tracking, currency, budget | 'not_provided', spent, percentUsed | null, warning, pendingAdjustments, notInTotals[] }`. Non-readers get `finance: { tracking }` only.
- **Timeline** adds a line kind `resource_needed_by` ("Needed by: Projector P-04"), one per line with a needed-by date that is not Cancelled, shown in the range; a hideable line kind in the existing timeline preferences. Line periods are not drawn as bars (no Gantt).
- **Needs you** (personal dashboard): for PM and Deputies, "Resources past needed-by date: n" per project; for Owner/Sponsor, budget and adjustment approvals appear through the existing pending-approvals item.

## 6. Leadership summary fields (C60)

Added to `LEADERSHIP_FIELDS` (hideable, rearrangeable, on by default):

- `resources` "Resources": counts by status (Needed, Arranged, In use) and needed-by passed. No item names, notes or overlaps.
- `budget` "Budget": "Not required", or currency, approved budget (or "Not provided"), spent, percentage used and warning level, labelled "Based on recorded entries". No entries, suppliers or references.

These are permitted summaries (O14, Shared Resources §12); a leadership grant gives no financial-detail access and no Resources tab.

## 7. Administrator analytics: Resources and finance panel

`panel=resources` in `GET /admin/analytics`, using the shared filters (department, status, ownership, include archived; the period applies to "lines ending in the period" only).

1. **Resource lines**: organisation, department and project rows: Needed, Arranged, In use, Finished in the period, needed-by passed, lines with overlaps.
2. **Shared items in overlap**: per catalogue item, the number of projects with overlapping current or future lines and the earliest overlapping date. Project names follow §7.3 of sub-project 7 (Administrators see project names in analytics already); line detail only where the Administrator is a participant.
3. **Finance, grouped by currency**: per currency: projects tracking, projects with budget Not provided, total approved budget, total spent, projects at or above each warning threshold; then per project the same summary figures. Never entries. Projects with tracking Not required are counted separately as "Not required", never as zero.
4. A link to the AI usage view, titled "AI spending is separate".

Drill-down and CSV export follow sub-project 7 (§7.3, §7.6), with this panel's columns.

## 8. Settings

### 8.1 System Settings › Resources and finance (Enterprise Administrator)

- **Catalogue**: items (add, edit, rename, retire), categories (add, rename, retire), filter by kind, category and status. Also open to named catalogue maintainers (menu item "Resource catalogue").
- **Catalogue maintainers**: add/remove a person with a reason.
- **Finance**: projects may manage finance settings (on/off, default on); default currency; enabled currencies; default warning thresholds (80, 100). Changes need a reason; history shown (`resource_settings_changes`).

### 8.2 Project Settings › Finance

Shown to PM, Owner, Sponsor (editable when delegated or when the viewer is the Administrator) and read-only to Deputies:

- Financial Tracking (Not Required / Enabled), reporting currency, warning thresholds (inherit or own), financial-detail readers (PM, Deputy, Owner, Sponsor always; plus "Members" and/or "Audit/Oversight holders").
- Each setting shows effective value, whether inherited, and who may change it (Q01). Reason required. History list. Turning tracking off shows a preview: "Finance sections will be hidden. n entries, the budget and n pending approvals are kept. Finance readers can still open Finance history."
- Currency cannot change once any budget version or spending entry exists ("The reporting currency is fixed once figures exist").

## 9. Permissions (additions)

Project matrix (`src/projects/matrix.ts`):

| Action | Roles | States | Notes |
|---|---|---|---|
| `resource.view` | participant (and grant holders) | ALL | Lines, people, overlap |
| `resource.edit` | pm, deputy_pm, owner, sponsor | OPEN | Create, edit, status, cancel |
| `finance.view` | pm, deputy_pm, owner, sponsor; plus member and/or grant holders by project policy | ALL | Detail, spending list, history view, report finance section |
| `finance.record` | pm, deputy_pm | OPEN, tracking Enabled | Spending entries |
| `finance.propose` | pm, deputy_pm (adjustments); pm, deputy_pm, owner, sponsor (budget) | OPEN, tracking Enabled | Through `change_requests` |
| approve budget / adjustment | owner, sponsor (existing approval rules: count, distinct people, D03 block, self-approval as today) | OPEN, tracking Enabled | `kindAllowedIn` for the two new kinds |
| `finance.settings` | pm, owner, sponsor when delegated; Administrator always | OPEN | Reason |

Organisation actions (`src/auth/permissions.ts`): `resources.catalogue.manage` (Enterprise Administrator; catalogue maintainers hold it through the delegates table, checked in the service), `resources.settings.manage` (Enterprise Administrator).

Grant holders' read set (`GRANT_ACTIONS`) gains `resource.view`; `finance.view` for them only when the project policy includes Audit/Oversight holders. Leadership grants gain nothing beyond §6.

## 10. Data model (migration `0030_resources_finance.sql`)

```sql
CREATE TABLE resource_categories (id uuid PRIMARY KEY, name text NOT NULL CHECK (btrim(name) <> ''),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')), created_by uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL,
  updated_by uuid REFERENCES users, updated_at timestamptz);
CREATE UNIQUE INDEX ON resource_categories (lower(name)) WHERE status = 'active';

CREATE TABLE resource_items (id uuid PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('equipment','facility')),
  reference text NOT NULL, name text NOT NULL, category_id uuid REFERENCES resource_categories, description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')), created_by uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL,
  updated_by uuid REFERENCES users, updated_at timestamptz);
CREATE UNIQUE INDEX ON resource_items (lower(reference)) WHERE status = 'active';

CREATE TABLE resource_catalogue_events (id uuid PRIMARY KEY, subject_kind text NOT NULL CHECK (subject_kind IN ('item','category','maintainer')),
  subject_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('added','edited','renamed','retired','maintainer_added','maintainer_removed')),
  actor_id uuid NOT NULL REFERENCES users, at timestamptz NOT NULL, reason text, detail jsonb NOT NULL DEFAULT '{}');   -- append-only

CREATE TABLE resource_catalogue_maintainers (user_id uuid PRIMARY KEY REFERENCES users, added_by uuid NOT NULL REFERENCES users,
  added_at timestamptz NOT NULL, reason text NOT NULL CHECK (btrim(reason) <> ''));

CREATE TABLE resource_lines (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects,
  item_id uuid REFERENCES resource_items, one_off_kind text CHECK (one_off_kind IN ('equipment','facility','other')), description text NOT NULL DEFAULT '',
  quantity numeric(14,2) CHECK (quantity > 0), unit text CHECK (unit IN ('hours','days','person_hours','person_days','items','seats','square_metres')),
  starts_on date, ends_on date, needed_by date, notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'needed' CHECK (status IN ('needed','arranged','in_use','finished','cancelled')),
  created_by uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  CHECK ((item_id IS NULL) <> (one_off_kind IS NULL)),
  CHECK ((quantity IS NULL) = (unit IS NULL)),
  CHECK (ends_on IS NULL OR (starts_on IS NOT NULL AND ends_on >= starts_on)));
CREATE INDEX ON resource_lines (project_id, status);
CREATE INDEX ON resource_lines (item_id, starts_on) WHERE item_id IS NOT NULL AND status <> 'cancelled';

CREATE TABLE resource_line_events (id uuid PRIMARY KEY, line_id uuid NOT NULL REFERENCES resource_lines,
  kind text NOT NULL CHECK (kind IN ('created','edited','status_changed','cancelled')),
  actor_id uuid NOT NULL REFERENCES users, at timestamptz NOT NULL, reason text, detail jsonb NOT NULL);           -- append-only

CREATE TABLE resource_settings (id boolean PRIMARY KEY DEFAULT true CHECK (id),
  projects_may_manage_finance boolean NOT NULL DEFAULT true,
  default_currency text NOT NULL DEFAULT 'MYR', enabled_currencies text[] NOT NULL DEFAULT '{MYR,SGD,USD}',
  warn_first_pct int NOT NULL DEFAULT 80, warn_second_pct int NOT NULL DEFAULT 100,
  CHECK (warn_first_pct BETWEEN 1 AND 200 AND warn_second_pct BETWEEN 1 AND 200 AND warn_first_pct < warn_second_pct),
  CHECK (default_currency = ANY (enabled_currencies)));
INSERT INTO resource_settings DEFAULT VALUES;
CREATE TABLE resource_settings_changes (id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users, at timestamptz NOT NULL,
  reason text NOT NULL, previous jsonb NOT NULL, next jsonb NOT NULL);                                              -- append-only

CREATE TABLE project_finance_settings (project_id uuid PRIMARY KEY REFERENCES projects,
  tracking text NOT NULL DEFAULT 'not_required' CHECK (tracking IN ('not_required','enabled')),
  currency text, warn_first_pct int, warn_second_pct int,             -- NULL thresholds = inherit
  members_read boolean NOT NULL DEFAULT false, grants_read boolean NOT NULL DEFAULT false,
  CHECK (tracking = 'not_required' OR currency IS NOT NULL),
  CHECK ((warn_first_pct IS NULL) = (warn_second_pct IS NULL)), CHECK (warn_first_pct IS NULL OR (warn_first_pct BETWEEN 1 AND 200 AND warn_second_pct BETWEEN 1 AND 200 AND warn_first_pct < warn_second_pct)));
CREATE TABLE project_finance_changes (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects, actor_id uuid NOT NULL REFERENCES users,
  at timestamptz NOT NULL, reason text NOT NULL CHECK (btrim(reason) <> ''), previous jsonb NOT NULL, next jsonb NOT NULL);   -- append-only
CREATE TABLE project_finance_state (project_id uuid PRIMARY KEY REFERENCES projects, notified_level smallint NOT NULL DEFAULT 0 CHECK (notified_level BETWEEN 0 AND 2));

CREATE TABLE budget_versions (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects, amount numeric(16,2) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL, change_request_id uuid NOT NULL REFERENCES change_requests, approved_at timestamptz NOT NULL);  -- append-only

CREATE TABLE expenditures (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects, spent_on date NOT NULL,
  amount numeric(16,2) NOT NULL CHECK (amount > 0), currency text NOT NULL, description text NOT NULL CHECK (btrim(description) <> ''),
  reference text NOT NULL DEFAULT '', recorded_by uuid NOT NULL REFERENCES users, recorded_at timestamptz NOT NULL);            -- append-only
CREATE INDEX ON expenditures (project_id, spent_on, recorded_at);

CREATE TABLE expenditure_adjustments (id uuid PRIMARY KEY, expenditure_id uuid NOT NULL REFERENCES expenditures,
  kind text NOT NULL CHECK (kind IN ('correction','refund','conversion')), amount numeric(16,2) NOT NULL CHECK (amount >= 0),
  rate numeric(18,8), rate_on date, refund_on date, reason text NOT NULL, change_request_id uuid NOT NULL REFERENCES change_requests,
  approved_at timestamptz NOT NULL);                                                                                            -- append-only
```

- `change_requests` CHECKs widen: `kind` adds `set_budget` and `finance_adjustment`; `target_kind` adds `project_budget` (target id = project id) and `expenditure`.
- `resource_settings_changes`, `project_finance_changes`, `resource_line_events` and `resource_catalogue_events` get catalogue entries (§12) and append-only triggers.
- The sketch shows intent; the builder fixes exact names, indexes and triggers in the project's style. The bench decides further indexes.

## 11. Endpoints

| Route | Who | Does |
|---|---|---|
| `GET /resources/catalogue` (`?all=1`) | signed-in (active items for pickers); maintainers with `all` | items, categories |
| `POST /resources/catalogue/items`, `PUT …/items/:id`, `POST …/items/:id/retire` | maintainers | catalogue changes |
| `POST /resources/catalogue/categories`, `PUT …/:id`, `POST …/:id/retire` | maintainers | categories |
| `GET/POST/DELETE /admin/resources/maintainers` | EA | maintainers, reason |
| `GET/PUT /admin/resources/settings` | EA | org finance settings, history |
| `GET /projects/:id/resources` | `resource.view` | lines with overlap, people, finance (readers) |
| `POST /projects/:id/resources/lines`, `PUT …/lines/:lineId`, `POST …/lines/:lineId/status`, `POST …/lines/:lineId/cancel` | `resource.edit` | line changes |
| `GET /projects/:id/resources/lines/:lineId/history` | `resource.view` | events |
| `GET /projects/:id/finance` | `finance.view` | budget versions, entries, adjustments, pending, figures; history view when tracking is off |
| `POST /projects/:id/finance/spending` | `finance.record` | new entry |
| `POST /projects/:id/finance/budget` | `finance.propose` | `set_budget` change request (Owner/Sponsor submitting approves at once, as today) |
| `POST /projects/:id/finance/spending/:entryId/adjust` | `finance.propose` | `finance_adjustment` change request |
| approve / reject / withdraw / revise | existing change-request routes | |
| `GET/PUT /projects/:id/settings/finance` | readers of settings / `finance.settings` | project settings, history, off-preview |
| `GET /projects/:id/resources/report` (`?format=csv`) | `resource.view` (finance sections only for `finance.view`) | report data or CSV |
| `GET /admin/analytics?panel=resources` | `analytics.view` | §7 |

## 12. Events and audit

- Catalogue entries (`src/analytics/catalogue.ts`) for every new event table and `kind` value, every new `writeAudit` action (`resources.settings_changed`, `resources.report_exported`, `finance.spending_recorded`, catalogue changes), and the new change-request kinds. The completeness test must pass.
- Quarantine registry: every new text/jsonb column is either registered with a `projectSql` (project-scoped user text: line description, notes, event reasons and details, spending description and reference, adjustment reasons, project finance change reasons) so the copy sweep (D80) cleans it, or listed in `NO_USER_TEXT` with its reason (enum columns, organisation-level catalogue text and settings). Resource lines and spending entries are not themselves reportable items (`ItemKind`) in V1.0. *Design call:* text is credential-checked at entry, and the copy sweep still covers it.

## 13. Testing and measured aims

- **Overlap tests (DB):** same item, inclusive boundaries, open ends, no period, Cancelled excluded, Finished included, one project counted once, named vs counted by the viewer's access (participant, grant holder, Administrator, outsider), Closed projects included.
- **Finance arithmetic (pure):** counted amounts through correction → refund → correction chains; conversions; void by 0; refund above counted amount refused; budget 0; Not provided; percentage and warning levels at exact thresholds; no balance without budget; no mixed currency.
- **Approval tests (HTTP):** budget and each adjustment kind through submit, approve (one and two approvers, distinct people), reject, withdraw, revise; totals unchanged until approved; D03 block; refused while Deferred/Closed and while tracking is off; currency fixed once figures exist.
- **Warning notices:** one notice per crossing per eligible reader; none repeated; re-notify after falling below; none to non-readers.
- **Leak tests (mandatory, one per surface: Resources tab, report and CSV, project dashboard, timeline, leadership, analytics panel and drill-down):** non-readers get no finance figures or entries; leadership holders get no Resources tab or entries; overlap never names a project the viewer cannot open and never carries another project's quantity, notes or status; an Administrator who is not a participant sees counts only on drill-down.
- **Settings tests:** delegation on/off, Administrator always, bounds, reason, history, inherit vs own thresholds, currency enabled list, tracking off preserves everything and the history view.
- **Permission tests** for every route; **catalogue completeness**; **quarantine registry completeness**; **migration test**.
- **Web helper tests:** "Not provided" / "Not required" / explicit 0 wording, overlap wording, money formatting per currency, status filter defaults, form validation.
- **Bench (`npm run bench-resources`, own database):** sub-project 7's data plus 300 catalogue items, 5,000 resource lines (40% on catalogue items, many overlapping), 60 tracking projects with 20,000 spending entries and 1,000 adjustments. **Aims (proposed; Product Owner approval requested): `GET /projects/:id/resources` p95 < 200 ms for a project with 100 lines; `GET /projects/:id/finance` p95 < 200 ms with 1,000 entries; `GET /admin/analytics?panel=resources` p95 < 500 ms; `GET /dashboard/leadership` (organisation scope) stays < 500 ms with the new fields.** Results are recorded here, met or missed.
- Screens checked at desktop width and 375 px, by keyboard, both themes; WCAG 2.2 AA.

## 14. Left to the builder, and open items

- Exact SQL, indexes (bench-guided), the money type handling in TypeScript (strings or integer minor units; never floating point).
- The report data is built by a reusable service (`ResourcesReportService`), not in the controller, so sub-project 9 can render it as DOCX/PDF later.
- **Sub-project 9 overlap.** It is built at the same time. Migration 0030 is reserved for 8. If 9 also widens the `change_requests` CHECKs, the branch merged second re-adds them as the union of both lists in its own migration (sub-project 9's session was told on 20 November 2026). Shared code files (matrix, permissions, analytics catalogue, quarantine registry, App routes) and shared documents will conflict at row level; keep both sides.
- The item picker's search details.
- Whether the People section's per-person link can filter the Work tab (only if a filter already exists; adding Work filters is outside 8).
- **For the Product Owner:** the D93 threshold bounds (1–200%, first below second); the bench aims; delegation default "allowed" (D94).

## 15. Documents updated in this branch

- Consolidated Specification §14: D91–D94.
- Permission Matrix §5: rows for resource view/edit, finance view/record/propose/approve/settings, catalogue maintainers.
- Configuration Catalogue: C51–C55 and C60 point to this design; new entries C76 (catalogue maintainers), C77 (resource categories), C78 (finance delegation switch), C79 (enabled currencies), C80 (project financial-detail readers).
- Remaining Design and Verification Register: R14 (resource, unit and currency catalogues) and R16 marked designed; R17's resource and finance part marked designed.
- `app/README.md`: the Resources tab, settings, catalogue, the bench.

## 16. Outside 8

- Booking, allocation, capacity and utilisation percentages; people availability.
- Per-line or per-category budgets; spending linked to lines.
- DOCX/PDF reports and filing (9). Backups and storage panels (10).
- Project-local categories and other delegated catalogue settings not listed here.
- Reminders for needed-by dates.
