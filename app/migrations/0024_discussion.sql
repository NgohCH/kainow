-- Sub-project 4a: shared discussion, typed meetings, audiences, AI minutes and analysis.
-- Additions only. Existing rows keep their meaning. Nothing is physically deleted:
-- history tables are append-only and version tables are immutable (as source_versions in 0004).

-- ---------------------------------------------------------------------------
-- Audiences (spec 6). project_id is NULL only for pre-project MVP sources.
-- ---------------------------------------------------------------------------
CREATE TABLE audiences (
  id          uuid PRIMARY KEY,
  project_id  uuid        REFERENCES projects (id),
  mode        text        NOT NULL CHECK (mode IN ('project', 'restricted')),
  created_at  timestamptz NOT NULL
);
CREATE INDEX audiences_project_idx ON audiences (project_id);

CREATE TABLE audience_members (
  audience_id uuid        NOT NULL REFERENCES audiences (id),
  user_id     uuid        NOT NULL REFERENCES users (id),
  added_by    uuid        NOT NULL REFERENCES users (id),
  added_at    timestamptz NOT NULL,
  PRIMARY KEY (audience_id, user_id)
);
CREATE INDEX audience_members_user_idx ON audience_members (user_id);

CREATE TABLE audience_events (
  id           uuid PRIMARY KEY,
  audience_id  uuid        NOT NULL REFERENCES audiences (id),
  actor_id     uuid        NOT NULL REFERENCES users (id),
  from_mode    text        NOT NULL CHECK (from_mode IN ('project', 'restricted')),
  to_mode      text        NOT NULL CHECK (to_mode IN ('project', 'restricted')),
  from_named   uuid[]      NOT NULL DEFAULT ARRAY[]::uuid[],
  to_named     uuid[]      NOT NULL DEFAULT ARRAY[]::uuid[],
  reason       text        NOT NULL CHECK (btrim(reason) <> ''),
  at           timestamptz NOT NULL
);
CREATE INDEX audience_events_audience_idx ON audience_events (audience_id, at);
CREATE TRIGGER audience_events_append_only BEFORE UPDATE OR DELETE ON audience_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- ---------------------------------------------------------------------------
-- Threads, messages, versions, meetings (spec 3, 4, 5)
-- ---------------------------------------------------------------------------
-- state is NULL for discussion threads and 'open' | 'ended' for meetings.
CREATE TABLE discussion_threads (
  id               uuid PRIMARY KEY,
  project_id       uuid        NOT NULL REFERENCES projects (id),
  kind             text        NOT NULL CHECK (kind IN ('discussion', 'meeting')),
  title            text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND btrim(title) <> ''),
  audience_id      uuid        NOT NULL REFERENCES audiences (id),
  meeting_date     date,
  state            text        CHECK (state IN ('open', 'ended')),
  ended_by         uuid        REFERENCES users (id),
  ended_at         timestamptz,
  created_by       uuid        NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL,
  last_message_at  timestamptz,
  next_message_no  integer     NOT NULL DEFAULT 1 CHECK (next_message_no >= 1),
  CONSTRAINT discussion_threads_kind_shape CHECK (
    (kind = 'discussion' AND state IS NULL AND meeting_date IS NULL AND ended_by IS NULL AND ended_at IS NULL)
    OR (kind = 'meeting' AND state IS NOT NULL AND meeting_date IS NOT NULL)
  ),
  CONSTRAINT discussion_threads_ended_shape CHECK (
    state IS DISTINCT FROM 'ended' OR (ended_by IS NOT NULL AND ended_at IS NOT NULL)
  )
);
CREATE INDEX discussion_threads_project_idx ON discussion_threads (project_id, kind, last_message_at DESC);
CREATE INDEX discussion_threads_audience_idx ON discussion_threads (audience_id);

CREATE TABLE discussion_messages (
  id           uuid PRIMARY KEY,
  thread_id    uuid        NOT NULL REFERENCES discussion_threads (id),
  message_no   integer     NOT NULL CHECK (message_no >= 1),
  author_id    uuid        NOT NULL REFERENCES users (id),
  reply_to_id  uuid        REFERENCES discussion_messages (id),
  state        text        NOT NULL DEFAULT 'visible' CHECK (state IN ('visible', 'hidden', 'deleted')),
  state_reason text,
  state_by     uuid        REFERENCES users (id),
  state_at     timestamptz,
  created_at   timestamptz NOT NULL,
  UNIQUE (thread_id, message_no),
  CONSTRAINT discussion_messages_state_has_reason CHECK (
    state = 'visible' OR (state_reason IS NOT NULL AND btrim(state_reason) <> '' AND state_by IS NOT NULL AND state_at IS NOT NULL)
  )
);
CREATE INDEX discussion_messages_thread_idx ON discussion_messages (thread_id, message_no);

