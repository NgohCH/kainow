-- AI extraction (milestone M4b).
-- A run is one attempt-set to extract proposals from one exact source version.
-- Proposals ("items") are never trusted: each keeps the model's quote and, when the quote is found
-- in the stored text, its character offsets (UTF-16 code units, end exclusive).

CREATE TABLE extraction_runs (
  id                uuid PRIMARY KEY,
  source_version_id uuid        NOT NULL REFERENCES source_versions (id),
  requested_by      uuid        NOT NULL REFERENCES users (id),
  status            text        NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'blocked')),
  model_id          text,
  -- Why a run failed or was blocked, in a fixed vocabulary. failure_detail never contains note text or secrets.
  failure_code      text,
  failure_detail    text,
  attempts          integer     NOT NULL DEFAULT 0,
  item_count        integer,
  unlocated_count   integer,
  created_at        timestamptz NOT NULL,
  started_at        timestamptz,
  finished_at       timestamptz,
  CONSTRAINT extraction_runs_failure_has_code CHECK (status NOT IN ('failed', 'blocked') OR failure_code IS NOT NULL)
);

-- At most one queued or running extraction for a version, so a double click cannot pay twice.
CREATE UNIQUE INDEX extraction_runs_one_active_per_version
  ON extraction_runs (source_version_id) WHERE status IN ('queued', 'running');
CREATE INDEX extraction_runs_version_idx ON extraction_runs (source_version_id, created_at);

CREATE TABLE extraction_items (
  id                uuid PRIMARY KEY,
  run_id            uuid    NOT NULL REFERENCES extraction_runs (id),
  source_version_id uuid    NOT NULL REFERENCES source_versions (id),
  position          integer NOT NULL CHECK (position >= 0),
  kind              text    NOT NULL CHECK (kind IN ('decision', 'action', 'question', 'risk')),
  text              text    NOT NULL,
  owner             text,
  due               text,
  -- Exactly what the model quoted, before any matching.
  quote             text    NOT NULL,
  -- Offsets of the first place the quote occurs in the version's stored text; NULL if it occurs nowhere.
  quote_start       integer,
  quote_end         integer,
  -- How many places the quote occurs. More than 1 means the model's intended place is ambiguous.
  quote_matches     integer NOT NULL CHECK (quote_matches >= 0),
  review_status     text    NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  created_at        timestamptz NOT NULL,
  UNIQUE (run_id, position),
  CONSTRAINT extraction_items_offsets_agree CHECK (
    (quote_matches = 0 AND quote_start IS NULL AND quote_end IS NULL)
    OR (quote_matches > 0 AND quote_start IS NOT NULL AND quote_end IS NOT NULL AND quote_end > quote_start AND quote_start >= 0)
  )
);
CREATE INDEX extraction_items_run_idx ON extraction_items (run_id, position);
