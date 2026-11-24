-- Changes to a project's own stages (D131, spec 14): who added, reordered, retired or brought back a stage, when, why,
-- and the list before and after. Append-only, like the other project settings histories.
CREATE TABLE project_stage_changes (
  id          uuid PRIMARY KEY,
  project_id  uuid        NOT NULL REFERENCES projects (id),
  kind        text        NOT NULL CHECK (kind IN ('added', 'reordered', 'retired', 'restored')),
  -- The stage added, retired or brought back; none for a new order.
  stage_id    uuid        REFERENCES project_stages (id),
  actor_id    uuid        NOT NULL REFERENCES users (id),
  at          timestamptz NOT NULL,
  reason      text        NOT NULL CHECK (btrim(reason) <> ''),
  previous    jsonb       NOT NULL,
  next        jsonb       NOT NULL,
  CONSTRAINT project_stage_changes_stage CHECK ((kind = 'reordered') = (stage_id IS NULL))
);
CREATE INDEX project_stage_changes_project_idx ON project_stage_changes (project_id, at);
CREATE TRIGGER project_stage_changes_append_only BEFORE UPDATE OR DELETE ON project_stage_changes
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
CREATE TRIGGER project_stage_changes_no_truncate BEFORE TRUNCATE ON project_stage_changes
  FOR EACH STATEMENT EXECUTE FUNCTION kainow_append_only();

-- 0037 removed the fixed list of stage names; a recorded stage is still a name of 1 to 80 characters. Every earlier row
-- passes: before 0037 only the five fixed names were allowed, and since then only names of project_stages, which carry
-- the same rule.
ALTER TABLE project_stage_periods
  ADD CONSTRAINT project_stage_periods_stage_check CHECK (btrim(stage) <> '' AND char_length(stage) <= 80);
