/**
 * The per-project sweep lock and the sweep marker (history spec 7.4; final review C1).
 *
 * A sweep cleans what exists when it runs. An AI run that read the text before a report and saves after it would
 * write the secret back into registered columns in plain text. Two things close that window:
 *
 *  1. Every transaction that sweeps or restores in a project (report, Mark more, each waiting case cleaned, deciding
 *     copies, release, release unchanged) takes the project's advisory lock EXCLUSIVE as its first statement
 *     (lockSweeps), before any row lock and before the case row is updated. It is a transaction lock, never taken
 *     inside a savepoint. Concurrent sweeps of one project queue instead of deadlocking.
 *  2. Every runner reads the project's sweep marker (sweepMarkSql) no later than the statement that reads the text it
 *     sends, and its save transaction first takes the same lock SHARED and reads the marker again (sweptSince). If
 *     the marker moved, nothing is saved. With the lock, a save either commits before a sweep takes its lock (the
 *     sweep then sees and cleans the saved rows) or starts after the sweep committed (the marker has moved).
 *
 * The marker is the project's highest sweep number together with its number of cases: a sweep with the key moves the
 * first, a report without the key (which holds instead of cleaning) moves the second. Both only grow (nothing is
 * deleted), so "moved" is "differs". quarantine_sweep_seq is not used: sequences are not transactional, so a sweep
 * still in progress would look already counted.
 *
 * Also here: JIT is switched off for the sweep transaction. The copy search is one very large statement whose
 * estimated cost passes every JIT threshold; compiling it took seconds while executing it takes about 100 ms
 * (final review I1). The setting is transaction-local.
 */
import type { PoolClient } from 'pg';

type Db = Pick<PoolClient, 'query'>;

/** The advisory lock key of project $1 (the only place the key is derived). */
const LOCK_KEY = `hashtextextended('kainow.quarantine:' || $1::text, 0)`;

/** SQL for the sweep marker of the project given by the SQL expression `project` (a uuid). */
export function sweepMarkSql(project: string): string {
  return `(coalesce((SELECT max(o.sweep) FROM quarantine_originals o JOIN quarantine_cases c ON c.id = o.case_id WHERE c.project_id = ${project}), 0)::text
           || ':' || (SELECT count(*) FROM quarantine_cases c WHERE c.project_id = ${project})::text)`;
}

/** The project's sweep marker now. Read it before (or in the same statement as) the text a run will send. */
export async function sweepMark(db: Db, projectId: string): Promise<string> {
  return (await db.query<{ mark: string }>(`SELECT ${sweepMarkSql('$1::uuid')} AS mark`, [projectId])).rows[0].mark;
}

/**
 * The first statement of every sweep or restore transaction of a project: the project's sweep lock, exclusive, and
 * JIT off for the rest of the transaction.
 */
export async function lockSweeps(db: Db, projectId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(${LOCK_KEY}), set_config('jit', 'off', true)`, [projectId]);
}

/**
 * SQL for how far the quarantine of `project` has come: the sweep marker and the number of events of its cases. Every
 * part only grows and changes with the transaction that moves it, so "differs" is "something was reported, cleaned,
 * restored or decided since", whatever any clock says.
 */
export function quarantineMarkSql(project: string): string {
  return `(${sweepMarkSql(project)} || ':' || (SELECT count(*) FROM quarantine_events e JOIN quarantine_cases c ON c.id = e.case_id WHERE c.project_id = ${project})::text)`;
}

/**
 * The project's sweep lock, shared, to the end of the transaction: no report, cleaning or restoring in the project can
 * commit meanwhile. Taken first, before any row lock, as by a runner's save.
 */
export async function shareSweeps(db: Db, projectId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock_shared(${LOCK_KEY})`, [projectId]);
}

/**
 * The first statement of a runner's save transaction: the project's sweep lock, shared, then whether the marker moved
 * since `mark` was read. True means a sweep or a report happened in between: the run must save nothing.
 */
export async function sweptSince(db: Db, projectId: string, mark: string): Promise<boolean> {
  await db.query(`SELECT pg_advisory_xact_lock_shared(${LOCK_KEY})`, [projectId]);
  return (await sweepMark(db, projectId)) !== mark;
}

/** The failure code and detail of a run whose material was reported while it ran (it ends blocked; nothing saved). */
export const HELD_DURING_RUN = {
  code: 'held',
  detail: 'A suspected credential was reported in this project while the AI was working, so nothing was saved. Ask again.',
} as const;
