-- Interface redesign: an optional organisation colour, and a correction of an AI proposal's type with a reason.

-- Lower-case hex only; the server lower-cases before storing. NULL means the built-in default colour.
ALTER TABLE organisation
  ADD COLUMN colour text CHECK (colour ~ '^#[0-9a-f]{6}$');

-- A reviewer's edit may also correct the proposal's type (same set as extraction_items.kind) and say why.
-- The append-only triggers on extraction_item_edits stay.
ALTER TABLE extraction_item_edits
  ADD COLUMN kind   text CHECK (kind IN ('decision', 'action', 'question', 'risk')),
  ADD COLUMN reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500);
