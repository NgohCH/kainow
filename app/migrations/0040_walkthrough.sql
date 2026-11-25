-- Sub-project 11a.1 (D133-D139): the walkthrough changes.

-- A task's description (D133), typed by a person when proposing or authorising; none on existing rows. The limit is in
-- the form of 0039: a cleaned value may be longer than what was typed.
ALTER TABLE tasks ADD COLUMN description text CONSTRAINT tasks_description_check CHECK (
  description IS NULL
  OR (btrim(description) <> '' AND (char_length(description) <= 4000 OR strpos(description, '[credential removed]') > 0)));
ALTER TABLE human_proposals ADD COLUMN description text CONSTRAINT human_proposals_description_check CHECK (
  description IS NULL
  OR (btrim(description) <> '' AND (char_length(description) <= 4000 OR strpos(description, '[credential removed]') > 0)));

-- A person's department (D134): information only, it gives no access. A retired department stays until changed.
ALTER TABLE users ADD COLUMN department_id uuid REFERENCES departments (id);

-- A stage can be renamed (D137); like every kind but a new order, a rename names its stage.
ALTER TABLE project_stage_changes DROP CONSTRAINT project_stage_changes_kind_check;
ALTER TABLE project_stage_changes ADD CONSTRAINT project_stage_changes_kind_check CHECK (
  kind IN ('added', 'reordered', 'retired', 'restored', 'renamed'));

-- Two stage names that differ only in what is removed clean to the same text; the unique rule ignores a name holding
-- the credential marker, so it cannot stop the cleaning. No other unique rule covers a swept column except the key of
-- summary_marks, which the cleaning engine keeps unique itself (registry.db.test.ts).
DROP INDEX project_stages_name;
CREATE UNIQUE INDEX project_stages_name ON project_stages (project_id, lower(name)) WHERE strpos(name, '[credential removed]') = 0;
