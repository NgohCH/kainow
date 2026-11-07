-- Review of proposals (milestone M5).
-- A proposal's content never changes after the model's answer is saved; only its review decision can.

ALTER TABLE extraction_items
  ADD COLUMN reviewed_by uuid REFERENCES users (id),
  ADD COLUMN reviewed_at timestamptz,
  ADD CONSTRAINT extraction_items_review_is_complete CHECK (
    (review_status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_status <> 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  -- A passage that cannot be found in the notes can be rejected but never approved.
  ADD CONSTRAINT extraction_items_unlocated_not_approved CHECK (review_status <> 'approved' OR quote_matches > 0);

CREATE FUNCTION extraction_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extraction_items are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.run_id, NEW.source_version_id, NEW.position, NEW.kind, NEW.text, NEW.owner, NEW.due,
      NEW.quote, NEW.quote_start, NEW.quote_end, NEW.quote_matches, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.run_id, OLD.source_version_id, OLD.position, OLD.kind, OLD.text, OLD.owner, OLD.due,
      OLD.quote, OLD.quote_start, OLD.quote_end, OLD.quote_matches, OLD.created_at) THEN
    RAISE EXCEPTION 'only the review decision of an extraction item can change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER extraction_items_guard_update BEFORE UPDATE ON extraction_items
  FOR EACH ROW EXECUTE FUNCTION extraction_items_guard();
CREATE TRIGGER extraction_items_guard_delete BEFORE DELETE ON extraction_items
  FOR EACH ROW EXECUTE FUNCTION extraction_items_guard();
