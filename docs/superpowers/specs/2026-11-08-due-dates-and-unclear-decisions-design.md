# Due dates and unclear decisions — design

Date: 8 November 2026. Status: for review by the Product Owner. Nothing here is built yet.

## Why

The first run on seven real sets of meeting minutes (8 November 2026) showed two gaps:

1. **Due values that are not dates.** Of 56 proposals with a due value, 43 were not one calendar day: "End of November 2026", "Immediate", "Friday", "Mid-July", "after approval", "Next Senate/MCM". A month has 30 days, so "End of November" or "June" is not a deadline anyone can be held to. The V1.0 rules say every actionable task has a due date, and reminders and overdue escalation are counted from it.
2. **Decisions whose status is unclear.** Minutes often record something as discussed or proposed without saying whether it is going ahead or waiting for someone. Recording that as a decision overstates it.

## What the Product Owner decided

| Question | Decision |
| --- | --- |
| Can a due be a range? | Yes. A range has an earliest and a latest day. Reminders and overdue count from the **latest** day. |
| How does relative wording become dates? | From the **meeting date** in the notes. Kainow suggests the dates; the reviewer confirms or changes them. If the notes give no meeting date, the reviewer is asked for it once per note version. |
| What must an action's due be before approval? | An exact date, a date range, **or** a named event it waits on ("after Dr Goh's approval"). Anything else blocks approval of an **action**. Decisions, questions and risks are never blocked. |
| What happens to an unclear decision? | It is proposed as a **question**, worded so the open point and the alternatives are explicit. |
| Who works out the dates? | **Kainow's code**, not the model (approach A). The model reports the wording, the meeting date and any event. |
| Default readings | "Immediate" = meeting date to 3 days after. "Mid-July" = 10 to 20 July. "End of November" = 30 November only. "June" = 1 to 30 June. |

## Part 1: due dates

### What the model returns

The structured output gains three fields. Everything else is unchanged.

| Field | Where | Meaning |
| --- | --- | --- |
| `meeting_date` | once per run | The meeting date the notes state, as `YYYY-MM-DD`, or null. Not the upload date, not a guess. |
| `due` | per item (existing) | The deadline **wording as the notes give it**, or null. Unchanged meaning; the prompt now says to copy the wording rather than restate it. |
| `due_event` | per item, new | The event the item waits on when the notes name one ("approval by Dr Goh", "next Senate/MCM"), or null. |

The prompt rule "The due value is the deadline for the item, not the date of the meeting or of an event" stays. One sentence is added: when an item depends on an event rather than a date, put the event in `due_event`. A `meeting_date` that is not a valid calendar date is stored as null.

### What Kainow works out: the due reading

A pure function, `readDue({ due, dueEvent, meetingDate })`, returns one of four states. It is **computed when proposals are read and when one is approved, never stored**, so a reviewer's meeting date or date change takes effect everywhere at once and nothing goes stale.

| State | Result | Examples |
| --- | --- | --- |
| `exact` | earliest = latest | "5 November 2026"; "End of November 2026" (30 Nov); "Friday" (the first Friday after the meeting); "Before December 2026" (30 Nov); "before 16 November 2026" (15 Nov) |
| `range` | earliest, latest | "June 2027" (1 to 30 Jun); "Mid-July" (10 to 20 Jul); "August–September 2026" (1 Aug to 30 Sep); "Immediate" (meeting date to +3 days); "within 1 week" (meeting date to +7 days); "next 3 days" (meeting date +1 to +3 days) |
| `event` | event name, no dates | `due_event` is set, or the wording names an event: "After approval", "Before rollout", "Upon finalisation", "Next Senate/MCM", "During any future POC" |
| `needs_date` | a reason | no due; "Every 3–5 years" or "Throughout 2027" (a period, not a deadline); relative wording with no meeting date; wording it cannot read |

Rules:

- **Missing year** ("1 July", "June", "Mid-July"): the meeting's year; if that day is already past at the meeting date, the next year. With no meeting date: `needs_date`, reason "no year and no meeting date".
- **Weekday** ("Friday"): the first such day after the meeting date, not the meeting day itself.
- **Early / late month** are read too ("early June" = 1 to 10, "late June" = 21 to the last day), though not seen in the notes so far.
- **Several dates in one item** ("Submission: 6 November 2026; approval: 9 November 2026"): each part is read. If every part is `exact` or `range`, the item is a `range` from the earliest part to the latest part, with a note "several dates in one item". If any part cannot be read, the item is `needs_date`. (Splitting such items is a separate prompt finding, not part of this change.)
- Bahasa Melayu month names (Januari to Disember, and short forms such as "Dis") are read the same as English ones.
- Dates are calendar days in UTC+8 with no time of day.
- The function returns the basis it used ("from meeting date 4 Nov 2026 in the notes" or "from the meeting date you entered") so the screen can show it.

### What the reviewer can set

- **Meeting date per note version.** If the model found none, the review screen shows "The notes do not give a meeting date. Enter it to work out the due dates:" above the proposals. If the model found one, it is shown with a Change link. The reviewer's date wins over the model's. Stored append-only with who and when, written to the audit trail.
- **Due per proposal.** The existing edit form gains: earliest date, latest date (optional; blank means the same day), **or** "waits on an event" with the event in words. When set, these replace the reading of the notes' wording. Stored in the existing edit history beside wording edits; the model's wording is always kept.

### Approval rule

When a proposal of kind `action` is approved, the server works out its due reading from the latest inputs. If the state is `needs_date`, approval is refused with: "This action needs a due date, a date range or the event it waits on before it can be approved." The reason is shown on the screen next to the due. Other kinds are not checked. The existing checks (quote not found, repeated quote) are unchanged and run first.

