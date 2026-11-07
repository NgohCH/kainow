# Extraction quality check

Checks AI extraction against meeting notes. Two thresholds from the handover (O16 / R19):

- **Supported proposals: 95%.** Every item's `source_quote` must appear verbatim in the input.
- **Expected items captured: 90%.** Each expected item's key phrase must appear in some quote the model returns.

## Running

Run this on a machine that can reach `api.openai.com`. The Kainow sandbox cannot.

```
export OPENAI_API_KEY=...            # your key, never committed
node tests/extraction/run.mjs         # uses inputs/synthetic by default
KAINOW_TEST_INPUTS=/path/to/notes node tests/extraction/run.mjs
KAINOW_MODEL=gpt-6.1-sol node tests/extraction/run.mjs   # try the alternate model
```

Without `OPENAI_API_KEY` the script exits without testing anything.

## What the score means

- The key-phrase match is an automated proxy. It doesn't judge meaning. A human reviewer must still adjudicate the expected items (R19) before a pass counts.
- `expected/*.json` files are DRAFTS and are not adjudicated.
- Real meeting notes must stay outside the repo. Point `KAINOW_TEST_INPUTS` at a folder on your computer. `out/` is git-ignored.

## Model

`config.json` names `gpt-6-luna` and `gpt-6.1-sol`, but `modelVerified` is `false`. Check both IDs against the provider's model list before relying on the results.

## Tests for the scoring code

```
node --test tests/extraction/score.test.mjs
```
