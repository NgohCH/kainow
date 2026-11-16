-- V1.0 sub-project 5: history, logical deletion (5a) and credential quarantine (5b).
-- Design: docs/superpowers/specs/2026-11-16-v1-history-deletion-design.md (section 8).
-- Additions only, apart from the narrow trigger and constraint changes marked below. Nothing is physically deleted.

-- ---------------------------------------------------------------------------
-- Quarantine cases come first: every holdable table points at one.
-- ---------------------------------------------------------------------------
CREATE TABLE quarantine_cases (
  id               uuid PRIMARY KEY,
  project_id       uuid        NOT NULL REFERENCES projects (id),
  item_kind        text        NOT NULL CHECK (btrim(item_kind) <> ''),
  item_id          uuid        NOT NULL,
  -- NULL when Kainow itself found the secret at job start.
  reporter_id      uuid        REFERENCES users (id),
  reason           text,
  -- Length and detector kinds only: the marked text lives nowhere but in the encrypted originals.
  marked_length    integer     NOT NULL CHECK (marked_length > 0),
  detector_kinds   text[]      NOT NULL DEFAULT '{}',
  holder_user_id   uuid        REFERENCES users (id),
  state            text        NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'cleaned', 'released', 'released_unchanged')),
  waiting_for_key  boolean     NOT NULL DEFAULT false,
  reported_at      timestamptz NOT NULL,
  cleaned_at       timestamptz,
  closed_at        timestamptz,
  closed_by        uuid        REFERENCES users (id),
  close_reason     text,
  -- A case is closed exactly when it is released (either way), and a closed case says by whom and why.
  CONSTRAINT quarantine_cases_closed_shape CHECK (
    (state IN ('held', 'cleaned') AND closed_at IS NULL AND closed_by IS NULL AND close_reason IS NULL)
    OR (state IN ('released', 'released_unchanged') AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
  )
);
CREATE INDEX quarantine_cases_project_idx ON quarantine_cases (project_id, state);
CREATE INDEX quarantine_cases_item_idx ON quarantine_cases (item_kind, item_id);

CREATE TABLE quarantine_items (
  case_id    uuid NOT NULL REFERENCES quarantine_cases (id),
  item_kind  text NOT NULL,
  item_id    uuid NOT NULL,
  role       text NOT NULL CHECK (role IN ('reported', 'copy')),
  PRIMARY KEY (case_id, item_kind, item_id)
);
CREATE INDEX quarantine_items_item_idx ON quarantine_items (item_kind, item_id);

