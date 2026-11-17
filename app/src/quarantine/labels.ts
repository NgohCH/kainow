import type { Pool, PoolClient } from 'pg';
import type { ItemKind } from './registry';

/** Shown on a place where reported text was masked at once, until a PM or Deputy confirms or dismisses it (spec 7.4). */
export const POSSIBLE_COPY_TEXT = 'Possible credential removed — awaiting check';

/** Shown on an authorised record held in an open case once it is cleaned: it stays in view and work (spec 7.5). */
export const UNDER_REVIEW_TEXT = 'Credential removed — under review';

/** Shown instead of the text of an item held in an open case and not yet open to review (spec 7.2). */
export const HELD_TEXT = 'Held — suspected credential, under review';

/**
 * The items among `ids` (of one kind) that are possible copies masked at once in an open case and not yet decided:
 * they carry POSSIBLE_COPY_TEXT wherever they are shown. Row references only; no text is read.
 */
export async function possibleCopies(db: Pool | PoolClient, kind: ItemKind, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT pc.item_id::text AS id FROM quarantine_possible_copies pc JOIN quarantine_cases c ON c.id = pc.case_id
      WHERE pc.item_kind = $1 AND pc.item_id = ANY($2::uuid[]) AND pc.masked AND pc.decision IS NULL AND c.state IN ('held', 'cleaned')`,
    [kind, ids],
  );
  return new Set(rows.map((r) => r.id));
}
