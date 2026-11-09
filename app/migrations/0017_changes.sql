-- V1.0 sub-project 2b: change requests and approvals, decision changes, closure accounting, delegated closure,
-- deadline review. Additions and widened checks only; records authorised in 2a are unchanged.

-- The organisation's approval policy: one row.
CREATE TABLE approval_policy (
  id                     smallint    PRIMARY KEY CHECK (id = 1),
  required               smallint    NOT NULL DEFAULT 1 CHECK (required BETWEEN 1 AND 3),
  projects_may_override  boolean     NOT NULL DEFAULT false,
  updated_by             uuid        REFERENCES users (id),
  updated_at             timestamptz NOT NULL
);
INSERT INTO approval_policy (id, required, projects_may_override, updated_at) VALUES (1, 1, false, now());

ALTER TABLE projects ADD COLUMN required_approvals smallint CHECK (required_approvals BETWEEN 1 AND 3);

-- Every change to the policy, for the organisation (project_id null) or one project.
CREATE TABLE approval_policy_changes (
  id              uuid        PRIMARY KEY,
  project_id      uuid        REFERENCES projects (id),
  field           text        NOT NULL CHECK (field IN ('required', 'projects_may_override')),
  old_value       text,
  new_value       text,
  reason          text        NOT NULL CHECK (btrim(reason) <> ''),
  pending_choice  text        CHECK (pending_choice IN ('keep', 'restart')),
  actor_id        uuid        NOT NULL REFERENCES users (id),
  at              timestamptz NOT NULL
);
CREATE INDEX approval_policy_changes_at_idx ON approval_policy_changes (at);
CREATE TRIGGER approval_policy_changes_append_only BEFORE UPDATE OR DELETE ON approval_policy_changes
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

