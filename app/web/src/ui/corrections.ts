/** Wording for correcting an AI proposal and its Change history (spec §7.7, §9, D130). Pure; Review only draws it. */
import type { Correction, Kind, ReviewStatus } from '../api.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The proposal kinds in the order the Type select offers them, and the word for each ("action" is shown as Task). */
export const KIND_WORDS: Record<Kind, string> = { action: 'Task', decision: 'Decision', question: 'Question', risk: 'Risk' };
export const KINDS = Object.keys(KIND_WORDS) as Kind[];

export function kindWord(kind: string): string {
  return KIND_WORDS[kind as Kind] ?? kind;
}

/** "24 Nov 2026 10:12" for a stored UTC time, shown in UTC+8. */
function stamp(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${d.toISOString().slice(11, 16)}`;
}

const FIELD_WORDS = { text: 'wording', owner: 'owner', due: 'due' } as const;

/** "24 Nov 2026 10:12 · Daniel Tan (Project Manager) changed type Task → Decision, wording, owner". */
export function correctionLine(c: Correction): string {
  const parts = c.changed.map((f) => (f === 'type' ? `type ${kindWord(c.from.kind)} → ${kindWord(c.to.kind)}` : FIELD_WORDS[f]));
  const who = c.role ? `${c.by} (${c.role})` : c.by;
  return `${stamp(c.at)} · ${who} changed ${parts.length > 0 ? parts.join(', ') : 'nothing that shows'}`;
}

/** "21 Nov 2026 16:40 · AI (gpt-6.1-sol) proposed: Task, "…", owner not stated, due 5 Dec 2026"; `at` is when the run made it. */
export function originalLine(o: { kind: string; text: string; owner: string | null; due: string | null; model: string | null }, at: string): string {
  const who = o.model ? `AI (${o.model})` : 'AI';
  return `${stamp(at)} · ${who} proposed: ${kindWord(o.kind)}, "${o.text}", ${o.owner ? `owner ${o.owner}` : 'owner not stated'}, ${o.due ? `due ${o.due}` : 'due not stated'}`;
}

/** A change of type needs a reason (§9). */
export function needsReason(from: Kind, to: Kind): boolean {
  return from !== to;
}

/**
 * Said before saving when the correction would set approvals aside: an approved proposal counts as one, and a
 * waiting authorisation counts the approvals it has. Null when nothing would be set aside.
 */
export function setAsideWarning(status: ReviewStatus, approvals: number): string | null {
  const n = Math.max(approvals, status === 'approved' ? 1 : 0);
  if (n === 0) return null;
  return `Saving sends this proposal back to review and sets aside ${n} ${n === 1 ? 'approval' : 'approvals'}.`;
}
