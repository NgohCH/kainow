# Extraction re-run and review runbook

Purpose: close O16 (supported proposals) and R19 (expected items captured) with evidence. Run it on a machine that can reach the provider, with your own key.

## 1. Prepare

1. Pull the latest code: `git pull origin main`. It must include commit `195ba1b` or later, so a missing expected file fails instead of passing.
2. Confirm the expected files are present: `ls tests/extraction/expected` should list `SYN-01.json`, `SYN-02.json`, `SYN-03.json`.
3. Confirm the inputs match the repo copies: `diff -r tests/extraction/inputs/synthetic <your synthetic folder>`.
4. Set the key for this session only: `export OPENAI_API_KEY=...`. Never commit it.

## 2. Run both models

```
node --test tests/extraction/score.test.mjs
node tests/extraction/run.mjs                                  # gpt-6-luna (default)
KAINOW_MODEL=gpt-6.1-sol node tests/extraction/run.mjs         # gpt-6.1-sol
```

Each run writes `tests/extraction/out/run-<timestamp>.json`. Keep the runner's console output with each file.

## 3. Create review sheets

```
node tests/extraction/make-review.mjs tests/extraction/out/run-<gpt-6-luna>.json
node tests/extraction/make-review.mjs tests/extraction/out/run-<gpt-6.1-sol>.json
```

The sheets are in `tests/extraction/out/review-*.csv`. `quote_verbatim` is computed automatically. Any row marked `NO` fails the 95% check for that item.

## 4. Reviewer fills the sheet (human only)

For each row:

- `classification_ok`: is it a decision, action, question or risk, and is that the right category? Policies and conditions are not actions.
- `owner_ok`: is the owner the person accountable for the outcome? A person who raises a concern is not automatically the owner.
- `conditional_ok`: if the item depends on approval or testing, does it stay conditional?
- `duplicate_of`: give the item number this repeats, if any.
- `reviewer_notes`: anything else.

Then count, per model:

- Supported: rows with `quote_verbatim = yes` / total. Pass at 95% or more.
- Captured: expected items matched by meaning / total expected items. Pass at 90% or more. Reviewer records each match or miss.
- Accuracy: rows with classification, owner and conditional all OK / total.
- Invented items: rows the reviewer judges as not supported by the meeting.

## 5. Record

Write the result in `docs/` with: model, date, runner commit, reviewer name, the counts above, and any items the reviewer rejected. Record the reviewer as a human. An AI reviewer's note is supporting evidence only.

Do not commit real meeting notes or the `out/` folder.
