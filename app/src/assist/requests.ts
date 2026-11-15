import type { PoolClient } from 'pg';
import { UUID, uuidv7 } from '../common/uuid7';
import type { MaterialItem, RecordKind } from './material';

type Db = Pick<PoolClient, 'query'>;

/**
 * The store of AI requests and exactly what each one sent (spec 3, 5.1, 9). A request is written with its material in
 * the caller's transaction; afterwards only the request's status and each material row's `cited` and
 * `dropped_at_start` change. Question, answer, draft and summary text never goes into these rows.
 */

export type AssistKind = 'question' | 'report' | 'summary';
export type RequestStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';

export interface NewRequest {
  projectId: string;
  kind: AssistKind;
  requestedBy: string;
  scope: 'personal' | 'thread';
  scopeThreadId?: string;
  material: MaterialItem[];
  /** When it was asked; the time now when omitted. */
  at?: Date;
}

/** One stored material row, with the text that is sent: the passage body, or the record snapshot. */
export interface RequestMaterial {
  ordinal: number;
  marker: string;
  passageId: string | null;
  recordKind: RecordKind | null;
  recordId: string | null;
  recordAudienceId: string | null;
  snapshot: string | null;
  location: string;
  text: string;
  cited: boolean;
  droppedAtStart: boolean;
}

export interface AssistRequest {
  id: string;
  projectId: string;
  kind: AssistKind;
  requestedBy: string;
  status: RequestStatus;
  failureCode: string | null;
  failureDetail: string | null;
  attempts: number;
  scope: 'personal' | 'thread';
  scopeThreadId: string | null;
  modelId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  material: RequestMaterial[];
}

/** Stores a queued request and its material in order (ordinal 0 is the first item). Returns the request id. */
export async function createRequest(db: Db, input: NewRequest): Promise<string> {
  const at = input.at ?? new Date();
  const id = uuidv7(at.getTime());
  await db.query(
    `INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, scope_thread_id, created_at)
     VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7)`,
    [id, input.projectId, input.kind, input.requestedBy, input.scope, input.scope === 'thread' ? input.scopeThreadId ?? null : null, at],
  );
  const m = input.material;
  if (m.length > 0) {
    await db.query(
      `INSERT INTO ai_request_material (request_id, ordinal, marker, passage_id, record_kind, record_id, record_audience_id, snapshot, location)
       SELECT $1, t.ordinal, t.marker, t.passage_id, t.record_kind, t.record_id, t.record_audience_id, t.snapshot, t.location
         FROM unnest($2::int[], $3::text[], $4::uuid[], $5::text[], $6::uuid[], $7::uuid[], $8::text[], $9::text[])
              AS t(ordinal, marker, passage_id, record_kind, record_id, record_audience_id, snapshot, location)`,
      [
        id,
        m.map((_, i) => i),
        m.map((i) => i.marker),
        m.map((i) => i.passageId),
        m.map((i) => i.recordKind),
        m.map((i) => i.recordId),
        m.map((i) => i.recordAudienceId),
        m.map((i) => i.snapshot),
        m.map((i) => i.location),
      ],
    );
  }
  return id;
}

/** The request and its material in ordinal order, or undefined. */
export async function loadRequest(db: Db, id: string): Promise<AssistRequest | undefined> {
  if (!UUID.test(id)) return undefined;
  const r = (
    await db.query(
      `SELECT id, project_id AS "projectId", kind, requested_by AS "requestedBy", status, failure_code AS "failureCode",
              failure_detail AS "failureDetail", attempts, scope, scope_thread_id AS "scopeThreadId", model_id AS "modelId",
              created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"
         FROM ai_requests WHERE id = $1`,
      [id],
    )
  ).rows[0] as Omit<AssistRequest, 'material'> | undefined;
  if (!r) return undefined;
  const material = (
    await db.query(
      `SELECT m.ordinal, m.marker, m.passage_id AS "passageId", m.record_kind AS "recordKind", m.record_id AS "recordId",
              m.record_audience_id AS "recordAudienceId", m.snapshot, m.location, coalesce(p.body, m.snapshot) AS text,
              m.cited, m.dropped_at_start AS "droppedAtStart"
         FROM ai_request_material m LEFT JOIN passages p ON p.id = m.passage_id
        WHERE m.request_id = $1 ORDER BY m.ordinal`,
      [id],
    )
  ).rows as RequestMaterial[];
  return { ...r, material };
}

/** Marks material rows as dropped before sending (no longer readable at job start). */
export async function markDropped(db: Db, id: string, ordinals: number[]): Promise<void> {
  if (ordinals.length === 0) return;
  await db.query(`UPDATE ai_request_material SET dropped_at_start = true WHERE request_id = $1 AND ordinal = ANY($2::int[]) AND NOT dropped_at_start`, [id, ordinals]);
}

/** Marks the material rows the output cited, by marker. */
export async function markCited(db: Db, id: string, markers: string[]): Promise<void> {
  if (markers.length === 0) return;
  await db.query(`UPDATE ai_request_material SET cited = true WHERE request_id = $1 AND marker = ANY($2::text[]) AND NOT cited`, [id, markers]);
}
