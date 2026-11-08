-- V1.0 sub-project 1: departments, eligible domains, projects, stages, transitions, memberships, invitations.
-- Design: docs/superpowers/specs/2026-11-08-v1-projects-roles-permissions-design.md. Additive only.

-- People who join by invitation are ordinary members; administrator stays an organisation role.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('enterprise_administrator', 'member'));

CREATE FUNCTION kainow_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TABLE departments (
  id          uuid PRIMARY KEY,
  name        text        NOT NULL CHECK (btrim(name) <> ''),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by  uuid        NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL,
  updated_by  uuid        REFERENCES users (id),
  updated_at  timestamptz
);
CREATE UNIQUE INDEX departments_active_name ON departments (lower(name)) WHERE status = 'active';

CREATE TABLE eligible_domains (
  id          uuid PRIMARY KEY,
  domain      text        NOT NULL CHECK (domain = lower(btrim(domain)) AND domain <> ''),
  added_by    uuid        NOT NULL REFERENCES users (id),
  added_at    timestamptz NOT NULL,
  removed_by  uuid        REFERENCES users (id),
  removed_at  timestamptz
);
CREATE UNIQUE INDEX eligible_domains_current ON eligible_domains (domain) WHERE removed_at IS NULL;

CREATE TABLE projects (
  id                    uuid PRIMARY KEY,
  name                  text        NOT NULL CHECK (btrim(name) <> ''),
  purpose               text        NOT NULL CHECK (btrim(purpose) <> ''),
  owning_department_id  uuid        NOT NULL REFERENCES departments (id),
  planned_end           date,
  status                text        NOT NULL CHECK (status IN ('draft', 'planned', 'active', 'deferred', 'closed')),
  closure_outcome       text        CHECK (closure_outcome IN ('delivered', 'partially_delivered', 'abandoned')),
  created_by            uuid        NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL,
  CONSTRAINT projects_outcome_when_closed CHECK ((status = 'closed') = (closure_outcome IS NOT NULL))
);

CREATE TABLE project_departments (
  project_id     uuid NOT NULL REFERENCES projects (id),
  department_id  uuid NOT NULL REFERENCES departments (id),
  PRIMARY KEY (project_id, department_id)
);

CREATE TABLE project_stage_periods (
  id          uuid PRIMARY KEY,
  project_id  uuid        NOT NULL REFERENCES projects (id),
  stage       text        NOT NULL CHECK (stage IN ('Initiation', 'Planning', 'Execution', 'Review & Acceptance', 'Closure')),
  substage    text,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  started_by  uuid        NOT NULL REFERENCES users (id),
  reason      text
);
CREATE UNIQUE INDEX project_stage_periods_one_open ON project_stage_periods (project_id) WHERE ended_at IS NULL;

CREATE TABLE project_transitions (
  id               uuid PRIMARY KEY,
  project_id       uuid        NOT NULL REFERENCES projects (id),
  from_status      text        NOT NULL,
  to_status        text        NOT NULL,
  actor_id         uuid        NOT NULL REFERENCES users (id),
  reason           text,
  closure_outcome  text,
  fast_track       boolean     NOT NULL DEFAULT false,
  at               timestamptz NOT NULL
);
CREATE INDEX project_transitions_project ON project_transitions (project_id, at);
CREATE TRIGGER project_transitions_append_only BEFORE UPDATE OR DELETE ON project_transitions
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

CREATE TABLE memberships (
  id             uuid PRIMARY KEY,
  project_id     uuid NOT NULL REFERENCES projects (id),
  user_id        uuid NOT NULL REFERENCES users (id),
  role           text NOT NULL CHECK (role IN ('pm', 'deputy_pm', 'owner', 'sponsor', 'member')),
  starts_on      date NOT NULL,
  expires_on     date,
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES users (id),
  revoke_reason  text,
  CONSTRAINT memberships_dates CHECK (expires_on IS NULL OR expires_on >= starts_on),
  CONSTRAINT memberships_one_per_role UNIQUE (project_id, user_id, role)
);
CREATE INDEX memberships_user ON memberships (user_id);

CREATE TABLE membership_events (
  id                   uuid PRIMARY KEY,
  membership_id        uuid        NOT NULL REFERENCES memberships (id),
  kind                 text        NOT NULL CHECK (kind IN ('appointed', 'extended', 'dates_changed', 'revoked', 'restored')),
  previous_starts_on   date,
  previous_expires_on  date,
  new_starts_on        date,
  new_expires_on       date,
  actor_id             uuid        NOT NULL REFERENCES users (id),
  reason               text,
  at                   timestamptz NOT NULL
);
CREATE TRIGGER membership_events_append_only BEFORE UPDATE OR DELETE ON membership_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

CREATE TABLE invitations (
  id             uuid PRIMARY KEY,
  project_id     uuid        NOT NULL REFERENCES projects (id),
  email          text        NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  display_name   text,
  role           text        NOT NULL CHECK (role IN ('pm', 'deputy_pm', 'owner', 'sponsor', 'member')),
  starts_on      date        NOT NULL,
  expires_on     date,
  invited_by     uuid        NOT NULL REFERENCES users (id),
  token_hash     text        NOT NULL UNIQUE,
  issued_at      timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  status         text        NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'accepted', 'declined', 'revoked', 'replaced')),
  responded_at   timestamptz,
  membership_id  uuid        REFERENCES memberships (id),
  replaced_by    uuid        REFERENCES invitations (id),
  CONSTRAINT invitations_dates CHECK (expires_on IS NULL OR expires_on >= starts_on)
);
CREATE INDEX invitations_project ON invitations (project_id);
CREATE INDEX invitations_email ON invitations (email);

-- Notes belong to a project. Notes from before projects keep no project and are visible to nobody.
ALTER TABLE sources ADD COLUMN project_id uuid REFERENCES projects (id);
CREATE INDEX sources_project ON sources (project_id);
