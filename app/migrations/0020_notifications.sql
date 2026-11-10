-- V1.0 sub-project 3: reminders, escalation, working-day calendar and email. Additions only.

-- True when an array has no repeated element (used by the settings bounds).
CREATE FUNCTION kainow_all_different(a smallint[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(a) = (SELECT count(DISTINCT x) FROM unnest(a) AS x)
$$;

-- The organisation's notification settings: one row.
CREATE TABLE notification_settings (
  id                             smallint    PRIMARY KEY CHECK (id = 1),
  day_counting                   text        NOT NULL DEFAULT 'working' CHECK (day_counting IN ('working', 'calendar')),
  weekdays                       smallint[]  NOT NULL DEFAULT ARRAY[1,2,3,4,5]::smallint[]
                                   CHECK (cardinality(weekdays) BETWEEN 1 AND 7
                                          AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
                                          AND kainow_all_different(weekdays)),
  lead_days                      smallint[]  NOT NULL DEFAULT ARRAY[7,1]::smallint[]
                                   CHECK (cardinality(lead_days) BETWEEN 1 AND 3
                                          AND lead_days <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30]::smallint[]
                                          AND kainow_all_different(lead_days)),
  escalation_days                smallint    NOT NULL DEFAULT 3 CHECK (escalation_days BETWEEN 1 AND 10),
  sweep_minutes                  smallint    NOT NULL DEFAULT 15 CHECK (sweep_minutes BETWEEN 5 AND 60),
  projects_may_change_calendar   boolean     NOT NULL DEFAULT false,
  projects_may_change_timings    boolean     NOT NULL DEFAULT false,
  projects_may_change_digest     boolean     NOT NULL DEFAULT false,
  updated_by                     uuid        REFERENCES users (id),
  updated_at                     timestamptz NOT NULL
);
INSERT INTO notification_settings (id, updated_at) VALUES (1, now());

-- Per-project overrides (null means: use the organisation's value) and the project's digest schedule.
CREATE TABLE project_notification_settings (
  project_id       uuid        PRIMARY KEY REFERENCES projects (id),
  day_counting     text        CHECK (day_counting IN ('working', 'calendar')),
  weekdays         smallint[]  CHECK (weekdays IS NULL OR (cardinality(weekdays) BETWEEN 1 AND 7
                                          AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
                                          AND kainow_all_different(weekdays))),
  lead_days        smallint[]  CHECK (lead_days IS NULL OR (cardinality(lead_days) BETWEEN 1 AND 3
                                          AND lead_days <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30]::smallint[]
                                          AND kainow_all_different(lead_days))),
  escalation_days  smallint    CHECK (escalation_days BETWEEN 1 AND 10),
  digest_enabled   boolean     NOT NULL DEFAULT false,
  digest_frequency text        CHECK (digest_frequency IN ('daily', 'weekly')),
  digest_weekday   smallint    CHECK (digest_weekday BETWEEN 1 AND 7),
  digest_time      time,
  updated_by       uuid        REFERENCES users (id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Holidays for the organisation (project_id null) or one project. Removal keeps the row.
CREATE TABLE holidays (
  id          uuid        PRIMARY KEY,
  project_id  uuid        REFERENCES projects (id),
  on_date     date        NOT NULL,
  name        text        NOT NULL CHECK (btrim(name) <> ''),
  added_by    uuid        NOT NULL REFERENCES users (id),
  added_at    timestamptz NOT NULL,
  removed_by  uuid        REFERENCES users (id),
  removed_at  timestamptz,
  CONSTRAINT holidays_removed_together CHECK ((removed_by IS NULL) = (removed_at IS NULL))
);
CREATE UNIQUE INDEX holidays_current ON holidays (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), on_date)
  WHERE removed_at IS NULL;

CREATE TABLE notification_settings_changes (
  id          uuid        PRIMARY KEY,
  scope       text        NOT NULL CHECK (scope IN ('organisation', 'project')),
  project_id  uuid        REFERENCES projects (id),
  field       text        NOT NULL,
  old_value   text,
  new_value   text,
  reason      text        NOT NULL CHECK (btrim(reason) <> ''),
  actor_id    uuid        NOT NULL REFERENCES users (id),
  at          timestamptz NOT NULL,
  CONSTRAINT notification_settings_changes_scope CHECK ((scope = 'project') = (project_id IS NOT NULL))
);
CREATE INDEX notification_settings_changes_at_idx ON notification_settings_changes (at);
CREATE TRIGGER notification_settings_changes_append_only BEFORE UPDATE OR DELETE ON notification_settings_changes
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- One row per decided trigger. Rows are inserted complete and never updated; the unique key decides who fires it.
CREATE TABLE notification_triggers (
  id           uuid        PRIMARY KEY,
  key          text        NOT NULL UNIQUE,
  kind         text        NOT NULL,
  project_id   uuid        NOT NULL REFERENCES projects (id),
  record_kind  text        NOT NULL,
  record_id    uuid        NOT NULL,
  fire_at      timestamptz NOT NULL,
  decided_at   timestamptz NOT NULL,
  outcome      text        NOT NULL CHECK (outcome IN ('sent', 'skipped_obsolete', 'skipped_paused', 'no_recipient', 'cancelled_ineligible')),
  recipients   uuid[]      NOT NULL DEFAULT '{}',
  detail       jsonb
);
CREATE INDEX notification_triggers_record_idx ON notification_triggers (record_kind, record_id);
CREATE INDEX notification_triggers_project_idx ON notification_triggers (project_id, decided_at);
CREATE TRIGGER notification_triggers_append_only BEFORE UPDATE OR DELETE ON notification_triggers
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

CREATE TABLE digest_runs (
  id                 uuid        PRIMARY KEY,
  project_id         uuid        NOT NULL REFERENCES projects (id),
  initiated_by_user  uuid        REFERENCES users (id),
  scheduled          boolean     NOT NULL,
  as_at              timestamptz NOT NULL,
  recipient_count    integer     NOT NULL DEFAULT 0 CHECK (recipient_count >= 0)
);
CREATE INDEX digest_runs_project_idx ON digest_runs (project_id, as_at);

-- Every email composed, with its delivery state. Not append-only: status and attempt fields change.
CREATE TABLE email_outbox (
  id                  uuid        PRIMARY KEY,
  to_user_id          uuid        REFERENCES users (id),
  to_address          text        NOT NULL,
  subject             text        NOT NULL,
  text_body           text        NOT NULL,
  html_body           text,
  attachments         jsonb,
  kind                text        NOT NULL,
  project_id          uuid        REFERENCES projects (id),
  initiated_by_user   uuid        REFERENCES users (id),
  initiated_by        text        NOT NULL CHECK (initiated_by IN ('person', 'schedule', 'trigger', 'digest', 'system')),
  trigger_ids         uuid[]      NOT NULL DEFAULT '{}',
  digest_run_id       uuid        REFERENCES digest_runs (id),
  relevance           jsonb,
  status              text        NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'sending', 'retry_wait', 'sent', 'failed', 'cancelled', 'uncertain')),
  attempts            smallint    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  first_failure_at    timestamptz,
  next_attempt_at     timestamptz,
  last_reason         text,
  possible_duplicate  boolean     NOT NULL DEFAULT false,
  resend_of           uuid        REFERENCES email_outbox (id),
  replaces            uuid        REFERENCES email_outbox (id),
  created_at          timestamptz NOT NULL,
  sent_at             timestamptz
);
CREATE INDEX email_outbox_status_idx ON email_outbox (status, next_attempt_at);
CREATE INDEX email_outbox_project_idx ON email_outbox (project_id, created_at DESC);

