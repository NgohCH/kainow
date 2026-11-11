# Extraction re-run with due readings and clearer questions (8 November 2026)

This records one run of the changed extraction (design `docs/superpowers/specs/2026-11-08-due-dates-and-unclear-decisions-design.md`) on the three synthetic notes and on seven sets of real meeting minutes. It is evidence for review, not an acceptance. The marks in the review sheet are still to be made by the Product Owner.

## What changed before this run

- The model reports the meeting date, the due as the notes word it, any event a due waits on, and possible answers for a question. It proposes a decision only when the notes make clear it was decided.
- Kainow reads each due as an exact day, a range (its latest day is the deadline), an event, or "needs a date". An action that needs a date cannot be approved.
- Word tables keep words whole (runs inside a cell are no longer split by spaces).

Model `gpt-6.1-sol`. Code at the commit that adds this record, branch `mvp/word-table-runs`.

## Synthetic notes (check script `tests/extraction/run.mjs`)

| Note | Items | Supported | Expected captured |
| --- | --- | --- | --- |
| SYN-01 (Bahasa Melayu) | 9 | 100% | 100% |
| SYN-02 (mixed) | 11 | 100% | 100% |
| SYN-03 (English) | 8 | 100% | 100% |

The counts match the run of 8 November on the earlier prompt (10, 11, 8 on SYN-01 to SYN-03 then). SYN-01's dues are worded in Bahasa Melayu ("sebelum 10 Disember", "menjelang 6 Disember"). The reader understands Malay month names but not these words for "before" and "by", which the design left out of scope, so in the app such actions would show "needs a date".

## Seven real sets of minutes (in the Docker install)

The minutes, the model's output and the review sheet stay outside the repository. Only counts are recorded here.

| | Before (first real run) | After (this run) |
| --- | --- | --- |
| Proposals | 188 | 177 |
| Quotes found word for word | 188 of 188 | 177 of 177 |
| Decisions | 38 | 29 |
| Open questions | 18 | 20 |
| Questions with possible answers | – | 3 of 20 |
| Actions | 108 | 104 |

Due readings for the 104 actions:

| Reading | Actions |
| --- | --- |
| Exact day or range, worked out automatically | 20 |
| Waits on a named event | 11 |
| Needs a date: the notes give no due | 44 |
| Needs a date: relative wording or no year, and the notes give no meeting date (resolved once a reviewer enters it) | 14 |
| Needs a date: a period or repeat ("Ongoing", "Throughout 2027") | 9 |
| Needs a date: several dates for several sub-actions in one item ("i. 11 November ii. 16 November", "6, 9 and 11 November respectively") | 6 |

Four of the seven notes state their meeting date and the model reported it each time. The other three do not state one, and the review screen asks for it.

Checked in the review screen of the running install: an action that needs a date cannot be approved and offers "Add a date"; entering a meeting date works the dates out again; a reviewer's range unblocks approval; changing only the wording keeps the reviewer's dates. The automated accessibility pass found 0 violations across 18 screen states.

## Findings

1. **Bundled sub-actions.** When one row lists sub-actions i, ii, iii with their own owners and dates, the model kept them as one proposal and copied the due wording as written, which the reader did not split. Addressed in the third run below.
2. **Decisions to questions.** Nine fewer decisions and two more questions is consistent with the new rule, but the items differ from run to run, so this needs the Product Owner's check of each question.
3. **Few possible answers.** Only 3 of 20 questions came with possible answers. Most questions in these minutes are open ("which central body should coordinate?") rather than either-or.
4. **Bahasa Melayu deadline words** ("sebelum", "menjelang", "minggu depan") were not read. Addressed in the third run below.

## Third run: one proposal per sub-action (same day)

Changes since the second run: the prompt asks for one item per sub-action when a row lists several (i, ii, iii); the reader also reads Bahasa Melayu deadline words, bundled date lists ("6, 9 and 11 November respectively", "21 & 28 Oct"), "29 February" without a year, "the following week" and a date in brackets; a reviewer can mark the model's event as not applying.

