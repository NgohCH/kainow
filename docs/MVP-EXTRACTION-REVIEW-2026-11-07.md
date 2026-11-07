# Extraction review record, 7 November 2026

Model: `gpt-6.1-sol`. Inputs: the three synthetic notes in `tests/extraction/inputs/synthetic`. Runner code: the reviewed run used the scorer as it was before alternative key phrases existed (the branch up to `1f1383c`; the extraction test files did not change in that range); the third run used `2465462`.
Reviewer: Ngoh Chee Hung (a person). The review sheet is `review-run-1794058732106.csv`, kept outside the repository.

This records the human review step of `tests/extraction/REVIEW-RUNBOOK.md`. It is **not yet a sign-off**: see "Still open".

## What was reviewed

The reviewed run is the first one. Under the scorer of that time its automatic result was: SYN-01 supported 100%, captured 86% (A2 missed); SYN-02 100% and 100%; SYN-03 supported 100%, captured 88% (A2 missed). It produced 33 items: SYN-01 12, SYN-02 10, SYN-03 11.

Two later runs were not reviewed row by row. The second run (old scorer): SYN-01 captured 86%, SYN-02 and SYN-03 100%. The third run (scorer with alternative key phrases, `2465462`): all three at 100% supported and 100% captured. The model's answers differ from run to run.

## Counts from the review sheet

Third version of the sheet. The reviewer filled `conditional_ok` (blank means the item is not conditional). SYN-01 rows 3 to 6 were then corrected on the reviewer's instruction, after Claude pointed out that the owner and conditional marks sat one row out; the reviewer adopted the suggested marks. The reviewer then asked for SYN-01 item 11 (draft sent to the Chair for approval) and SYN-02 item 6 (announce only after registry confirmation) to be marked the same way; both are marked conditional, because each depends on an approval or confirmation.

| Measure | Result | Threshold |
| --- | --- | --- |
| Supported (quote appears word for word) | 33 of 33 (100%): SYN-01 12/12, SYN-02 10/10, SYN-03 11/11. Computed by the script, not by the reviewer | 95% |
| Classification not OK | 2: SYN-01 item 12 and SYN-02 item 10 (the date of the next meeting is not a decision) | - |
| Owner not OK | 1: SYN-01 item 4 (the owner named is the approver, not the person accountable) | - |
| Conditional wording | Marked OK on 11 conditional items (SYN-01 items 4, 6, 11; SYN-02 items 2, 5, 6, 7, 9; SYN-03 items 2, 3, 5). None marked not OK | - |
| Classification, owner and conditional all OK | 30 of 33 (91%): SYN-01 10/12, SYN-02 9/10, SYN-03 11/11 | no threshold set |
| Duplicates marked | 2 (SYN-03 item 10 repeats item 6; item 11 repeats item 8). They are still counted above | - |
| Invented items | None recorded | - |

## Expected items captured (R19)

The reviewer marked the expected items by meaning on a table of the 22 expected items (plain meaning, closest model item, and a suggested marking from Claude that the reviewer was free to change). All 22 are marked captured, the same as the suggestion.

| Note | Marked captured |
| --- | --- |
| SYN-01 | 7 of 7 |
| SYN-02 | 7 of 7 |
| SYN-03 | 8 of 8 (D1 was first left blank, then marked captured by the reviewer) |

No row was marked partly captured or missed. Each meets the 90% bar on its own, as the policy requires. The reason for each row was drafted by Claude at the reviewer's request, from the model's items and the notes (owner, deadline and conditions compared); the reviewer chose the markings.

The two items the automatic matcher missed (SYN-01 A2 and SYN-03 A2) were confirmed by the reviewer to be present, and are recorded as `alsoKeys` in the expected files. The automatic key-phrase score is a proxy only.

## Still open

1. A review of a later run, and of real meeting notes, before relying on the 95% and 90% result for the product. The reviewed run is the first of three, the model's answers differ between runs, and the synthetic notes are not real notes.
2. Sign-off. This record is the human review of the three synthetic notes; it is not an acceptance of O16 and R19 for the product.
