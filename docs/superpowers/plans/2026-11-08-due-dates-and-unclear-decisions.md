# Due Dates and Unclear Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every approved action carry an exact date, a date range or the event it waits on, worked out by Kainow from the notes' wording and meeting date, and have unclear decisions proposed as explicitly worded questions with alternatives.

**Architecture:** The model reports wording (`due`), the meeting date and any event (`due_event`), plus `alternatives` for questions. A pure server function `readDue` turns those inputs into a reading (`exact`, `range`, `event`, `needs_date`) every time proposals are read or approved; readings are never stored. Reviewers can set a meeting date per note version and a due per proposal; both are append-only records.

**Tech Stack:** TypeScript, NestJS, PostgreSQL 16 (plain SQL migrations), `node:test`, React + Vite review screen, OpenAI structured output.

**Spec:** `docs/superpowers/specs/2026-11-08-due-dates-and-unclear-decisions-design.md`

## Global Constraints

- Dates are calendar days held as `'YYYY-MM-DD'` strings. All date arithmetic uses `Date.UTC` and `getUTC*`; never local time, never a time of day. Dates are shown for UTC+8.
- Default readings, verbatim from the spec: "Immediate" = meeting date to 3 days after. "Mid-July" = 10 to 20 July. "End of November" = 30 November only. "June" = 1 to 30 June.
- A range's **latest** day is the one reminders and overdue will count from.
- Approval refusal text, exact: `This action needs a due date, a date range or the event it waits on before it can be approved.`
- Only proposals of kind `action` are blocked. Decisions, questions and risks are never blocked.
- Migrations are additive. Never edit migrations 0001 to 0009 (their checksums are recorded).
- The prompt in `app/src/extraction/prompt.ts` and in `tests/extraction/run.mjs` must stay word for word the same (an existing test enforces it). The output schema in both must match.
- No real meeting content (names, minutes text) in the repository. Test wording is generic.
- Every change starts with a failing test. Server tests run against a throwaway PostgreSQL (see "Running the tests").
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit only the task's files; never `kainow/` (a stray nested clone) or `.env`.

## Running the tests

Server (from `app/`), with a throwaway database:

```bash
docker run -d --rm --name kainow-testdb -e POSTGRES_PASSWORD=test -e POSTGRES_DB=kainow_test -p 127.0.0.1:55432:5432 postgres:16
```

```bash
KAINOW_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/kainow_test npm test
```

A single file: `npx tsc -p tsconfig.json && node --test dist/extraction/due.test.js` (database tests also need the variable). Web (from `app/web/`): `npm test` and `npm run build`. Stop the database afterwards with `docker stop kainow-testdb`.

## Review Focus

Inputs the spec implies but does not spell out; each has a test in the task that owns it.

1. **Month ends and leap years**: "End of February 2028" is 29 Feb 2028, "end of Feb 2027" is 28 Feb 2027. (Task 3)
2. **Wording that crosses a year end**: meeting 30 Dec 2026, "Monday" is 4 Jan 2027; meeting 4 Nov 2026, "1 July" is 1 Jul 2027. (Task 3)
3. **Ordinary variation in wording**: case, extra spaces and number words ("end of november 2026", "  Immediate ", "within one week", "within two weeks") read the same as the tidy form. (Task 3)
4. **Editing wording after setting a due**: a reviewer who set 10–12 Nov and then fixes a typo must not lose the dates. The screen always sends the current due fields with an edit. (Task 6)
5. **Proposals from runs before this change**: no meeting date, no event, no alternatives. They load, their dues are read from the wording alone, and absolute dates still read as dates. (Task 5)

---

### Task 1: Commit the Word table fix

The fix is already written and tested on branch `mvp/word-table-runs` (uncommitted): `app/src/notes/readers.ts`, `app/src/notes/readers.test.ts`, `app/src/testing/files.ts`.

- [ ] **Step 1: Run the reader tests**

Run (from `app/`): `npx tsc -p tsconfig.json && node --test dist/notes/readers.test.js`
Expected: `pass 19`, `fail 0`.

- [ ] **Step 2: Commit**

```bash
git add app/src/notes/readers.ts app/src/notes/readers.test.ts app/src/testing/files.ts
git commit -m "Keep a word whole when Word splits it across runs in a table cell"
```

Body: real minutes produced "stakeholder s", "compil ation" because table cell text joined every run with a space; runs now join with nothing and paragraphs, cells and rows end with a space.

