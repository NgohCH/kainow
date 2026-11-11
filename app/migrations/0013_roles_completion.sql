-- V1.0 sub-project 1b: account states, membership holds and findings, Audit/Oversight grants,
-- archive history, department changes and Project Manager handovers. Additions only.

-- Accounts: an invitee's account is Invited until its first sign-in.
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('invited', 'active', 'disabled'));

-- Membership holds. A hold is current when held_at is set and restored_at is empty or earlier.
ALTER TABLE memberships
  ADD COLUMN held_at        timestamptz,
  ADD COLUMN held_by        uuid REFERENCES users (id),
  ADD COLUMN hold_reason    text,
  ADD COLUMN restored_at    timestamptz,
  ADD COLUMN restored_by    uuid REFERENCES users (id),
  ADD COLUMN restore_reason text;

ALTER TABLE membership_events DROP CONSTRAINT membership_events_kind_check;
ALTER TABLE membership_events ADD CONSTRAINT membership_events_kind_check
  CHECK (kind IN ('appointed', 'extended', 'dates_changed', 'revoked', 'restored', 'held', 'finding'));

CREATE TABLE membership_findings (
  id              uuid        PRIMARY KEY,
  membership_id   uuid        NOT NULL REFERENCES memberships (id),
  finding         text        NOT NULL CHECK (btrim(finding) <> ''),
  recommendation  text        NOT NULL CHECK (recommendation IN ('restore', 'revoke')),
  recorded_by     uuid        NOT NULL REFERENCES users (id),
  at              timestamptz NOT NULL
);
CREATE INDEX membership_findings_membership_idx ON membership_findings (membership_id);
CREATE TRIGGER membership_findings_append_only BEFORE UPDATE OR DELETE ON membership_findings
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- Audit and Oversight access: one row per recorded request; state is worked out from it and the dates.
CREATE TABLE access_grants (
  id               uuid        PRIMARY KEY,
  project_id       uuid        NOT NULL REFERENCES projects (id),
  user_id          uuid        NOT NULL REFERENCES users (id),
  kind             text        NOT NULL CHECK (kind IN ('audit', 'oversight')),
  purpose          text        NOT NULL CHECK (btrim(purpose) <> ''),
  scope            text        NOT NULL CHECK (btrim(scope) <> ''),
  starts_on        date        NOT NULL,
  expires_on       date        NOT NULL,
  requested_by     uuid        NOT NULL REFERENCES users (id),
  requested_at     timestamptz NOT NULL,
  decision         text        CHECK (decision IN ('approved', 'declined')),
  decided_by       uuid        REFERENCES users (id),
  decided_at       timestamptz,
  decision_reason  text,
  suspended_at     timestamptz,
  suspended_by     uuid        REFERENCES users (id),
  suspend_reason   text,
  revoked_at       timestamptz,
  revoked_by       uuid        REFERENCES users (id),
  revoke_reason    text,
  CONSTRAINT access_grants_dates CHECK (expires_on >= starts_on)
);
CREATE INDEX access_grants_project_user_idx ON access_grants (project_id, user_id);

CREATE TABLE grant_events (
  id                   uuid        PRIMARY KEY,
  grant_id             uuid        NOT NULL REFERENCES access_grants (id),
  kind                 text        NOT NULL CHECK (kind IN ('requested', 'approved', 'declined', 'extended', 'suspended', 'restored', 'revoked')),
  previous_expires_on  date,
  new_expires_on       date,
  actor_id             uuid        NOT NULL REFERENCES users (id),
  reason               text,
  at                   timestamptz NOT NULL
);
CREATE TRIGGER grant_events_append_only BEFORE UPDATE OR DELETE ON grant_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- Archive history; archived state is worked out from these and the closing date.
CREATE TABLE project_archive_events (
  id          uuid        PRIMARY KEY,
  project_id  uuid        NOT NULL REFERENCES projects (id),
  kind        text        NOT NULL CHECK (kind IN ('archived', 'unarchived')),
  actor_id    uuid        NOT NULL REFERENCES users (id),
  reason      text        NOT NULL CHECK (btrim(reason) <> ''),
  at          timestamptz NOT NULL
);
CREATE INDEX project_archive_events_project_idx ON project_archive_events (project_id, at);
CREATE TRIGGER project_archive_events_append_only BEFORE UPDATE OR DELETE ON project_archive_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- The Administrator's moves of a project to another owning department.
CREATE TABLE project_department_changes (
  id                  uuid        PRIMARY KEY,
  project_id          uuid        NOT NULL REFERENCES projects (id),
  from_department_id  uuid        NOT NULL REFERENCES departments (id),
  to_department_id    uuid        NOT NULL REFERENCES departments (id),
  actor_id            uuid        NOT NULL REFERENCES users (id),
  reason              text        NOT NULL CHECK (btrim(reason) <> ''),
  files_decision      text        NOT NULL CHECK (files_decision IN ('kept_in_place')),
  at                  timestamptz NOT NULL
);
CREATE TRIGGER project_department_changes_append_only BEFORE UPDATE OR DELETE ON project_department_changes
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- Project Manager handovers travel as invitations of their own kind.
ALTER TABLE invitations
  ADD COLUMN kind                   text NOT NULL DEFAULT 'role' CHECK (kind IN ('role', 'handover')),
  ADD COLUMN outgoing_membership_id uuid REFERENCES memberships (id),
  ADD COLUMN outgoing_role          text CHECK (outgoing_role IN ('deputy_pm', 'member', 'leave')),
  ADD CONSTRAINT invitations_handover_shape CHECK (
    (kind = 'role' AND outgoing_membership_id IS NULL AND outgoing_role IS NULL)
    OR (kind = 'handover' AND role = 'pm' AND outgoing_membership_id IS NOT NULL AND outgoing_role IS NOT NULL)
  );