Synthetic notes: all three at 100% supported and 100% captured (10, 12 and 8 items).

| | Second run | Third run |
| --- | --- | --- |
| Proposals | 177 | 205 |
| Quotes found word for word | 177 of 177 | 205 of 205 |
| Decisions | 29 | 28 |
| Open questions (with possible answers) | 20 (3) | 22 (5) |
| Actions | 104 | 130 |
| Actions still bundling several sub-actions | 6 | 0 |
| Action dues read as a day or range | 20 | 44 |
| Action dues waiting on a named event | 11 | 14 |
| Needs a date: no due in the notes | 44 | 49 |
| Needs a date: relative wording or no year, notes give no meeting date | 14 | 15 |
| Needs a date: a period or repeat | 9 | 8 |
| Needs a date: wording not read | 6 | 0 |

The rise in actions comes almost all from the minutes with a sub-action table (22 actions became 38, of which 35 now read as dates). The sheet for this run is `real-notes-review-2026-11-08-run3.csv`, outside the repository; its assessed copy is recorded in the next section.

## Provisional review of the third run (8 November 2026)

The Product Owner returned an assessed copy of the third-run sheet (`real-notes-review-2026-11-08-run3-assessed.xlsx`, kept outside the repository, because the minutes hold real names). The workbook describes itself as a **provisional review against the extracted quotes; the original meeting documents were not independently checked. It is NOT a final acceptance.** Only counts are recorded here.

The sheet has 212 rows: the 205 proposals and 7 missed-item placeholders, one per set of minutes. The placeholders are left out of every rate below.

| Field (205 proposals) | Accepted | Flagged |
| --- | --- | --- |
| Classification correct | 193 | 12 needs review |
| Owner correct | 159 | 25 needs review, 21 needs assignment |
| Condition or status kept | 193 | 12 needs review |
| Question clear (22 questions) | 20 | 2 needs review |
| Invented | 193 no evidence of invention | 12 needs review |
| Duplicate of another proposal | none established | — |

156 of 205 proposals (76%) have no mark against them. The 12 flagged for classification are the same 12 flagged for condition and invention: 10 actions that read as a status report, work already under way, an expected milestone or a suggested message rather than an assigned task, 1 question that is a proposal, and 1 decision that may be a milestone. The due readings were not marked.

**Owners are the main finding.** 46 proposals have an owner mark:

| Owner problem | Proposals |
| --- | --- |
| Action with no named person (needs assignment; the reviewer asks that none be invented) | 21 |
| Several people, or responsibility split between them | 12 (11 actions, 1 decision) |
| The named party has another role (asked to answer, approves, sets criteria), not owner | 6 (decisions and questions) |
| The owner is not named in the quoted text | 4 (3 actions, 1 decision) |
| No owner given for a decision or question | 3 |

Besides the 11 flagged actions, 33 actions marked as correct still list more than one name in the owner field. V1.0 requires exactly one assignee per task, which sub-project 2 will enforce: the 21 actions with no one named and the 44 actions naming several people all need a single person chosen at review.

**Against the targets.**

- *95% of proposals supported by a real quote:* 193 of 205 (94.1%) carry no mark for invention, two short of the 195 needed. This is a reading of each extracted quote only. It does not show the quotes match the original documents (`quote_found` was carried over from the export, not re-checked), and "no evidence" does not mean the item was checked against the full minutes.
- *90% of expected items captured:* not established. The 7 missed-item placeholders are empty, so the sheet gives no list of expected items to count against.

## Limits

One run on each set. The synthetic notes are the same three the prompt was tuned on. Draft marks from the first real run do not carry over, because the items differ. The second-run sheet (`real-notes-review-2026-11-08-rerun.csv`) has no marks. The third-run review above is provisional: against the extracted quotes only, with no check of missed items, and not a final acceptance.
