-- V1.0 cross-project search: one view over everything a person may search, and a trigram index on each table the
-- view reads. Additions only. The `text` of each branch is written exactly as its index expression, so a search
-- on the view can use the index. Who may see a row is decided by the search service, not here.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX search_projects_trgm ON projects USING gin ((name || E'\n' || purpose) gin_trgm_ops);
CREATE INDEX search_users_trgm ON users USING gin (display_name gin_trgm_ops);
CREATE INDEX search_sources_trgm ON sources USING gin (title gin_trgm_ops) WHERE project_id IS NOT NULL;
CREATE INDEX search_source_versions_trgm ON source_versions USING gin (text_content gin_trgm_ops);
CREATE INDEX search_extraction_items_trgm ON extraction_items USING gin ((text || E'\n' || quote) gin_trgm_ops)
  WHERE review_status <> 'approved';
CREATE INDEX search_extraction_item_edits_trgm ON extraction_item_edits USING gin (text gin_trgm_ops);
CREATE INDEX search_human_proposals_trgm ON human_proposals USING gin (text gin_trgm_ops) WHERE review_status <> 'approved';
CREATE INDEX search_tasks_trgm ON tasks USING gin (title gin_trgm_ops);
CREATE INDEX search_task_events_trgm ON task_events USING gin ((detail -> 'title' ->> 'from') gin_trgm_ops)
  WHERE kind = 'amended';
CREATE INDEX search_decisions_trgm ON decisions USING gin ((statement || E'\n' || coalesce(rationale, '')) gin_trgm_ops);
CREATE INDEX search_questions_trgm ON questions USING gin (text gin_trgm_ops);
CREATE INDEX search_question_answers_trgm ON question_answers USING gin (answer gin_trgm_ops);
CREATE INDEX search_risks_trgm ON risks USING gin ((description || E'\n' || coalesce(mitigation, '')) gin_trgm_ops);

