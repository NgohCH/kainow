import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { type PassageLabel, formatMessageTime, splitPassages } from './passages';

type Db = Pick<PoolClient, 'query'>;

/**
 * Writes the passages of one stored version, in the caller's transaction (spec 4.1). Versions are immutable, so the
 * rows are written once. Discussion transcripts are never indexed (their messages are). Returns the rows written.
 */
export async function indexVersion(
  db: Db,
  ownerKind: 'source_version' | 'message_version',
  ownerId: string,
  projectId: string,
  text: string,
  label: PassageLabel = {},
): Promise<number> {
  if (ownerKind === 'source_version') {
    const kind = (await db.query(`SELECT s.kind FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE v.id = $1`, [ownerId])).rows[0]?.kind;
    if (kind === undefined || kind === 'discussion') return 0;
  }
  const drafts = splitPassages(text, ownerKind === 'message_version' ? 'message' : 'document', label);
  if (drafts.length === 0) return 0;
  const result = await db.query(
    `INSERT INTO passages (id, project_id, owner_kind, owner_id, ordinal, location, start_offset, end_offset, body)
     SELECT t.id, $1, $2, $3, t.ordinal, t.location, t.start_offset, t.end_offset, t.body
       FROM unnest($4::uuid[], $5::int[], $6::text[], $7::int[], $8::int[], $9::text[]) AS t(id, ordinal, location, start_offset, end_offset, body)
     ON CONFLICT (owner_kind, owner_id, ordinal) DO NOTHING`,
    [
      projectId,
      ownerKind,
      ownerId,
      drafts.map(() => uuidv7()),
      drafts.map((d) => d.ordinal),
      drafts.map((d) => d.location),
      drafts.map((d) => d.start),
      drafts.map((d) => d.end),
      drafts.map((d) => d.body),
    ],
  );
  return result.rowCount ?? 0;
}

const BATCH = 500;

/**
 * One-off job: indexes every source version (not `discussion`) and message version that has no passages, in batches
 * of 500, each batch its own transaction. Safe to re-run: versions that already have passages are skipped. Progress is
 * by keyset (id order), so a version that yields no passages (blank text) cannot hold the job in a loop; only versions
 * that gained passages are counted.
 */
export async function backfillPassages(pool: Pool, log: (m: string) => void): Promise<{ versions: number; passages: number; ms: number }> {
  const started = Date.now();
  let versions = 0;
  let passages = 0;
  const phases: Array<{ kind: 'source_version' | 'message_version'; sql: string }> = [
    {
      kind: 'source_version',
      sql: `SELECT v.id, s.project_id AS "projectId", v.text_content AS text
              FROM source_versions v JOIN sources s ON s.id = v.source_id
             WHERE s.kind <> 'discussion' AND s.project_id IS NOT NULL AND v.id > $1
               AND NOT EXISTS (SELECT 1 FROM passages p WHERE p.owner_kind = 'source_version' AND p.owner_id = v.id)
             ORDER BY v.id LIMIT ${BATCH}`,
    },
    {
      kind: 'message_version',
      sql: `SELECT mv.id, t.project_id AS "projectId", mv.body AS text, m.message_no AS "messageNo", u.display_name AS author, mv.created_at AS "at"
              FROM message_versions mv
              JOIN discussion_messages m ON m.id = mv.message_id
              JOIN discussion_threads t ON t.id = m.thread_id
              JOIN users u ON u.id = m.author_id
             WHERE mv.id > $1
               AND NOT EXISTS (SELECT 1 FROM passages p WHERE p.owner_kind = 'message_version' AND p.owner_id = mv.id)
             ORDER BY mv.id LIMIT ${BATCH}`,
    },
  ];
  for (const phase of phases) {
    let last = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const client = await pool.connect();
      let n = 0;
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(phase.sql, [last]);
        for (const r of rows) {
          const label = phase.kind === 'message_version' ? { messageNo: r.messageNo, author: r.author, at: formatMessageTime(r.at) } : {};
          const written = await indexVersion(client, phase.kind, r.id, r.projectId, r.text, label);
          passages += written;
          if (written > 0) versions++;
        }
        await client.query('COMMIT');
        n = rows.length;
        if (n > 0) last = rows[n - 1].id;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      if (n > 0) log(`indexed ${versions} versions, ${passages} passages`);
      if (n < BATCH) break;
    }
  }
  return { versions, passages, ms: Date.now() - started };
}
