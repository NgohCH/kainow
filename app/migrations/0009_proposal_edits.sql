-- Reviewer edits to a proposal's wording. The model's own wording stays untouched in extraction_items;
-- an edit is a new row here, and the latest row is the wording in force. Rows are never changed or removed.

CREATE TABLE extraction_item_edits (
  id         uuid PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES extraction_items (id),
  text       text NOT NULL CHECK (btrim(text) <> ''),
  owner      text,
  due        text,
  edited_by  uuid NOT NULL REFERENCES users (id),
  edited_at  timestamptz NOT NULL
);
CREATE INDEX extraction_item_edits_item_idx ON extraction_item_edits (item_id, edited_at DESC, id DESC);

CREATE FUNCTION extraction_item_edits_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'extraction_item_edits is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER extraction_item_edits_no_change BEFORE UPDATE OR DELETE ON extraction_item_edits
  FOR EACH ROW EXECUTE FUNCTION extraction_item_edits_append_only();
CREATE TRIGGER extraction_item_edits_no_truncate BEFORE TRUNCATE ON extraction_item_edits
  FOR EACH STATEMENT EXECUTE FUNCTION extraction_item_edits_append_only();