### What the screen shows

Under each proposal's due, one line:

- Exact or range: "Notes say *Immediate* → 4–7 Nov 2026 (from meeting date 4 Nov)".
- Event: "Waits on: approval by Dr Goh".
- Needs a date: "Needs a date: *Friday*: no meeting date" in the warning style, with an "Add a date" button that opens the edit form at the due fields.

## Part 2: unclear decisions and questions

### Prompt rules (added to both copies of the prompt, which a test keeps identical)

- A proposal is a `decision` only when the notes make clear it was decided. A decision with a stated condition ("approved, subject to the Dean's approval") is still a decision and keeps the condition.
- When the notes leave the status open (proposed, being considered, or unclear whether it is going ahead or waiting for someone), propose it as a `question`, worded so the open point is explicit, for example "Is the Lark POC going ahead now, or waiting for the commercial proposal?"
- Every question must be answerable: it says what is being asked, not "clarify the timeline".
- The owner of a question is the person the notes say must answer it, otherwise null.

### New field

| Field | Where | Meaning |
| --- | --- | --- |
| `alternatives` | per item | For questions: 2 to 4 short possible answers taken from the notes ("Going ahead now", "Waiting for the commercial proposal"). An empty list when the notes suggest none, and always empty for other kinds. |

### Screen

A question shows its alternatives as a short list under the text. Approving a question means "this is an open question for the project", as today. Questions are never blocked.

Not included: turning a question into a decision on the review screen. A reviewer who knows the answer rejects the question and notes the answer. This can be added later.

## Data changes (migration 0010, additive only)

- `extraction_runs.meeting_date date NULL`: the model's meeting date for the run.
- `extraction_items.due_event text NULL`, `extraction_items.alternatives text[] NOT NULL DEFAULT '{}'`. Both are added to the immutability guard from migration 0006, so they cannot change after insert, like the other model fields.
- `extraction_item_edits.due_earliest date NULL`, `due_latest date NULL`, `due_event text NULL`: a reviewer's due. A check constraint allows either dates or an event, not both, and `due_latest >= due_earliest`.
- New table `source_version_meeting_dates (id, source_version_id, meeting_date, set_by, set_at)`: append-only (update and delete refused by trigger), the latest row wins.
- Existing rows are not changed. Proposals from runs before this change have no `meeting_date`, `due_event` or `alternatives`; their dues are read from the wording alone, so most relative ones show "needs a date" until a reviewer enters a meeting date.

## API changes

- `GET /extractions/:runId`: each item gains `due: { wording, state, earliest, latest, event, reason, basis }` (the reading) and `alternatives`. The run gains `meetingDate` (the one in use) and `meetingDateSource` (`notes`, `reviewer` or `none`).
- `POST /notes/:id/versions/:n/meeting-date` with `{ meetingDate }`: sets the reviewer's meeting date. Signed-in, anti-forgery token, same permission as review. Audited as `note.meeting_date_set`.
- `POST /extractions/:runId/items/:itemId/edit` accepts `dueEarliest`, `dueLatest` and `dueEvent` in addition to the existing fields.
- `POST .../review` with `approved` is refused with 409 for an action whose reading is `needs_date`.

## Testing

Written test first, as for every change here.

- **`readDue` table test**: every due wording seen in the seven real notes, with the expected state, dates and reason, at two meeting dates and with none. Only generic wording goes in the repository, no names or content from the minutes. It also covers missing year rolling forward, weekday after the meeting, several dates in one item, and Bahasa Melayu month names.
- **Server tests** (real PostgreSQL): an action that needs a date is refused and the same action with a range is approved; an event is accepted; setting the meeting date changes the readings; a reviewer's due overrides the wording and both are kept; old runs without the new fields still load; the new columns are immutable; the meeting-date table refuses update and delete.
- **Model schema test**: the stand-in model returns the new fields; a bad `meeting_date` is stored as null; `alternatives` is capped at 4.
- **Prompt test**: the two copies of the prompt stay identical.
- **Screen tests**: the due line in each state, the meeting-date prompt, the "Add a date" path and the alternatives list. The automated accessibility pass runs again at both widths.

## Checking with the model

1. Re-run the three synthetic notes and compare with the record of 8 November: supported and captured stay at 100%, and the existing marks do not get worse.
2. Re-run the seven real notes (about MYR 1) and regenerate the review sheet with new columns: the due reading (state, dates, reason) and the alternatives.
3. Measures: the share of action dues worked out without the reviewer; the number of decisions that became questions, each checked by the Product Owner; and that no action can be approved while it needs a date (shown in the screen, not only in tests).
4. One run on each set proves little. The Product Owner reviews the results; Claude's marks are a draft.

## Order of work

1. Commit the Word table fix (branch `mvp/word-table-runs`) on its own, since clean table text matters for the re-runs.
2. Migration 0010 and its tests.
3. `readDue` and its table test.
4. Model schema, prompt (both copies) and storing the new fields.
5. The reading in the API, the meeting-date endpoint, the due fields in edit, and the approval rule.
6. The review screen.
7. The re-runs and a dated review record in `docs/`.

## Out of scope

- Reminders and overdue escalation (not in the MVP). The latest day is stored so they can use it later.
- Turning a question into a decision on the review screen.
- Splitting an item that bundles several actions with different owners. That is a separate prompt finding from the same review.
- Working out dates from wording in Bahasa Melayu beyond month names (for example "minggu depan"). Such wording shows "needs a date" and the reviewer sets it.