---

### Task 2: Migration 0010

**Files:**
- Create: `app/migrations/0010_due_dates_and_alternatives.sql`
- Modify: `app/src/db/migrate.test.ts` (add the file to `REAL_FILES`)
- Test: `app/src/db/due-schema.test.ts` (new, database test, `describe(..., { skip: SKIP_NO_DB })`, same setup as `migrate.test.ts`)

**Interfaces:**
- Produces columns: `extraction_runs.meeting_date date NULL`; `extraction_items.due_event text NULL`; `extraction_items.alternatives text[] NOT NULL DEFAULT '{}'`; `extraction_item_edits.due_earliest date NULL`, `due_latest date NULL`, `due_event text NULL`.
- Produces table: `source_version_meeting_dates (id uuid PK, source_version_id uuid NOT NULL REFERENCES source_versions(id), meeting_date date NOT NULL, set_by uuid NOT NULL REFERENCES users(id), set_at timestamptz NOT NULL)` with index `(source_version_id, set_at DESC, id DESC)`; the latest row wins.

- [ ] **Step 1: Write the failing tests** in `due-schema.test.ts`

- `a new item's due_event and alternatives cannot be changed`: insert a run and an item with `due_event = 'after approval'`, `alternatives = '{A,B}'`; `UPDATE extraction_items SET due_event = 'x'` and `SET alternatives = '{C}'` each reject with SQLSTATE `23001` (`restrict_violation`); `UPDATE ... SET review_status = 'approved'` still succeeds.
- `meeting dates are append-only`: insert a row; `UPDATE` and `DELETE` on `source_version_meeting_dates` reject with `23001`.
- `a reviewer due is dates or an event, not both`: inserting an edit with `due_earliest` and `due_event` both set rejects with `23514` (check violation); `due_latest < due_earliest` rejects with `23514`; `due_latest` without `due_earliest` rejects with `23514`.
- `rows from before the migration load with empty new fields`: an item inserted without the new columns has `due_event IS NULL` and `alternatives = '{}'`.

- [ ] **Step 2: Run them and see them fail** (columns do not exist).

- [ ] **Step 3: Write the migration**

