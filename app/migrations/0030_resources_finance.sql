-- V1.0 sub-project 8: shared resources (a catalogue, and per-project resource lines) and optional financial tracking
-- (budget versions, spending entries and their adjustments).
-- Design: docs/superpowers/specs/2026-11-20-v1-resources-budget-design.md (section 10).
-- Additive, apart from widening two change_requests CHECKs. Nothing here is ever deleted: a line is Cancelled, an
-- entry is corrected. The history tables are append-only.

-- ---------------------------------------------------------------------------
-- The shared catalogue: categories, items, their events and the people who maintain them.
-- ---------------------------------------------------------------------------
CREATE TABLE resource_categories (
  id          uuid PRIMARY KEY,
  name        text        NOT NULL CHECK (btrim(name) <> ''),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by  uuid        NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL,
  updated_by  uuid        REFERENCES users (id),
  updated_at  timestamptz
);
CREATE UNIQUE INDEX resource_categories_active_name_key ON resource_categories (lower(name)) WHERE status = 'active';

CREATE TABLE resource_items (
  id           uuid PRIMARY KEY,
  kind         text        NOT NULL CHECK (kind IN ('equipment', 'facility')),
  reference    text        NOT NULL CHECK (btrim(reference) <> ''),
  name         text        NOT NULL CHECK (btrim(name) <> ''),
  category_id  uuid        REFERENCES resource_categories (id),
  description  text        NOT NULL DEFAULT '',
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by   uuid        NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL,
  updated_by   uuid        REFERENCES users (id),
  updated_at   timestamptz
);
CREATE UNIQUE INDEX resource_items_active_reference_key ON resource_items (lower(reference)) WHERE status = 'active';
CREATE INDEX resource_items_category_idx ON resource_items (category_id);

CREATE TABLE resource_catalogue_events (
  id            uuid PRIMARY KEY,
  subject_kind  text        NOT NULL CHECK (subject_kind IN ('item', 'category', 'maintainer')),
  subject_id    uuid        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('added', 'edited', 'renamed', 'retired', 'maintainer_added', 'maintainer_removed')),
  actor_id      uuid        NOT NULL REFERENCES users (id),
  at            timestamptz NOT NULL,
  reason        text,
  detail        jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX resource_catalogue_events_subject_idx ON resource_catalogue_events (subject_kind, subject_id, at);

CREATE TABLE resource_catalogue_maintainers (
  user_id   uuid PRIMARY KEY REFERENCES users (id),
  added_by  uuid        NOT NULL REFERENCES users (id),
  added_at  timestamptz NOT NULL,
  reason    text        NOT NULL CHECK (btrim(reason) <> '')
);

-- ---------------------------------------------------------------------------
-- Project resource lines and their events.
-- ---------------------------------------------------------------------------
CREATE TABLE resource_lines (
  id            uuid PRIMARY KEY,
  project_id    uuid        NOT NULL REFERENCES projects (id),
  item_id       uuid        REFERENCES resource_items (id),
  one_off_kind  text        CHECK (one_off_kind IN ('equipment', 'facility', 'other')),
  description   text        NOT NULL DEFAULT '',
  quantity      numeric(14, 2) CHECK (quantity > 0),
  unit          text        CHECK (unit IN ('hours', 'days', 'person_hours', 'person_days', 'items', 'seats', 'square_metres')),
  starts_on     date,
  ends_on       date,
  needed_by     date,
  notes         text        NOT NULL DEFAULT '',
  status        text        NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'arranged', 'in_use', 'finished', 'cancelled')),
  created_by    uuid        NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  CONSTRAINT resource_lines_item_or_one_off CHECK ((item_id IS NULL) <> (one_off_kind IS NULL)),
  CONSTRAINT resource_lines_quantity_unit CHECK ((quantity IS NULL) = (unit IS NULL)),
  CONSTRAINT resource_lines_period CHECK (ends_on IS NULL OR (starts_on IS NOT NULL AND ends_on >= starts_on))
);
CREATE INDEX resource_lines_project_status_idx ON resource_lines (project_id, status);
CREATE INDEX resource_lines_item_period_idx ON resource_lines (item_id, starts_on) WHERE item_id IS NOT NULL AND status <> 'cancelled';

