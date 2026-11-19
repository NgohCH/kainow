/**
 * Kainow's own reports (history spec 7.1, D80): when a runner's secret check at job start finds a secret in STORED
 * content, Kainow opens a quarantine case itself, on the item that owns the text, and the run then ends `blocked` as
 * before. Typed input (a question on its way in) is refused at entry and never reaches here.
 *
 * Order and locking (decided here): every runner reports after its secret check and before it ends the run. At that
 * point a runner holds no transaction and no row lock (its claim of the run is a committed autocommit update, and its
 * save transaction opens only after the AI call), so the report's own transaction cannot wait on the runner. The run
 * is still `running` while the report cleans: nothing the report writes depends on the run row.
 *
 * The matched strings go from the detector straight to CasesService.report, which encrypts them. They are never
 * logged, never kept in a variable that outlives the call, and no error here carries them: a failure is logged as a
 * fixed sentence and the code only. A report that finds the item already held (409) or gone or no longer readable (404)
 * is the same as already reported: no second case. Anything else (a 400 included) is logged, never swallowed.
 */
import type { Pool } from 'pg';
import { findCredentialMatches } from '../extraction/credentials';
import type { ReportInput } from './cases.service';
import { MAX_MARK_CHARS, MIN_MARK } from './mark-limits';
import type { ItemKind } from './registry';

/** The part of CasesService the runners use. */
export interface KainowReporter {
  report(user: 'kainow', input: ReportInput): Promise<unknown>;
}

/** One piece of stored text and the item that owns it. */
export interface OwnedText {
  kind: ItemKind;
  id: string;
  text: string;
}

/** A report that found the item held (409) or gone or unreadable (404) is an "already reported", not a failure. */
const BENIGN = new Set([404, 409]);

/**
 * Reports each owner of a hit once, marking the matches found in its text. Never throws: the run must still end blocked.
 * Returns how many cases were opened.
 */
export async function reportOwned(reporter: KainowReporter | undefined, projectId: string | null, owned: OwnedText[], log?: (m: string) => void): Promise<number> {
  if (!reporter || !projectId) return 0;
  // One report per item, carrying every match found in any of its texts.
  const byItem = new Map<string, { kind: ItemKind; id: string; marked: Set<string> }>();
  for (const o of owned) {
    const matches = findCredentialMatches(o.text);
    if (matches.length === 0) continue;
    const key = `${o.kind}:${o.id}`;
    const entry = byItem.get(key) ?? { kind: o.kind, id: o.id, marked: new Set<string>() };
    for (const m of matches) entry.marked.add(m);
    byItem.set(key, entry);
  }
  let opened = 0;
  for (const { kind, id, marked } of byItem.values()) {
    try {
      // One mark outside the service's limits would refuse the whole report, so such a mark is dropped (and said so), not sent.
      const usable = [...marked].filter((m) => m.length >= MIN_MARK && m.length <= MAX_MARK_CHARS && m.trim().length >= MIN_MARK);
      if (usable.length < marked.size) log?.(`${marked.size - usable.length} match(es) of a stored secret in ${kind} ${id} were outside the limits for a mark and were not marked.`);
      if (usable.length === 0) continue;
      await reporter.report('kainow', { projectId, kind, id, marked: usable, reason: null });
      opened++;
    } catch (err) {
      const status = (err as { getStatus?: () => number }).getStatus?.();
      if (typeof status === 'number' && BENIGN.has(status)) continue;
      log?.(`A stored secret could not be reported for ${kind} ${id}; the run is blocked all the same.`);
    }
  }
  return opened;
}

/**
 * Discussion messages by message version id (the passages and transcript spans name versions): each text is a message
 * body, owned by its message.
 */
export async function messagesOfVersions(pool: Pool, texts: Array<{ messageVersionId: string; text: string }>): Promise<OwnedText[]> {
  if (texts.length === 0) return [];
  const { rows } = await pool.query<{ id: string; message_id: string }>(`SELECT id, message_id FROM message_versions WHERE id = ANY($1::uuid[])`, [texts.map((t) => t.messageVersionId)]);
  const owner = new Map(rows.map((r) => [r.id, r.message_id]));
  return texts.flatMap((t) => (owner.has(t.messageVersionId) ? [{ kind: 'message' as const, id: owner.get(t.messageVersionId)!, text: t.text }] : []));
}