Add the columns and table above. Edits constraint: `CHECK (NOT (due_event IS NOT NULL AND due_earliest IS NOT NULL)) `, `CHECK (due_latest IS NULL OR (due_earliest IS NOT NULL AND due_latest >= due_earliest))`. Replace `extraction_items_guard()` with `CREATE OR REPLACE FUNCTION` that adds `due_event` and `alternatives` to both row tuples of the existing comparison (copy the 0006 body exactly, plus the two columns). Meeting-date append-only trigger function and `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers, modelled on `extraction_item_edits_append_only` in 0009.

- [ ] **Step 4: Add `'0010_due_dates_and_alternatives.sql'` to `REAL_FILES` in `migrate.test.ts`, run the full server suite.**
Expected: all pass, including the new file.

- [ ] **Step 5: Commit** (`Add columns for meeting date, due event, alternatives and reviewer dues`).

---

### Task 3: `readDue`

**Files:**
- Create: `app/src/extraction/due.ts`
- Test: `app/src/extraction/due.test.ts` (pure, no database)

**Interfaces:**
- Produces:

```ts
export type DueState = 'exact' | 'range' | 'event' | 'needs_date';
export interface DueReading {
  state: DueState;
  earliest: string | null;        // 'YYYY-MM-DD'; set for exact and range
  latest: string | null;          // equal to earliest for exact
  event: string | null;           // set for event
  reason: string | null;          // set for needs_date (exact strings below)
  note: string | null;            // 'several dates in one item' when that applies
  usedMeetingDate: boolean;       // true when the meeting date decided the dates
}
export interface DueInput { due: string | null; dueEvent: string | null; meetingDate: string | null }
export interface ReviewerDue { earliest: string | null; latest: string | null; event: string | null }
export function readDue(input: DueInput, reviewer?: ReviewerDue | null): DueReading;
export function isCalendarDate(v: unknown): v is string;  // 'YYYY-MM-DD' and a real day
```

- `reason` strings, exact: `'no due given'`, `'no year and no meeting date'`, `'relative wording and no meeting date'`, `'a period or repeat, not a deadline'`, `'several dates in one item; not all are dates'`, `'wording not understood'`.

- [ ] **Step 1: Write the failing table test** `readDue reads every due wording seen so far`

One table of `[due, meetingDate, expected]`, asserted with `deepEqual` on the whole reading (`usedMeetingDate` included). Meeting dates: `M = '2026-11-04'` (a Wednesday), `MAY = '2026-05-14'`, and `null`. Expected results:

| due | meeting | state | earliest | latest | other |
| --- | --- | --- | --- | --- | --- |
| `5 November 2026` | any | exact | 2026-11-05 | 2026-11-05 | |
| `End of November 2026`, `By end of November 2026`, `end of november 2026` | any | exact | 2026-11-30 | 2026-11-30 | |
| `End of February 2028` / `end of Feb 2027` | any | exact | 2028-02-29 / 2027-02-28 | same | |
| `End July` | MAY / M / null | exact / exact / needs_date | 2026-07-31 / 2027-07-31 / – | same | null: reason `no year and no meeting date` |
| `June` | MAY / M | range | 2026-06-01 / 2027-06-01 | 2026-06-30 / 2027-06-30 | `usedMeetingDate: true` |
| `June 2027` | null | range | 2027-06-01 | 2027-06-30 | `usedMeetingDate: false` |
| `Mid-July` | MAY | range | 2026-07-10 | 2026-07-20 | |
| `early June 2027` / `late June 2027` | null | range | 2027-06-01 / 2027-06-21 | 2027-06-10 / 2027-06-30 | |
| `August–September 2026` (en dash) and `August-September 2026` | null | range | 2026-08-01 | 2026-09-30 | |
| `December 2026` | null | range | 2026-12-01 | 2026-12-31 | |
| `Before December 2026` | null | exact | 2026-11-30 | 2026-11-30 | |
| `before 16 November 2026` | null | exact | 2026-11-15 | 2026-11-15 | |
| `1 July` | MAY / M | exact | 2026-07-01 / 2027-07-01 | same | |
| `15 June` | null | needs_date | | | `no year and no meeting date` |
| `Friday` | M / `2026-11-06` / null | exact / exact / needs_date | 2026-11-06 / 2026-11-13 | same | null: `relative wording and no meeting date` |
| `Monday` | `2026-12-30` | exact | 2027-01-04 | 2027-01-04 | |
| `Immediate`, `  Immediate `, `immediately`, `ASAP` | M | range | 2026-11-04 | 2026-11-07 | |
| `Within 1 week`, `within one week` | M | range | 2026-11-04 | 2026-11-11 | |
| `within two weeks` | M | range | 2026-11-04 | 2026-11-18 | |
| `within 2 days` | M | range | 2026-11-04 | 2026-11-06 | |
| `next 3 days` | M | range | 2026-11-05 | 2026-11-07 | |
| `Immediate` | null | needs_date | | | `relative wording and no meeting date` |
| `After approval`, `Before June rollout`, `Before rollout`, `Upon finalisation`, `Next Senate/MCM`, `During any future POC`, `Before Go-Live in November 2026` | any | event | | | `event` = the wording, trimmed |
| null with `dueEvent: 'approval by Dr Goh'` | any | event | | | `event: 'approval by Dr Goh'` |
| `After approval` with `dueEvent: 'approval by the Dean'` | any | event | | | `event: 'approval by the Dean'` (the model's event wins) |
| `Every 3–5 years`, `Throughout the required transition period in 2027`, `Ongoing` | any | needs_date | | | `a period or repeat, not a deadline` |
| null | any | needs_date | | | `no due given` |
| `Submission: 6 November 2026; approval: 9 November 2026; setup: 11 November 2026` | null | range | 2026-11-06 | 2026-11-11 | `note: 'several dates in one item'` |
| `Draft: 5 November 2026; poster: before 16 November 2026` | null | range | 2026-11-05 | 2026-11-15 | note as above |
| `Dry run: 6 November 2026; data removal: before go-live` | null | needs_date | | | `several dates in one item; not all are dates` |
| `16 November 2026 for the announcement` | null | exact | 2026-11-16 | 2026-11-16 | |
| `15 Disember 2026` / `Dis 2026` / `Mac 2027` | null | exact / range / range | 2026-12-15 / 2026-12-01 / 2027-03-01 | 2026-12-15 / 2026-12-31 / 2027-03-31 | |
| `31 February 2027`, `sometime soon` | null | needs_date | | | `wording not understood` |

- [ ] **Step 2: Write the failing test** `a reviewer's due replaces the reading of the wording`: `readDue({ due: 'Friday', dueEvent: null, meetingDate: null }, { earliest: '2026-11-10', latest: '2026-11-12', event: null })` → `range 2026-11-10..2026-11-12`, `usedMeetingDate: false`; same with `latest: null` → `exact 2026-11-10`; with `{ earliest: null, latest: null, event: 'Senate approval' }` → `event`. A reviewer value of all nulls is ignored (the wording is read).

