/** Grouping of the Needs you queue by urgency (spec 7.1). */
import type { NeedsYouItem } from '../dashboard.ts';
import type { Meaning } from './meanings.ts';

export type AttentionGroup = 'overdue' | 'review' | 'blocked' | 'dueSoon';
export interface AttentionBucket { group: AttentionGroup; meaning: Meaning; heading: string; items: NeedsYouItem[] }

const ORDER: { group: AttentionGroup; meaning: Meaning; heading: string }[] = [
  { group: 'overdue', meaning: 'overdue', heading: 'Overdue' },
  { group: 'review', meaning: 'review', heading: 'Review and decisions' },
  { group: 'blocked', meaning: 'blocked', heading: 'Blocked' },
  { group: 'dueSoon', meaning: 'dueSoon', heading: 'Due soon' },
];

export const KIND_GROUP: Record<NeedsYouItem['kind'], AttentionGroup> = {
  overdue: 'overdue',
  approval: 'review',
  minutes: 'review',
  question: 'review',
  deadline_review: 'review',
  blocked: 'blocked',
  copies: 'dueSoon',
  resources: 'dueSoon',
  due_soon: 'dueSoon',
  risk_review: 'dueSoon',
};

/** The groups in order Overdue, Review and decisions, Blocked, Due soon; empty groups are dropped; items keep their order. */
export function groupAttention(items: NeedsYouItem[]): AttentionBucket[] {
  return ORDER.map((g) => ({ ...g, items: items.filter((i) => KIND_GROUP[i.kind] === g.group) })).filter((g) => g.items.length > 0);
}