CREATE TABLE email_attempts (
  id           uuid        PRIMARY KEY,
  outbox_id    uuid        NOT NULL REFERENCES email_outbox (id),
  attempt_no   smallint    NOT NULL CHECK (attempt_no >= 1),
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  outcome      text        NOT NULL CHECK (outcome IN ('sent', 'temporary', 'permanent', 'uncertain')),
  smtp_code    text,
  error_class  text
);
CREATE INDEX email_attempts_outbox_idx ON email_attempts (outbox_id, attempt_no);
CREATE TRIGGER email_attempts_append_only BEFORE UPDATE OR DELETE ON email_attempts
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- In-app notices. read_at and outbox_id are set later, so this table is not append-only.
CREATE TABLE notifications (
  id          uuid        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id),
  trigger_id  uuid        REFERENCES notification_triggers (id),
  project_id  uuid        REFERENCES projects (id),
  kind        text        NOT NULL,
  urgent      boolean     NOT NULL DEFAULT false,
  summary     text        NOT NULL,
  link        text,
  created_at  timestamptz NOT NULL,
  read_at     timestamptz,
  outbox_id   uuid        REFERENCES email_outbox (id),
  email_off   boolean     NOT NULL DEFAULT false
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, created_at DESC);
CREATE INDEX notifications_unsent_idx ON notifications (user_id, project_id) WHERE outbox_id IS NULL;
CREATE INDEX notifications_trigger_idx ON notifications (trigger_id) WHERE trigger_id IS NOT NULL;

-- No row means the default, daily_urgent_immediate.
CREATE TABLE email_preferences (
  user_id     uuid        NOT NULL REFERENCES users (id),
  project_id  uuid        NOT NULL REFERENCES projects (id),
  choice      text        NOT NULL CHECK (choice IN ('daily_urgent_immediate', 'immediate', 'daily', 'off')),
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE away_periods (
  id          uuid        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id),
  starts_on   date        NOT NULL,
  ends_on     date        NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL,
  removed_at  timestamptz,
  CONSTRAINT away_periods_order CHECK (ends_on >= starts_on)
);
CREATE INDEX away_periods_user_idx ON away_periods (user_id, starts_on) WHERE removed_at IS NULL;

CREATE TABLE sweep_runs (
  id              uuid        PRIMARY KEY,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz,
  duration_ms     integer     CHECK (duration_ms >= 0),
  triggers_fired  integer     NOT NULL DEFAULT 0,
  emails_queued   integer     NOT NULL DEFAULT 0
);
CREATE INDEX sweep_runs_started_idx ON sweep_runs (started_at);

-- Indexes the sweep needs on open work.
CREATE INDEX tasks_open_sweep_idx ON tasks (project_id) WHERE status NOT IN ('completed', 'cancelled');
CREATE INDEX risks_review_sweep_idx ON risks (project_id) WHERE status <> 'resolved' AND review_on IS NOT NULL;
