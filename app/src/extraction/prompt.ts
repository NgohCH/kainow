/**
 * The extraction instructions. Kept word for word the same as tests/extraction/run.mjs, which is the
 * check that the model quotes accurately. Change both together and re-run that check.
 */
export const EXTRACTION_SYSTEM_PROMPT =
  'Extract decisions, actions, open questions and risks from meeting notes. ' +
  'Each item must include source_quote copied exactly, character for character, ' +
  'from the notes. The source_quote must contain the whole clause that gives the item ' +
  'its meaning, including any approval, condition, exception or deadline that applies ' +
  '(for example, a rule plus the exception that needs written approval). ' +
  'Do not shorten a quote to one sentence if the rule depends on a following sentence. ' +
  'A source_quote must be ONE contiguous passage copied from one place in the notes. ' +
  'Never join text from separate sections, lines or table rows, and never add a separator ' +
  'such as a line break or table marker between two passages. If one item needs two places, ' +
  'split it into two items, each with its own quote. ' +
  'Do not invent items. Use null when owner or due is not stated.';

/** The most the model may write in one answer. It is also the output part of every spend reservation. */
export const MAX_OUTPUT_TOKENS = 8000;

/** How long to wait for one AI request before treating its outcome as unknown. */
export const REQUEST_TIMEOUT_MS = 120_000;

/** One request may be tried this many times in all (the first try plus two retries). */
export const MAX_ATTEMPTS = 3;
