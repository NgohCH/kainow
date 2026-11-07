# Extraction review record, 7 November 2026

Model: `gpt-6.1-sol`. Inputs: the three synthetic notes in `tests/extraction/inputs/synthetic`. Runner code: the reviewed run used the scorer as it was before alternative key phrases existed (the branch up to `1f1383c`; the extraction test files did not change in that range); the third run used `2465462`.
Reviewer: Ngoh Chee Hung (a person). The review sheet is `review-run-1794058732106.csv`, kept outside the repository.

This records the human review step of `tests/extraction/REVIEW-RUNBOOK.md`. It is **not yet a sign-off**: see "Still open".

## What was reviewed

The reviewed run is the first one. Under the scorer of that time its automatic result was: SYN-01 supported 100%, captured 86% (A2 missed); SYN-02 100% and 100%; SYN-03 supported 100%, captured 88% (A2 missed). It produced 33 items: SYN-01 12, SYN-02 10, SYN-03 11.

Two later runs were not reviewed row by row. The second run (old scorer): SYN-01 captured 86%, SYN-02 and SYN-03 100%. The third run (scorer with alternative key phrases, `2465462`): all three at 100% supported and 100% captured. The model's answers differ from run to run.

## Counts from the review sheet

| Measure | Result | Threshold |
| --- | --- | --- |
| Supported (quote appears word for word) | 33 of 33 (100%): SYN-01 12/12, SYN-02 10/10, SYN-03 11/11. Computed by the script, not by the reviewer | 95% |
| Classification and owner both marked OK by the reviewer | 30 of 33 (91%): SYN-01 10/12, SYN-02 9/10, SYN-03 11/11 | no threshold set |
| Conditional wording (`conditional_ok`) | **Not marked on any row** | no threshold set |
| Duplicates marked | 2 (SYN-03 item 10 repeats item 6; item 11 repeats item 8) | - |
| Invented items | None recorded | - |

The reviewer's changes to the first marks: SYN-01 item 4, owner not OK (the owner named is the approver, not the person accountable); SYN-01 item 12 and SYN-02 item 10, classification not OK (the date of the next meeting is not a decision). Notes were added to SYN-01 item 1 and SYN-02 item 5, where the due field holds an event date and not a deadline. SYN-03 has no item for the next meeting.

## Expected items captured (R19)

The two items the automatic matcher missed (SYN-01 A2 and SYN-03 A2) were confirmed by the reviewer to be present in the model's output, from the action-list line and from the narrative sentence. They are recorded as `alsoKeys` in the expected files.

The reviewer has **not yet** judged every expected item by meaning on the marking sheet (`make-marking.mjs`). The automatic figure is a proxy only.

## Still open

1. The reviewer's judgement by meaning on every expected item (the marking sheet).
2. The `conditional_ok` mark on every row, so the combined accuracy figure (classification, owner and conditional all OK) can be calculated.
3. A review of a later run, and of real meeting notes, before relying on the 95% and 90% result for the product.

The synthetic notes are not real notes; this result says the setup works and does not show the rate on real ones.