- [ ] **Step 3: Write the failing test** `isCalendarDate` accepts `'2028-02-29'` and refuses `'2027-02-29'`, `'2026-13-01'`, `'4 Nov 2026'`, `''`, `null`.

- [ ] **Step 4: Run, see all fail.**

- [ ] **Step 5: Implement `readDue` and `isCalendarDate` in `due.ts`.**

Approach: normalise (trim, collapse spaces, lower case, `–`→`-`, strip a trailing ` for the …`); split on `;` and strip a leading `label:` from each part; read each part in this order: exact date with year → day and month without year → before + date / before + month → end/mid/early/late + month (± year) → month range → month (± year) → weekday → immediate/ASAP → within N days/weeks → next N days → period words (`every`, `throughout`, `ongoing`) → event words (`after`, `upon`, `before`, `during`, `following`, `once`, `next`, `subject to`, `on completion`) → not understood. Month names: English full and three-letter, plus Malay `Januari Februari Mac April Mei Jun Julai Ogos September Oktober November Disember` and their short forms (`Jan Feb Mac Apr Mei Jun Jul Ogo Sep Okt Nov Dis`). Number words `one` to `ten`. Missing year: the meeting's year, moved one year forward if the resulting **latest** day is before the meeting date. Weekday: strictly after the meeting date. Several parts: all exact/range → range of min earliest to max latest with the note; otherwise `needs_date` with the several-dates reason. `dueEvent` given and the wording is null or event wording → event named by `dueEvent`. A wording that reads as a date wins over `dueEvent`.

- [ ] **Step 6: Run, all pass.** Run the full server suite; nothing else changed.

- [ ] **Step 7: Commit** (`Read due wording as a date, a range, an event, or needing a date`).

---

### Task 4: Model output, prompt and storing the new fields

**Files:**
- Modify: `app/src/extraction/model.ts` (schema, `RawItem`, `ModelResult`, parsing)
- Modify: `app/src/extraction/runner.ts` (`saveItems` stores the new fields)
- Modify: `app/src/extraction/prompt.ts` and `tests/extraction/run.mjs` (same sentences, same schema)
- Modify: `app/src/extraction/probe.ts` if it reads `parseItems` (it should keep working unchanged otherwise)
- Test: `app/src/extraction/model.test.ts`, `app/src/extraction/prompt.test.ts`, `app/src/extraction/runner.test.ts`

**Interfaces:**
- Consumes: `isCalendarDate` from Task 3.
- Produces:

```ts
export interface RawItem { kind: ItemKind; text: string; owner: string | null; due: string | null; due_event: string | null; alternatives: string[]; source_quote: string }
export interface ModelAnswer { meetingDate: string | null; items: RawItem[] }
export interface ModelResult extends ModelAnswer { usage: Usage }
export function parseAnswer(content: unknown, usage: Usage): ModelAnswer;   // replaces parseItems
export const MAX_ALTERNATIVES = 4;
```

- [ ] **Step 1: Write the failing model tests**

- `parseAnswer returns the meeting date and the new item fields`: content `{ meeting_date: '2026-11-04', items: [{ ...ITEM, due_event: 'approval by the Dean', alternatives: ['Go ahead', 'Wait'] , kind: 'question' }] }` → `meetingDate '2026-11-04'`, fields as given.
- `a meeting date that is not a real day is stored as null, not refused`: `'2026-02-30'`, `'4 Nov 2026'` → `meetingDate: null`, no throw.
- `alternatives are trimmed, blanks dropped, capped at 4, and empty for kinds other than question`.
- `a malformed due_event or alternatives is a bad response`: `due_event: 5` and `alternatives: 'x'` each throw `ModelBadResponse` carrying the usage.
- Update existing tests from `parseItems` to `parseAnswer(...).items`.

