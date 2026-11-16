/** The authorised records that can be deleted (history spec 3, 4.3). */
export type RecordKind = 'task' | 'decision' | 'question' | 'risk';

export const RECORD_KINDS: readonly RecordKind[] = ['task', 'decision', 'question', 'risk'];

/** The refusal for deleting a record not in a final state: it names the state needed (O14). */
export const NOT_FINAL: Readonly<Record<RecordKind, string>> = {
  task: 'Cancel this task before deleting it.',
  decision: 'Withdraw or supersede this decision before deleting it.',
  question: 'Resolve or withdraw this question before deleting it.',
  risk: 'Resolve this risk, or accept it with no further review, before deleting it.',
};

/**
 * Null when the record is in a final state (spec 3): a Completed or Cancelled task; a Superseded or Withdrawn decision;
 * a Resolved or Withdrawn question; a Resolved risk, or one Accepted with "No further review required" (no review
 * date). Otherwise the refusal naming the state needed.
 */
export function deletionRefusal(kind: RecordKind, row: { status: string; noFurtherReview?: boolean }): string | null {
  const s = row.status;
  const final =
    kind === 'task'
      ? s === 'completed' || s === 'cancelled'
      : kind === 'decision'
        ? s === 'superseded' || s === 'withdrawn'
        : kind === 'question'
          ? s === 'resolved' || s === 'withdrawn'
          : s === 'resolved' || (s === 'accepted' && row.noFurtherReview === true);
  return final ? null : NOT_FINAL[kind];
}
