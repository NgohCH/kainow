# Extraction review record, 7 November 2026

Model: `gpt-6.1-sol`. Inputs: the three synthetic notes in `tests/extraction/inputs/synthetic`. Runner code: the reviewed run used the scorer as it was before alternative key phrases existed (the branch up to `1f1383c`; the extraction test files did not change in that range); the third run used `2465462`.
Reviewer: Ngoh Chee Hung (a person). The review sheet is `review-run-1794058732106.csv`, kept outside the repository.

This records the human review step of `tests/extraction/REVIEW-RUNBOOK.md`. It is **not yet a sign-off**: see "Still open".

## What was reviewed

The reviewed run is the first one. Under the scorer of that time its automatic result was: SYN-01 supported 100%, captured 86% (A2 missed); SYN-02 100% and 100%; SYN-03 supported 100%, captured 88% (A2 missed). It produced 33 items: SYN-01 12, SYN-02 10, SYN-03 11.

Two later runs were not reviewed row by row. The second run (old scorer): SYN-01 captured 86%, SYN-02 and SYN-03 100%. The third run (scorer with alternative key phrases, `2465462`): all three at 100% supported and 100% captured. The model's answers differ from run to run.

## Counts from the review sheet

Second version of the sheet, as marked by the reviewer (`conditional_ok` filled; blank means the item is not conditional).

| Measure | Result | Threshold |
| --- | --- | --- |
| Supported (quote appears word for word) | 33 of 33 (100%): SYN-01 12/12, SYN-02 10/10, SYN-03 11/11. Computed by the script, not by the reviewer | 95% |
| Classification not OK | 2: SYN-01 item 12 and SYN-02 item 10 (the date of the next meeting is not a decision) | - |
| Owner not OK | 2: SYN-01 items 3 and 4 (see "Still open" about item 3) | - |
| Conditional wording | Marked OK on 10 conditional items (SYN-01 items 3, 5, 11; SYN-02 items 2, 5, 7, 9; SYN-03 items 2, 3, 5). None marked not OK | - |
| Classification, owner and conditional all OK | 29 of 33 (88%): SYN-01 9/12, SYN-02 9/10, SYN-03 11/11 | no threshold set |
| Duplicates marked | 2 (SYN-03 item 10 repeats item 6; item 11 repeats item 8). They are still counted above | - |
| Invented items | None recorded | - |

## Expected items captured (R19)

The two items the automatic matcher missed (SYN-01 A2 and SYN-03 A2) were confirmed by the reviewer to be present in the model's output, from the action-list line and from the narrative sentence. They are recorded as `alsoKeys` in the expected files.

The reviewer has **not yet** judged every expected item by meaning on the marking sheet (`make-marking.mjs`). The automatic figure is a proxy only.

## Still open

1. The reviewer's judgement by meaning on every expected item (the marking sheet).
2. SYN-01 items 3 to 6 need a second look by the reviewer. Item 3 (a risk with no owner and no condition) is marked owner not OK and conditional OK, while item 4 (the decision that needs the Head of Department's approval) and item 6 (the late-fee rule with its exception) have no conditional mark. These may be marked one row out. If item 3's owner mark is a slip, the combined figure is 30 of 33 (91%).
3. A review of a later run, and of real meeting notes, before relying on the 95% and 90% result for the product.

The synthetic notes are not real notes; this result says the setup works and does not show the rate on real ones.