- [ ] **Step 2: Write the failing prompt test** `the prompt asks for meeting date, due wording, events and clear questions` asserting `EXTRACTION_SYSTEM_PROMPT` matches `/meeting_date/`, `/due_event/`, `/decision only when the notes make clear/i`, `/propose it as a question/i`, `/alternatives/`. The existing identical-copy test stays.

- [ ] **Step 3: Write the failing runner test** `saves the meeting date on the run and due_event and alternatives on each item`, using the existing fake model in `runner.test.ts` returning a `meetingDate` and one question with alternatives; read back `extraction_runs.meeting_date` (as `'YYYY-MM-DD'` via `to_char`) and the item columns.

- [ ] **Step 4: Run, see them fail.**

- [ ] **Step 5: Implement**

Schema: top level `required: ['meeting_date', 'items']`, `meeting_date: { type: ['string', 'null'] }`; item `required` adds `'due_event', 'alternatives'`, `due_event: { type: ['string', 'null'] }`, `alternatives: { type: 'array', items: { type: 'string' } }`. Copy the same schema change into `run.mjs`. Prompt: insert these sentences, in this order, immediately before `Do not invent items.` in **both** files (exact copy):

```
Report meeting_date as the date of the meeting stated in the notes, in the form YYYY-MM-DD, or null if the notes do not state it.
Copy the due value as the notes word it, for example "End of November" or "Immediate"; do not turn it into a date.
When an item depends on an event rather than a date, for example "after the Dean's approval", put the event in due_event; otherwise due_event is null.
Propose a decision only when the notes make clear it was decided. A decision with a stated condition stays a decision and keeps the condition.
When the notes leave open whether something is going ahead, for example it was only proposed or is waiting for someone, propose it as a question instead, worded so the open point is explicit, for example "Is the pilot going ahead now, or waiting for the commercial proposal?"
Every question must say what is being asked; never only ask to clarify something.
For a question, list in alternatives two to four short possible answers taken from the notes, or none if the notes suggest none; for other kinds alternatives is empty.
The owner of a question is the person the notes say must answer it.
```

(Each is one string literal ending in a space, as the existing sentences are; in `run.mjs` the inner quotes are escaped `\"`.) Runner: `saveItems(run, modelId, answer: ModelAnswer)` writes `meeting_date` in the same `UPDATE extraction_runs ... SET status = 'succeeded'` and `due_event`, `alternatives` in the item insert.

- [ ] **Step 6: Run the full server suite, all pass.** (No real-model call here; that is Task 7.)

- [ ] **Step 7: Commit** (`Ask the model for the meeting date, due events and clearly worded questions`).

---

### Task 5: Readings in the API, the meeting date, reviewer dues and the approval rule

**Files:**
- Modify: `app/src/extraction/extraction.service.ts` (`getRun`, `review`, `edit`, new `setMeetingDate`)
- Modify: `app/src/extraction/extraction.controller.ts` (new route, new edit fields)
- Test: `app/src/extraction/review.http.test.ts`, `app/src/extraction/edit.http.test.ts`, new `app/src/extraction/meeting-date.http.test.ts` (copy the setup of `review.http.test.ts`)

