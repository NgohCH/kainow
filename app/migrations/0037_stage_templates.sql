-- Stage templates (D131): named, ordered stage lists the Enterprise Administrator manages; each project keeps its own
-- copy of the stages it was created with. The seven starter templates are seeded with fixed ids (they match
-- app/src/projects/stage-templates.ts). Every existing project gets a copy of General, its current five stages.

-- ---------------------------------------------------------------------------
-- The catalogue. A shipped template has no creator (shown as "Kainow").
-- ---------------------------------------------------------------------------
CREATE TABLE stage_templates (
  id           uuid PRIMARY KEY,
  name         text        NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 80),
  description  text        CHECK (description IS NULL OR char_length(description) <= 300),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  position     integer     NOT NULL,
  created_by   uuid        REFERENCES users (id),
  created_at   timestamptz NOT NULL,
  updated_by   uuid        REFERENCES users (id),
  updated_at   timestamptz
);
-- Names are unique among active templates, ignoring case; a retired template may share a name.
CREATE UNIQUE INDEX stage_templates_active_name ON stage_templates (lower(name)) WHERE status = 'active';

CREATE TABLE stage_template_stages (
  id           uuid PRIMARY KEY,
  template_id  uuid    NOT NULL REFERENCES stage_templates (id),
  position     integer NOT NULL,
  name         text    NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 80),
  substages    text[]  NOT NULL DEFAULT '{}' CHECK (cardinality(substages) <= 10)
);
CREATE UNIQUE INDEX stage_template_stages_name ON stage_template_stages (template_id, lower(name));

-- ---------------------------------------------------------------------------
-- A project's own stages: a copy taken at creation, then added to or retired from by the project (never renamed:
-- past stage periods record the name).
-- ---------------------------------------------------------------------------
CREATE TABLE project_stages (
  id          uuid PRIMARY KEY,
  project_id  uuid        NOT NULL REFERENCES projects (id),
  position    integer     NOT NULL,
  name        text        NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 80),
  substages   text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(substages) <= 10),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  added_by    uuid        REFERENCES users (id),
  added_at    timestamptz NOT NULL,
  retired_by  uuid        REFERENCES users (id),
  retired_at  timestamptz
);
CREATE UNIQUE INDEX project_stages_name ON project_stages (project_id, lower(name));

ALTER TABLE projects ADD COLUMN stage_template_id uuid REFERENCES stage_templates (id);

-- ---------------------------------------------------------------------------
-- The seven starter templates.
-- ---------------------------------------------------------------------------
INSERT INTO stage_templates (id, name, status, position, created_at) VALUES
  ('d1310000-0000-4000-8000-000000000001', 'General',              'active', 1, now()),
  ('d1310000-0000-4000-8000-000000000002', 'Software development', 'active', 2, now()),
  ('d1310000-0000-4000-8000-000000000003', 'Product sales',        'active', 3, now()),
  ('d1310000-0000-4000-8000-000000000004', 'Research project',     'active', 4, now()),
  ('d1310000-0000-4000-8000-000000000005', 'Syllabus development', 'active', 5, now()),
  ('d1310000-0000-4000-8000-000000000006', 'Marketing campaign',   'active', 6, now()),
  ('d1310000-0000-4000-8000-000000000007', 'Event',                'active', 7, now());

INSERT INTO stage_template_stages (id, template_id, position, name, substages)
SELECT gen_random_uuid(), t.template_id::uuid, t.position, t.name, t.substages
  FROM (VALUES
    ('d1310000-0000-4000-8000-000000000001', 1, 'Initiation',          ARRAY['Define Purpose', 'Identify Participants', 'Confirm Accountability']),
    ('d1310000-0000-4000-8000-000000000001', 2, 'Planning',            ARRAY['Define Scope', 'Break Down Work', 'Identify Resources', 'Approve Plan']),
    ('d1310000-0000-4000-8000-000000000001', 3, 'Execution',           ARRAY['In Progress', 'Monitoring & Follow-up']),
    ('d1310000-0000-4000-8000-000000000001', 4, 'Review & Acceptance', ARRAY['Review Deliverables', 'Resolve Outstanding Items', 'Confirm Acceptance']),
    ('d1310000-0000-4000-8000-000000000001', 5, 'Closure',             ARRAY['Record Outcome', 'Handover', 'Close Project']),

    ('d1310000-0000-4000-8000-000000000002', 1, 'Discovery',  '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000002', 2, 'Design',     '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000002', 3, 'Build',      '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000002', 4, 'Testing',    '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000002', 5, 'Rollout',    '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000002', 6, 'Closure',    '{}'::text[]),

    ('d1310000-0000-4000-8000-000000000003', 1, 'Lead generation',    '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000003', 2, 'Qualification',      '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000003', 3, 'Proposal',           '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000003', 4, 'Negotiation',        '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000003', 5, 'Closing',            '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000003', 6, 'After-sales review', '{}'::text[]),

    ('d1310000-0000-4000-8000-000000000004', 1, 'Proposal',                    '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000004', 2, 'Literature review',           '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000004', 3, 'Methods and ethics approval', '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000004', 4, 'Data collection',             '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000004', 5, 'Analysis',                    '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000004', 6, 'Writing and publication',     '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000004', 7, 'Closure',                     '{}'::text[]),

    ('d1310000-0000-4000-8000-000000000005', 1, 'Needs analysis',          '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000005', 2, 'Learning outcomes',       '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000005', 3, 'Content design',          '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000005', 4, 'Review and approval',     '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000005', 5, 'Pilot delivery',          '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000005', 6, 'Evaluation and revision', '{}'::text[]),

    ('d1310000-0000-4000-8000-000000000006', 1, 'Research and brief',          '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000006', 2, 'Strategy and planning',       '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000006', 3, 'Creative development',        '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000006', 4, 'Launch',                      '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000006', 5, 'Monitoring and optimisation', '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000006', 6, 'Evaluation',                  '{}'::text[]),

    ('d1310000-0000-4000-8000-000000000007', 1, 'Concept and budget',    '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000007', 2, 'Planning and bookings', '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000007', 3, 'Promotion',             '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000007', 4, 'Final preparations',    '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000007', 5, 'Event day',             '{}'::text[]),
    ('d1310000-0000-4000-8000-000000000007', 6, 'Wrap-up and review',    '{}'::text[])
  ) AS t (template_id, position, name, substages);

-- ---------------------------------------------------------------------------
-- Existing projects: a copy of General, added by the project's creator when the project was created.
-- ---------------------------------------------------------------------------
INSERT INTO project_stages (id, project_id, position, name, substages, status, added_by, added_at)
SELECT gen_random_uuid(), p.id, s.position, s.name, s.substages, 'active', p.created_by, p.created_at
  FROM projects p
  CROSS JOIN stage_template_stages s
 WHERE s.template_id = 'd1310000-0000-4000-8000-000000000001';

UPDATE projects SET stage_template_id = 'd1310000-0000-4000-8000-000000000001';

-- The fixed list of stage names goes: the server checks a stage against the project's own list. Past periods keep the
-- names they were recorded with.
ALTER TABLE project_stage_periods DROP CONSTRAINT project_stage_periods_stage_check;
