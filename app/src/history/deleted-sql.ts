/**
 * The SQL conditions every read path uses to leave out Deleted and held items (spec 4, 7.2). Each takes the table alias
 * and returns a parenthesised boolean expression; no parameters, so they can be dropped into any WHERE or EXISTS.
 */

/** A source that is neither Deleted nor held in an open quarantine case. */
export const liveSourceSql = (alias: string): string => `(${alias}.status <> 'deleted' AND ${alias}.held_case_id IS NULL)`;

/** A task, decision, question or risk that is neither Deleted nor held. */
export const liveRecordSql = (alias: string): string => `(${alias}.deleted_at IS NULL AND ${alias}.held_case_id IS NULL)`;

/** A discussion message that is visible (not hidden or deleted) and not held. */
export const liveMessageSql = (alias: string): string => `(${alias}.state = 'visible' AND ${alias}.held_case_id IS NULL)`;
