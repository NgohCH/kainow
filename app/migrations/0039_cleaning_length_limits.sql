-- Upper length limits on registered text columns, in the form of 0027: the credential marker is longer than most secrets,
-- so a cleaned value may exceed the limit the application enforces on input. Each limit still holds for any value without
-- the marker; the application's own limits are unchanged. Every existing row passes: each limit only becomes wider.
ALTER TABLE project_stages DROP CONSTRAINT project_stages_name_check;
ALTER TABLE project_stages ADD CONSTRAINT project_stages_name_check CHECK (
  btrim(name) <> '' AND (char_length(name) <= 80 OR strpos(name, '[credential removed]') > 0));
ALTER TABLE project_stage_periods DROP CONSTRAINT project_stage_periods_stage_check;
ALTER TABLE project_stage_periods ADD CONSTRAINT project_stage_periods_stage_check CHECK (
  btrim(stage) <> '' AND (char_length(stage) <= 80 OR strpos(stage, '[credential removed]') > 0));
ALTER TABLE extraction_item_edits DROP CONSTRAINT extraction_item_edits_reason_check;
ALTER TABLE extraction_item_edits ADD CONSTRAINT extraction_item_edits_reason_check CHECK (
  reason IS NULL OR (char_length(reason) >= 1 AND (char_length(reason) <= 500 OR strpos(reason, '[credential removed]') > 0)));
ALTER TABLE ai_connections DROP CONSTRAINT ai_connections_label_check;
ALTER TABLE ai_connections ADD CONSTRAINT ai_connections_label_check CHECK (
  btrim(label) <> '' AND (char_length(label) <= 100 OR strpos(label, '[credential removed]') > 0));
