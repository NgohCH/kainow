-- V1.0 sub-project 11: the go-live checklist. Additions only.

-- Notices due before this time are neither recorded nor sent. Null means: no limit (every database not made by golive-init).
ALTER TABLE notification_settings ADD COLUMN notices_from timestamptz;

-- The 11 checklist steps. ticked_by null with ticked_at set means ticked automatically ("Kainow").
CREATE TABLE golive_steps (
  key        text        PRIMARY KEY,
  position   smallint    NOT NULL UNIQUE,
  ticked_by  uuid        REFERENCES users (id),
  ticked_at  timestamptz,
  note       text        CHECK (char_length(note) <= 200),
  skipped    boolean     NOT NULL DEFAULT false
);
INSERT INTO golive_steps (key, position) VALUES
  ('organisation', 1), ('logos', 2), ('second_admin', 3), ('recovery', 4), ('mailbox', 5), ('test_email', 6),
  ('calendar', 7), ('backups', 8), ('department', 9), ('users', 10), ('project', 11);

-- One row; closed_at is set once, when the checklist closes.
CREATE TABLE golive_checklist (
  id         smallint    PRIMARY KEY CHECK (id = 1),
  closed_at  timestamptz
);
INSERT INTO golive_checklist (id) VALUES (1);

CREATE TABLE golive_events (
  id        uuid        PRIMARY KEY,
  step_key  text        REFERENCES golive_steps (key),
  action    text        NOT NULL CHECK (action IN ('ticked', 'unticked', 'closed')),
  actor_id  uuid        REFERENCES users (id),
  note      text,
  at        timestamptz NOT NULL
);
CREATE INDEX golive_events_at_idx ON golive_events (at);
CREATE TRIGGER golive_events_append_only BEFORE UPDATE OR DELETE ON golive_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