CREATE TABLE message_versions (
  id           uuid PRIMARY KEY,
  message_id   uuid        NOT NULL REFERENCES discussion_messages (id),
  version_no   integer     NOT NULL CHECK (version_no >= 1),
  body         text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  body_sha256  text        NOT NULL,
  created_at   timestamptz NOT NULL,
  UNIQUE (message_id, version_no)
);
CREATE INDEX message_versions_trgm ON message_versions USING gin (body gin_trgm_ops);

CREATE FUNCTION discussion_versions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% are immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_versions_no_update BEFORE UPDATE OR DELETE ON message_versions
  FOR EACH ROW EXECUTE FUNCTION discussion_versions_immutable();
CREATE TRIGGER message_versions_no_truncate BEFORE TRUNCATE ON message_versions
  FOR EACH STATEMENT EXECUTE FUNCTION discussion_versions_immutable();

CREATE TABLE meeting_attendees (
  thread_id  uuid        NOT NULL REFERENCES discussion_threads (id),
  user_id    uuid        NOT NULL REFERENCES users (id),
  marked_by  uuid        NOT NULL REFERENCES users (id),
  marked_at  timestamptz NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Draft minutes. analysis_run_id is constrained after analysis_runs exists.
-- ---------------------------------------------------------------------------
CREATE TABLE minutes_drafts (
  id                uuid PRIMARY KEY,
  thread_id         uuid        NOT NULL REFERENCES discussion_threads (id),
  version_no        integer     NOT NULL CHECK (version_no >= 1),
  origin            text        NOT NULL CHECK (origin IN ('ai', 'human')),
  body              text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 100000),
  covers_through_no integer     NOT NULL CHECK (covers_through_no >= 0),
  analysis_run_id   uuid,
  edited_from_id    uuid        REFERENCES minutes_drafts (id),
  created_by        uuid        REFERENCES users (id),
  created_at        timestamptz NOT NULL,
  UNIQUE (thread_id, version_no),
  CONSTRAINT minutes_drafts_human_has_author CHECK (origin <> 'human' OR created_by IS NOT NULL),
  CONSTRAINT minutes_drafts_ai_has_run CHECK (origin <> 'ai' OR analysis_run_id IS NOT NULL)
);
CREATE TRIGGER minutes_drafts_no_update BEFORE UPDATE OR DELETE ON minutes_drafts
  FOR EACH ROW EXECUTE FUNCTION discussion_versions_immutable();
CREATE TRIGGER minutes_drafts_no_truncate BEFORE TRUNCATE ON minutes_drafts
  FOR EACH STATEMENT EXECUTE FUNCTION discussion_versions_immutable();

-- ---------------------------------------------------------------------------
-- Existing tables: sources gain kind, audience, publication, thread link.
-- ---------------------------------------------------------------------------
ALTER TABLE sources
  ADD COLUMN kind            text NOT NULL DEFAULT 'notes' CHECK (kind IN ('notes', 'minutes', 'discussion')),
  ADD COLUMN audience_id     uuid REFERENCES audiences (id),
  ADD COLUMN publication     text NOT NULL DEFAULT 'published' CHECK (publication IN ('published', 'submitted', 'returned')),
  ADD COLUMN thread_id       uuid REFERENCES discussion_threads (id),
  ADD COLUMN submitted_by    uuid REFERENCES users (id),
  ADD COLUMN returned_reason text,
  ADD COLUMN intended_mode   text CHECK (intended_mode IN ('project', 'restricted'));

-- One Project-wide audience per existing source (project_id NULL for pre-project sources).
CREATE TEMPORARY TABLE source_audience_map ON COMMIT DROP AS
  SELECT id AS source_id, gen_random_uuid() AS audience_id, project_id, created_at FROM sources;
INSERT INTO audiences (id, project_id, mode, created_at)
  SELECT audience_id, project_id, 'project', created_at FROM source_audience_map;
UPDATE sources s SET audience_id = m.audience_id FROM source_audience_map m WHERE m.source_id = s.id;
ALTER TABLE sources ALTER COLUMN audience_id SET NOT NULL;
CREATE INDEX sources_audience_idx ON sources (audience_id);
CREATE INDEX sources_thread_idx ON sources (thread_id) WHERE thread_id IS NOT NULL;

-- A source inserted without an audience (older code paths) gets its own Project-wide one.
CREATE FUNCTION sources_default_audience() RETURNS trigger AS $$
BEGIN
  IF NEW.audience_id IS NULL THEN
    NEW.audience_id := gen_random_uuid();
    INSERT INTO audiences (id, project_id, mode, created_at) VALUES (NEW.audience_id, NEW.project_id, 'project', NEW.created_at);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sources_default_audience BEFORE INSERT ON sources
  FOR EACH ROW EXECUTE FUNCTION sources_default_audience();

