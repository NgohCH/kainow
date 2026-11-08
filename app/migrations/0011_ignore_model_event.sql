-- A reviewer can say the event the model named for a proposal's due does not apply. The model's event stays
-- recorded on the item; this edit flag stops it counting. Additive only.

ALTER TABLE extraction_item_edits ADD COLUMN ignore_model_event boolean NOT NULL DEFAULT false;
