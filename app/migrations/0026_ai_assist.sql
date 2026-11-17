-- Sub-project 4b: AI questions, draft reports and shareable summaries (spec 2026-11-15-v1-ai-assist-design.md section 9).
-- Additions only. Nothing is physically deleted: passages are derived index rows written once, version tables are
-- immutable by trigger and event tables are append-only. Question, answer, draft and summary text never goes into
-- audit_events or ai_assist_events.

-- ---------------------------------------------------------------------------
-- Passages (spec 4.1). Audience and visibility are joined at query time from the owner, never copied here.
-- owner_id points at a source_versions or message_versions row (an approved summary version is a version of its
-- 'summary' source), so it is not a foreign key.
-- ---------------------------------------------------------------------------
CREATE TABLE passages (
  id            uuid PRIMARY KEY,
  project_id    uuid    NOT NULL REFERENCES projects (id),
  owner_kind    text    NOT NULL CHECK (owner_kind IN ('source_version', 'message_version')),
  owner_id      uuid    NOT NULL,
  ordinal       integer NOT NULL CHECK (ordinal >= 0),
  location      text    NOT NULL CHECK (btrim(location) <> ''),
  start_offset  integer NOT NULL CHECK (start_offset >= 0),
  end_offset    integer NOT NULL,
  body          text    NOT NULL CHECK (btrim(body) <> ''),
  english       tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED,
  simple        tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
  UNIQUE (owner_kind, owner_id, ordinal),
  CONSTRAINT passages_offsets CHECK (start_offset <= end_offset)
);
CREATE INDEX passages_project_idx ON passages (project_id);
CREATE INDEX passages_english_idx ON passages USING gin (english);
CREATE INDEX passages_simple_idx ON passages USING gin (simple);

CREATE FUNCTION ai_assist_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% are immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER passages_no_update BEFORE UPDATE OR DELETE ON passages
  FOR EACH ROW EXECUTE FUNCTION ai_assist_immutable();
CREATE TRIGGER passages_no_truncate BEFORE TRUNCATE ON passages
  FOR EACH STATEMENT EXECUTE FUNCTION ai_assist_immutable();

-- ---------------------------------------------------------------------------
-- Records are searched live (spec 4.2): expression indexes, English stemming and exact words.
-- ---------------------------------------------------------------------------
CREATE INDEX tasks_fts_english ON tasks USING gin (to_tsvector('english', title));
CREATE INDEX tasks_fts_simple ON tasks USING gin (to_tsvector('simple', title));
CREATE INDEX decisions_fts_english ON decisions USING gin (to_tsvector('english', statement || ' ' || coalesce(rationale, '')));
CREATE INDEX decisions_fts_simple ON decisions USING gin (to_tsvector('simple', statement || ' ' || coalesce(rationale, '')));
CREATE INDEX questions_fts_english ON questions USING gin (to_tsvector('english', text));
CREATE INDEX questions_fts_simple ON questions USING gin (to_tsvector('simple', text));
CREATE INDEX question_answers_fts_english ON question_answers USING gin (to_tsvector('english', answer));
CREATE INDEX question_answers_fts_simple ON question_answers USING gin (to_tsvector('simple', answer));
CREATE INDEX risks_fts_english ON risks USING gin (to_tsvector('english', description || ' ' || coalesce(mitigation, '')));
CREATE INDEX risks_fts_simple ON risks USING gin (to_tsvector('simple', description || ' ' || coalesce(mitigation, '')));
CREATE INDEX extraction_items_fts_english ON extraction_items USING gin (to_tsvector('english', text));
CREATE INDEX extraction_items_fts_simple ON extraction_items USING gin (to_tsvector('simple', text));
CREATE INDEX human_proposals_fts_english ON human_proposals USING gin (to_tsvector('english', text));
CREATE INDEX human_proposals_fts_simple ON human_proposals USING gin (to_tsvector('simple', text));

-- ---------------------------------------------------------------------------
-- AI requests and exactly what was sent (spec 3, 5.1)
-- ---------------------------------------------------------------------------
CREATE TABLE ai_requests (
  id               uuid PRIMARY KEY,
  project_id       uuid        NOT NULL REFERENCES projects (id),
  kind             text        NOT NULL CHECK (kind IN ('question', 'report', 'summary')),
  requested_by     uuid        NOT NULL REFERENCES users (id),
  status           text        NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'blocked')),
  failure_code     text,
  failure_detail   text,
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  scope            text        NOT NULL CHECK (scope IN ('personal', 'thread')),
  scope_thread_id  uuid        REFERENCES discussion_threads (id),
  model_id         text,
  created_at       timestamptz NOT NULL,
  started_at       timestamptz,
  finished_at      timestamptz,
  CONSTRAINT ai_requests_thread_scope CHECK ((scope = 'thread') = (scope_thread_id IS NOT NULL)),
  CONSTRAINT ai_requests_failure_has_code CHECK (status NOT IN ('failed', 'blocked') OR failure_code IS NOT NULL)
);
CREATE INDEX ai_requests_project_idx ON ai_requests (project_id, created_at);
CREATE INDEX ai_requests_requester_idx ON ai_requests (requested_by, created_at);
CREATE INDEX ai_requests_active_idx ON ai_requests (status, created_at) WHERE status IN ('queued', 'running');

