import type { PoolClient } from 'pg';

/**
 * Decides budget-warning notices after a project-level change that can move the warning level (spec 3.6, D93): spending
 * recorded, an adjustment or budget approved, thresholds changed, tracking turned on. Runs inside the caller's
 * transaction. A no-op hook for now: filled by Task 10.
 */
export async function evaluateFinanceWarnings(_c: PoolClient, _projectId: string, _at: Date): Promise<void> {
  // Filled by Task 10.
}
