/** What must still be true for a queued email to be worth delivering (checked by the dispatcher, Task 7). */
export type Relevance =
  | { kind: 'task'; taskId: string; dueOn: string; reopenCount: number }
  | { kind: 'risk'; riskId: string; reviewOn: string }
  | { kind: 'project_active'; projectId: string }
  | { kind: 'none' };

/** A consolidated email lists several items, each with its own check. */
export type ConsolidatedRelevance = { items: Array<{ triggerId: string; projectId: string; check: Relevance; line: string }> };

export type EmailRelevance = Relevance | ConsolidatedRelevance;