-- Material sent: a passage, or a record snapshot (Kainow's own rendering of the record's fields).
-- Only cited and dropped_at_start change after the row is written.
CREATE TABLE ai_request_material (
  request_id          uuid    NOT NULL REFERENCES ai_requests (id),
  ordinal             integer NOT NULL CHECK (ordinal >= 0),
  marker              text    NOT NULL CHECK (btrim(marker) <> ''),
  passage_id          uuid    REFERENCES passages (id),
  record_kind         text    CHECK (record_kind IN ('task', 'decision', 'question', 'risk', 'ai_proposal', 'human_proposal')),
  record_id           uuid,
  record_audience_id  uuid    REFERENCES audiences (id),
  snapshot            text,
  location            text    NOT NULL,
  cited               boolean NOT NULL DEFAULT false,
  dropped_at_start    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (request_id, ordinal),
  CONSTRAINT ai_request_material_one_kind CHECK (
    (passage_id IS NOT NULL AND record_kind IS NULL AND record_id IS NULL AND snapshot IS NULL AND record_audience_id IS NULL)
    OR (passage_id IS NULL AND record_kind IS NOT NULL AND record_id IS NOT NULL AND snapshot IS NOT NULL)
  )
);
CREATE INDEX ai_request_material_passage_idx ON ai_request_material (passage_id) WHERE passage_id IS NOT NULL;
CREATE INDEX ai_request_material_record_idx ON ai_request_material (record_kind, record_id) WHERE record_kind IS NOT NULL;

CREATE FUNCTION ai_request_material_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'ai_request_material rows are not deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'cited' - 'dropped_at_start') IS DISTINCT FROM (to_jsonb(OLD) - 'cited' - 'dropped_at_start') THEN
    RAISE EXCEPTION 'only cited and dropped_at_start of ai_request_material may change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_request_material_guard BEFORE UPDATE OR DELETE ON ai_request_material
  FOR EACH ROW EXECUTE FUNCTION ai_request_material_guard();
CREATE TRIGGER ai_request_material_no_truncate BEFORE TRUNCATE ON ai_request_material
  FOR EACH STATEMENT EXECUTE FUNCTION ai_request_material_guard();

-- ---------------------------------------------------------------------------
-- Answers (spec 5)
-- ---------------------------------------------------------------------------
CREATE TABLE ai_answers (
  request_id        uuid PRIMARY KEY REFERENCES ai_requests (id),
  project_id        uuid        NOT NULL REFERENCES projects (id),
  question          text        NOT NULL CHECK (btrim(question) <> ''),
  answer_markdown   text,
  not_found         boolean     NOT NULL DEFAULT false,
  visibility        text        NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  shared_thread_id  uuid        REFERENCES discussion_threads (id),
  shared_by         uuid        REFERENCES users (id),
  shared_at         timestamptz,
  hidden            boolean     NOT NULL DEFAULT false,
  hidden_reason     text,
  hidden_by         uuid        REFERENCES users (id),
  hidden_at         timestamptz,
  review_state      text        NOT NULL DEFAULT 'none' CHECK (review_state IN ('none', 'review_required', 'cleared', 'withdrawn')),
  review_reason     text,
  reviewed_by       uuid        REFERENCES users (id),
  reviewed_at       timestamptz,
  CONSTRAINT ai_answers_shared_shape CHECK (
    visibility = 'private' OR (shared_thread_id IS NOT NULL AND shared_by IS NOT NULL AND shared_at IS NOT NULL)
  )
);
CREATE INDEX ai_answers_project_idx ON ai_answers (project_id, review_state);
CREATE INDEX ai_answers_thread_idx ON ai_answers (shared_thread_id) WHERE shared_thread_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Report drafts (spec 6): drafts only, with immutable versions
-- ---------------------------------------------------------------------------
CREATE TABLE report_drafts (
  id             uuid PRIMARY KEY,
  project_id     uuid        NOT NULL REFERENCES projects (id),
  kind           text        NOT NULL CHECK (kind IN ('status', 'decisions_actions', 'risks', 'specification', 'free_form')),
  title          text        NOT NULL CHECK (btrim(title) <> ''),
  period_from    date,
  period_to      date,
  brief          text,
  chosen         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_by     uuid        NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL,
  shared         boolean     NOT NULL DEFAULT false,
  shared_at      timestamptz,
  review_state   text        NOT NULL DEFAULT 'none' CHECK (review_state IN ('none', 'review_required', 'cleared', 'withdrawn')),
  review_reason  text,
  reviewed_by    uuid        REFERENCES users (id),
  reviewed_at    timestamptz,
  CONSTRAINT report_drafts_period CHECK (period_from IS NULL OR period_to IS NULL OR period_from <= period_to)
);
CREATE INDEX report_drafts_project_idx ON report_drafts (project_id, created_at);
CREATE INDEX report_drafts_owner_idx ON report_drafts (created_by);

