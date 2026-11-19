-- V1.0 sub-project 6: AI configuration (approved models, project connections and keys, project limits, call slots).
-- Design: docs/superpowers/specs/2026-11-18-v1-ai-configuration-design.md (section 10).
-- Nothing is deleted: catalogue entries, connections, keys and spend entries are never removed, and the event
-- tables are append-only. notifications.kind has no CHECK constraint (0020), so 'ai_key_rejected' needs no change here.

-- ---------------------------------------------------------------------------
-- Approved models (the catalogue). Prices are micro-USD per million tokens.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_models (
  id                                  uuid PRIMARY KEY,
  provider                            text    NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model_id                            text    NOT NULL CHECK (btrim(model_id) <> '' AND char_length(model_id) <= 200),
  display_name                        text    NOT NULL CHECK (btrim(display_name) <> ''),
  input_usd_per_million_micro         bigint  NOT NULL CHECK (input_usd_per_million_micro >= 0),
  cached_input_usd_per_million_micro  bigint  NOT NULL CHECK (cached_input_usd_per_million_micro >= 0),
  cache_write_usd_per_million_micro   bigint  NOT NULL DEFAULT 0 CHECK (cache_write_usd_per_million_micro >= 0),
  output_usd_per_million_micro        bigint  NOT NULL CHECK (output_usd_per_million_micro >= 0),
  data_terms                          text    NOT NULL CHECK (btrim(data_terms) <> ''),
  purposes                            text[]  NOT NULL DEFAULT '{}'
    CHECK (purposes <@ ARRAY['extraction', 'discussion_analysis', 'minutes_draft', 'question_answer', 'report_draft', 'summary_draft']::text[]),
  restricted_ok                       boolean NOT NULL DEFAULT false,
  state                               text    NOT NULL CHECK (state IN ('approved', 'withdrawn')),
  updated_at                          timestamptz NOT NULL,
  updated_by                          uuid REFERENCES users (id),
  CONSTRAINT ai_models_provider_model_key UNIQUE (provider, model_id)
);

-- One catalogue entry from today's settings row, if there is one. Everything that approves it is off.
INSERT INTO ai_models (id, provider, model_id, display_name, input_usd_per_million_micro, cached_input_usd_per_million_micro,
                       cache_write_usd_per_million_micro, output_usd_per_million_micro, data_terms, purposes, restricted_ok, state, updated_at)
SELECT gen_random_uuid(), 'openai', model_id, model_id, input_usd_per_million_micro, cached_input_usd_per_million_micro,
       0, output_usd_per_million_micro, 'Recorded before sub-project 6 — review before approving', '{}', false, 'withdrawn', now()
  FROM ai_spend_settings;

CREATE TABLE ai_model_events (
  id         uuid PRIMARY KEY,
  model_ref  uuid        NOT NULL REFERENCES ai_models (id),
  action     text        NOT NULL CHECK (action IN ('approved', 'changed', 'withdrawn', 'reapproved')),
  actor_id   uuid        REFERENCES users (id),
  reason     text        NOT NULL CHECK (btrim(reason) <> ''),
  -- Previous and new non-secret values.
  detail     jsonb       NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL
);
CREATE INDEX ai_model_events_model_idx ON ai_model_events (model_ref, at);

