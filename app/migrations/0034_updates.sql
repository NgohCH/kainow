-- Sub-project 10b: the updater. Release checks, approved updates, their steps, and the maintenance reason 'update'.

-- Update maintenance reuses 10a's protective mode; only the updater ends it (Resume refuses it).
ALTER TABLE operations_state DROP CONSTRAINT operations_state_reason_check;
ALTER TABLE operations_state ADD CONSTRAINT operations_state_reason_check
  CHECK (reason IN ('low_space', 'restored_from_backup', 'update'));

-- ---------------------------------------------------------------------------
-- Release checks (diagnostic, D115) and the tags seen (one notice per tag).
-- ---------------------------------------------------------------------------
CREATE TABLE release_checks (
  id            uuid PRIMARY KEY,
  at            timestamptz NOT NULL,
  trigger       text        NOT NULL CHECK (trigger IN ('daily', 'manual')),
  actor_id      uuid        REFERENCES users (id),
  outcome       text        NOT NULL CHECK (outcome IN ('found', 'none_newer', 'failed')),
  failure_code  text,
  newest_tag    text,
  newest_commit text
);
CREATE INDEX release_checks_at_idx ON release_checks (at DESC, id DESC);

CREATE TABLE releases_seen (
  tag            text PRIMARY KEY,
  commit         text        NOT NULL,
  first_seen_at  timestamptz NOT NULL,
  notified_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- Updates: one approved release on its way to being installed.
-- ---------------------------------------------------------------------------
CREATE TABLE updates (
  id                        uuid PRIMARY KEY,
  from_version              text        NOT NULL,
  to_version                text        NOT NULL,
  tag                       text        NOT NULL,
  commit                    text        NOT NULL,
  tag_object                text,                                  -- set when the tag is verified
  state                     text        NOT NULL CHECK (state IN (
    'approved', 'preparing', 'ready', 'installing', 'succeeded', 'refused',
    'failed_before_install', 'failed_after_migration', 'failed_needs_attention', 'recovered', 'cancelled')),
  starts_at                 timestamptz NOT NULL,
  expected_minutes          integer     NOT NULL CHECK (expected_minutes BETWEEN 5 AND 240),
  approved_by               uuid        NOT NULL REFERENCES users (id),
  approved_at               timestamptz NOT NULL,
  reason                    text        NOT NULL CHECK (btrim(reason) <> ''),
  cancelled_by              uuid        REFERENCES users (id),
  cancelled_at              timestamptz,
  cancel_reason             text,
  reminder_sent_at          timestamptz,
  release_notes             text,                                  -- from the verified tag message
  pre_update_backup_run_id  uuid        REFERENCES backup_runs (id),
  recovery_backup_run_id    uuid        REFERENCES backup_runs (id),
  failure_code              text,
  finished_at               timestamptz
);
CREATE INDEX updates_approved_idx ON updates (approved_at DESC, id DESC);
-- At most one update is open at a time.
CREATE UNIQUE INDEX updates_one_open ON updates ((true)) WHERE state IN ('approved', 'preparing', 'ready', 'installing');

-- Approved, rescheduled, cancelled and every state change; the actor is NULL when the updater acted.
CREATE TABLE update_changes (
  id         uuid PRIMARY KEY,
  update_id  uuid        NOT NULL REFERENCES updates (id),
  at         timestamptz NOT NULL,
  action     text        NOT NULL CHECK (action IN ('approved', 'rescheduled', 'cancelled', 'state_changed', 'reminded')),
  actor_id   uuid        REFERENCES users (id),
  detail     jsonb
);
CREATE INDEX update_changes_update_idx ON update_changes (update_id, at, id);

CREATE TABLE update_steps (
  id            uuid PRIMARY KEY,
  update_id     uuid        NOT NULL REFERENCES updates (id),
  step          text        NOT NULL,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz,
  outcome       text        NOT NULL CHECK (outcome IN ('running', 'passed', 'failed', 'skipped')),
  failure_code  text
);
CREATE INDEX update_steps_update_idx ON update_steps (update_id, started_at, id);

-- Diagnostic (D115): what each updater run did, and which release key and tag it saw.
CREATE TABLE updater_ticks (
  id               uuid PRIMARY KEY,
  at               timestamptz NOT NULL,
  did              text        NOT NULL,
  running_tag      text,
  key_fingerprint  text
);
CREATE INDEX updater_ticks_at_idx ON updater_ticks (at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Append-only history. A step may be finished once: only finished_at, outcome and failure_code change, on a running row.
-- ---------------------------------------------------------------------------
CREATE TRIGGER update_changes_append_only BEFORE UPDATE OR DELETE ON update_changes
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER update_changes_no_truncate BEFORE TRUNCATE ON update_changes
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();

CREATE FUNCTION update_steps_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.outcome = 'running'
     AND NEW.outcome <> 'running'
     AND NEW.id = OLD.id AND NEW.update_id = OLD.update_id AND NEW.step = OLD.step AND NEW.started_at = OLD.started_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER update_steps_guard BEFORE UPDATE OR DELETE ON update_steps
  FOR EACH ROW EXECUTE FUNCTION update_steps_guard();
CREATE TRIGGER update_steps_no_truncate BEFORE TRUNCATE ON update_steps
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