CREATE TABLE resource_line_events (
  id        uuid PRIMARY KEY,
  line_id   uuid        NOT NULL REFERENCES resource_lines (id),
  kind      text        NOT NULL CHECK (kind IN ('created', 'edited', 'status_changed', 'cancelled')),
  actor_id  uuid        NOT NULL REFERENCES users (id),
  at        timestamptz NOT NULL,
  reason    text,
  detail    jsonb       NOT NULL
);
CREATE INDEX resource_line_events_line_idx ON resource_line_events (line_id, at);

-- ---------------------------------------------------------------------------
-- Organisation settings (D93, D94): one row, the primary key is the constant true.
-- ---------------------------------------------------------------------------
CREATE TABLE resource_settings (
  id                           boolean PRIMARY KEY DEFAULT true CHECK (id),
  projects_may_manage_finance  boolean NOT NULL DEFAULT true,
  default_currency             text    NOT NULL DEFAULT 'MYR',
  enabled_currencies           text[]  NOT NULL DEFAULT '{MYR,SGD,USD}',
  warn_first_pct               integer NOT NULL DEFAULT 80,
  warn_second_pct              integer NOT NULL DEFAULT 100,
  CONSTRAINT resource_settings_thresholds CHECK (
    warn_first_pct BETWEEN 1 AND 200 AND warn_second_pct BETWEEN 1 AND 200 AND warn_first_pct < warn_second_pct),
  CONSTRAINT resource_settings_default_enabled CHECK (default_currency = ANY (enabled_currencies))
);
INSERT INTO resource_settings DEFAULT VALUES;

CREATE TABLE resource_settings_changes (
  id         uuid PRIMARY KEY,
  actor_id   uuid        NOT NULL REFERENCES users (id),
  at         timestamptz NOT NULL,
  reason     text        NOT NULL CHECK (btrim(reason) <> ''),
  previous   jsonb       NOT NULL,
  next       jsonb       NOT NULL
);
CREATE INDEX resource_settings_changes_at_idx ON resource_settings_changes (at);

-- ---------------------------------------------------------------------------
-- Per-project financial tracking. NULL thresholds inherit the organisation's.
-- ---------------------------------------------------------------------------
CREATE TABLE project_finance_settings (
  project_id       uuid PRIMARY KEY REFERENCES projects (id),
  tracking         text    NOT NULL DEFAULT 'not_required' CHECK (tracking IN ('not_required', 'enabled')),
  currency         text,
  warn_first_pct   integer,
  warn_second_pct  integer,
  members_read     boolean NOT NULL DEFAULT false,
  grants_read      boolean NOT NULL DEFAULT false,
  CONSTRAINT project_finance_settings_currency CHECK (tracking = 'not_required' OR currency IS NOT NULL),
  CONSTRAINT project_finance_settings_thresholds_together CHECK ((warn_first_pct IS NULL) = (warn_second_pct IS NULL)),
  CONSTRAINT project_finance_settings_thresholds CHECK (
    warn_first_pct IS NULL OR (warn_first_pct BETWEEN 1 AND 200 AND warn_second_pct BETWEEN 1 AND 200 AND warn_first_pct < warn_second_pct))
);

CREATE TABLE project_finance_changes (
  id          uuid PRIMARY KEY,
  project_id  uuid        NOT NULL REFERENCES projects (id),
  actor_id    uuid        NOT NULL REFERENCES users (id),
  at          timestamptz NOT NULL,
  reason      text        NOT NULL CHECK (btrim(reason) <> ''),
  previous    jsonb       NOT NULL,
  next        jsonb       NOT NULL
);
CREATE INDEX project_finance_changes_project_idx ON project_finance_changes (project_id, at);

CREATE TABLE project_finance_state (
  project_id      uuid PRIMARY KEY REFERENCES projects (id),
  notified_level  smallint NOT NULL DEFAULT 0 CHECK (notified_level BETWEEN 0 AND 2)
);

