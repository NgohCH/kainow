-- Which place a repeated quote was meant to point at (reviewer's explicit choice).
-- 0-based, the same numbering as `locateQuote`'s occurrence. Set only on an approved proposal whose quote
-- appears more than once; NULL otherwise. It replaces the earlier "I checked" tick, which only confirmed
-- the first place without recording it.

ALTER TABLE extraction_items ADD COLUMN chosen_occurrence integer;

-- Proposals approved under the earlier tick were approved against the highlighted first place.
UPDATE extraction_items SET chosen_occurrence = 0 WHERE review_status = 'approved' AND quote_matches > 1;

ALTER TABLE extraction_items
  ADD CONSTRAINT extraction_items_chosen_occurrence_valid CHECK (
    (review_status = 'approved' AND quote_matches > 1 AND chosen_occurrence IS NOT NULL AND chosen_occurrence >= 0 AND chosen_occurrence < quote_matches)
    OR (NOT (review_status = 'approved' AND quote_matches > 1) AND chosen_occurrence IS NULL)
  );
