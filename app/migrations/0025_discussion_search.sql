-- Sub-project 4a: search over discussion messages, and source audiences in search. Replaces the search_documents view
-- of 0019 (nothing else depends on it) and adds an index. The four columns appended at the end carry what the search
-- service needs to decide who may see a row:
--   audience_id   the audience of the source or thread the row comes from (NULL for rows that have none),
--   message_no    a message's number in its thread (the link target),
--   publication   a source's publication state ('published', 'submitted', 'returned'; NULL for non-source rows),
--   submitted_by  who submitted a source (NULL for none).
-- Rules in the view: a `discussion` source (a transcript) is never matched as text, neither its title nor any
-- version; a message is matched only through its current version and only while visible. A proposal from a
-- transcript is matched on its own wording only, never on its quote, because the quote is message text that may
-- since have been hidden or deleted. Who may see an audience-bound row is decided by the service (audienceVisibleSql).

CREATE INDEX extraction_items_wording_trgm ON extraction_items USING gin (text gin_trgm_ops)
  WHERE review_status <> 'approved';

CREATE OR REPLACE VIEW search_documents AS
  -- Projects.
  SELECT p.id AS project_id, 'project'::text AS kind, p.id AS item_id, NULL::uuid AS source_id, NULL::uuid AS run_id,
         NULL::int AS version_no, NULL::int AS version_count, true AS is_current, NULL::text AS match_note,
         p.name || E'\n' || p.purpose AS text, p.name AS ref_title, p.status AS status,
         p.created_at AS at, NULL::date AS ends_on,
         NULL::uuid AS audience_id, NULL::int AS message_no, NULL::text AS publication, NULL::uuid AS submitted_by
    FROM projects p
  UNION ALL
  -- People holding a place on a project now.
  SELECT m.project_id, 'person', u.id, NULL, NULL,
         NULL, NULL, true, NULL,
         u.display_name, u.display_name, NULL,
         m.starts_on::timestamptz, m.expires_on,
         NULL, NULL, NULL, NULL
    FROM memberships m JOIN users u ON u.id = m.user_id
   WHERE m.revoked_at IS NULL
     AND (m.held_at IS NULL OR (m.restored_at IS NOT NULL AND m.restored_at >= m.held_at))
  UNION ALL
  -- Note titles (never a discussion transcript's).
  SELECT s.project_id, 'note', s.id, s.id, NULL,
         NULL, NULL, true, 'Matched the note''s title',
         s.title, s.title, NULL,
         s.created_at, NULL,
         s.audience_id, NULL, s.publication, s.submitted_by
    FROM sources s
   WHERE s.project_id IS NOT NULL AND s.kind <> 'discussion'
  UNION ALL
  -- Note text, every version (never a discussion transcript's).
  SELECT s.project_id, 'note', s.id, s.id, NULL,
         v.version_no, (SELECT max(v2.version_no) FROM source_versions v2 WHERE v2.source_id = v.source_id)::int,
         NOT EXISTS (SELECT 1 FROM source_versions v2 WHERE v2.source_id = v.source_id AND v2.version_no > v.version_no), NULL,
         v.text_content, s.title, NULL,
         v.created_at, NULL,
         s.audience_id, NULL, s.publication, s.submitted_by
    FROM source_versions v JOIN sources s ON s.id = v.source_id
   WHERE s.project_id IS NOT NULL AND s.kind <> 'discussion'
  UNION ALL
  -- AI proposals not yet approved, from notes and minutes: the model's wording and its quote, current only while
  -- no one has edited it.
  SELECT s.project_id, 'ai_proposal', x.id, s.id, x.run_id,
         NULL, NULL,
         NOT EXISTS (SELECT 1 FROM extraction_item_edits e WHERE e.item_id = x.id),
         CASE WHEN EXISTS (SELECT 1 FROM extraction_item_edits e WHERE e.item_id = x.id) THEN 'Matched earlier wording' END,
         x.text || E'\n' || x.quote,
         coalesce((SELECT e.text FROM extraction_item_edits e WHERE e.item_id = x.id ORDER BY e.edited_at DESC, e.id DESC LIMIT 1), x.text),
         x.review_status,
         x.created_at, NULL,
         s.audience_id, NULL, s.publication, s.submitted_by
    FROM extraction_items x
    JOIN source_versions v ON v.id = x.source_version_id
    JOIN sources s ON s.id = v.source_id
   WHERE x.review_status <> 'approved' AND s.project_id IS NOT NULL AND s.kind <> 'discussion'
  UNION ALL
  -- AI proposals from a discussion transcript: the wording only. The quote is a copy of message text and is not
  -- matched (the message itself is, while it is visible).
  SELECT s.project_id, 'ai_proposal', x.id, s.id, x.run_id,
         NULL, NULL,
         NOT EXISTS (SELECT 1 FROM extraction_item_edits e WHERE e.item_id = x.id),
         CASE WHEN EXISTS (SELECT 1 FROM extraction_item_edits e WHERE e.item_id = x.id) THEN 'Matched earlier wording' END,
         x.text,
         coalesce((SELECT e.text FROM extraction_item_edits e WHERE e.item_id = x.id ORDER BY e.edited_at DESC, e.id DESC LIMIT 1), x.text),
         x.review_status,
         x.created_at, NULL,
         s.audience_id, NULL, s.publication, s.submitted_by
    FROM extraction_items x
    JOIN source_versions v ON v.id = x.source_version_id
    JOIN sources s ON s.id = v.source_id
   WHERE x.review_status <> 'approved' AND s.project_id IS NOT NULL AND s.kind = 'discussion'
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
         e.edited_at, NULL,
         s.audience_id, NULL, s.publication, s.submitted_by
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
         h.proposed_at, NULL,
         NULL, NULL, NULL, NULL
    FROM human_proposals h
   WHERE h.review_status <> 'approved'
  UNION ALL
  -- Tasks, as titled now.
  SELECT t.project_id, 'task', t.id, NULL, NULL,
         NULL, NULL, true, NULL,
         t.title, t.title, t.status,
         t.authorised_at, NULL,
         NULL, NULL, NULL, NULL
    FROM tasks t
  UNION ALL
  -- Task titles before an amendment.
  SELECT t.project_id, 'task', t.id, NULL, NULL,
         NULL, NULL, false, 'Matched wording before an amendment',
         e.detail -> 'title' ->> 'from', t.title, t.status,
         e.at, NULL,
         NULL, NULL, NULL, NULL
    FROM task_events e JOIN tasks t ON t.id = e.task_id
   WHERE e.kind = 'amended' AND e.detail ? 'title'
  UNION ALL
  SELECT d.project_id, 'decision', d.id, NULL, NULL,
         NULL, NULL, true, NULL,
         d.statement || E'\n' || coalesce(d.rationale, ''), d.statement, d.status,
         d.authorised_at, NULL,
         NULL, NULL, NULL, NULL
    FROM decisions d
  UNION ALL
  SELECT q.project_id, 'question', q.id, NULL, NULL,
         NULL, NULL, true, NULL,
         q.text, q.text, q.status,
         q.authorised_at, NULL,
         NULL, NULL, NULL, NULL
    FROM questions q
  UNION ALL
  -- Answers to questions.
  SELECT q.project_id, 'question', q.id, NULL, NULL,
         NULL, NULL, true, 'Matched an answer',
         a.answer, q.text, q.status,
         a.at, NULL,
         NULL, NULL, NULL, NULL
    FROM question_answers a JOIN questions q ON q.id = a.question_id
  UNION ALL
  SELECT r.project_id, 'risk', r.id, NULL, NULL,
         NULL, NULL, true, NULL,
         r.description || E'\n' || coalesce(r.mitigation, ''), r.description, r.status,
         r.authorised_at, NULL,
         NULL, NULL, NULL, NULL
    FROM risks r
  UNION ALL
  -- Discussion messages: the current version of a visible message. The trigram index on message_versions.body finds
  -- the candidates; only then is "no later version" checked, for the matches alone. source_id carries the thread.
  SELECT th.project_id, 'message', m.id, th.id, NULL,
         NULL, NULL, true, NULL,
         v.body, th.title, NULL,
         v.created_at, NULL,
         th.audience_id, m.message_no, NULL, NULL
    FROM message_versions v
    JOIN discussion_messages m ON m.id = v.message_id
    JOIN discussion_threads th ON th.id = m.thread_id
   WHERE m.state = 'visible'
     AND NOT EXISTS (SELECT 1 FROM message_versions v2 WHERE v2.message_id = v.message_id AND v2.version_no > v.version_no);