CREATE TABLE report_draft_versions (
  id              uuid PRIMARY KEY,
  draft_id        uuid        NOT NULL REFERENCES report_drafts (id),
  version_no      integer     NOT NULL CHECK (version_no >= 1),
  origin          text        NOT NULL CHECK (origin IN ('ai', 'human')),
  body            text        NOT NULL CHECK (btrim(body) <> ''),
  request_id      uuid        REFERENCES ai_requests (id),
  edited_from_id  uuid        REFERENCES report_draft_versions (id),
  created_by      uuid        REFERENCES users (id),
  created_at      timestamptz NOT NULL,
  UNIQUE (draft_id, version_no),
  CONSTRAINT report_draft_versions_ai_has_request CHECK (origin <> 'ai' OR request_id IS NOT NULL),
  CONSTRAINT report_draft_versions_human_has_author CHECK (origin <> 'human' OR created_by IS NOT NULL)
);
CREATE TRIGGER report_draft_versions_no_update BEFORE UPDATE OR DELETE ON report_draft_versions
  FOR EACH ROW EXECUTE FUNCTION ai_assist_immutable();
CREATE TRIGGER report_draft_versions_no_truncate BEFORE TRUNCATE ON report_draft_versions
  FOR EACH STATEMENT EXECUTE FUNCTION ai_assist_immutable();

-- ---------------------------------------------------------------------------
-- Shareable summaries (spec 7). Approval publishes a 'summary' source (sources.summary_id below).
-- ---------------------------------------------------------------------------
CREATE TABLE summaries (
  id                   uuid PRIMARY KEY,
  project_id           uuid        NOT NULL REFERENCES projects (id),
  original_source_id   uuid        REFERENCES sources (id),
  original_thread_id   uuid        REFERENCES discussion_threads (id),
  intended_audience    jsonb       NOT NULL,
  leave_out            text        NOT NULL DEFAULT '',
  state                text        NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'approved', 'review_required', 'hidden', 'withdrawn')),
  summary_source_id    uuid        REFERENCES sources (id),
  approved_version_id  uuid,
  approved_by          uuid        REFERENCES users (id),
  approved_at          timestamptz,
  review_reason        text,
  created_by           uuid        NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL,
  CONSTRAINT summaries_one_original CHECK ((original_source_id IS NOT NULL) <> (original_thread_id IS NOT NULL))
);
CREATE INDEX summaries_project_idx ON summaries (project_id, state);
CREATE INDEX summaries_source_idx ON summaries (original_source_id) WHERE original_source_id IS NOT NULL;
CREATE INDEX summaries_thread_idx ON summaries (original_thread_id) WHERE original_thread_id IS NOT NULL;

CREATE TABLE summary_versions (
  id                  uuid PRIMARY KEY,
  summary_id          uuid        NOT NULL REFERENCES summaries (id),
  version_no          integer     NOT NULL CHECK (version_no >= 1),
  origin              text        NOT NULL CHECK (origin IN ('ai', 'human')),
  body                text        NOT NULL CHECK (btrim(body) <> ''),
  request_id          uuid        REFERENCES ai_requests (id),
  edited_from_id      uuid        REFERENCES summary_versions (id),
  omitted_categories  text[]      NOT NULL DEFAULT ARRAY[]::text[],
  created_by          uuid        REFERENCES users (id),
  created_at          timestamptz NOT NULL,
  UNIQUE (summary_id, version_no),
  CONSTRAINT summary_versions_ai_has_request CHECK (origin <> 'ai' OR request_id IS NOT NULL),
  CONSTRAINT summary_versions_human_has_author CHECK (origin <> 'human' OR created_by IS NOT NULL)
);
CREATE TRIGGER summary_versions_no_update BEFORE UPDATE OR DELETE ON summary_versions
  FOR EACH ROW EXECUTE FUNCTION ai_assist_immutable();