-- Places found holding the marked text elsewhere in the project: row references only, never text.
CREATE TABLE quarantine_possible_copies (
  case_id     uuid        NOT NULL REFERENCES quarantine_cases (id),
  item_kind   text        NOT NULL,
  item_id     uuid        NOT NULL,
  found_at    timestamptz NOT NULL,
  masked      boolean     NOT NULL DEFAULT true,
  decision    text        CHECK (decision IN ('confirmed', 'dismissed')),
  decided_by  uuid        REFERENCES users (id),
  decided_at  timestamptz,
  PRIMARY KEY (case_id, item_kind, item_id),
  CONSTRAINT quarantine_possible_copies_decided_together CHECK (
    (decision IS NULL AND decided_by IS NULL AND decided_at IS NULL)
    OR (decision IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

-- The original values, encrypted (AES-256-GCM) with the protected key. Only restored_at ever changes.
CREATE TABLE quarantine_originals (
  id              uuid PRIMARY KEY,
  case_id         uuid  NOT NULL REFERENCES quarantine_cases (id),
  table_name      text  NOT NULL,
  row_key         jsonb NOT NULL,
  column_name     text  NOT NULL,
  ciphertext      bytea NOT NULL,
  nonce           bytea NOT NULL CHECK (octet_length(nonce) = 12),
  tag             bytea NOT NULL CHECK (octet_length(tag) = 16),
  key_id          text  NOT NULL,
  -- SHA-256 of the cleaned value written, so a later release can tell whether the row changed since.
  cleaned_sha256  text  NOT NULL,
  restored_at     timestamptz
);
CREATE INDEX quarantine_originals_case_idx ON quarantine_originals (case_id);

CREATE TABLE quarantine_events (
  id          uuid PRIMARY KEY,
  case_id     uuid        NOT NULL REFERENCES quarantine_cases (id),
  project_id  uuid        NOT NULL REFERENCES projects (id),
  actor_id    uuid        REFERENCES users (id),
  action      text        NOT NULL CHECK (action IN (
    'reported', 'held', 'cleaned', 'copies_found', 'copy_confirmed', 'copy_dismissed', 'marked_more',
    'released', 'released_unchanged', 'grant_requested', 'grant_approved', 'grant_declined', 'grant_extended',
    'grant_revoked', 'original_opened', 'notified')),
  item_kind   text,
  item_id     uuid,
  reason      text,
  -- Counts and references only (rows cleaned, copies found); never any text.
  detail      jsonb,
  at          timestamptz NOT NULL
);
CREATE INDEX quarantine_events_case_idx ON quarantine_events (case_id, at);

-- Security reviewers (Q03): designated by an Enterprise Administrator, never by themselves.
ALTER TABLE users ADD COLUMN security_reviewer boolean NOT NULL DEFAULT false;
CREATE TABLE security_reviewer_events (
  id        uuid PRIMARY KEY,
  user_id   uuid        NOT NULL REFERENCES users (id),
  kind      text        NOT NULL CHECK (kind IN ('designated', 'undesignated')),
  actor_id  uuid        NOT NULL REFERENCES users (id),
  reason    text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  at        timestamptz NOT NULL,
  CONSTRAINT security_reviewer_events_not_self CHECK (actor_id <> user_id)
);
CREATE INDEX security_reviewer_events_user_idx ON security_reviewer_events (user_id, at);

CREATE TABLE quarantine_grants (
  id               uuid PRIMARY KEY,
  requester_id     uuid        NOT NULL REFERENCES users (id),
  purpose          text        NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 1 AND 1000),
  hours            integer     NOT NULL CHECK (hours > 0),
  requested_at     timestamptz NOT NULL,
  decision         text        CHECK (decision IN ('approved', 'declined')),
  decided_by       uuid        REFERENCES users (id),
  decided_at       timestamptz,
  decision_reason  text,
  expires_at       timestamptz,
  revoked_by       uuid        REFERENCES users (id),
  revoked_at       timestamptz,
  revoke_reason    text,
  -- Nobody approves or declines their own request; there is no emergency route.
  CONSTRAINT quarantine_grants_not_self_decided CHECK (decided_by IS NULL OR decided_by <> requester_id),
  CONSTRAINT quarantine_grants_decided_together CHECK (
    (decision IS NULL AND decided_by IS NULL AND decided_at IS NULL)
    OR (decision IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT quarantine_grants_revoked_together CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);
CREATE INDEX quarantine_grants_requester_idx ON quarantine_grants (requester_id, requested_at);

CREATE TABLE quarantine_grant_cases (
  grant_id  uuid NOT NULL REFERENCES quarantine_grants (id),
  case_id   uuid NOT NULL REFERENCES quarantine_cases (id),
  PRIMARY KEY (grant_id, case_id)
);

-- ---------------------------------------------------------------------------
-- The quarantine write exception.
-- ---------------------------------------------------------------------------
-- True when the transaction-local setting kainow.quarantine_write holds the id of a quarantine case that is
--   * in state 'held' or 'cleaned' (the case is open), or
--   * being closed in this very transaction (state 'released' / 'released_unchanged' and the case row itself
--     was written by the current top-level transaction: its xmin equals txid_current()). That lets release
--     unchanged and dismiss close the case and decrypt the originals back into place in one transaction,
--     while a case closed in any earlier transaction opens nothing.
-- Anything else (no setting, an empty or non-uuid value, an unknown case, a case closed earlier) is false.
-- Only the quarantine module sets the setting. Every immutable / append-only trigger function below returns NEW
-- for UPDATE when this is true; DELETE and TRUNCATE are always refused.
CREATE FUNCTION kainow_quarantine_writing() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  setting text := current_setting('kainow.quarantine_write', true);
  case_id uuid;
BEGIN
  IF setting IS NULL OR setting = '' THEN
    RETURN false;
  END IF;
  BEGIN
    case_id := setting::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;
  RETURN EXISTS (
    SELECT 1 FROM quarantine_cases c
     WHERE c.id = case_id
       AND (c.state IN ('held', 'cleaned')
            OR (c.state IN ('released', 'released_unchanged')
                AND c.xmin::text::bigint = txid_current() % 4294967296))
  );
END;
$$;

-- Replacement trigger functions (the triggers themselves, created in 0004-0026, are unchanged).
-- 0004: source_versions (UPDATE, DELETE, TRUNCATE)
CREATE OR REPLACE FUNCTION source_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND kainow_quarantine_writing() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'source_versions are immutable' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- 0010 (replacing 0006): extraction_items. Only the review decision changes, or the quarantine write.
CREATE OR REPLACE FUNCTION extraction_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extraction_items are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF kainow_quarantine_writing() THEN
    RETURN NEW;
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

-- 0009: extraction_item_edits
CREATE OR REPLACE FUNCTION extraction_item_edits_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND kainow_quarantine_writing() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'extraction_item_edits is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;

-- 0012: the shared append-only function. It serves membership_events, grant_events, task_events,
-- record_events, question_answers, change_request_versions, approvals, discussion_events, feedback_events,
-- transcript_spans, ai_assist_events, quarantine_events, source_events and the other *_events history tables,
-- so one replacement covers them all.
CREATE OR REPLACE FUNCTION kainow_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND kainow_quarantine_writing() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

-- 0024: message_versions, minutes_drafts
CREATE OR REPLACE FUNCTION discussion_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND kainow_quarantine_writing() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% are immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- 0026: passages, report_draft_versions, summary_versions
CREATE OR REPLACE FUNCTION ai_assist_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND kainow_quarantine_writing() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% are immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- 0026: ai_request_material (the snapshot of a record may be cleaned)
CREATE OR REPLACE FUNCTION ai_request_material_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'ai_request_material rows are not deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF kainow_quarantine_writing() THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'cited' - 'dropped_at_start') IS DISTINCT FROM (to_jsonb(OLD) - 'cited' - 'dropped_at_start') THEN
    RAISE EXCEPTION 'only cited and dropped_at_start of ai_request_material may change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 0026: summary_marks (the phrase may be cleaned)
CREATE OR REPLACE FUNCTION summary_marks_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'summary_marks rows are not deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF kainow_quarantine_writing() THEN
    RETURN NEW;
  END IF;
  IF OLD.intended_by IS NOT NULL
     OR (to_jsonb(NEW) - 'intended_by' - 'intended_at') IS DISTINCT FROM (to_jsonb(OLD) - 'intended_by' - 'intended_at') THEN
    RAISE EXCEPTION 'only intended_by and intended_at of summary_marks may be set, once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Events of this migration: append-only, with the same exception.
CREATE TRIGGER quarantine_events_append_only BEFORE UPDATE OR DELETE ON quarantine_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER security_reviewer_events_append_only BEFORE UPDATE OR DELETE ON security_reviewer_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- Originals: only restored_at may change; never deleted, and the quarantine exception does not widen that.
CREATE FUNCTION quarantine_originals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'quarantine_originals rows are not deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'restored_at') IS DISTINCT FROM (to_jsonb(OLD) - 'restored_at') THEN
    RAISE EXCEPTION 'only restored_at of quarantine_originals may change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quarantine_originals_guard BEFORE UPDATE OR DELETE ON quarantine_originals
  FOR EACH ROW EXECUTE FUNCTION quarantine_originals_guard();
CREATE TRIGGER quarantine_originals_no_truncate BEFORE TRUNCATE ON quarantine_originals
  FOR EACH STATEMENT EXECUTE FUNCTION quarantine_originals_guard();

-- Truncating the new append-only tables is refused too.
CREATE TRIGGER quarantine_events_no_truncate BEFORE TRUNCATE ON quarantine_events
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER security_reviewer_events_no_truncate BEFORE TRUNCATE ON security_reviewer_events
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();

-- ---------------------------------------------------------------------------
-- Sources: logical deletion and its history.
-- ---------------------------------------------------------------------------
ALTER TABLE sources
  ADD COLUMN deleted_by     uuid REFERENCES users (id),
  ADD COLUMN deleted_at     timestamptz,
  ADD COLUMN delete_reason  text,
  ADD COLUMN held_case_id   uuid REFERENCES quarantine_cases (id);
ALTER TABLE sources ADD CONSTRAINT sources_deleted_together CHECK (
  (deleted_by IS NULL AND deleted_at IS NULL AND delete_reason IS NULL)
  OR (deleted_by IS NOT NULL AND deleted_at IS NOT NULL AND delete_reason IS NOT NULL AND char_length(btrim(delete_reason)) BETWEEN 1 AND 1000)
);

CREATE TABLE source_events (
  id          uuid PRIMARY KEY,
  source_id   uuid        NOT NULL REFERENCES sources (id),
  project_id  uuid        NOT NULL REFERENCES projects (id),
  kind        text        NOT NULL CHECK (kind IN ('deleted', 'restored')),
  actor_id    uuid        NOT NULL REFERENCES users (id),
  reason      text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  at          timestamptz NOT NULL
);
CREATE INDEX source_events_source_idx ON source_events (source_id, at);
CREATE INDEX source_events_project_idx ON source_events (project_id, at);
CREATE TRIGGER source_events_append_only BEFORE UPDATE OR DELETE ON source_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER source_events_no_truncate BEFORE TRUNCATE ON source_events
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();

-- A version's uploaded original may be withheld once its text had a credential removed (spec 7.4).
ALTER TABLE source_versions ADD COLUMN quarantined_at timestamptz;
ALTER TABLE source_versions DROP CONSTRAINT source_versions_upload_has_original;
ALTER TABLE source_versions ADD CONSTRAINT source_versions_upload_has_original CHECK (
  (origin = 'upload' AND original_bytes IS NOT NULL AND original_sha256 IS NOT NULL AND filename IS NOT NULL)
  OR (origin = 'upload' AND original_bytes IS NULL AND quarantined_at IS NOT NULL)
  OR (origin <> 'upload' AND original_bytes IS NULL AND original_sha256 IS NULL)
);

-- ---------------------------------------------------------------------------
-- Authorised records: logical deletion. Status values are unchanged, so restoring returns the earlier state.
-- ---------------------------------------------------------------------------
ALTER TABLE tasks
  ADD COLUMN deleted_at     timestamptz,
  ADD COLUMN deleted_by     uuid REFERENCES users (id),
  ADD COLUMN delete_reason  text,
  ADD COLUMN held_case_id   uuid REFERENCES quarantine_cases (id),
  -- Set on a subtask deleted together with its parent: restoring the parent restores exactly these.
  ADD COLUMN deleted_with   uuid REFERENCES tasks (id);
ALTER TABLE tasks ADD CONSTRAINT tasks_deleted_together CHECK (
  (deleted_by IS NULL AND deleted_at IS NULL AND delete_reason IS NULL)
  OR (deleted_by IS NOT NULL AND deleted_at IS NOT NULL AND delete_reason IS NOT NULL AND char_length(btrim(delete_reason)) BETWEEN 1 AND 1000)
);
ALTER TABLE tasks ADD CONSTRAINT tasks_deleted_with_is_deleted CHECK (deleted_with IS NULL OR deleted_at IS NOT NULL);
CREATE INDEX tasks_deleted_with_idx ON tasks (deleted_with) WHERE deleted_with IS NOT NULL;

ALTER TABLE decisions
  ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid REFERENCES users (id), ADD COLUMN delete_reason text,
  ADD COLUMN held_case_id uuid REFERENCES quarantine_cases (id);
ALTER TABLE decisions ADD CONSTRAINT decisions_deleted_together CHECK (
  (deleted_by IS NULL AND deleted_at IS NULL AND delete_reason IS NULL)
  OR (deleted_by IS NOT NULL AND deleted_at IS NOT NULL AND delete_reason IS NOT NULL AND char_length(btrim(delete_reason)) BETWEEN 1 AND 1000)
);

ALTER TABLE questions
  ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid REFERENCES users (id), ADD COLUMN delete_reason text,
  ADD COLUMN held_case_id uuid REFERENCES quarantine_cases (id);
ALTER TABLE questions ADD CONSTRAINT questions_deleted_together CHECK (
  (deleted_by IS NULL AND deleted_at IS NULL AND delete_reason IS NULL)
  OR (deleted_by IS NOT NULL AND deleted_at IS NOT NULL AND delete_reason IS NOT NULL AND char_length(btrim(delete_reason)) BETWEEN 1 AND 1000)
);

ALTER TABLE risks
  ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid REFERENCES users (id), ADD COLUMN delete_reason text,
  ADD COLUMN held_case_id uuid REFERENCES quarantine_cases (id);
ALTER TABLE risks ADD CONSTRAINT risks_deleted_together CHECK (
  (deleted_by IS NULL AND deleted_at IS NULL AND delete_reason IS NULL)
  OR (deleted_by IS NOT NULL AND deleted_at IS NOT NULL AND delete_reason IS NOT NULL AND char_length(btrim(delete_reason)) BETWEEN 1 AND 1000)
);

-- task_events gains 'deleted' and 'restored'. record_events.kind has no CHECK constraint (0014), so any kind
-- already fits there and nothing changes.
ALTER TABLE task_events DROP CONSTRAINT task_events_kind_check;
ALTER TABLE task_events ADD CONSTRAINT task_events_kind_check CHECK (kind IN (
  'authorised', 'started', 'blocked', 'unblocked', 'completed', 'reopened',
  'amended', 'cancelled', 'review_required', 'deadline_reviewed', 'reconciled',
  'deleted', 'restored'));

-- ---------------------------------------------------------------------------
-- Other holdable item tables (spec 7.2).
-- ---------------------------------------------------------------------------
ALTER TABLE discussion_messages ADD COLUMN held_case_id uuid REFERENCES quarantine_cases (id);
ALTER TABLE discussion_threads  ADD COLUMN held_case_id uuid REFERENCES quarantine_cases (id);
ALTER TABLE extraction_items    ADD COLUMN held_case_id uuid REFERENCES quarantine_cases (id);
ALTER TABLE human_proposals     ADD COLUMN held_case_id uuid REFERENCES quarantine_cases (id);
ALTER TABLE ai_answers          ADD COLUMN held_case_id uuid REFERENCES quarantine_cases (id);
ALTER TABLE report_drafts       ADD COLUMN held_case_id uuid REFERENCES quarantine_cases (id);
ALTER TABLE summaries           ADD COLUMN held_case_id uuid REFERENCES quarantine_cases (id);
ALTER TABLE ai_feedback         ADD COLUMN held_case_id uuid REFERENCES quarantine_cases (id);

-- ---------------------------------------------------------------------------
-- Delegation of record deletion to the Project Manager (D83), shaped like closure_delegations.
-- ---------------------------------------------------------------------------
CREATE TABLE record_deletion_delegations (
  id             uuid        PRIMARY KEY,
  project_id     uuid        NOT NULL REFERENCES projects (id),
  pm_user_id     uuid        NOT NULL REFERENCES users (id),
  delegated_by   uuid        NOT NULL REFERENCES users (id),
  reason         text        NOT NULL,
  at             timestamptz NOT NULL,
  revoked_by     uuid        REFERENCES users (id),
  revoked_at     timestamptz,
  revoke_reason  text,
  CONSTRAINT record_deletion_delegations_revoked_together CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);
CREATE UNIQUE INDEX record_deletion_delegations_one_open ON record_deletion_delegations (project_id) WHERE revoked_at IS NULL;

-- Inspect Deleted Content (O02): a flag on an access grant.
ALTER TABLE access_grants ADD COLUMN inspect_deleted boolean NOT NULL DEFAULT false;