-- ---------------------------------------------------------------------------
-- Project connections and their sealed keys.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_connections (
  id                     uuid PRIMARY KEY,
  project_id             uuid        NOT NULL REFERENCES projects (id),
  model_ref              uuid        NOT NULL REFERENCES ai_models (id),
  label                  text        NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 100),
  position               integer     NOT NULL CHECK (position >= 1),
  state                  text        NOT NULL CHECK (state IN ('ready', 'unchecked', 'key_rejected', 'disabled')),
  rejected_at            timestamptz,
  rejected_status        smallint,
  rejection_notified_at  timestamptz,
  last_used_at           timestamptz,
  created_at             timestamptz NOT NULL,
  created_by             uuid        REFERENCES users (id),
  -- Deferred so a reorder can swap positions inside one transaction.
  CONSTRAINT ai_connections_position_key UNIQUE (project_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ai_connections_model_idx ON ai_connections (model_ref);

CREATE TABLE ai_connection_keys (
  id             uuid PRIMARY KEY,
  connection_id  uuid        NOT NULL REFERENCES ai_connections (id),
  ciphertext     bytea       NOT NULL,
  nonce          bytea       NOT NULL,
  tag            bytea       NOT NULL,
  key_id         text        NOT NULL CHECK (btrim(key_id) <> ''),
  saved_at       timestamptz NOT NULL,
  saved_by       uuid        REFERENCES users (id),
  superseded_at  timestamptz
);
-- At most one current key per connection.
CREATE UNIQUE INDEX ai_connection_keys_current_key ON ai_connection_keys (connection_id) WHERE superseded_at IS NULL;

CREATE TABLE ai_connection_events (
  id             uuid PRIMARY KEY,
  connection_id  uuid        NOT NULL REFERENCES ai_connections (id),
  action         text        NOT NULL CHECK (action IN ('added', 'key_saved', 'key_replaced', 'checked', 'reordered', 'disabled', 'enabled', 'key_rejected')),
  -- NULL when Kainow itself acted (a rejected key).
  actor_id       uuid        REFERENCES users (id),
  reason         text,
  -- Previous and new non-secret values. Never a key.
  detail         jsonb       NOT NULL DEFAULT '{}',
  at             timestamptz NOT NULL
);
CREATE INDEX ai_connection_events_connection_idx ON ai_connection_events (connection_id, at);

-- ---------------------------------------------------------------------------
-- Project limits. No row means nothing is set: no allowance.
-- ---------------------------------------------------------------------------
CREATE TABLE project_ai_limits (
  project_id                    uuid PRIMARY KEY REFERENCES projects (id),
  monthly_limit_micro_myr       bigint  CHECK (monthly_limit_micro_myr >= 0),
  daily_mode                    text    NOT NULL CHECK (daily_mode IN ('limit', 'not_applied')),
  daily_limit_micro_myr         bigint  CHECK (daily_limit_micro_myr >= 0),
  user_monthly_mode             text    NOT NULL DEFAULT 'not_applied' CHECK (user_monthly_mode IN ('limit', 'not_applied')),
  user_monthly_limit_micro_myr  bigint  CHECK (user_monthly_limit_micro_myr >= 0),
  -- NULL: the organisation's value applies.
  max_attempts                  integer CHECK (max_attempts BETWEEN 1 AND 5),
  timeout_seconds               integer CHECK (timeout_seconds BETWEEN 30 AND 300),
  updated_at                    timestamptz NOT NULL,
  updated_by                    uuid REFERENCES users (id),
  CONSTRAINT project_ai_limits_daily_only_with_limit_mode CHECK (daily_mode = 'limit' OR daily_limit_micro_myr IS NULL),
  CONSTRAINT project_ai_limits_user_only_with_limit_mode CHECK (user_monthly_mode = 'limit' OR user_monthly_limit_micro_myr IS NULL)
);

CREATE TABLE project_ai_limit_events (
  id          uuid PRIMARY KEY,
  project_id  uuid        NOT NULL REFERENCES projects (id),
  actor_id    uuid        REFERENCES users (id),
  reason      text        NOT NULL CHECK (btrim(reason) <> ''),
  -- Previous and new values.
  detail      jsonb       NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL
);
CREATE INDEX project_ai_limit_events_project_idx ON project_ai_limit_events (project_id, at);

-- ---------------------------------------------------------------------------
-- Organisation settings: the model and its prices moved to the catalogue (copied above).
-- ---------------------------------------------------------------------------
ALTER TABLE ai_spend_settings
  DROP COLUMN model_id,
  DROP COLUMN input_usd_per_million_micro,
  DROP COLUMN cached_input_usd_per_million_micro,
  DROP COLUMN output_usd_per_million_micro,
  ADD COLUMN projects_may_set_limits         boolean NOT NULL DEFAULT false,
  ADD COLUMN projects_may_manage_connections boolean NOT NULL DEFAULT false,
  ADD COLUMN project_ceiling_mode            text    NOT NULL DEFAULT 'not_applied' CHECK (project_ceiling_mode IN ('limit', 'not_applied')),
  ADD COLUMN project_ceiling_micro_myr       bigint  CHECK (project_ceiling_micro_myr >= 0),
  ADD COLUMN max_attempts                    integer NOT NULL DEFAULT 3   CHECK (max_attempts BETWEEN 1 AND 5),
  ADD COLUMN timeout_seconds                 integer NOT NULL DEFAULT 120 CHECK (timeout_seconds BETWEEN 30 AND 300),
  ADD COLUMN concurrency                     integer NOT NULL DEFAULT 2   CHECK (concurrency BETWEEN 1 AND 10),
  ADD CONSTRAINT ai_spend_ceiling_only_with_limit_mode CHECK (project_ceiling_mode = 'limit' OR project_ceiling_micro_myr IS NULL);

-- ---------------------------------------------------------------------------
-- Spend entries: project, connection, provider, cache writes. Rows from before 0028 are not "ruled": they have no
-- project and count against organisation limits only.
-- ---------------------------------------------------------------------------
ALTER TABLE ai_spend_entries
  ADD COLUMN project_id                        uuid REFERENCES projects (id),
  ADD COLUMN connection_id                     uuid REFERENCES ai_connections (id),
  ADD COLUMN provider                          text CHECK (provider IN ('openai', 'anthropic')),
  ADD COLUMN cache_write_usd_per_million_micro bigint CHECK (cache_write_usd_per_million_micro >= 0),
  ADD COLUMN cache_write_tokens                bigint CHECK (cache_write_tokens >= 0),
  ADD COLUMN ruled                             boolean NOT NULL DEFAULT false;
ALTER TABLE ai_spend_entries ALTER COLUMN ruled SET DEFAULT true;
ALTER TABLE ai_spend_entries ADD CONSTRAINT ai_spend_ruled_needs_project CHECK (NOT ruled OR project_id IS NOT NULL);
CREATE INDEX ai_spend_entries_project_idx ON ai_spend_entries (project_id, created_at) WHERE status <> 'released';
CREATE INDEX ai_spend_entries_project_actor_idx ON ai_spend_entries (project_id, actor_user_id, created_at);

-- ---------------------------------------------------------------------------
-- AI call slots: the limit on requests at once, held in the database so it holds across worker processes.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_call_slots (
  slot          smallint PRIMARY KEY CHECK (slot BETWEEN 1 AND 10),
  holder        text,
  leased_until  timestamptz
);
INSERT INTO ai_call_slots (slot) SELECT generate_series(1, 10);

-- ---------------------------------------------------------------------------
-- Nothing is deleted; events are append-only; a key row only ever gets its superseded_at set, once.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ai_config_never_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ai_models_no_delete BEFORE DELETE ON ai_models
  FOR EACH ROW EXECUTE FUNCTION ai_config_never_removed();
CREATE TRIGGER ai_models_no_truncate BEFORE TRUNCATE ON ai_models
  FOR EACH STATEMENT EXECUTE FUNCTION ai_config_never_removed();
CREATE TRIGGER ai_connections_no_delete BEFORE DELETE ON ai_connections
  FOR EACH ROW EXECUTE FUNCTION ai_config_never_removed();
CREATE TRIGGER ai_connections_no_truncate BEFORE TRUNCATE ON ai_connections
  FOR EACH STATEMENT EXECUTE FUNCTION ai_config_never_removed();
CREATE TRIGGER ai_connection_keys_no_delete BEFORE DELETE ON ai_connection_keys
  FOR EACH ROW EXECUTE FUNCTION ai_config_never_removed();
CREATE TRIGGER ai_connection_keys_no_truncate BEFORE TRUNCATE ON ai_connection_keys
  FOR EACH STATEMENT EXECUTE FUNCTION ai_config_never_removed();

CREATE TRIGGER ai_model_events_append_only BEFORE UPDATE OR DELETE ON ai_model_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER ai_model_events_no_truncate BEFORE TRUNCATE ON ai_model_events
  FOR EACH STATEMENT EXECUTE FUNCTION ai_config_never_removed();
CREATE TRIGGER ai_connection_events_append_only BEFORE UPDATE OR DELETE ON ai_connection_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER ai_connection_events_no_truncate BEFORE TRUNCATE ON ai_connection_events
  FOR EACH STATEMENT EXECUTE FUNCTION ai_config_never_removed();
CREATE TRIGGER project_ai_limit_events_append_only BEFORE UPDATE OR DELETE ON project_ai_limit_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER project_ai_limit_events_no_truncate BEFORE TRUNCATE ON project_ai_limit_events
  FOR EACH STATEMENT EXECUTE FUNCTION ai_config_never_removed();

CREATE FUNCTION ai_connection_keys_only_supersede() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.superseded_at IS NOT NULL
     OR NEW.superseded_at IS NULL
     OR (NEW.id, NEW.connection_id, NEW.ciphertext, NEW.nonce, NEW.tag, NEW.key_id, NEW.saved_at, NEW.saved_by)
        IS DISTINCT FROM (OLD.id, OLD.connection_id, OLD.ciphertext, OLD.nonce, OLD.tag, OLD.key_id, OLD.saved_at, OLD.saved_by) THEN
    RAISE EXCEPTION 'only superseded_at of ai_connection_keys may be set, once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_connection_keys_immutable BEFORE UPDATE ON ai_connection_keys
  FOR EACH ROW EXECUTE FUNCTION ai_connection_keys_only_supersede();