ALTER TABLE sources ADD CONSTRAINT sources_linked_to_thread CHECK (kind = 'notes' OR thread_id IS NOT NULL);
ALTER TABLE sources ADD CONSTRAINT sources_returned_has_reason
  CHECK (publication <> 'returned' OR (returned_reason IS NOT NULL AND btrim(returned_reason) <> ''));

-- Automatic transcripts have no person: created_by may be NULL only for kind 'discussion'.
ALTER TABLE sources ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE sources ADD CONSTRAINT sources_creator_required CHECK (created_by IS NOT NULL OR kind = 'discussion');

ALTER TABLE source_versions ADD COLUMN minutes_draft_id uuid REFERENCES minutes_drafts (id);
ALTER TABLE source_versions DROP CONSTRAINT source_versions_origin_check;
ALTER TABLE source_versions ADD CONSTRAINT source_versions_origin_check
  CHECK (origin IN ('paste', 'upload', 'meeting', 'discussion'));
ALTER TABLE source_versions DROP CONSTRAINT source_versions_upload_has_original;
ALTER TABLE source_versions ADD CONSTRAINT source_versions_upload_has_original CHECK (
  (origin = 'upload' AND original_bytes IS NOT NULL AND original_sha256 IS NOT NULL AND filename IS NOT NULL)
  OR (origin <> 'upload' AND original_bytes IS NULL AND original_sha256 IS NULL)
);
ALTER TABLE source_versions ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE source_versions ADD CONSTRAINT source_versions_creator_required
  CHECK (created_by IS NOT NULL OR origin = 'discussion');

-- Extraction may now be started by an event rather than a person.
ALTER TABLE extraction_runs ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE extraction_runs ADD COLUMN trigger text NOT NULL DEFAULT 'request'
  CHECK (trigger IN ('request', 'minutes_published', 'discussion'));
ALTER TABLE extraction_runs ADD CONSTRAINT extraction_runs_requester_for_request
  CHECK (requested_by IS NOT NULL OR trigger <> 'request');

-- ---------------------------------------------------------------------------
-- Analysis runs and transcript spans (spec 7)
-- ---------------------------------------------------------------------------
CREATE TABLE analysis_runs (
  id                   uuid PRIMARY KEY,
  thread_id            uuid        NOT NULL REFERENCES discussion_threads (id),
  kind                 text        NOT NULL CHECK (kind IN ('proposals', 'minutes')),
  trigger              text        NOT NULL CHECK (trigger IN ('quiet_period', 'meeting_end', 'button', 'selection')),
  requested_by         uuid        REFERENCES users (id),
  status               text        NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'blocked')),
  failure_code         text,
  failure_detail       text,
  attempts             integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  covers_from_no       integer     CHECK (covers_from_no >= 1),
  covers_through_no    integer     CHECK (covers_through_no >= 0),
  selected_message_ids uuid[],
  source_version_id    uuid        REFERENCES source_versions (id),
  extraction_run_id    uuid        REFERENCES extraction_runs (id),
  minutes_draft_id     uuid        REFERENCES minutes_drafts (id),
  repeated_count       integer     NOT NULL DEFAULT 0 CHECK (repeated_count >= 0),
  created_at           timestamptz NOT NULL,
  started_at           timestamptz,
  finished_at          timestamptz,
  CONSTRAINT analysis_runs_failure_has_code CHECK (status NOT IN ('failed', 'blocked') OR failure_code IS NOT NULL)
);
-- At most one queued or running run per thread, so a double click or a tick race cannot pay twice.
CREATE UNIQUE INDEX analysis_runs_one_active_per_thread
  ON analysis_runs (thread_id) WHERE status IN ('queued', 'running');
CREATE INDEX analysis_runs_thread_idx ON analysis_runs (thread_id, created_at);

ALTER TABLE minutes_drafts ADD CONSTRAINT minutes_drafts_analysis_run_fk
  FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs (id);

