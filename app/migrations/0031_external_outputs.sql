-- V1.0 sub-project 9: external outputs (output register, SharePoint/OneDrive storage, managed source area).
-- Design: docs/superpowers/specs/2026-11-20-v1-external-outputs-design.md (section 13).
-- Additive, except that the change_requests kind and target CHECKs, the source_versions upload CHECK and the
-- source_versions immutability trigger are widened. Event and move tables are append-only; output versions are
-- immutable apart from the four columns the filing and approval flows set.

-- ---------------------------------------------------------------------------
-- Report types (R14): a fixed starting list the Administrator can extend and retire.
-- ---------------------------------------------------------------------------
CREATE TABLE report_types (
  id          uuid PRIMARY KEY,
  name        text        NOT NULL UNIQUE CHECK (btrim(name) <> '' AND char_length(name) <= 100),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  position    integer     NOT NULL,
  created_by  uuid        REFERENCES users (id),
  created_at  timestamptz NOT NULL,
  updated_by  uuid        REFERENCES users (id),
  updated_at  timestamptz
);
INSERT INTO report_types (id, name, position, created_at) VALUES
  (gen_random_uuid(), 'Status reports', 1, now()),
  (gen_random_uuid(), 'Decisions and actions', 2, now()),
  (gen_random_uuid(), 'Risk summaries', 3, now()),
  (gen_random_uuid(), 'Specifications', 4, now()),
  (gen_random_uuid(), 'Minutes', 5, now()),
  (gen_random_uuid(), 'Exports', 6, now()),
  (gen_random_uuid(), 'Other', 7, now());

-- ---------------------------------------------------------------------------
-- Storage settings (one row) and the sealed connection secret (one current row).
-- ---------------------------------------------------------------------------
CREATE TABLE storage_settings (
  id                               boolean PRIMARY KEY DEFAULT true CHECK (id),
  tenant_id                        text,
  client_id                        text,
  approved_input_formats           text[]  NOT NULL DEFAULT '{txt,md,docx,pdf}',
  approved_output_formats          text[]  NOT NULL DEFAULT '{md,docx,pdf,csv}',
  projects_may_change_formats      boolean NOT NULL DEFAULT true,
  projects_may_choose_destination  boolean NOT NULL DEFAULT true,
  projects_may_set_export_roles    boolean NOT NULL DEFAULT true,
  directory_lookup                 boolean NOT NULL DEFAULT false,
  scheduled_checks                 boolean NOT NULL DEFAULT false
);
INSERT INTO storage_settings DEFAULT VALUES;

CREATE TABLE storage_settings_changes (
  id        uuid PRIMARY KEY,
  actor_id  uuid        NOT NULL REFERENCES users (id),
  at        timestamptz NOT NULL,
  reason    text        NOT NULL CHECK (btrim(reason) <> ''),
  previous  jsonb       NOT NULL,
  next      jsonb       NOT NULL
);
CREATE INDEX storage_settings_changes_at_idx ON storage_settings_changes (at);

-- The client secret, sealed (AES-256-GCM) like ai_connection_keys. Only the row with superseded_at NULL is current.
CREATE TABLE storage_connection_secrets (
  id             uuid PRIMARY KEY,
  ciphertext     bytea       NOT NULL,
  nonce          bytea       NOT NULL,
  tag            bytea       NOT NULL,
  key_id         text        NOT NULL,
  saved_by       uuid        NOT NULL REFERENCES users (id),
  saved_at       timestamptz NOT NULL,
  superseded_at  timestamptz
);
CREATE UNIQUE INDEX storage_connection_secrets_current ON storage_connection_secrets ((true)) WHERE superseded_at IS NULL;

-- ---------------------------------------------------------------------------
-- Destinations (the source area and output libraries), their events and the folder cache.
-- ---------------------------------------------------------------------------
CREATE TABLE storage_destinations (
  id               uuid PRIMARY KEY,
  connector        text        NOT NULL CHECK (connector IN ('graph', 'local')),
  kind             text        NOT NULL CHECK (kind IN ('sharepoint_library', 'onedrive', 'local')),
  purpose          text        NOT NULL CHECK (purpose IN ('source_area', 'outputs')),
  label            text        NOT NULL CHECK (btrim(label) <> ''),
  site_url         text,
  account_email    text,
  folder_path      text,
  site_id          text,
  drive_id         text,
  root_item_id     text,
  status           text        NOT NULL CHECK (status IN ('proposed', 'approved', 'withdrawn')),
  last_check       jsonb,
  last_checked_at  timestamptz,
  created_by       uuid        NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL
);
-- At most one approved source area.
CREATE UNIQUE INDEX one_source_area ON storage_destinations ((true)) WHERE purpose = 'source_area' AND status = 'approved';
CREATE INDEX storage_destinations_purpose_idx ON storage_destinations (purpose, status);

