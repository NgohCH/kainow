-- Sub-project 11a.1 (D140): a project made from another one, and the proposals it carried over.

-- Where a project or a proposal was copied from; none on existing rows. Shown by name only to those who may open the original.
ALTER TABLE projects ADD COLUMN copied_from_id uuid REFERENCES projects (id);
ALTER TABLE human_proposals ADD COLUMN copied_from_project_id uuid REFERENCES projects (id);

-- The subtasks a copied action came with: [{ title, description, due }]. They fill in the authorise form and nothing else.
-- Their lengths are limited where they are typed; no limit here, so removing a credential can never be refused.
ALTER TABLE human_proposals ADD COLUMN proposed_subtasks jsonb CONSTRAINT human_proposals_proposed_subtasks_check CHECK (
  proposed_subtasks IS NULL OR (kind = 'action' AND jsonb_typeof(proposed_subtasks) = 'array'));
