import type { Pool, PoolClient } from 'pg';
import type { AiPurpose } from './guarded-call';
import type { Provider } from './keys';
import { type ModelPrices, modelPricesFromColumns } from './models.service';

type Db = Pool | PoolClient;

/**
 * The spend-entry `note` values the chooser reads. Task 10 (guarded-call) writes exactly these.
 * A 429 is recorded on the entry that was released (or held) for that attempt; a bad response on the
 * entry that was confirmed from its usage.
 */
export const NOTE_RATE_LIMITED = 'rate_limited_429';
export const NOTE_BAD_RESPONSE = 'bad_response';

export interface CandidateConnection {
  id: string;
  position: number;
  provider: Provider;
  modelId: string;
  /** The ai_models row id. */
  modelRef: string;
  /** Per-model prices; the exchange rate is the organisation's and is added by the caller. */
  prices: ModelPrices;
  eligible: boolean;
}

/** moveOn: the attempt ended in an outage (uncertain), a 429, or a bad response. */
export type PreviousOutcome = { connectionId: string; moveOn: boolean } | null;

export type CandidateFailure = 'ai_not_set_up' | 'no_eligible_connection' | 'protected_key_missing';

export function isMoveOn(status: string, note: string | null): boolean {
  return status === 'uncertain' || note === NOTE_RATE_LIMITED || note === NOTE_BAD_RESPONSE;
}

/**
 * Spec 6.2. Connections are tried in position order. After an attempt that moved on, take the first eligible
 * connection after the previous one's position, wrapping to the first eligible. With no previous attempt
 * (or one that did not move on, or one we cannot find) take the first eligible.
 */
export function chooseConnection(all: CandidateConnection[], previous: PreviousOutcome): CandidateConnection | null {
  const eligible = all.filter((c) => c.eligible).sort((a, b) => a.position - b.position);
  if (eligible.length === 0) return null;
  if (previous === null || !previous.moveOn) return eligible[0];
  const old = all.find((c) => c.id === previous.connectionId);
  if (!old) return eligible[0];
  return eligible.find((c) => c.position > old.position) ?? eligible[0];
}

interface CandidateRow {
  project_id: string;
  id: string;
  position: number;
  provider: Provider;
  model_id: string;
  model_ref: string;
  p_in: string;
  p_cached: string;
  p_write: string;
  p_out: string;
  eligible: boolean;
}

/**
 * Every connection of the given projects with its eligibility (spec 3): state ready or unchecked, an approved model
 * whose purposes include the purpose (and restricted_ok when the request carries restricted material), and a current
 * key sealed under the protected key now loaded ($4 = its key id). Shared by one project (the chooser) and by many
 * (Task 12, discussion analysis, which passes carriesRestricted = false).
 *
 * A key row whose key_id matches but that still does not decrypt (a copied row) cannot be seen here;
 * Task 10 meets KeyUnreadableError when it opens the key and handles it there.
 */
const CANDIDATES_SQL = `
  SELECT c.project_id, c.id, c.position, m.provider, m.model_id, m.id AS model_ref,
         m.input_usd_per_million_micro::text AS p_in, m.cached_input_usd_per_million_micro::text AS p_cached,
         m.cache_write_usd_per_million_micro::text AS p_write, m.output_usd_per_million_micro::text AS p_out,
         (c.state IN ('ready', 'unchecked')
          AND m.state = 'approved'
          AND $2 = ANY (m.purposes)
          AND (NOT $3::boolean OR m.restricted_ok)
          AND k.id IS NOT NULL) AS eligible
    FROM ai_connections c
    JOIN ai_models m ON m.id = c.model_ref
    LEFT JOIN ai_connection_keys k ON k.connection_id = c.id AND k.superseded_at IS NULL AND k.key_id = $4
   WHERE c.project_id = ANY ($1::uuid[])
   ORDER BY c.project_id, c.position`;

/** All connections (eligible or not) for each project, in position order. A project with none is absent from the map. */
export async function loadCandidatesForProjects(
  db: Db,
  projectIds: string[],
  purpose: AiPurpose,
  carriesRestricted: boolean,
  keyId: string,
): Promise<Map<string, CandidateConnection[]>> {
  const { rows } = await db.query<CandidateRow>(CANDIDATES_SQL, [projectIds, purpose, carriesRestricted, keyId]);
  const out = new Map<string, CandidateConnection[]>();
  for (const r of rows) {
    const list = out.get(r.project_id) ?? [];
    list.push({
      id: r.id,
      position: r.position,
      provider: r.provider,
      modelId: r.model_id,
      modelRef: r.model_ref,
      prices: modelPricesFromColumns(r),
      eligible: r.eligible,
    });
    out.set(r.project_id, list);
  }
  return out;
}

export async function loadCandidates(
  db: Db,
  projectId: string,
  purpose: AiPurpose,
  carriesRestricted: boolean,
  keyId: string | null,
): Promise<{ list: CandidateConnection[]; reason?: CandidateFailure }> {
  if (keyId === null) return { list: [], reason: 'protected_key_missing' };
  const list = (await loadCandidatesForProjects(db, [projectId], purpose, carriesRestricted, keyId)).get(projectId) ?? [];
  if (list.length === 0) return { list, reason: 'ai_not_set_up' };
  if (!list.some((c) => c.eligible)) return { list, reason: 'no_eligible_connection' };
  return { list };
}

/** The entry with the highest attempt_no below `attemptNo` for this request, or null when there is none. */
export async function previousOutcome(db: Db, requestId: string, attemptNo: number): Promise<PreviousOutcome> {
  const { rows } = await db.query<{ connection_id: string | null; status: string; note: string | null }>(
    `SELECT connection_id, status, note FROM ai_spend_entries WHERE request_id = $1 AND attempt_no < $2 ORDER BY attempt_no DESC LIMIT 1`,
    [requestId, attemptNo],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  // An entry without a connection (written before sub-project 6) cannot place the next attempt.
  if (r.connection_id === null) return null;
  return { connectionId: r.connection_id, moveOn: isMoveOn(r.status, r.note) };
}
