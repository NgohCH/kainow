-- V1.0 sub-project 7: dashboards and analytics (leadership grants, display preferences, saved analytics views,
-- access settings, and the indexes the measures need).
-- Design: docs/superpowers/specs/2026-11-18-v1-dashboards-design.md (section 12).
-- Additive only. Leadership grants are never deleted; the two change/event tables are append-only.

-- ---------------------------------------------------------------------------
-- Leadership grants (D89). expires_on is the last day; NULL means no end.
-- ---------------------------------------------------------------------------
CREATE TABLE leadership_grants (
  id             uuid PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES users (id),
  scope_kind     text        NOT NULL CHECK (scope_kind IN ('organisation', 'departments', 'projects')),
  starts_on      date        NOT NULL,
  expires_on     date,
  reason         text        NOT NULL CHECK (btrim(reason) <> ''),
  granted_by     uuid        NOT NULL REFERENCES users (id),
  granted_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_by     uuid        REFERENCES users (id),
  revoke_reason  text        CHECK (revoke_reason IS NULL OR btrim(revoke_reason) <> ''),
  CONSTRAINT leadership_grants_not_self CHECK (granted_by <> user_id),
  CONSTRAINT leadership_grants_dates CHECK (expires_on IS NULL OR expires_on >= starts_on),
  CONSTRAINT leadership_grants_revoked_together CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX leadership_grants_user_idx ON leadership_grants (user_id, starts_on);

CREATE TABLE leadership_grant_departments (
  grant_id       uuid NOT NULL REFERENCES leadership_grants (id),
  department_id  uuid NOT NULL REFERENCES departments (id),
  PRIMARY KEY (grant_id, department_id)
);
CREATE INDEX leadership_grant_departments_department_idx ON leadership_grant_departments (department_id);

CREATE TABLE leadership_grant_projects (
  grant_id    uuid NOT NULL REFERENCES leadership_grants (id),
  project_id  uuid NOT NULL REFERENCES projects (id),
  PRIMARY KEY (grant_id, project_id)
);
CREATE INDEX leadership_grant_projects_project_idx ON leadership_grant_projects (project_id);

CREATE TABLE leadership_grant_events (
  id        uuid PRIMARY KEY,
  grant_id  uuid        NOT NULL REFERENCES leadership_grants (id),
  kind      text        NOT NULL CHECK (kind IN ('granted', 'end_changed', 'revoked')),
  actor_id  uuid        NOT NULL REFERENCES users (id),
  at        timestamptz NOT NULL,
  reason    text        NOT NULL CHECK (btrim(reason) <> ''),
  detail    jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX leadership_grant_events_grant_idx ON leadership_grant_events (grant_id, at);

-- ---------------------------------------------------------------------------
-- Display preferences and saved analytics views.
-- ---------------------------------------------------------------------------
CREATE TABLE user_preferences (
  user_id     uuid PRIMARY KEY REFERENCES users (id),
  prefs       jsonb       NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL
);

CREATE TABLE analytics_views (
  id          uuid PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id),
  name        text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  config      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  CONSTRAINT analytics_views_user_name_key UNIQUE (user_id, name)
);

-- ---------------------------------------------------------------------------
-- Access settings (D90): one row, the primary key is the constant true.
-- ---------------------------------------------------------------------------
CREATE TABLE access_settings (
  id                        boolean PRIMARY KEY DEFAULT true CHECK (id),
  archive_after_months      integer NOT NULL DEFAULT 12 CHECK (archive_after_months BETWEEN 1 AND 60),
  grant_default_days        integer NOT NULL DEFAULT 30 CHECK (grant_default_days BETWEEN 1 AND 90),
  grant_max_days            integer NOT NULL DEFAULT 90 CHECK (grant_max_days BETWEEN 1 AND 365),
  invitation_valid_days     integer NOT NULL DEFAULT 7  CHECK (invitation_valid_days BETWEEN 1 AND 30),
  analytics_export_allowed  boolean NOT NULL DEFAULT true,
  CONSTRAINT access_settings_default_within_max CHECK (grant_default_days <= grant_max_days)
);
INSERT INTO access_settings DEFAULT VALUES;

CREATE TABLE access_settings_changes (
  id         uuid PRIMARY KEY,
  actor_id   uuid        NOT NULL REFERENCES users (id),
  at         timestamptz NOT NULL,
  reason     text        NOT NULL CHECK (btrim(reason) <> ''),
  previous   jsonb       NOT NULL,
  next       jsonb       NOT NULL
);
CREATE INDEX access_settings_changes_at_idx ON access_settings_changes (at);

-- ---------------------------------------------------------------------------
-- Indexes the measures need.
-- ---------------------------------------------------------------------------
CREATE INDEX tasks_project_status_idx ON tasks (project_id, status);
CREATE INDEX risks_project_status_severity_idx ON risks (project_id, status, severity);
CREATE INDEX change_requests_pending_idx ON change_requests (project_id) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Append-only history; grants are never deleted.
-- ---------------------------------------------------------------------------
CREATE TRIGGER leadership_grant_events_append_only BEFORE UPDATE OR DELETE ON leadership_grant_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER leadership_grant_events_no_truncate BEFORE TRUNCATE ON leadership_grant_events
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER access_settings_changes_append_only BEFORE UPDATE OR DELETE ON access_settings_changes
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER access_settings_changes_no_truncate BEFORE TRUNCATE ON access_settings_changes
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();

CREATE FUNCTION leadership_grants_never_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER leadership_grants_no_delete BEFORE DELETE ON leadership_grants
  FOR EACH ROW EXECUTE FUNCTION leadership_grants_never_removed();
CREATE TRIGGER leadership_grants_no_truncate BEFORE TRUNCATE ON leadership_grants
  FOR EACH STATEMENT EXECUTE FUNCTION leadership_grants_never_removed();