-- ---------------------------------------------------------------------------
-- Change requests: budget and finance adjustments go through approval (widen two CHECKs).
-- ---------------------------------------------------------------------------
ALTER TABLE change_requests DROP CONSTRAINT change_requests_kind_check;
ALTER TABLE change_requests ADD CONSTRAINT change_requests_kind_check CHECK (kind IN (
  'authorise_proposal', 'amend_task', 'cancel_task', 'supersede_decision',
  'withdraw_decision', 'deadline_review', 'reconcile_completion', 'risk_handover',
  'set_budget', 'finance_adjustment'));
ALTER TABLE change_requests DROP CONSTRAINT change_requests_target_kind_check;
ALTER TABLE change_requests ADD CONSTRAINT change_requests_target_kind_check CHECK (target_kind IN (
  'extraction_item', 'human_proposal', 'task', 'decision', 'risk', 'project_budget', 'expenditure'));

-- ---------------------------------------------------------------------------
-- Budget versions, spending entries and adjustments (append-only; amounts in minor-unit precision).
-- ---------------------------------------------------------------------------
CREATE TABLE budget_versions (
  id                 uuid PRIMARY KEY,
  project_id         uuid        NOT NULL REFERENCES projects (id),
  amount             numeric(16, 2) NOT NULL CHECK (amount >= 0),
  currency           text        NOT NULL,
  change_request_id  uuid        NOT NULL REFERENCES change_requests (id),
  approved_at        timestamptz NOT NULL
);
CREATE INDEX budget_versions_project_idx ON budget_versions (project_id, approved_at);

CREATE TABLE expenditures (
  id           uuid PRIMARY KEY,
  project_id   uuid        NOT NULL REFERENCES projects (id),
  spent_on     date        NOT NULL,
  amount       numeric(16, 2) NOT NULL CHECK (amount > 0),
  currency     text        NOT NULL,
  description  text        NOT NULL CHECK (btrim(description) <> ''),
  reference    text        NOT NULL DEFAULT '',
  recorded_by  uuid        NOT NULL REFERENCES users (id),
  recorded_at  timestamptz NOT NULL
);
CREATE INDEX expenditures_project_spent_idx ON expenditures (project_id, spent_on, recorded_at);

CREATE TABLE expenditure_adjustments (
  id                 uuid PRIMARY KEY,
  expenditure_id     uuid        NOT NULL REFERENCES expenditures (id),
  kind               text        NOT NULL CHECK (kind IN ('correction', 'refund', 'conversion')),
  amount             numeric(16, 2) NOT NULL CHECK (amount >= 0),
  rate               numeric(18, 8),
  rate_on            date,
  refund_on          date,
  reason             text        NOT NULL CHECK (btrim(reason) <> ''),
  change_request_id  uuid        NOT NULL REFERENCES change_requests (id),
  approved_at        timestamptz NOT NULL
);
CREATE INDEX expenditure_adjustments_expenditure_idx ON expenditure_adjustments (expenditure_id, approved_at);

-- ---------------------------------------------------------------------------
-- Append-only history.
-- ---------------------------------------------------------------------------
CREATE TRIGGER resource_line_events_append_only BEFORE UPDATE OR DELETE ON resource_line_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER resource_line_events_no_truncate BEFORE TRUNCATE ON resource_line_events
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER resource_catalogue_events_append_only BEFORE UPDATE OR DELETE ON resource_catalogue_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER resource_catalogue_events_no_truncate BEFORE TRUNCATE ON resource_catalogue_events
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER resource_settings_changes_append_only BEFORE UPDATE OR DELETE ON resource_settings_changes
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER resource_settings_changes_no_truncate BEFORE TRUNCATE ON resource_settings_changes
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER project_finance_changes_append_only BEFORE UPDATE OR DELETE ON project_finance_changes
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER project_finance_changes_no_truncate BEFORE TRUNCATE ON project_finance_changes
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER budget_versions_append_only BEFORE UPDATE OR DELETE ON budget_versions
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER budget_versions_no_truncate BEFORE TRUNCATE ON budget_versions
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER expenditures_append_only BEFORE UPDATE OR DELETE ON expenditures
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER expenditures_no_truncate BEFORE TRUNCATE ON expenditures
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER expenditure_adjustments_append_only BEFORE UPDATE OR DELETE ON expenditure_adjustments
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER expenditure_adjustments_no_truncate BEFORE TRUNCATE ON expenditure_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();