CREATE TABLE storage_destination_events (
  id              uuid PRIMARY KEY,
  destination_id  uuid        NOT NULL REFERENCES storage_destinations (id),
  kind            text        NOT NULL CHECK (kind IN ('proposed', 'checked', 'approved', 'withdrawn')),
  actor_id        uuid        REFERENCES users (id),
  at              timestamptz NOT NULL,
  reason          text,
  detail          jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX storage_destination_events_destination_idx ON storage_destination_events (destination_id, at);

CREATE TABLE storage_folders (
  id              uuid PRIMARY KEY,
  destination_id  uuid        NOT NULL REFERENCES storage_destinations (id),
  level           text        NOT NULL CHECK (level IN ('department', 'project', 'year', 'report_type', 'restricted_root', 'output', 'source_root')),
  key             text        NOT NULL,
  item_id         text        NOT NULL,
  name            text        NOT NULL,
  created_at      timestamptz NOT NULL,
  UNIQUE (destination_id, level, key)
);

-- ---------------------------------------------------------------------------
-- Stored files (provider-neutral references), their moves, the job outbox and attempt log.
-- ---------------------------------------------------------------------------
CREATE TABLE stored_files (
  id               uuid PRIMARY KEY,
  purpose          text        NOT NULL CHECK (purpose IN ('source_original', 'source_text', 'output')),
  project_id       uuid        NOT NULL REFERENCES projects (id),
  destination_id   uuid        REFERENCES storage_destinations (id),
  connector        text,
  drive_id         text,
  item_id          text,
  path             text,
  name             text        NOT NULL,
  size_bytes       bigint,
  sha256           text,
  provider_hash    text,
  etag             text,
  ctag             text,
  web_url          text,
  state            text        NOT NULL CHECK (state IN ('pending', 'storing', 'stored', 'failed', 'withheld', 'relocating', 'missing', 'linked')),
  check_status     text        NOT NULL DEFAULT 'unverified' CHECK (check_status IN ('ok', 'changed', 'moved', 'missing', 'access_denied', 'unverified')),
  last_checked_at  timestamptz,
  failure_code     text,
  attempts         integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL,
  stored_at        timestamptz
);
CREATE INDEX stored_files_project_idx ON stored_files (project_id, purpose);
CREATE INDEX stored_files_state_idx ON stored_files (state, created_at);
CREATE INDEX stored_files_check_idx ON stored_files (last_checked_at NULLS FIRST) WHERE state = 'stored';
CREATE INDEX stored_files_destination_idx ON stored_files (destination_id) WHERE destination_id IS NOT NULL;

CREATE TABLE stored_file_moves (
  id                  uuid PRIMARY KEY,
  stored_file_id      uuid        NOT NULL REFERENCES stored_files (id),
  reason              text        NOT NULL,
  old_destination_id  uuid        REFERENCES storage_destinations (id),
  old_drive_id        text,
  old_item_id         text,
  old_path            text,
  new_destination_id  uuid        REFERENCES storage_destinations (id),
  new_drive_id        text,
  new_item_id         text,
  new_path            text,
  actor_id            uuid        REFERENCES users (id),
  at                  timestamptz NOT NULL
);
CREATE INDEX stored_file_moves_file_idx ON stored_file_moves (stored_file_id, at);

CREATE TABLE storage_outbox (
  id          uuid PRIMARY KEY,
  job         text        NOT NULL,
  subject_id  uuid        NOT NULL,
  created_at  timestamptz NOT NULL,
  sent_at     timestamptz
);
CREATE INDEX storage_outbox_unsent_idx ON storage_outbox (created_at) WHERE sent_at IS NULL;

CREATE TABLE storage_attempts (
  id               uuid PRIMARY KEY,
  job              text        NOT NULL,
  subject_id       uuid        NOT NULL,
  outcome          text        NOT NULL,
  provider_status  integer,
  duration_ms      integer     NOT NULL,
  at               timestamptz NOT NULL
);
CREATE INDEX storage_attempts_subject_idx ON storage_attempts (subject_id, at);

-- ---------------------------------------------------------------------------
-- Sharing: grants Kainow created on folders (never on files), and Storage Administrators (A14, D104).
-- ---------------------------------------------------------------------------
CREATE TABLE storage_grants (
  id             uuid PRIMARY KEY,
  folder_id      uuid        NOT NULL REFERENCES storage_folders (id),
  user_id        uuid        NOT NULL REFERENCES users (id),
  role           text        NOT NULL CHECK (role IN ('read', 'write')),
  state          text        NOT NULL CHECK (state IN ('pending', 'granted', 'not_found', 'revoking', 'revoked', 'failed')),
  permission_id  text,
  updated_at     timestamptz NOT NULL
);
CREATE UNIQUE INDEX storage_grants_live ON storage_grants (folder_id, user_id) WHERE state <> 'revoked';
CREATE INDEX storage_grants_user_idx ON storage_grants (user_id);

CREATE TABLE storage_admins (
  id             uuid PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES users (id),
  designated_by  uuid        NOT NULL REFERENCES users (id),
  designated_at  timestamptz NOT NULL,
  reason         text        NOT NULL CHECK (btrim(reason) <> ''),
  ended_at       timestamptz,
  ended_by       uuid        REFERENCES users (id),
  end_reason     text        CHECK (end_reason IS NULL OR btrim(end_reason) <> ''),
  CONSTRAINT storage_admins_not_self CHECK (designated_by <> user_id),
  CONSTRAINT storage_admins_ended_together CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX storage_admins_current ON storage_admins (user_id) WHERE ended_at IS NULL;

CREATE TABLE storage_admin_events (
  id        uuid PRIMARY KEY,
  admin_id  uuid        NOT NULL REFERENCES storage_admins (id),
  kind      text        NOT NULL CHECK (kind IN ('designated', 'ended')),
  actor_id  uuid        NOT NULL REFERENCES users (id),
  at        timestamptz NOT NULL,
  reason    text        NOT NULL CHECK (btrim(reason) <> '')
);
CREATE INDEX storage_admin_events_admin_idx ON storage_admin_events (admin_id, at);

-- ---------------------------------------------------------------------------
-- The managed source area: source versions may keep their original (and text) in a stored file.
-- ---------------------------------------------------------------------------
ALTER TABLE source_versions
  ADD COLUMN original_stored_file_id uuid REFERENCES stored_files (id),
  ADD COLUMN text_stored_file_id     uuid REFERENCES stored_files (id);
CREATE INDEX source_versions_original_file_idx ON source_versions (original_stored_file_id) WHERE original_stored_file_id IS NOT NULL;
CREATE INDEX source_versions_text_file_idx ON source_versions (text_stored_file_id) WHERE text_stored_file_id IS NOT NULL;

-- An upload has its bytes in the database, or in a stored file (bytes NULL, hash kept), or is withheld (0027).
ALTER TABLE source_versions DROP CONSTRAINT source_versions_upload_has_original;
ALTER TABLE source_versions ADD CONSTRAINT source_versions_upload_has_original CHECK (
  (origin = 'upload' AND original_sha256 IS NOT NULL AND filename IS NOT NULL
     AND (original_bytes IS NOT NULL OR original_stored_file_id IS NOT NULL))
  OR (origin = 'upload' AND original_bytes IS NULL AND quarantined_at IS NOT NULL)
  OR (origin <> 'upload' AND original_bytes IS NULL AND original_sha256 IS NULL)
);

-- Versions stay immutable (0004, 0027) except for the move of storage: the store-source job may clear original_bytes
-- and set original_stored_file_id and text_stored_file_id once each. Nothing else about a version can change.
CREATE OR REPLACE FUNCTION source_versions_immutable() RETURNS trigger AS $$
DECLARE
  n source_versions%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF kainow_quarantine_writing() THEN
      RETURN NEW;
    END IF;
    n := NEW;
    n.original_bytes := OLD.original_bytes;
    n.original_stored_file_id := OLD.original_stored_file_id;
    n.text_stored_file_id := OLD.text_stored_file_id;
    IF n IS NOT DISTINCT FROM OLD
       AND (NEW.original_bytes IS NULL OR NEW.original_bytes IS NOT DISTINCT FROM OLD.original_bytes)
       AND (OLD.original_stored_file_id IS NULL OR NEW.original_stored_file_id IS NOT DISTINCT FROM OLD.original_stored_file_id)
       AND (OLD.text_stored_file_id IS NULL OR NEW.text_stored_file_id IS NOT DISTINCT FROM OLD.text_stored_file_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'source_versions are immutable' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Project output settings.
-- ---------------------------------------------------------------------------
CREATE TABLE project_output_settings (
  project_id      uuid PRIMARY KEY REFERENCES projects (id),
  destination_id  uuid REFERENCES storage_destinations (id),
  input_formats   text[],
  output_formats  text[],
  export_roles    text[] NOT NULL DEFAULT '{pm,deputy,owner,sponsor}',
  updated_by      uuid REFERENCES users (id),
  updated_at      timestamptz
);

CREATE TABLE project_output_settings_changes (
  id          uuid PRIMARY KEY,
  project_id  uuid        NOT NULL REFERENCES projects (id),
  actor_id    uuid        NOT NULL REFERENCES users (id),
  at          timestamptz NOT NULL,
  reason      text        NOT NULL CHECK (btrim(reason) <> ''),
  previous    jsonb       NOT NULL,
  next        jsonb       NOT NULL
);
CREATE INDEX project_output_settings_changes_project_idx ON project_output_settings_changes (project_id, at);

-- ---------------------------------------------------------------------------
-- The output register.
-- ---------------------------------------------------------------------------
CREATE TABLE outputs (
  id              uuid PRIMARY KEY,
  project_id      uuid        NOT NULL REFERENCES projects (id),
  title           text        NOT NULL CHECK (btrim(title) <> ''),
  report_type_id  uuid        REFERENCES report_types (id),
  issue_date      date,
  audience_id     uuid        REFERENCES audiences (id),
  status          text        NOT NULL CHECK (status IN ('submitted', 'registered', 'declined', 'withdrawn')),
  review_state    text        NOT NULL DEFAULT 'none' CHECK (review_state IN ('none', 'review_required', 'cleared')),
  ai_assisted     boolean     NOT NULL DEFAULT false,
  author_id       uuid        NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL,
  registered_by   uuid        REFERENCES users (id),
  registered_at   timestamptz,
  deleted_at      timestamptz,
  deleted_by      uuid        REFERENCES users (id),
  delete_reason   text,
  held_case_id    uuid        REFERENCES quarantine_cases (id)
);
CREATE INDEX outputs_project_idx ON outputs (project_id, status, created_at);
CREATE INDEX outputs_report_type_idx ON outputs (report_type_id) WHERE report_type_id IS NOT NULL;

CREATE TABLE output_categories (
  output_id       uuid NOT NULL REFERENCES outputs (id),
  report_type_id  uuid NOT NULL REFERENCES report_types (id),
  PRIMARY KEY (output_id, report_type_id)
);

CREATE TABLE output_contributors (
  output_id      uuid NOT NULL REFERENCES outputs (id),
  user_id        uuid REFERENCES users (id),
  department_id  uuid REFERENCES departments (id),
  added_at       timestamptz NOT NULL,
  CONSTRAINT output_contributors_one CHECK (user_id IS NOT NULL OR department_id IS NOT NULL)
);
CREATE INDEX output_contributors_output_idx ON output_contributors (output_id);

CREATE TABLE output_versions (
  id                   uuid PRIMARY KEY,
  output_id            uuid        NOT NULL REFERENCES outputs (id),
  version_no           integer     NOT NULL CHECK (version_no >= 1),
  origin               text        NOT NULL CHECK (origin IN ('draft_report', 'export', 'upload', 'link', 'changed_file')),
  format               text        NOT NULL CHECK (format IN ('md', 'docx', 'pdf', 'csv', 'txt', 'other')),
  draft_version_id     uuid        REFERENCES report_draft_versions (id),
  stored_file_id       uuid        REFERENCES stored_files (id),
  status               text        NOT NULL CHECK (status IN ('draft', 'approved', 'superseded')),
  approval_request_id  uuid        REFERENCES change_requests (id),
  sha256               text        NOT NULL,
  size_bytes           bigint      NOT NULL CHECK (size_bytes >= 0),
  created_by           uuid        NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL,
  held_case_id         uuid        REFERENCES quarantine_cases (id),
  UNIQUE (output_id, version_no)
);
CREATE INDEX output_versions_stored_file_idx ON output_versions (stored_file_id) WHERE stored_file_id IS NOT NULL;
CREATE INDEX output_versions_draft_idx ON output_versions (draft_version_id) WHERE draft_version_id IS NOT NULL;

-- Immutable except status, stored_file_id, approval_request_id and held_case_id; never deleted.
CREATE FUNCTION output_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'output_versions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.output_id, NEW.version_no, NEW.origin, NEW.format, NEW.draft_version_id, NEW.sha256, NEW.size_bytes,
      NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.output_id, OLD.version_no, OLD.origin, OLD.format, OLD.draft_version_id, OLD.sha256, OLD.size_bytes,
      OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'only the status, stored file, approval request and hold of an output version can change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER output_versions_no_change BEFORE UPDATE OR DELETE ON output_versions
  FOR EACH ROW EXECUTE FUNCTION output_versions_guard();
CREATE TRIGGER output_versions_no_truncate BEFORE TRUNCATE ON output_versions
  FOR EACH STATEMENT EXECUTE FUNCTION output_versions_guard();

-- The generated or uploaded bytes, kept in the database until the file is stored and verified (kept_until).
-- bytes is nullable so a withheld copy can be emptied.
CREATE TABLE output_version_bytes (
  output_version_id  uuid PRIMARY KEY REFERENCES output_versions (id),
  bytes              bytea,
  kept_until         timestamptz NOT NULL
);

CREATE TABLE output_events (
  id          uuid PRIMARY KEY,
  output_id   uuid        NOT NULL REFERENCES outputs (id),
  version_id  uuid        REFERENCES output_versions (id),
  kind        text        NOT NULL CHECK (kind IN (
                'submitted', 'registered', 'declined', 'updated', 'version_added', 'filed', 'filing_failed', 'approval_requested',
                'approved', 'superseded', 'audience_changed', 'review_required', 'review_cleared', 'withdrawn', 'deleted', 'restored',
                'held', 'released', 'checked', 'changed_found', 'moved_found', 'missing_found', 'relinked', 'changed_registered')),
  actor_id    uuid        REFERENCES users (id),
  at          timestamptz NOT NULL,
  reason      text,
  detail      jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX output_events_output_idx ON output_events (output_id, at);

CREATE TABLE project_department_transfers (
  id                  uuid PRIMARY KEY,
  project_id          uuid        NOT NULL REFERENCES projects (id),
  from_department_id  uuid        NOT NULL REFERENCES departments (id),
  to_department_id    uuid        NOT NULL REFERENCES departments (id),
  reason              text        NOT NULL CHECK (btrim(reason) <> ''),
  folder_choice       text        CHECK (folder_choice IN ('move', 'keep')),
  state               text        NOT NULL CHECK (state IN ('done', 'moving', 'move_failed')),
  actor_id            uuid        NOT NULL REFERENCES users (id),
  at                  timestamptz NOT NULL
);
CREATE INDEX project_department_transfers_project_idx ON project_department_transfers (project_id, at);

-- ---------------------------------------------------------------------------
-- Access settings: project exports (D106) are off until an Administrator allows them.
-- ---------------------------------------------------------------------------
ALTER TABLE access_settings ADD COLUMN project_exports_allowed boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Go-live: the storage step.
-- ---------------------------------------------------------------------------
INSERT INTO golive_steps (key, position) VALUES ('storage', 12);

-- ---------------------------------------------------------------------------
-- change_requests: add kind approve_output and target output_version (spec 13.3). The lists are rebuilt as the union
-- of the values the database holds now (so sub-project 8's 0030 is kept whether or not it has run) and the new ones.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  col    text;
  extra  text;
  con    record;
  vals   text[];
BEGIN
  FOREACH col IN ARRAY ARRAY['kind', 'target_kind'] LOOP
    extra := CASE col WHEN 'kind' THEN 'approve_output' ELSE 'output_version' END;
    vals := ARRAY[]::text[];
    FOR con IN
      SELECT c.conname, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.conrelid = 'change_requests'::regclass AND c.contype = 'c' AND cardinality(c.conkey) = 1 AND a.attname = col
    LOOP
      vals := vals || ARRAY(SELECT m[1] FROM regexp_matches(con.def, '''([^'']+)''', 'g') AS m);
      EXECUTE format('ALTER TABLE change_requests DROP CONSTRAINT %I', con.conname);
    END LOOP;
    IF cardinality(vals) = 0 THEN
      RAISE EXCEPTION 'change_requests has no CHECK on %', col;
    END IF;
    vals := ARRAY(SELECT DISTINCT v FROM unnest(vals || ARRAY[extra]) AS v ORDER BY v);
    EXECUTE format('ALTER TABLE change_requests ADD CONSTRAINT %I CHECK (%I IN (%s))',
                   'change_requests_' || col || '_check', col,
                   (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Append-only history.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['output_events', 'storage_destination_events', 'stored_file_moves', 'storage_admin_events',
                           'storage_settings_changes', 'project_output_settings_changes'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION kainow_append_only()',
                   t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only()',
                   t || '_no_truncate', t);
  END LOOP;
END;
$$;