**Interfaces:**
- Consumes: `readDue`, `isCalendarDate`, `DueReading` (Task 3); columns from Task 2.
- Produces (API, consumed by Task 6):
  - `GET /extractions/:runId` → `run.meetingDate: string | null`, `run.meetingDateSource: 'notes' | 'reviewer' | 'none'`; each item keeps `due` (the wording in force, unchanged meaning) and gains `dueReading: DueReading`, `reviewerDue: { earliest, latest, event } | null`, `dueEvent: string | null` (the model's), `alternatives: string[]`. `original` (when edited) is unchanged.
  - `POST /notes/:id/versions/:n/meeting-date` body `{ meetingDate }` → `200 { meetingDate }`. `@RequireAction('proposal.review')`. Audit action `note.meeting_date_set`, subject the source version, detail `{ meetingDate }`.
  - `POST /extractions/:runId/items/:itemId/edit` accepts `dueEarliest`, `dueLatest`, `dueEvent` (blank or absent = none; the body is the complete new wording, as today).
  - `POST .../review` approve: `409` with the exact refusal text for an action whose reading is `needs_date`.

- [ ] **Step 1: Write the failing tests**

`meeting-date.http.test.ts`:
- `setting the meeting date changes the readings`: run whose items are `Immediate` (action) and `5 November 2026`; before: `meetingDateSource 'none'`, first reading `needs_date`; POST `2026-11-04`; after: `meetingDateSource 'reviewer'`, `2026-11-04..2026-11-07` with `usedMeetingDate: true`, second item unchanged.
- `the reviewer's meeting date wins over the model's and the latest one counts`: run with `meeting_date = 2026-11-01`; source `'notes'`; set `2026-11-04`, then `2026-11-05` → `'reviewer'`, `2026-11-05`.
- `a meeting date that is not a calendar day is refused`: `'2026-02-30'` and `'4 Nov'` → `400` with `meetingDate must be a date in the form YYYY-MM-DD`.
- `setting a meeting date needs the review permission and the anti-forgery token`, and is written to the audit trail.

`review.http.test.ts`:
- `an action that needs a date cannot be approved`: action with due `Friday`, no meeting date → `409`, exact text; rejecting it still works.
- `an action with a range or an event can be approved`; `a decision, question or risk with no due can be approved`.
- Existing fixtures that approve an action with no due: give them `due = '5 November 2026'`.
- `runs from before this change still load`: an item inserted without the new columns returns `alternatives: []`, `dueEvent: null`, and `5 November 2026` reads `exact`.

`edit.http.test.ts`:
- `a reviewer's due replaces the reading and is kept in history`: edit with `dueEarliest 2026-11-10, dueLatest 2026-11-12` → `reviewerDue` set, reading `range`, wording `due` unchanged, `original` still the model's.
- `editing the wording with the same due keeps the dates`: second edit with new text and the same three due fields → reading still `range 2026-11-10..2026-11-12`.
- `dates and an event together are refused` (`400`, `Give dates or an event, not both`); `latest before earliest` (`400`, `The latest date cannot be before the earliest date`); `latest without earliest` (`400`, `Give the earliest date first`); a non-calendar date (`400`, `Dates must be in the form YYYY-MM-DD`).
- `changing only the due counts as a change` (audit `changed` includes `'due_dates'`).

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement**

`getRun`: select `r.meeting_date` and the latest `source_version_meeting_dates` row for the run's version; meeting date in use = reviewer's, else model's; select `i.due_event`, `i.alternatives` and the latest edit's `due_earliest`, `due_latest`, `due_event` (extend the existing `LATERAL` join); format dates with `to_char(..., 'YYYY-MM-DD')`; compute `dueReading = readDue({ due, dueEvent, meetingDate }, reviewerDue)` per item. `review`: before the update, when approving and `kind = 'action'`, compute the reading the same way (share one private helper with `getRun` so both read identically) and throw `ConflictException(<exact text>)` for `needs_date`; this check runs after the existing quote checks. `edit`: validate the three fields as above (`dueLatest` blank → stored equal to `dueEarliest`), include them in the insert and in change detection (as one entry `'due_dates'`). `setMeetingDate(sourceId, versionNo, meetingDate, actorUserId)`: find the version (404 if none), insert a row, write the audit entry, return `{ meetingDate }`.

- [ ] **Step 4: Run the full server suite, all pass.**

- [ ] **Step 5: Commit** (`Show each due's reading, let reviewers set the meeting date and dues, and block undated actions`).

---

### Task 6: Review screen

**Files:**
- Create: `app/web/src/due.ts`, `app/web/src/due.test.ts`
- Modify: `app/web/src/api.ts` (types for the Task 5 fields; `setMeetingDate`; `editProposal` sends the due fields)
- Modify: `app/web/src/views/Review.tsx` (due line, meeting-date banner, due fields in the edit form, alternatives, `canApprove`)
- Modify: `app/web/src/styles.css` (warning style for the due line if none fits)

**Interfaces:**
- Consumes: the API shape from Task 5.
- Produces (pure, tested):

```ts
export function formatDay(iso: string): string;                         // '2026-11-04' → '4 Nov 2026'
export function formatSpan(earliest: string, latest: string): string;   // '4–7 Nov 2026', '28 Nov – 2 Dec 2026', '30 Dec 2026 – 4 Jan 2027'
export function dueLine(item: Item, run: Run): { tone: 'plain' | 'warn'; text: string } | null;
export function blocksApproval(item: Item): boolean;                    // action and dueReading.state === 'needs_date'
/** The edit form's fields; '' means none. The form sends all of them on every save. */
export interface EditFields { text: string; owner: string; due: string; dueEarliest: string; dueLatest: string; dueEvent: string }
export function editFormFrom(item: Item): EditFields;                   // starts from the wording and the reviewer's due in force
```

`api.ts` `editProposal(runId, itemId, sourceVersionId, fields: EditFields)` sends every field.

- [ ] **Step 1: Write the failing tests** in `due.test.ts`

- `formatDay` and `formatSpan` for the three cases above and an exact day (`'5 Nov 2026'`).
- `dueLine`, exact text:
  - range from the meeting date in the notes: `Notes say “Immediate” → 4–7 Nov 2026 (from the meeting date in the notes, 4 Nov 2026)`.
  - from the reviewer's meeting date: `… (from the meeting date you entered, 4 Nov 2026)`.
  - exact with no meeting date used: `Notes say “5 November 2026” → 5 Nov 2026`.
  - reviewer's due: `Set by reviewer: 10–12 Nov 2026`.
  - event: `Waits on: approval by Dr Goh`.
  - needs a date, action: tone `warn`, `Needs a date: “Friday”: relative wording and no meeting date`.
  - needs a date with no due on a decision, question or risk: `null` (nothing shown).
  - several dates: the line ends with ` (several dates in one item)`.
- `blocksApproval` is true only for an action whose reading is `needs_date`.
- `editFormFrom` fills `dueEarliest`, `dueLatest`, `dueEvent` from the item's current `reviewerDue` (and `''` when there is none), so saving after changing only the text sends the same dates (Review Focus 4).

- [ ] **Step 2: Run (`npm test` in `app/web`), see them fail.**

- [ ] **Step 3: Implement `due.ts`, then the screen**

Screen: under each proposal's meta, render `dueLine` (`role="note"`; warn tone uses the existing warning colour tokens). For a blocking action, show an **Add a date** button that opens the edit form focused on the earliest-date field, and make `canApprove` return false so Approve is disabled with the reason as its `title` and as visible text. The edit form gains: **Earliest date** and **Latest date** (`<input type="date">`, latest optional), or a **Waits on an event** text field; switching between dates and event clears the other. Above the list: if `meetingDateSource === 'none'`, a banner `The notes do not give a meeting date. Enter it to work out the due dates:` with a date input and **Save**; otherwise `Meeting date: 4 Nov 2026 (from the notes)` or `(you entered it)` with a **Change** link opening the same input. After saving, reload the run. A question with alternatives shows them as a list labelled `Possible answers:`.

- [ ] **Step 4: Run `npm test` and `npm run build` in `app/web`, both pass.**

- [ ] **Step 5: Check in the running app**

Rebuild and start the install (`docker compose up -d --build` in the repo root), open a review, and confirm in the browser: the due lines, the banner, setting a meeting date recalculates, an undated action's Approve is disabled and **Add a date** opens the form, editing only the text keeps the dates. Then run the accessibility pass (`npm run audit` in `tests/a11y`, per its README) and expect 0 violations.

- [ ] **Step 6: Commit** (`Show due readings, the meeting date and possible answers on the review screen`).

---

### Task 7: Re-runs and the review record

**Files:**
- Create: `docs/MVP-EXTRACTION-REVIEW-<date>.md` (dated the day of the run)
- Modify: `README.md` ("Where things stand": extraction and review rows)
- Outside the repository: the regenerated review sheet beside `C:\Project\Kainow\Minutes.zip`

- [ ] **Step 1: Synthetic notes.** Run the extraction check on the three synthetic notes with the real model (per `tests/extraction/README.md`). Expected: supported and captured stay at 100%. Record items per note, how many decisions became questions, and any due readings of `needs_date` for actions.

- [ ] **Step 2: Real notes.** In the running install, upload the seven real notes again as new versions and run extraction (about MYR 1). Regenerate the review sheet with new columns `due_state`, `due_earliest`, `due_latest`, `due_event`, `due_reason`, `alternatives`, keeping all existing columns and the draft-marks layout.

- [ ] **Step 3: Write the record**: date, model, commit, cost; per note: action dues read automatically / total actions, decisions that became questions (listed for the Product Owner to check), actions still needing a date; that an undated action cannot be approved in the screen; the limits (one run each, Claude's marks are a draft, the Product Owner reviews). No names or minutes text from the real notes in the record beyond counts.

- [ ] **Step 4: Update README** "Where things stand" to match, then commit (`Record the re-runs with due readings and clearer questions`).
