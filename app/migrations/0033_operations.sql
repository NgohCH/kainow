-- Sub-project 10a: operations. Settings, protective mode, backup runs, restore drills, storage readings, alerts.

-- ---------------------------------------------------------------------------
-- Operations settings (D110, D113-D115): one row, the primary key is the constant true.
-- ---------------------------------------------------------------------------
CREATE TABLE operations_settings (
  id                         boolean PRIMARY KEY DEFAULT true CHECK (id),
  backup_retention_days      integer NOT NULL DEFAULT 30 CHECK (backup_retention_days BETWEEN 7 AND 365),
  storage_warning_pct        integer NOT NULL DEFAULT 80 CHECK (storage_warning_pct BETWEEN 50 AND 95),
  storage_critical_pct       integer NOT NULL DEFAULT 90 CHECK (storage_critical_pct <= 99),
  safe_floor_gb              integer NOT NULL DEFAULT 5  CHECK (safe_floor_gb BETWEEN 1 AND 1000),
  diagnostic_retention_days  integer NOT NULL DEFAULT 30 CHECK (diagnostic_retention_days BETWEEN 7 AND 365),
  CONSTRAINT operations_settings_critical_above_warning CHECK (storage_critical_pct > storage_warning_pct)
);
INSERT INTO operations_settings DEFAULT VALUES;

CREATE TABLE operations_settings_changes (
  id         uuid PRIMARY KEY,
  actor_id   uuid        NOT NULL REFERENCES users (id),
  at         timestamptz NOT NULL,
  reason     text        NOT NULL CHECK (btrim(reason) <> ''),
  previous   jsonb       NOT NULL,
  next       jsonb       NOT NULL
);
CREATE INDEX operations_settings_changes_at_idx ON operations_settings_changes (at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Protective mode: one row, plus its append-only history (10b adds the reason 'update').
-- ---------------------------------------------------------------------------
CREATE TABLE operations_state (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  protective  boolean NOT NULL DEFAULT false,
  reason      text    CHECK (reason IN ('low_space', 'restored_from_backup')),
  since       timestamptz,
  detail      jsonb,
  changed_by  uuid    REFERENCES users (id)
);
INSERT INTO operations_state DEFAULT VALUES;

CREATE TABLE operations_state_changes (
  id        uuid PRIMARY KEY,
  at        timestamptz NOT NULL,
  action    text        NOT NULL CHECK (action IN ('entered', 'resumed')),
  actor_id  uuid        REFERENCES users (id),   -- NULL: Kainow itself
  reason    text,
  detail    jsonb
);
CREATE INDEX operations_state_changes_at_idx ON operations_state_changes (at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Backup runs and restore drills.
-- ---------------------------------------------------------------------------
CREATE TABLE backup_runs (
  id                uuid PRIMARY KEY,
  kind              text        NOT NULL CHECK (kind IN ('daily', 'manual', 'pre_update')),
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz,
  outcome           text        NOT NULL CHECK (outcome IN ('running', 'succeeded', 'failed')),
  failure_code      text,
  failure_detail    text,                         -- fixed text only
  set_name          text,
  folder_label      text,
  key_id            text,
  kainow_version    text,
  migration_level   text,
  database_bytes    bigint,
  files_total       integer,
  files_new         integer,
  files_new_bytes   bigint,
  files_not_copied  integer,
  source_area       text        CHECK (source_area IN ('included', 'not_in_use')),
  manifest_sha256   text,
  expired_at        timestamptz
);
CREATE INDEX backup_runs_started_idx ON backup_runs (started_at DESC, id DESC);

CREATE TABLE restore_drills (
  id                uuid PRIMARY KEY,
  backup_run_id     uuid REFERENCES backup_runs (id),
  set_name          text,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz,
  outcome           text        NOT NULL CHECK (outcome IN ('running', 'passed', 'passed_over_target', 'failed')),
  duration_seconds  integer,
  sampled           boolean     NOT NULL DEFAULT false,
  checks            jsonb       NOT NULL DEFAULT '[]',
  failure_code      text,
  kept_database     text,
  key_id            text,
  folder_label      text
);
CREATE INDEX restore_drills_started_idx ON restore_drills (started_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Storage readings, their daily summary and alert episodes.
-- ---------------------------------------------------------------------------
CREATE TABLE storage_readings (
  id           uuid PRIMARY KEY,
  at           timestamptz NOT NULL,
  location     text        NOT NULL CHECK (location IN ('database_disk', 'backup_disk', 'source_area')),
  total_bytes  bigint,
  free_bytes   bigint,
  used_bytes   bigint,
  extra        jsonb,
  unavailable  boolean     NOT NULL DEFAULT false
);
CREATE INDEX storage_readings_location_idx ON storage_readings (location, at DESC, id DESC);

CREATE TABLE storage_daily (
  day             date   NOT NULL,
  location        text   NOT NULL CHECK (location IN ('database_disk', 'backup_disk', 'source_area')),
  max_used_bytes  bigint,
  min_free_bytes  bigint,
  total_bytes     bigint,
  PRIMARY KEY (day, location)
);

CREATE TABLE ops_alerts (
  id         uuid PRIMARY KEY,
  kind       text        NOT NULL,
  location   text,
  opened_at  timestamptz NOT NULL,
  closed_at  timestamptz
);
-- One open episode per kind and location.
CREATE UNIQUE INDEX ops_alerts_open_key ON ops_alerts (kind, coalesce(location, '')) WHERE closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Email outbox: a message queued before a restore is never sent after it.
-- ---------------------------------------------------------------------------
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_status_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_status_check
  CHECK (status IN ('queued', 'sending', 'retry_wait', 'sent', 'failed', 'cancelled', 'uncertain', 'not_sent_restored'));

-- ---------------------------------------------------------------------------
-- Append-only history.
-- ---------------------------------------------------------------------------
CREATE TRIGGER operations_settings_changes_append_only BEFORE UPDATE OR DELETE ON operations_settings_changes
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER operations_settings_changes_no_truncate BEFORE TRUNCATE ON operations_settings_changes
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER operations_state_changes_append_only BEFORE UPDATE OR DELETE ON operations_state_changes
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER operations_state_changes_no_truncate BEFORE TRUNCATE ON operations_state_changes
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
