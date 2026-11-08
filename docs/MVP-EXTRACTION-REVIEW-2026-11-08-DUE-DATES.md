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

1. **Bundled sub-actions.** When one row lists sub-actions i, ii, iii with their own owners and dates, the model keeps them as one proposal, and now copies the due wording as written, which the reader does not split. Such items are refused for approval until a reviewer sets a date. Splitting them into one proposal each (an earlier finding) would fix both.
2. **Decisions to questions.** Nine fewer decisions and two more questions is consistent with the new rule, but the items differ from run to run, so this needs the Product Owner's check of each question.
3. **Few possible answers.** Only 3 of 20 questions came with possible answers. Most questions in these minutes are open ("which central body should coordinate?") rather than either-or.
4. **Bahasa Melayu deadline words** ("sebelum", "menjelang", "minggu depan") are not read.

## Limits

One run on each set. The synthetic notes are the same three the prompt was tuned on. Draft marks from the first real run do not carry over, because the items differ. The review sheet for this run is `real-notes-review-2026-11-08-rerun.csv`, kept outside the repository, and has no marks yet.