-- Where each message sits in a transcript source version (evidence masking and quote mapping).
CREATE TABLE transcript_spans (
  source_version_id  uuid    NOT NULL REFERENCES source_versions (id),
  message_no         integer NOT NULL CHECK (message_no >= 1),
  message_version_id uuid    NOT NULL REFERENCES message_versions (id),
  author_id          uuid    NOT NULL REFERENCES users (id),
  header_start       integer NOT NULL CHECK (header_start >= 0),
  body_start         integer NOT NULL,
  body_end           integer NOT NULL,
  is_context         boolean NOT NULL DEFAULT false,
  PRIMARY KEY (source_version_id, header_start),
  CONSTRAINT transcript_spans_offsets CHECK (header_start <= body_start AND body_start <= body_end)
);
CREATE INDEX transcript_spans_message_idx ON transcript_spans (message_version_id);
CREATE TRIGGER transcript_spans_append_only BEFORE UPDATE OR DELETE ON transcript_spans
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- ---------------------------------------------------------------------------
-- History (spec 4.4). Message and minutes text is never written here.
-- ---------------------------------------------------------------------------
CREATE TABLE discussion_events (
  id          uuid PRIMARY KEY,
  thread_id   uuid        NOT NULL REFERENCES discussion_threads (id),
  message_id  uuid        REFERENCES discussion_messages (id),
  draft_id    uuid        REFERENCES minutes_drafts (id),
  actor_id    uuid        NOT NULL REFERENCES users (id),
  action      text        NOT NULL CHECK (action IN (
                'thread_started', 'posted', 'edited', 'hidden', 'unhidden', 'deleted', 'restored',
                'meeting_ended', 'present_changed', 'minutes_edited', 'minutes_published',
                'submission_returned', 'audience_changed')),
  reason      text,
  detail      jsonb,
  at          timestamptz NOT NULL
);
CREATE INDEX discussion_events_thread_idx ON discussion_events (thread_id, at);
CREATE TRIGGER discussion_events_append_only BEFORE UPDATE OR DELETE ON discussion_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- ---------------------------------------------------------------------------
-- Analysis settings (spec 7.7). No row means the defaults: on, 5 minutes, projects may not change.
-- ---------------------------------------------------------------------------
CREATE TABLE analysis_settings (
  id                   smallint    PRIMARY KEY CHECK (id = 1),
  automatic            boolean     NOT NULL DEFAULT true,
  quiet_minutes        smallint    NOT NULL DEFAULT 5 CHECK (quiet_minutes BETWEEN 5 AND 30),
  projects_may_change  boolean     NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL,
  updated_by           uuid        REFERENCES users (id)
);

-- NULL means "inherit the organisation value".
CREATE TABLE project_analysis_settings (
  project_id     uuid PRIMARY KEY REFERENCES projects (id),
  automatic      boolean,
  quiet_minutes  smallint    CHECK (quiet_minutes BETWEEN 5 AND 30),
  updated_at     timestamptz NOT NULL,
  updated_by     uuid        REFERENCES users (id)
);

-- project_id NULL means the organisation row.
CREATE TABLE analysis_settings_changes (
  id          uuid PRIMARY KEY,
  project_id  uuid        REFERENCES projects (id),
  field       text        NOT NULL,
  from_value  text,
  to_value    text,
  reason      text        NOT NULL CHECK (btrim(reason) <> ''),
  actor_id    uuid        NOT NULL REFERENCES users (id),
  at          timestamptz NOT NULL
);
CREATE INDEX analysis_settings_changes_at_idx ON analysis_settings_changes (at);
CREATE TRIGGER analysis_settings_changes_append_only BEFORE UPDATE OR DELETE ON analysis_settings_changes
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- ---------------------------------------------------------------------------
-- AI feedback (spec 8)
-- ---------------------------------------------------------------------------
CREATE TABLE ai_feedback (
  id              uuid PRIMARY KEY,
  project_id      uuid        NOT NULL REFERENCES projects (id),
  target_kind     text        NOT NULL CHECK (target_kind IN ('minutes_draft', 'analysis_run', 'proposal')),
  target_id       uuid        NOT NULL,
  category        text        NOT NULL CHECK (category IN ('incorrect', 'missed_item', 'misleading', 'other')),
  note            text        NOT NULL CHECK (char_length(note) BETWEEN 1 AND 2000),
  status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'closed')),
  reporter_id     uuid        NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL,
  escalated_at    timestamptz,
  escalation_note text
);
CREATE INDEX ai_feedback_project_idx ON ai_feedback (project_id, status, created_at);

CREATE TABLE feedback_events (
  id           uuid PRIMARY KEY,
  feedback_id  uuid        NOT NULL REFERENCES ai_feedback (id),
  actor_id     uuid        NOT NULL REFERENCES users (id),
  action       text        NOT NULL,
  from_status  text        CHECK (from_status IN ('open', 'reviewed', 'closed')),
  to_status    text        CHECK (to_status IN ('open', 'reviewed', 'closed')),
  note         text,
  at           timestamptz NOT NULL
);
CREATE INDEX feedback_events_feedback_idx ON feedback_events (feedback_id, at);
CREATE TRIGGER feedback_events_append_only BEFORE UPDATE OR DELETE ON feedback_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