CREATE VIEW search_documents AS
  -- Projects.
  SELECT p.id AS project_id, 'project'::text AS kind, p.id AS item_id, NULL::uuid AS source_id, NULL::uuid AS run_id,
         NULL::int AS version_no, NULL::int AS version_count, true AS is_current, NULL::text AS match_note,
         p.name || E'\n' || p.purpose AS text, p.name AS ref_title, p.status AS status,
         p.created_at AS at, NULL::date AS ends_on
    FROM projects p
  UNION ALL
  -- People holding a place on a project now.
  SELECT m.project_id, 'person', u.id, NULL, NULL,
         NULL, NULL, true, NULL,
         u.display_name, u.display_name, NULL,
         m.starts_on::timestamptz, m.expires_on
    FROM memberships m JOIN users u ON u.id = m.user_id
   WHERE m.revoked_at IS NULL
     AND (m.held_at IS NULL OR (m.restored_at IS NOT NULL AND m.restored_at >= m.held_at))
  UNION ALL
  -- Note titles.
  SELECT s.project_id, 'note', s.id, s.id, NULL,
         NULL, NULL, true, 'Matched the note''s title',
         s.title, s.title, NULL,
         s.created_at, NULL
    FROM sources s
   WHERE s.project_id IS NOT NULL
  UNION ALL
  -- Note text, every version.
  SELECT s.project_id, 'note', s.id, s.id, NULL,
         v.version_no, max(v.version_no) OVER (PARTITION BY v.source_id)::int,
         v.version_no = max(v.version_no) OVER (PARTITION BY v.source_id), NULL,
         v.text_content, s.title, NULL,
         v.created_at, NULL
    FROM source_versions v JOIN sources s ON s.id = v.source_id
   WHERE s.project_id IS NOT NULL
  UNION ALL
  -- AI proposals not yet approved: the model's wording, current only while no one has edited it.
  SELECT s.project_id, 'ai_proposal', x.id, s.id, x.run_id,
         NULL, NULL,
         NOT EXISTS (SELECT 1 FROM extraction_item_edits e WHERE e.item_id = x.id),
         CASE WHEN EXISTS (SELECT 1 FROM extraction_item_edits e WHERE e.item_id = x.id) THEN 'Matched earlier wording' END,
         x.text || E'\n' || x.quote,
         coalesce((SELECT e.text FROM extraction_item_edits e WHERE e.item_id = x.id ORDER BY e.edited_at DESC, e.id DESC LIMIT 1), x.text),
         x.review_status,
         x.created_at, NULL
    FROM extraction_items x
    JOIN source_versions v ON v.id = x.source_version_id
    JOIN sources s ON s.id = v.source_id
   WHERE x.review_status <> 'approved' AND s.project_id IS NOT NULL
  UNION ALL
  -- AI proposals: each edit, the newest being the wording in force.
  SELECT s.project_id, 'ai_proposal', x.id, s.id, x.run_id,
         NULL, NULL,
         NOT EXISTS (SELECT 1 FROM extraction_item_edits n
                      WHERE n.item_id = e.item_id AND (n.edited_at, n.id) > (e.edited_at, e.id)),
         CASE WHEN EXISTS (SELECT 1 FROM extraction_item_edits n
                            WHERE n.item_id = e.item_id AND (n.edited_at, n.id) > (e.edited_at, e.id))
              THEN 'Matched earlier wording' END,
         e.text,
         (SELECT l.text FROM extraction_item_edits l WHERE l.item_id = x.id ORDER BY l.edited_at DESC, l.id DESC LIMIT 1),
         x.review_status,
         e.edited_at, NULL
    FROM extraction_item_edits e
    JOIN extraction_items x ON x.id = e.item_id
    JOIN source_versions v ON v.id = x.source_version_id
    JOIN sources s ON s.id = v.source_id
   WHERE x.review_status <> 'approved' AND s.project_id IS NOT NULL
  UNION ALL
  -- Proposals made by people.
  SELECT h.project_id, 'human_proposal', h.id, NULL, NULL,
         NULL, NULL, true, NULL,
         h.text, h.text, h.review_status,
         h.proposed_at, NULL
    FROM human_proposals h
   WHERE h.review_status <> 'approved'
  UNION ALL
  -- Tasks, as titled now.
  SELECT t.project_id, 'task', t.id, NULL, NULL,
         NULL, NULL, true, NULL,
         t.title, t.title, t.status,
         t.authorised_at, NULL
    FROM tasks t
  UNION ALL
  -- Task titles before an amendment.
  SELECT t.project_id, 'task', t.id, NULL, NULL,
         NULL, NULL, false, 'Matched wording before an amendment',
         e.detail -> 'title' ->> 'from', t.title, t.status,
         e.at, NULL
    FROM task_events e JOIN tasks t ON t.id = e.task_id
   WHERE e.kind = 'amended' AND e.detail ? 'title'
  UNION ALL
  SELECT d.project_id, 'decision', d.id, NULL, NULL,
         NULL, NULL, true, NULL,
         d.statement || E'\n' || coalesce(d.rationale, ''), d.statement, d.status,
         d.authorised_at, NULL
    FROM decisions d
  UNION ALL
  SELECT q.project_id, 'question', q.id, NULL, NULL,
         NULL, NULL, true, NULL,
         q.text, q.text, q.status,
         q.authorised_at, NULL
    FROM questions q
  UNION ALL
  -- Answers to questions.
  SELECT q.project_id, 'question', q.id, NULL, NULL,
         NULL, NULL, true, 'Matched an answer',
         a.answer, q.text, q.status,
         a.at, NULL
    FROM question_answers a JOIN questions q ON q.id = a.question_id
  UNION ALL
  SELECT r.project_id, 'risk', r.id, NULL, NULL,
         NULL, NULL, true, NULL,
         r.description || E'\n' || coalesce(r.mitigation, ''), r.description, r.status,
         r.authorised_at, NULL
    FROM risks r;