CREATE TRIGGER summary_versions_no_truncate BEFORE TRUNCATE ON summary_versions
  FOR EACH STATEMENT EXECUTE FUNCTION ai_assist_immutable();

ALTER TABLE summaries ADD CONSTRAINT summaries_approved_version_fk
  FOREIGN KEY (approved_version_id) REFERENCES summary_versions (id);

-- Phrases the person told Kainow to leave out, or names found in a draft. Only intended_by / intended_at may be
-- set, and only once (the person confirms the mark is intended).
CREATE TABLE summary_marks (
  version_id   uuid        NOT NULL REFERENCES summary_versions (id),
  phrase       text        NOT NULL CHECK (btrim(phrase) <> ''),
  kind         text        NOT NULL CHECK (kind IN ('leave_out', 'name')),
  intended_by  uuid        REFERENCES users (id),
  intended_at  timestamptz,
  PRIMARY KEY (version_id, phrase, kind),
  CONSTRAINT summary_marks_intended_together CHECK ((intended_by IS NULL) = (intended_at IS NULL))
);

CREATE FUNCTION summary_marks_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'summary_marks rows are not deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.intended_by IS NOT NULL
     OR (to_jsonb(NEW) - 'intended_by' - 'intended_at') IS DISTINCT FROM (to_jsonb(OLD) - 'intended_by' - 'intended_at') THEN
    RAISE EXCEPTION 'only intended_by and intended_at of summary_marks may be set, once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER summary_marks_guard BEFORE UPDATE OR DELETE ON summary_marks
  FOR EACH ROW EXECUTE FUNCTION summary_marks_guard();
CREATE TRIGGER summary_marks_no_truncate BEFORE TRUNCATE ON summary_marks
  FOR EACH STATEMENT EXECUTE FUNCTION summary_marks_guard();

-- ---------------------------------------------------------------------------
-- Existing tables: summary sources and feedback targets
-- ---------------------------------------------------------------------------
ALTER TABLE sources ADD COLUMN summary_id uuid REFERENCES summaries (id);
CREATE INDEX sources_summary_idx ON sources (summary_id) WHERE summary_id IS NOT NULL;

ALTER TABLE sources DROP CONSTRAINT sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check CHECK (kind IN ('notes', 'minutes', 'discussion', 'summary'));
ALTER TABLE sources DROP CONSTRAINT sources_linked_to_thread;
ALTER TABLE sources ADD CONSTRAINT sources_linked_to_thread CHECK (kind IN ('notes', 'summary') OR thread_id IS NOT NULL);

ALTER TABLE source_versions DROP CONSTRAINT source_versions_origin_check;
ALTER TABLE source_versions ADD CONSTRAINT source_versions_origin_check
  CHECK (origin IN ('paste', 'upload', 'meeting', 'discussion', 'summary'));

ALTER TABLE ai_feedback DROP CONSTRAINT ai_feedback_target_kind_check;
ALTER TABLE ai_feedback ADD CONSTRAINT ai_feedback_target_kind_check
  CHECK (target_kind IN ('minutes_draft', 'analysis_run', 'proposal', 'answer', 'report_version', 'summary_version'));

-- ---------------------------------------------------------------------------
-- History (spec 9). Question, answer, draft and summary text is never written here.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_assist_events (
  id           uuid PRIMARY KEY,
  project_id   uuid        NOT NULL REFERENCES projects (id),
  actor_id     uuid        REFERENCES users (id),
  action       text        NOT NULL CHECK (action IN (
                 'asked', 'shared', 'reanswered', 'hidden', 'unhidden', 'review_required', 'cleared', 'withdrawn',
                 'draft_requested', 'draft_edited', 'draft_shared', 'draft_unshared',
                 'summary_requested', 'summary_edited', 'summary_approval_requested', 'summary_approved',
                 'summary_confirmed', 'summary_withdrawn')),
  target_kind  text        NOT NULL,
  target_id    uuid        NOT NULL,
  reason       text,
  detail       jsonb,
  at           timestamptz NOT NULL
);
CREATE INDEX ai_assist_events_project_idx ON ai_assist_events (project_id, at);
CREATE INDEX ai_assist_events_target_idx ON ai_assist_events (target_kind, target_id, at);
CREATE TRIGGER ai_assist_events_append_only BEFORE UPDATE OR DELETE ON ai_assist_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER ai_assist_events_no_truncate BEFORE TRUNCATE ON ai_assist_events
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
