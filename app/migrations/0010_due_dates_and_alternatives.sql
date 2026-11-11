-- Due dates and unclear decisions (design of 8 November 2026).
-- The model now reports the meeting date, the event a due waits on, and possible answers to a question.
-- Kainow works out each due's reading when it is shown; readings are not stored. Additive only.

ALTER TABLE extraction_runs ADD COLUMN meeting_date date;

ALTER TABLE extraction_items ADD COLUMN due_event text;
ALTER TABLE extraction_items ADD COLUMN alternatives text[] NOT NULL DEFAULT '{}';

-- The model's fields, the new ones included, never change after insert; only the review decision does.
CREATE OR REPLACE FUNCTION extraction_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extraction_items are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.run_id, NEW.source_version_id, NEW.position, NEW.kind, NEW.text, NEW.owner, NEW.due,
      NEW.quote, NEW.quote_start, NEW.quote_end, NEW.quote_matches, NEW.created_at, NEW.due_event, NEW.alternatives)
     IS DISTINCT FROM
     (OLD.id, OLD.run_id, OLD.source_version_id, OLD.position, OLD.kind, OLD.text, OLD.owner, OLD.due,
      OLD.quote, OLD.quote_start, OLD.quote_end, OLD.quote_matches, OLD.created_at, OLD.due_event, OLD.alternatives) THEN
    RAISE EXCEPTION 'only the review decision of an extraction item can change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- A reviewer's due: an earliest and latest day, or the event the item waits on. Not both.
ALTER TABLE extraction_item_edits ADD COLUMN due_earliest date;
ALTER TABLE extraction_item_edits ADD COLUMN due_latest date;
ALTER TABLE extraction_item_edits ADD COLUMN due_event text;
ALTER TABLE extraction_item_edits ADD CONSTRAINT extraction_item_edits_dates_or_event
  CHECK (NOT (due_event IS NOT NULL AND due_earliest IS NOT NULL));
ALTER TABLE extraction_item_edits ADD CONSTRAINT extraction_item_edits_latest_after_earliest
  CHECK (due_latest IS NULL OR (due_earliest IS NOT NULL AND due_latest >= due_earliest));

-- The meeting date a reviewer gives for a note version. The latest row is the one in force.
CREATE TABLE source_version_meeting_dates (
  id                uuid PRIMARY KEY,
  source_version_id uuid        NOT NULL REFERENCES source_versions (id),
  meeting_date      date        NOT NULL,
  set_by            uuid        NOT NULL REFERENCES users (id),
  set_at            timestamptz NOT NULL
);
CREATE INDEX source_version_meeting_dates_version_idx ON source_version_meeting_dates (source_version_id, set_at DESC, id DESC);

CREATE FUNCTION source_version_meeting_dates_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'source_version_meeting_dates is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER source_version_meeting_dates_no_change BEFORE UPDATE OR DELETE ON source_version_meeting_dates
  FOR EACH ROW EXECUTE FUNCTION source_version_meeting_dates_append_only();
CREATE TRIGGER source_version_meeting_dates_no_truncate BEFORE TRUNCATE ON source_version_meeting_dates
  FOR EACH STATEMENT EXECUTE FUNCTION source_version_meeting_dates_append_only();
