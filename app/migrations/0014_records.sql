-- V1.0 sub-project 2a: authorised records (tasks, decisions, questions, risks), human proposals and
-- their histories. Additions only. A record comes from one extraction item or one human proposal.

CREATE TABLE human_proposals (
  id             uuid        PRIMARY KEY,
  project_id     uuid        NOT NULL REFERENCES projects (id),
  kind           text        NOT NULL CHECK (kind IN ('action', 'decision', 'question', 'risk')),
  text           text        NOT NULL CHECK (btrim(text) <> ''),
  owner          text,
  due            text,
  proposed_by    uuid        NOT NULL REFERENCES users (id),
  proposed_at    timestamptz NOT NULL,
  review_status  text        NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_by    uuid        REFERENCES users (id),
  reviewed_at    timestamptz,
  reject_reason  text,
  CONSTRAINT human_proposals_review_complete CHECK (
    (review_status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_status <> 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);
CREATE INDEX human_proposals_project_idx ON human_proposals (project_id, proposed_at);

CREATE TABLE tasks (
  id                  uuid        PRIMARY KEY,
  project_id          uuid        NOT NULL REFERENCES projects (id),
  parent_id           uuid        REFERENCES tasks (id),
  depth               integer     NOT NULL CHECK (depth BETWEEN 0 AND 2),
  title               text        NOT NULL CHECK (btrim(title) <> ''),
  assignee_id         uuid        NOT NULL REFERENCES users (id),
  owner_as_written    text,
  due_on              date        NOT NULL,
  status              text        NOT NULL DEFAULT 'not_started'
                                  CHECK (status IN ('not_started', 'in_progress', 'blocked', 'completed', 'cancelled')),
  invitation_id       uuid        REFERENCES invitations (id),
  origin_item_id      uuid        REFERENCES extraction_items (id),
  origin_proposal_id  uuid        REFERENCES human_proposals (id),
  authorised_by       uuid        NOT NULL REFERENCES users (id),
  authorised_at       timestamptz NOT NULL,
  CONSTRAINT tasks_parent_matches_depth CHECK ((depth = 0) = (parent_id IS NULL)),
  CONSTRAINT tasks_one_origin CHECK (origin_item_id IS NULL OR origin_proposal_id IS NULL),
  CONSTRAINT tasks_subtasks_have_no_origin CHECK (depth = 0 OR (origin_item_id IS NULL AND origin_proposal_id IS NULL))
);
CREATE UNIQUE INDEX tasks_origin_item_once ON tasks (origin_item_id) WHERE depth = 0 AND origin_item_id IS NOT NULL;
CREATE UNIQUE INDEX tasks_origin_proposal_once ON tasks (origin_proposal_id) WHERE depth = 0 AND origin_proposal_id IS NOT NULL;
CREATE INDEX tasks_project_idx ON tasks (project_id, due_on);
CREATE INDEX tasks_parent_idx ON tasks (parent_id);

CREATE TABLE task_events (
  id               uuid        PRIMARY KEY,
  task_id          uuid        NOT NULL REFERENCES tasks (id),
  kind             text        NOT NULL CHECK (kind IN ('authorised', 'started', 'blocked', 'unblocked', 'completed', 'reopened')),
  from_status      text,
  to_status        text,
  note             text,
  override_reason  text,
  actor_id         uuid        NOT NULL REFERENCES users (id),
  at               timestamptz NOT NULL
);
CREATE INDEX task_events_task_idx ON task_events (task_id, at);
CREATE TRIGGER task_events_append_only BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

CREATE TABLE decisions (
  id                  uuid        PRIMARY KEY,
  project_id          uuid        NOT NULL REFERENCES projects (id),
  statement           text        NOT NULL CHECK (btrim(statement) <> ''),
  rationale           text,
  status              text        NOT NULL DEFAULT 'active' CHECK (status IN ('active')),
  origin_item_id      uuid        UNIQUE REFERENCES extraction_items (id),
  origin_proposal_id  uuid        UNIQUE REFERENCES human_proposals (id),
  authorised_by       uuid        NOT NULL REFERENCES users (id),
  authorised_at       timestamptz NOT NULL,
  CONSTRAINT decisions_one_origin CHECK ((origin_item_id IS NULL) <> (origin_proposal_id IS NULL))
);

CREATE TABLE questions (
  id                  uuid        PRIMARY KEY,
  project_id          uuid        NOT NULL REFERENCES projects (id),
  text                text        NOT NULL CHECK (btrim(text) <> ''),
  requester_id        uuid        NOT NULL REFERENCES users (id),
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'resolved', 'withdrawn')),
  origin_item_id      uuid        UNIQUE REFERENCES extraction_items (id),
  origin_proposal_id  uuid        UNIQUE REFERENCES human_proposals (id),
  authorised_by       uuid        NOT NULL REFERENCES users (id),
  authorised_at       timestamptz NOT NULL,
  CONSTRAINT questions_one_origin CHECK ((origin_item_id IS NULL) <> (origin_proposal_id IS NULL))
);

CREATE TABLE question_answers (
  id           uuid        PRIMARY KEY,
  question_id  uuid        NOT NULL REFERENCES questions (id),
  answer       text        NOT NULL CHECK (btrim(answer) <> ''),
  author_id    uuid        NOT NULL REFERENCES users (id),
  at           timestamptz NOT NULL
);
CREATE INDEX question_answers_question_idx ON question_answers (question_id, at);
CREATE TRIGGER question_answers_append_only BEFORE UPDATE OR DELETE ON question_answers
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();

CREATE TABLE risks (
  id                  uuid        PRIMARY KEY,
  project_id          uuid        NOT NULL REFERENCES projects (id),
  description         text        NOT NULL CHECK (btrim(description) <> ''),
  severity            text        NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  responsible_id      uuid        REFERENCES users (id),
  review_on           date,
  mitigation          text,
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'mitigating', 'resolved', 'accepted')),
  origin_item_id      uuid        UNIQUE REFERENCES extraction_items (id),
  origin_proposal_id  uuid        UNIQUE REFERENCES human_proposals (id),
  authorised_by       uuid        NOT NULL REFERENCES users (id),
  authorised_at       timestamptz NOT NULL,
  CONSTRAINT risks_one_origin CHECK ((origin_item_id IS NULL) <> (origin_proposal_id IS NULL))
);

-- History for questions and risks (tasks have task_events).
CREATE TABLE record_events (
  id           uuid        PRIMARY KEY,
  record_kind  text        NOT NULL CHECK (record_kind IN ('question', 'risk', 'decision')),
  record_id    uuid        NOT NULL,
  kind         text        NOT NULL,
  from_status  text,
  to_status    text,
  note         text,
  actor_id     uuid        NOT NULL REFERENCES users (id),
  at           timestamptz NOT NULL
);
CREATE INDEX record_events_record_idx ON record_events (record_kind, record_id, at);
CREATE TRIGGER record_events_append_only BEFORE UPDATE OR DELETE ON record_events
  FOR EACH ROW EXECUTE FUNCTION kainow_append_only();
