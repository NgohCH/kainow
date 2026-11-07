-- Notes intake (milestone M3).
-- A source is one set of meeting notes. Each edit or re-upload is a new immutable version.
-- Extraction and review later bind to one exact version, so versions are never changed or deleted.

CREATE TABLE sources (
  id          uuid PRIMARY KEY,
  title       text        NOT NULL CHECK (btrim(title) <> ''),
  created_by  uuid        NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL,
  -- Logical deletion only. Nothing is ever physically removed in the MVP.
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted'))
);

CREATE TABLE source_versions (
  id                uuid PRIMARY KEY,
  source_id         uuid        NOT NULL REFERENCES sources (id),
  version_no        integer     NOT NULL CHECK (version_no >= 1),
  origin            text        NOT NULL CHECK (origin IN ('paste', 'upload')),
  filename          text,
  media_type        text,
  -- The uploaded bytes exactly as received (decision: originals live in PostgreSQL for the MVP).
  -- NULL for pasted text, which has no separate original.
  original_bytes    bytea,
  original_sha256   text,
  -- The normalised text (NFC, LF line ends). Quote offsets refer to this text, as UTF-16 code units.
  text_content      text        NOT NULL CHECK (text_content <> ''),
  text_sha256       text        NOT NULL,
  char_count        integer     NOT NULL CHECK (char_count > 0),
  created_by        uuid        NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL,
  UNIQUE (source_id, version_no),
  CONSTRAINT source_versions_upload_has_original CHECK (
    (origin = 'upload' AND original_bytes IS NOT NULL AND original_sha256 IS NOT NULL AND filename IS NOT NULL)
    OR (origin = 'paste' AND original_bytes IS NULL AND original_sha256 IS NULL)
  )
);

CREATE INDEX source_versions_source_idx ON source_versions (source_id, version_no);

-- Versions are immutable: they can be neither changed nor deleted.
CREATE FUNCTION source_versions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'source_versions are immutable' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_versions_no_update BEFORE UPDATE ON source_versions
  FOR EACH ROW EXECUTE FUNCTION source_versions_immutable();
CREATE TRIGGER source_versions_no_delete BEFORE DELETE ON source_versions
  FOR EACH ROW EXECUTE FUNCTION source_versions_immutable();
CREATE TRIGGER source_versions_no_truncate BEFORE TRUNCATE ON source_versions
  FOR EACH STATEMENT EXECUTE FUNCTION source_versions_immutable();

-- A source row may only change its title or status; it is never deleted.
CREATE FUNCTION sources_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sources are never deleted; mark them deleted instead' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sources_no_delete BEFORE DELETE ON sources
  FOR EACH ROW EXECUTE FUNCTION sources_no_delete();
CREATE TRIGGER sources_no_truncate BEFORE TRUNCATE ON sources
  FOR EACH STATEMENT EXECUTE FUNCTION sources_no_delete();