CREATE TABLE change_requests (
  id                  uuid        PRIMARY KEY,
  project_id          uuid        NOT NULL REFERENCES projects (id),
  kind                text        NOT NULL CHECK (kind IN (
                                    'authorise_proposal', 'amend_task', 'cancel_task', 'supersede_decision',
                                    'withdraw_decision', 'deadline_review', 'reconcile_completion', 'risk_handover')),
  target_kind         text        NOT NULL CHECK (target_kind IN ('extraction_item', 'human_proposal', 'task', 'decision', 'risk')),
  target_id           uuid        NOT NULL,
  batch_id            uuid,
  version             integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  required_approvals  smallint    NOT NULL CHECK (required_approvals BETWEEN 1 AND 3),
  status              text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorised', 'rejected', 'withdrawn', 'superseded')),
  submitted_by        uuid        NOT NULL REFERENCES users (id),
  submitted_at        timestamptz NOT NULL,
  decided_by          uuid        REFERENCES users (id),
  decided_at          timestamptz,
  reason              text
);
CREATE UNIQUE INDEX change_requests_one_open ON change_requests (target_kind, target_id) WHERE status = 'pending';
CREATE INDEX change_requests_project_idx ON change_requests (project_id, status, submitted_at);
CREATE INDEX change_requests_batch_idx ON change_requests (batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE change_request_versions (
  request_id  uuid        NOT NULL REFERENCES change_requests (id),
  version     integer     NOT NULL CHECK (version >= 1),
  terms       jsonb       NOT NULL,
  reason      text,
  author_id   uuid        NOT NULL REFERENCES users (id),
  at          timestamptz NOT NULL,
  PRIMARY KEY (request_id, version)
);
CREATE TRIGGER change_request_versions_append_only BEFORE UPDATE OR DELETE ON change_request_versions
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

CREATE TABLE approvals (
  id           uuid        PRIMARY KEY,
  request_id   uuid        NOT NULL REFERENCES change_requests (id),
  version      integer     NOT NULL CHECK (version >= 1),
  approver_id  uuid        NOT NULL REFERENCES users (id),
  at           timestamptz NOT NULL,
  CONSTRAINT approvals_once_per_version UNIQUE (request_id, version, approver_id)
);
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

-- Decisions: statuses superseded and withdrawn, a link to what they replace, and a third origin (a request).
ALTER TABLE decisions DROP CONSTRAINT decisions_status_check;
ALTER TABLE decisions ADD CONSTRAINT decisions_status_check CHECK (status IN ('active', 'superseded', 'withdrawn'));
ALTER TABLE decisions ADD COLUMN replaces_id uuid REFERENCES decisions (id);
ALTER TABLE decisions ADD COLUMN origin_request_id uuid UNIQUE REFERENCES change_requests (id);
ALTER TABLE decisions DROP CONSTRAINT decisions_one_origin;
ALTER TABLE decisions ADD CONSTRAINT decisions_one_origin CHECK (
  (origin_item_id IS NOT NULL)::int + (origin_proposal_id IS NOT NULL)::int + (origin_request_id IS NOT NULL)::int = 1
);

-- Work a decision change may affect, flagged for review. Flags never block work.
CREATE TABLE review_flags (
  id           uuid        PRIMARY KEY,
  project_id   uuid        NOT NULL REFERENCES projects (id),
  record_kind  text        NOT NULL CHECK (record_kind IN ('task', 'question', 'risk')),
  record_id    uuid        NOT NULL,
  cause        text        NOT NULL CHECK (cause IN ('decision_changed')),
  decision_id  uuid        NOT NULL REFERENCES decisions (id),
  raised_by    uuid        NOT NULL REFERENCES users (id),
  raised_at    timestamptz NOT NULL,
  cleared_by   uuid        REFERENCES users (id),
  cleared_at   timestamptz,
  note         text,
  CONSTRAINT review_flags_cleared_together CHECK ((cleared_by IS NULL) = (cleared_at IS NULL))
);
CREATE INDEX review_flags_record_idx ON review_flags (record_kind, record_id);
CREATE INDEX review_flags_open_idx ON review_flags (project_id) WHERE cleared_at IS NULL;

-- What the closer chose for each open item before closing. Changing a choice sets replaced_at on the old row and
-- adds a new one; Close sets final on the current rows.
CREATE TABLE closure_dispositions (
  id                   uuid        PRIMARY KEY,
  project_id           uuid        NOT NULL REFERENCES projects (id),
  record_kind          text        NOT NULL CHECK (record_kind IN ('task', 'question', 'risk')),
  record_id            uuid        NOT NULL,
  disposition          text        NOT NULL CHECK (disposition IN ('cancel', 'keep', 'resolve', 'withdraw', 'unresolved', 'handover', 'final_accept')),
  reason               text        NOT NULL,
  affects_delivery     boolean     NOT NULL DEFAULT false,
  handover_project_id  uuid        REFERENCES projects (id),
  chosen_by            uuid        NOT NULL REFERENCES users (id),
  chosen_at            timestamptz NOT NULL,
  replaced_at          timestamptz,
  final                boolean     NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX closure_dispositions_current ON closure_dispositions (project_id, record_kind, record_id) WHERE replaced_at IS NULL;

-- A Project Manager allowed to close the project on the Owners' and Sponsors' behalf. One open per project.
CREATE TABLE closure_delegations (
  id            uuid        PRIMARY KEY,
  project_id    uuid        NOT NULL REFERENCES projects (id),
  pm_user_id    uuid        NOT NULL REFERENCES users (id),
  delegated_by  uuid        NOT NULL REFERENCES users (id),
  reason        text        NOT NULL,
  at            timestamptz NOT NULL,
  revoked_by    uuid        REFERENCES users (id),
  revoked_at    timestamptz,
  CONSTRAINT closure_delegations_revoked_together CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);
CREATE UNIQUE INDEX closure_delegations_one_open ON closure_delegations (project_id) WHERE revoked_at IS NULL;

-- Tasks: deadline review mark, the task a new one follows on from, and when it was completed.
ALTER TABLE tasks ADD COLUMN deadline_review_required boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN follows_task_id uuid REFERENCES tasks (id);
ALTER TABLE tasks ADD COLUMN completed_at timestamptz;
ALTER TABLE human_proposals ADD COLUMN follows_task_id uuid REFERENCES tasks (id);

-- Tasks already completed keep the time of their latest completion event.
UPDATE tasks t SET completed_at = e.at
  FROM (SELECT task_id, max(at) AS at FROM task_events WHERE kind = 'completed' GROUP BY task_id) e
 WHERE e.task_id = t.id AND t.status = 'completed';

ALTER TABLE task_events DROP CONSTRAINT task_events_kind_check;
ALTER TABLE task_events ADD CONSTRAINT task_events_kind_check CHECK (kind IN (
  'authorised', 'started', 'blocked', 'unblocked', 'completed', 'reopened',
  'amended', 'cancelled', 'review_required', 'deadline_reviewed', 'reconciled'));
ALTER TABLE task_events ADD COLUMN detail jsonb;

-- Marks the project's tasks and subtasks that are not completed or cancelled and not already marked, records a
-- review_required event for each (by actor), and returns how many it marked. Used below for projects already paused
-- or closed, and by the application when a project is deferred or closed.
CREATE FUNCTION mark_deadline_review(p uuid, actor uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  marked integer;
BEGIN
  WITH newly AS (
    UPDATE tasks SET deadline_review_required = true
     WHERE project_id = p AND status NOT IN ('completed', 'cancelled') AND NOT deadline_review_required
    RETURNING id, status
  ), logged AS (
    INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at)
    SELECT gen_random_uuid(), id, 'review_required', status, status, actor, now() FROM newly
    RETURNING 1
  )
  SELECT count(*) INTO marked FROM logged;
  RETURN marked;
END;
$$;

SELECT mark_deadline_review(
         p.id,
         COALESCE((SELECT t.actor_id FROM project_transitions t WHERE t.project_id = p.id ORDER BY t.at DESC, t.id DESC LIMIT 1), p.created_by))
  FROM projects p
 WHERE p.status IN ('deferred', 'closed');
