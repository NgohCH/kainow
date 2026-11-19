import { ConflictException, NotFoundException } from '@nestjs/common';

/** The refusal for deleting, restoring or changing an item held in an open quarantine case (spec 4.4, 7.2). */
export const HELD = 'Held — suspected credential, under review. It can be deleted or restored once the case is released.';

/**
 * For a write that reaches a source directly (a new version, publishing, returning): a Deleted source does not exist
 * (404) and a held one is refused (409 HELD).
 */
export function refuseUnliveSource(row: { status: string; heldCaseId: string | null }): void {
  if (row.status === 'deleted') throw new NotFoundException();
  if (row.heldCaseId) throw new ConflictException(HELD);
}

/**
 * The SQL conditions every read path uses to leave out Deleted and held items (spec 4, 7.2). Each takes the table alias
 * and returns a parenthesised boolean expression; no parameters, so they can be dropped into any WHERE or EXISTS.
 */

/** A source that is neither Deleted nor held in an open quarantine case. */
export const liveSourceSql = (alias: string): string => `(${alias}.status <> 'deleted' AND ${alias}.held_case_id IS NULL)`;

/**
 * A task, decision, question or risk that is not Deleted and is in view: not held, or held in a case whose cleaning is
 * done (history spec 7.5: a cleaned record stays visible during review, labelled "Credential removed — under review",
 * so reminders and work continue; while it waits for the protected key it is hidden). For record views, work lists,
 * dashboards, counts, reminders and escalations only: anything that carries record text elsewhere uses unheldRecordSql.
 * Deleting and restoring still
 * refuse any held record (409 HELD, they read held_case_id themselves), and Inspect Deleted Content never shows one.
 */
export const liveRecordSql = (alias: string): string =>
  `(${alias}.deleted_at IS NULL AND (${alias}.held_case_id IS NULL OR EXISTS (SELECT 1 FROM quarantine_cases lrq WHERE lrq.id = ${alias}.held_case_id AND lrq.state = 'cleaned')))`;

/**
 * The strict form, for everything that carries record text out of the record views: AI material (Ask, report drafts,
 * new AI request input), search, digests and email relevance. A held record is left out whether or not it is cleaned
 * (spec 1 goals, D80, the spec 10 leak list); only work views and reminders see a cleaned record under review.
 */
export const unheldRecordSql = (alias: string): string => `(${alias}.deleted_at IS NULL AND ${alias}.held_case_id IS NULL)`;

/** A discussion message that is visible (not hidden or deleted) and not held. */
export const liveMessageSql = (alias: string): string => `(${alias}.state = 'visible' AND ${alias}.held_case_id IS NULL)`;

/** How a link from a live record to a Deleted one reads, without its title (history spec 4.3). */
export const DELETED_LINK = 'a deleted record';

/**
 * For rows that point at a record by (kind, id) columns (review flags, change requests, notification triggers): true
 * when the record is a live task, decision, question or risk, and for any other kind of target.
 */
export const liveRecordRefSql = (kindCol: string, idCol: string): string =>
  `(CASE ${kindCol}
      WHEN 'task' THEN EXISTS (SELECT 1 FROM tasks lr WHERE lr.id = ${idCol} AND ${liveRecordSql('lr')})
      WHEN 'decision' THEN EXISTS (SELECT 1 FROM decisions lr WHERE lr.id = ${idCol} AND ${liveRecordSql('lr')})
      WHEN 'question' THEN EXISTS (SELECT 1 FROM questions lr WHERE lr.id = ${idCol} AND ${liveRecordSql('lr')})
      WHEN 'risk' THEN EXISTS (SELECT 1 FROM risks lr WHERE lr.id = ${idCol} AND ${liveRecordSql('lr')})
      ELSE true END)`;

/** The strict form of `liveRecordRefSql` (see `unheldRecordSql`): for search. */
export const unheldRecordRefSql = (kindCol: string, idCol: string): string =>
  `(CASE ${kindCol}
      WHEN 'task' THEN EXISTS (SELECT 1 FROM tasks lr WHERE lr.id = ${idCol} AND ${unheldRecordSql('lr')})
      WHEN 'decision' THEN EXISTS (SELECT 1 FROM decisions lr WHERE lr.id = ${idCol} AND ${unheldRecordSql('lr')})
      WHEN 'question' THEN EXISTS (SELECT 1 FROM questions lr WHERE lr.id = ${idCol} AND ${unheldRecordSql('lr')})
      WHEN 'risk' THEN EXISTS (SELECT 1 FROM risks lr WHERE lr.id = ${idCol} AND ${unheldRecordSql('lr')})
      ELSE true END)`;

/**
 * Like `liveRecordRefSql`, but a reference to a record that does not exist at all passes: true unless the record is
 * there and is Deleted or held (for notices, which may outlive or never had their record).
 */
export const notDeletedRecordRefSql = (kindCol: string, idCol: string): string =>
  `(CASE ${kindCol}
      WHEN 'task' THEN NOT EXISTS (SELECT 1 FROM tasks lr WHERE lr.id = ${idCol} AND NOT ${liveRecordSql('lr')})
      WHEN 'decision' THEN NOT EXISTS (SELECT 1 FROM decisions lr WHERE lr.id = ${idCol} AND NOT ${liveRecordSql('lr')})
      WHEN 'question' THEN NOT EXISTS (SELECT 1 FROM questions lr WHERE lr.id = ${idCol} AND NOT ${liveRecordSql('lr')})
      WHEN 'risk' THEN NOT EXISTS (SELECT 1 FROM risks lr WHERE lr.id = ${idCol} AND NOT ${liveRecordSql('lr')})
      ELSE true END)`;

/**
 * A row of a holdable table (proposal, human proposal, AI answer, report draft, summary, feedback note, thread) that is
 * not held in an open quarantine case (history spec 7.2). Minutes drafts are held through their meeting thread.
 */
export const notHeldSql = (alias: string): string => `(${alias}.held_case_id IS NULL)`;

/** For a write that reaches a held row directly: refused with HELD (409), as for sources. */
export function refuseHeld(row: { heldCaseId?: string | null; held_case_id?: string | null } | undefined): void {
  if (row && (row.heldCaseId || row.held_case_id)) throw new ConflictException(HELD);
}
